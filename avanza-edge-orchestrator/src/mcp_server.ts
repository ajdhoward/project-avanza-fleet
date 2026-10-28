// ============================================================================
// PROJECT AVANZA — avanza-mcp-bridge / src/mcp_server.ts
// Cloudflare Worker: MCP (JSON-RPC 2.0) network-control bridge, multi-tenant
// telemetry ingestion (Durable Objects -> batched D1), edge-cached dashboard
// API (Cache API, s-maxage=60), server-driven UI layout manifest, GitOps
// fleet-bundle distribution over KV version token + R2 blobs.
//
// Auth: HMAC-SHA256 request signing (headers or query fallback), replay
// window, constant-time compare, per-IP fixed-window rate limiting.
// ============================================================================

export interface Env {
  DB: D1Database;
  CACHE_KV: KVNamespace;
  CONFIG_KV: KVNamespace;
  FIRMWARE: R2Bucket;
  TELEMETRY: DurableObjectNamespace;
  COMMANDS: DurableObjectNamespace;
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  ASSETS: Fetcher;
  AVANZA_HMAC_KEY?: string;
  DASHBOARD_READ_TOKEN?: string;
  SCHEMA_VERSION?: string;
  CACHE_TTL_SECONDS?: string;
  TELEMETRY_RETENTION_DAYS?: string;
  GUEST_EVAL_AI_BUDGET_PER_DAY?: string;
  SPEEDTEST_PAYLOAD_BYTES?: string;
  HMAC_REPLAY_WINDOW_SECONDS?: string;
}

export interface TelemetryIngestBody {
  kind: "telemetry" | "speedtest" | "plc_links" | "guest_request";
  device: string;
  ts: number;
  schema_ver?: number;
  metrics?: {
    mem_total_kb?: number;
    mem_avail_kb?: number;
    conntrack?: number;
    load1?: number;
    uptime_s?: number;
    plc_tx_mbps?: number;
    plc_rx_mbps?: number;
  };
  clients_json?: string;
  links?: Array<{
    local_mac?: string;
    peer_mac: string;
    tx_mbps?: number;
    rx_mbps?: number;
    atten_db?: number;
    iface?: string;
  }>;
  requests?: Array<{ id?: string; mac: string; hostname?: string; note?: string }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_SUPPORTED_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05", "2026-07-28"]);
const SERVER_INFO = { name: "avanza-edge-orchestrator", version: "2.0.0" };
const MAX_BODY_BYTES = 262144;
const RATE_LIMIT_PER_MIN = 240;
const OVERIDE_LANES = new Set([
  "telemetry_interval",
  "steering_mode",
  "guest_grant",
  "config_apply",
  "service_restart",
  "reboot",
  "plc_scan",
]);
const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

function jsonRpcResult(id: JsonRpcId, result: Record<string, unknown>): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Response {
  const err: Record<string, unknown> = { code, message };
  if (data !== undefined) err.data = data;
  return Response.json({ jsonrpc: "2.0", id, error: err });
}

function httpError(status: number, code: string, message: string): Response {
  return Response.json({ ok: false, error: { code, message } }, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function toNum(v: unknown, fallback = 0, min = -1e15, max = 1e15): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function toStr(v: unknown, maxLen: number, fallback = ""): string {
  if (typeof v !== "string") return fallback;
  return v.length > maxLen ? v.slice(0, maxLen) : v;
}

const MAC_RE = /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/;

function toMac(v: unknown): string {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return MAC_RE.test(s) ? s : "";
}

function toInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = Math.trunc(toNum(v, fallback, min, max));
  return Math.min(max, Math.max(min, n));
}

function bytesToHex(buf: ArrayBuffer): string {
  const view = new DataView(buf);
  let out = "";
  for (let i = 0; i < view.byteLength; i++) {
    out += view.getUint8(i).toString(16).padStart(2, "0");
  }
  return out;
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (x: ArrayBuffer, y: ArrayBuffer) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(new TextEncoder().encode(a).buffer as ArrayBuffer,
      new TextEncoder().encode(b).buffer as ArrayBuffer);
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToHex(sig);
}

// Per-IP fixed-window limiter (isolate-local; cheap abuse guard, not billing-grade)
const rateBuckets = new Map<string, { window: number; count: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const windowStart = Math.floor(now / 60000);
  const bucket = rateBuckets.get(ip);
  if (!bucket || bucket.window !== windowStart) {
    if (rateBuckets.size > 4096) rateBuckets.clear();
    rateBuckets.set(ip, { window: windowStart, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_PER_MIN;
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "0.0.0.0";
}

function securityHeaders(h: Record<string, string> = {}): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...h,
  };
}

// Edge-cache wrapper — absorbs repetitive dashboard polls before origin work.
async function cachedJson(
  request: Request,
  ctx: ExecutionContext,
  ttlSeconds: number,
  compute: () => Promise<Record<string, unknown>>,
): Promise<Response> {
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) {
    const cloned = new Response(hit.body, hit);
    cloned.headers.set("X-Avanza-Cache", "HIT");
    return cloned;
  }
  const data = await compute();
  const miss = new Response(JSON.stringify(data), {
    headers: securityHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, s-maxage=${ttlSeconds}, stale-while-revalidate=30`,
      "X-Avanza-Cache": "MISS",
    }),
  });
  ctx.waitUntil(cache.put(request, miss.clone()));
  return miss;
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 request authentication
//   POST : sign `${ts}.${rawBody}`
//   GET  : sign `${ts}.GET ${pathname}${searchWithoutSig}`
// Signature in `X-Avanza-Signature` header (curl path) or `sig`/`sig_ts`
// query params (uclient-fetch path). Replay window enforced.
// ---------------------------------------------------------------------------
type AuthOk = { ok: true; ts: number };
type AuthFail = { ok: false; response: Response };

async function authenticate(request: Request, env: Env, rawBody: string | null): Promise<AuthOk | AuthFail> {
  const secret = env.AVANZA_HMAC_KEY;
  if (!secret || secret.length < 32) {
    return { ok: false, response: httpError(503, "auth_unprovisioned", "AVANZA_HMAC_KEY secret is not provisioned") };
  }
  const url = new URL(request.url);
  let ts = request.headers.get("X-Avanza-Timestamp") ?? url.searchParams.get("sig_ts") ?? "";
  let sig = request.headers.get("X-Avanza-Signature") ?? url.searchParams.get("sig") ?? "";
  ts = toStr(ts, 32);
  sig = toStr(sig, 128).toLowerCase();
  const tsNum = Number(ts);
  // Accept both epoch-seconds (busybox `date +%s` agents) and epoch-millis.
  const tsMs = tsNum < 1e12 ? tsNum * 1000 : tsNum;
  const windowMs = toInt(env.HMAC_REPLAY_WINDOW_SECONDS, 300, 30, 3600) * 1000;
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsMs) > windowMs) {
    return { ok: false, response: httpError(401, "replay_rejected", "timestamp outside replay window") };
  }
  if (!/^[0-9a-f]{64}$/.test(sig)) {
    return { ok: false, response: httpError(401, "bad_signature_format", "signature must be 64 hex chars") };
  }
  let canonical: string;
  if (request.method === "POST") {
    if (rawBody === null) {
      return { ok: false, response: httpError(400, "empty_body", "request body required") };
    }
    canonical = `${ts}.${rawBody}`;
  } else {
    const params = new URLSearchParams(url.search);
    params.delete("sig");
    params.delete("sig_ts");
    const search = params.toString();
    canonical = `${ts}.GET ${url.pathname}${search ? `?${search}` : ""}`;
  }
  const expected = await hmacHex(secret, canonical);
  if (!constantTimeEqualHex(expected, sig)) {
    return { ok: false, response: httpError(401, "signature_mismatch", "HMAC verification failed") };
  }
  return { ok: true, ts: tsNum };
}

// Optional read-gate for dashboard endpoints (active when token secret is set)
function dashboardAuthorized(request: Request, env: Env): boolean {
  if (!env.DASHBOARD_READ_TOKEN) return true;
  const url = new URL(request.url);
  const provided = request.headers.get("X-Avanza-Read-Token") ?? url.searchParams.get("token") ?? "";
  return provided.length > 0 && constantTimeEqualHex(
    await0hash(provided), await0hash(env.DASHBOARD_READ_TOKEN),
  );
}

function await0hash(input: string): string {
  // Deterministic non-crypto digest for constant-length comparison of the
  // read token: FNV-1a hex. Prevents trivial length probing only; token is
  // still required to match exactly.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Durable Object: TelemetryBuffer — per-device ingest buffering with
// alarm-driven batched D1 flush (respects D1 bind limits, batches statements).
// ---------------------------------------------------------------------------
export class TelemetryBuffer {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    const sql = state.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS pending (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      device TEXT NOT NULL,
      ts INTEGER NOT NULL,
      payload TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS latest (
      device TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      metrics TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS last_anomaly (
      scope TEXT PRIMARY KEY,
      ts INTEGER NOT NULL
    )`);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/ingest") {
        return await this.handleIngest(request);
      }
      if (request.method === "GET" && url.pathname === "/snapshot") {
        return this.handleSnapshot();
      }
      if (url.pathname === "/flush" || url.pathname === "/drain") {
        const result = await this.flushNow();
        return Response.json({ ok: true, ...result });
      }
      return httpError(404, "do_route", `unknown DO route ${url.pathname}`);
    } catch (e) {
      return httpError(500, "do_internal", e instanceof Error ? e.message : "DO failure");
    }
  }

  private async handleIngest(request: Request): Promise<Response> {
    const raw = await request.text();
    if (raw.length === 0 || raw.length > MAX_BODY_BYTES) {
      return httpError(413, "payload_size", "ingest body out of bounds");
    }
    let body: TelemetryIngestBody;
    try {
      body = JSON.parse(raw) as TelemetryIngestBody;
    } catch {
      return httpError(400, "bad_json", "ingest body is not valid JSON");
    }
    const device = toStr(body.device, 64);
    const kind = toStr(body.kind, 24);
    if (!device || !/^[a-z0-9_-]{1,64}$/.test(device)) {
      return httpError(422, "bad_device", "device id must match [a-z0-9_-]{1,64}");
    }
    if (!["telemetry", "speedtest", "plc_links", "guest_request"].includes(kind)) {
      return httpError(422, "bad_kind", "unsupported ingest kind");
    }
    const ts = toInt(body.ts, Date.now(), 0, 4102444800000);
    const sql = this.state.storage.sql;

    if (kind === "telemetry" && body.metrics) {
      const m = body.metrics;
      const metrics = {
        mem_total_kb: toInt(m.mem_total_kb, 0, 0, 8_000_000),
        mem_avail_kb: toInt(m.mem_avail_kb, 0, 0, 8_000_000),
        conntrack: toInt(m.conntrack, 0, 0, 1_000_000),
        load1: toNum(m.load1, 0, 0, 1000),
        uptime_s: toInt(m.uptime_s, 0, 0, 40000000),
        plc_tx_mbps: toNum(m.plc_tx_mbps, 0, 0, 10000),
        plc_rx_mbps: toNum(m.plc_rx_mbps, 0, 0, 10000),
      };
      const clientsJson = toStr(body.clients_json, 8192, "");
      sql.exec(
        "INSERT INTO pending (kind, device, ts, payload) VALUES ('telemetry', ?, ?, ?)",
        device, ts, JSON.stringify({ metrics, clients_json: clientsJson }),
      );
      sql.exec(
        `INSERT INTO latest (device, ts, metrics) VALUES (?, ?, ?)
         ON CONFLICT(device) DO UPDATE SET ts = excluded.ts, metrics = excluded.metrics`,
        device, ts, JSON.stringify({ metrics, clients_json: clientsJson }),
      );
      await this.detectAnomalies(device, ts, metrics);
    }

    if (kind === "plc_links" && Array.isArray(body.links)) {
      const links = body.links.slice(0, 32);
      for (const link of links) {
        const peer = toMac(link.peer_mac);
        if (!peer) continue;
        sql.exec(
          "INSERT INTO pending (kind, device, ts, payload) VALUES ('plc_link', ?, ?, ?)",
          device, ts,
          JSON.stringify({
            local_mac: toMac(link.local_mac),
            peer_mac: peer,
            tx_mbps: toNum(link.tx_mbps, 0, 0, 10000),
            rx_mbps: toNum(link.rx_mbps, 0, 0, 10000),
            atten_db: toNum(link.atten_db, 0, -120, 120),
            iface: toStr(link.iface, 16),
          }),
        );
      }
      if (links.length > 0) {
        sql.exec(
          `INSERT INTO last_anomaly (scope, ts) VALUES (?, ?)
           ON CONFLICT(scope) DO UPDATE SET ts = excluded.ts`,
          `${device}:plc_seen`, ts,
        );
      }
    }

    if (kind === "speedtest") {
      sql.exec(
        "INSERT INTO pending (kind, device, ts, payload) VALUES ('speedtest', ?, ?, ?)",
        device, ts,
        JSON.stringify({
          mbps: toNum((body as unknown as { mbps?: number }).mbps, 0, 0, 10000),
          duration_ms: toInt((body as unknown as { duration_ms?: number }).duration_ms, 0, 0, 600000),
          payload_bytes: toInt((body as unknown as { payload_bytes?: number }).payload_bytes, 0, 0, 1e9),
        }),
      );
    }

    if (kind === "guest_request" && Array.isArray(body.requests)) {
      for (const req of body.requests.slice(0, 32)) {
        const mac = toMac(req.mac);
        if (!mac) continue;
        const rid = toStr(req.id, 64) || crypto.randomUUID();
        sql.exec(
          "INSERT INTO pending (kind, device, ts, payload) VALUES ('guest_request', ?, ?, ?)",
          device, ts,
          JSON.stringify({
            id: rid,
            mac,
            hostname: toStr(req.hostname, 64, ""),
            note: toStr(req.note, 256, ""),
          }),
        );
      }
    }

    const alarm = await this.state.storage.getAlarm();
    if (alarm === null) {
      await this.state.storage.setAlarm(Date.now() + 30_000);
    }
    return Response.json({ ok: true, accepted: kind, device, server_ts: Date.now() });
  }

  private async detectAnomalies(
    device: string, ts: number,
    m: { mem_avail_kb: number; conntrack: number; plc_tx_mbps: number; plc_rx_mbps: number },
  ): Promise<void> {
    const rules: Array<{ scope: string; kind: string; severity: string; hit: boolean; detail: string }> = [
      { scope: "mem_critical", kind: "memory_pressure", severity: "critical",
        hit: m.mem_avail_kb > 0 && m.mem_avail_kb < 8192,
        detail: `mem_avail_kb=${m.mem_avail_kb}` },
      { scope: "mem_warn", kind: "memory_pressure", severity: "warn",
        hit: m.mem_avail_kb >= 8192 && m.mem_avail_kb < 12288,
        detail: `mem_avail_kb=${m.mem_avail_kb}` },
      { scope: "conntrack", kind: "conntrack_saturation", severity: "warn",
        hit: m.conntrack > 12000, detail: `conntrack=${m.conntrack}` },
      { scope: "plc_down", kind: "powerline_down", severity: "critical",
        hit: m.plc_rx_mbps === 0 && m.plc_tx_mbps === 0,
        detail: "plcstat reported no active link rates" },
      { scope: "plc_degraded", kind: "powerline_degraded", severity: "warn",
        hit: m.plc_rx_mbps > 0 && m.plc_rx_mbps < 40,
        detail: `plc_rx_mbps=${m.plc_rx_mbps}` },
    ];
    for (const rule of rules) {
      if (!rule.hit) continue;
      const scope = `${device}:${rule.scope}`;
      const rows = this.state.storage.sql
        .exec("SELECT ts FROM last_anomaly WHERE scope = ?", scope).toArray();
      const last = rows.length > 0 ? toNum((rows[0] as { ts: unknown }).ts, 0) : 0;
      if (ts - last < 300_000) continue;
      this.state.storage.sql.exec(
        `INSERT INTO last_anomaly (scope, ts) VALUES (?, ?)
         ON CONFLICT(scope) DO UPDATE SET ts = excluded.ts`,
        scope, ts,
      );
      this.state.storage.sql.exec(
        "INSERT INTO pending (kind, device, ts, payload) VALUES ('anomaly', ?, ?, ?)",
        device, ts, JSON.stringify({ anomaly_kind: rule.kind, severity: rule.severity, detail: rule.detail }),
      );
    }
  }

  private handleSnapshot(): Response {
    const rows = this.state.storage.sql
      .exec("SELECT device, ts, metrics FROM latest ORDER BY device").toArray() as Array<Record<string, unknown>>;
    const devices: Array<Record<string, unknown>> = rows.map((r) => {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(String(r.metrics)) as Record<string, unknown>; } catch { parsed = {}; }
      const metrics = (parsed.metrics ?? parsed) as Record<string, unknown>;
      return {
        device: String(r.device),
        ts: toNum(r.ts),
        ...metrics,
        clients: typeof parsed.clients_json === "string" && parsed.clients_json.length > 0
          ? (() => { try { return JSON.parse(parsed.clients_json as string); } catch { return null; } })()
          : null,
      };
    });
    return Response.json({ ok: true, devices, server_ts: Date.now() });
  }

  async alarm(): Promise<void> {
    const result = await this.flushNow();
    if (result.remaining > 0) {
      await this.state.storage.setAlarm(Date.now() + 5_000);
    }
  }

  private async flushNow(): Promise<{ flushed: number; remaining: number }> {
    const sql = this.state.storage.sql;
    const rows = sql
      .exec("SELECT id, kind, device, ts, payload FROM pending ORDER BY id LIMIT 400")
      .toArray() as Array<{ id: number; kind: string; device: string; ts: number; payload: string }>;
    if (rows.length === 0) {
      const count = sql.exec("SELECT COUNT(*) AS n FROM pending").toArray() as Array<{ n: number }>;
      return { flushed: 0, remaining: toNum(count[0]?.n, 0) };
    }
    const maxId = rows[rows.length - 1].id;
    const telemetryStmts: D1PreparedStatement[] = [];
    const plcStmts: D1PreparedStatement[] = [];
    const speedStmts: D1PreparedStatement[] = [];
    const guestStmts: D1PreparedStatement[] = [];
    const anomalyStmts: D1PreparedStatement[] = [];

    for (const row of rows) {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(row.payload) as Record<string, unknown>; } catch { continue; }
      const m = (payload.metrics ?? payload) as Record<string, unknown>;
      switch (row.kind) {
        case "telemetry":
          telemetryStmts.push(this.env.DB.prepare(
            `INSERT INTO telemetry (device, ts, mem_total_kb, mem_avail_kb, conntrack, load1, uptime_s, plc_tx_mbps, plc_rx_mbps, clients_json, schema_ver)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            row.device, row.ts,
            toInt(m.mem_total_kb, 0, 0, 8e6), toInt(m.mem_avail_kb, 0, 0, 8e6),
            toInt(m.conntrack, 0, 0, 1e6), toNum(m.load1, 0, 0, 1000), toInt(m.uptime_s, 0, 0, 4e7),
            toNum(m.plc_tx_mbps, 0, 0, 10000), toNum(m.plc_rx_mbps, 0, 0, 10000),
            toStr(m.clients_json as string, 8192, ""),
            toInt(this.env.SCHEMA_VERSION, 2, 1, 99),
          ));
          break;
        case "plc_link":
          plcStmts.push(this.env.DB.prepare(
            `INSERT INTO plc_links (ts, device, local_mac, peer_mac, tx_mbps, rx_mbps, atten_db, iface, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
          ).bind(
            row.ts, row.device, toMac(payload.local_mac), toMac(payload.peer_mac),
            toNum(payload.tx_mbps, 0, 0, 10000), toNum(payload.rx_mbps, 0, 0, 10000),
            toNum(payload.atten_db, 0, -120, 120), toStr(payload.iface as string, 16, ""),
          ));
          break;
        case "speedtest":
          speedStmts.push(this.env.DB.prepare(
            `INSERT INTO speedtests (ts, device, direction, mbps, duration_ms, payload_bytes)
             VALUES (?, ?, 'edge_down', ?, ?, ?)`,
          ).bind(row.ts, row.device, toNum(payload.mbps, 0, 0, 10000),
            toInt(payload.duration_ms, 0, 0, 600000), toInt(payload.payload_bytes, 0, 0, 1e9)));
          break;
        case "guest_request":
          guestStmts.push(this.env.DB.prepare(
            `INSERT INTO guest_requests (id, ts, device, mac, hostname, note, status)
             VALUES (?, ?, ?, ?, ?, ?, 'pending')
             ON CONFLICT(id) DO NOTHING`,
          ).bind(toStr(payload.id as string, 64), row.ts, row.device,
            toMac(payload.mac), toStr(payload.hostname as string, 64, ""),
            toStr(payload.note as string, 256, "")));
          break;
        case "anomaly":
          anomalyStmts.push(this.env.DB.prepare(
            `INSERT INTO anomalies (ts, device, kind, severity, detail)
             VALUES (?, ?, ?, ?, ?)`,
          ).bind(row.ts, row.device, toStr(payload.anomaly_kind as string, 64, "unknown"),
            toStr(payload.severity as string, 16, "info"), toStr(payload.detail as string, 512, "")));
          break;
        default:
          break;
      }
    }

    const batches: D1PreparedStatement[][] = [];
    for (const list of [telemetryStmts, plcStmts, speedStmts, guestStmts, anomalyStmts]) {
      for (let i = 0; i < list.length; i += 80) {
        batches.push(list.slice(i, i + 80));
      }
    }
    for (const batch of batches) {
      if (batch.length > 0) await this.env.DB.batch(batch);
    }
    sql.exec("DELETE FROM pending WHERE id <= ?", maxId);
    const count = sql.exec("SELECT COUNT(*) AS n FROM pending").toArray() as Array<{ n: number }>;
    return { flushed: rows.length, remaining: toNum(count[0]?.n, 0) };
  }
}

// ---------------------------------------------------------------------------
// Durable Object: CommandLane — durable override command queue with TTL
// expiry alarms; the local agent polls, executes under the 10-minute
// rollback safety matrix, and acknowledges.
// ---------------------------------------------------------------------------
export class CommandLane {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS commands (
      id TEXT PRIMARY KEY,
      device TEXT NOT NULL,
      lane TEXT NOT NULL,
      action TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      created INTEGER NOT NULL,
      expires INTEGER NOT NULL,
      detail TEXT
    )`);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/commands") return await this.putCommand(request);
      if (request.method === "GET" && url.pathname === "/commands") return await this.takeCommands(url);
      if (request.method === "POST" && url.pathname === "/ack") return await this.ack(request);
      if (request.method === "POST" && url.pathname === "/sweep") return await this.sweepExpired();
      return httpError(404, "do_route", `unknown DO route ${url.pathname}`);
    } catch (e) {
      return httpError(500, "do_internal", e instanceof Error ? e.message : "DO failure");
    }
  }

  private async putCommand(request: Request): Promise<Response> {
    const raw = await request.text();
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw) as Record<string, unknown>; } catch {
      return httpError(400, "bad_json", "command body is not valid JSON");
    }
    const device = toStr(body.device_id ?? body.device, 64);
    const lane = toStr(body.lane, 32);
    const action = toStr(body.action, 32);
    if (!/^[a-z0-9_-]{1,64}$/.test(device)) return httpError(422, "bad_device", "invalid device id");
    if (!OVERIDE_LANES.has(lane)) return httpError(422, "bad_lane", "unknown override lane");
    const ttlMinutes = toInt(body.ttl_minutes, 60, 1, 1440);
    const now = Date.now();
    const id = toStr(body.command_id, 64) || crypto.randomUUID();
    const payload = JSON.stringify({
      payload: body.payload ?? {},
      requested_by: toStr(body.requested_by, 128, "mcp"),
      confirm: body.confirm === true,
    });
    this.state.storage.sql.exec(
      `INSERT INTO commands (id, device, lane, action, payload, status, created, expires)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, status = 'pending',
         created = excluded.created, expires = excluded.expires`,
      id, device, lane, action, payload, now, now + ttlMinutes * 60_000,
    );
    const nextExpiry = this.state.storage.sql
      .exec("SELECT MIN(expires) AS e FROM commands WHERE status IN ('pending','dispatched')")
      .toArray() as Array<{ e: number | null }>;
    const e = nextExpiry[0]?.e;
    if (e) await this.state.storage.setAlarm(Math.max(Date.now() + 1_000, e));
    try {
      await this.env.DB.prepare(
        "INSERT INTO audit_log (ts, actor, action, target, payload) VALUES (?, ?, ?, ?, ?)",
      ).bind(now, "mcp:set_device_override_lane", `${lane}:${action}`, device, payload).run();
    } catch {
      // audit trail is best-effort; command durability lives in DO storage
    }
    return Response.json({ ok: true, command_id: id, device, lane, action, expires_at: now + ttlMinutes * 60_000 });
  }

  private async takeCommands(url: URL): Promise<Response> {
    const device = toStr(url.searchParams.get("device"), 64);
    if (!/^[a-z0-9_-]{1,64}$/.test(device)) return httpError(422, "bad_device", "invalid device id");
    const now = Date.now();
    const rows = this.state.storage.sql
      .exec("SELECT id, lane, action, payload, created, expires FROM commands WHERE device = ? AND status = 'pending' AND expires > ? ORDER BY created LIMIT 10",
        device, now)
      .toArray() as Array<Record<string, unknown>>;
    const commands = rows.map((r) => {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(String(r.payload)) as Record<string, unknown>; } catch { payload = {}; }
      return {
        command_id: String(r.id), lane: String(r.lane), action: String(r.action),
        payload: payload.payload ?? {}, confirm: payload.confirm === true,
        requested_by: payload.requested_by ?? "mcp",
        created: toNum(r.created), expires: toNum(r.expires),
      };
    });
    for (const r of rows) {
      this.state.storage.sql.exec("UPDATE commands SET status = 'dispatched' WHERE id = ?", String(r.id));
    }
    return Response.json({ ok: true, device, commands, server_ts: now });
  }

  private async ack(request: Request): Promise<Response> {
    const raw = await request.text();
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw) as Record<string, unknown>; } catch {
      return httpError(400, "bad_json", "ack body is not valid JSON");
    }
    const id = toStr(body.command_id, 64);
    const ok = body.ok === true;
    const detail = toStr(body.detail, 1024, "");
    if (!id) return httpError(422, "bad_command_id", "command_id required");
    const now = Date.now();
    this.state.storage.sql.exec(
      "UPDATE commands SET status = ?, detail = ? WHERE id = ? AND status IN ('pending','dispatched')",
      ok ? "confirmed" : "failed", detail, id,
    );
    const rows = this.state.storage.sql
      .exec("SELECT device, lane, action FROM commands WHERE id = ?", id)
      .toArray() as Array<Record<string, unknown>>;
    if (rows.length > 0) {
      const r = rows[0];
      try {
        await this.env.DB.prepare(
          "INSERT INTO audit_log (ts, actor, action, target, payload) VALUES (?, ?, ?, ?, ?)",
        ).bind(now, "agent:ack", `${String(r.lane)}:${String(r.action)}`, String(r.device), detail).run();
      } catch {
        // best-effort audit
      }
    }
    return Response.json({ ok: true, command_id: id, state: ok ? "confirmed" : "failed" });
  }

  private async sweepExpired(): Promise<Response> {
    const now = Date.now();
    this.state.storage.sql.exec(
      "UPDATE commands SET status = 'expired', detail = 'ttl elapsed without confirmation' WHERE status IN ('pending','dispatched') AND expires <= ?",
      now,
    );
    const next = this.state.storage.sql
      .exec("SELECT MIN(expires) AS e FROM commands WHERE status IN ('pending','dispatched')")
      .toArray() as Array<{ e: number | null }>;
    const e = next[0]?.e;
    if (e) await this.state.storage.setAlarm(Math.max(now + 1_000, e));
    else await this.state.storage.deleteAlarm();
    return Response.json({ ok: true, swept_at: now });
  }

  async alarm(): Promise<void> {
    await this.sweepExpired();
  }
}

// ---------------------------------------------------------------------------
// MCP tool surface
// ---------------------------------------------------------------------------
interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: McpTool[] = [
  {
    name: "get_fleet_status",
    title: "Get AVANZA fleet status",
    description:
      "Reads the freshest telemetry snapshot per fleet device (Archer C7 core, TD-W8968 L2 switch, Tenda A750 AP plane): memory pressure, nf_conntrack saturation, load, powerline backhaul rates, client counts and staleness.",
    inputSchema: {
      type: "object",
      properties: {
        device: { type: "string", description: "Optional device id filter, e.g. avanza-core" },
        window_minutes: { type: "number", description: "Lookback window in minutes (1-1440)", default: 15 },
      },
    },
  },
  {
    name: "get_powerline_topology",
    title: "Get powerline (PLC) topology",
    description:
      "Builds the HomePlug AV backhaul adjacency map harvested from non-resident plcstat runs: per-peer TX/RX line rates, attenuation, and link-health classification (good/fair/poor/down).",
    inputSchema: {
      type: "object",
      properties: {
        max_age_minutes: { type: "number", description: "Max age of link samples to include (5-1440)", default: 60 },
      },
    },
  },
  {
    name: "set_device_override_lane",
    title: "Set device override lane",
    description:
      "Writes a confirmed override command into the durable CommandLane for a fleet device. Lanes: telemetry_interval, steering_mode, guest_grant, config_apply, service_restart, reboot, plc_scan. Requires confirm=true. The local agent executes under a 10-minute rollback safety matrix and acknowledges.",
    inputSchema: {
      type: "object",
      required: ["device_id", "lane", "action", "confirm"],
      properties: {
        device_id: { type: "string", description: "Target device id" },
        lane: { type: "string", enum: [...OVERIDE_LANES] },
        action: { type: "string", description: "Lane action: set|grant|revoke|apply|restart|schedule|now" },
        payload: { type: "object", description: "Lane-specific parameters (seconds, mode, mac, minutes, service, delay_seconds, bundle)" },
        ttl_minutes: { type: "number", description: "Command validity window (1-1440)", default: 60 },
        confirm: { type: "boolean", description: "Must be true; safety confirmation" },
      },
    },
  },
  {
    name: "evaluate_guest_requests",
    title: "Evaluate guest access requests",
    description:
      "Scores pending guest-network access requests with policy heuristics plus Workers AI, writes decisions, and optionally auto-applies allow grants into the guest_grant override lane.",
    inputSchema: {
      type: "object",
      properties: {
        auto_apply: { type: "boolean", description: "Push allow decisions to the device guest_grant lane", default: false },
        max_requests: { type: "number", description: "Batch cap (1-10)", default: 5 },
      },
    },
  },
];

interface ToolOutput {
  content: Array<{ type: string; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

function toolOk(data: Record<string, unknown>): ToolOutput {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function toolErr(message: string): ToolOutput {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

// --- Tool: get_fleet_status -------------------------------------------------
async function toolGetFleetStatus(args: Record<string, unknown>, env: Env): Promise<ToolOutput> {
  const device = toStr(args.device, 64);
  const windowMinutes = toInt(args.window_minutes, 15, 1, 1440);
  const since = Date.now() - windowMinutes * 60_000;
  const latest = await env.DB.prepare(
    `SELECT t.* FROM telemetry t
     JOIN (SELECT device, MAX(id) AS mid FROM telemetry WHERE ts > ?1 GROUP BY device) g
       ON t.id = g.mid`,
  ).bind(since).all<Record<string, unknown>>();
  const stats = await env.DB.prepare(
    `SELECT device, COUNT(*) AS n, AVG(mem_avail_kb) AS mem, AVG(conntrack) AS ct,
            AVG(plc_rx_mbps) AS rx, MAX(ts) AS last_ts
     FROM telemetry WHERE ts > ?1 GROUP BY device`,
  ).bind(since).all<Record<string, unknown>>();
  const statsByDevice = new Map<string, Record<string, unknown>>();
  for (const s of stats.results ?? []) statsByDevice.set(String(s.device), s);
  const devices = (latest.results ?? [])
    .filter((r) => !device || String(r.device) === device)
    .map((r) => {
      const s = statsByDevice.get(String(r.device));
      let clients: unknown = null;
      try { clients = r.clients_json ? JSON.parse(String(r.clients_json)) : null; } catch { clients = null; }
      return {
        device: String(r.device),
        last_report_ts: toNum(r.ts),
        age_seconds: Math.round((Date.now() - toNum(r.ts)) / 1000),
        mem_total_kb: toNum(r.mem_total_kb),
        mem_avail_kb: toNum(r.mem_avail_kb),
        conntrack: toNum(r.conntrack),
        load1: toNum(r.load1),
        uptime_s: toNum(r.uptime_s),
        plc_tx_mbps: toNum(r.plc_tx_mbps),
        plc_rx_mbps: toNum(r.plc_rx_mbps),
        clients,
        window: {
          samples: toNum(s?.n),
          avg_mem_avail_kb: Math.round(toNum(s?.mem)),
          avg_conntrack: Math.round(toNum(s?.ct)),
          avg_plc_rx_mbps: Math.round(toNum(s?.rx) * 10) / 10,
        },
      };
    });
  let version = "unknown";
  try { version = (await env.CACHE_KV.get("fleet/version")) ?? "unknown"; } catch { version = "unknown"; }
  return toolOk({
    fleet_version: version,
    schema_version: toInt(env.SCHEMA_VERSION, 2, 1, 99),
    window_minutes: windowMinutes,
    devices,
  });
}

// --- Tool: get_powerline_topology -------------------------------------------
async function toolGetPowerlineTopology(args: Record<string, unknown>, env: Env): Promise<ToolOutput> {
  const maxAgeMinutes = toInt(args.max_age_minutes, 60, 5, 1440);
  const since = Date.now() - maxAgeMinutes * 60_000;
  const rows = await env.DB.prepare(
    `SELECT device, local_mac, peer_mac, tx_mbps, rx_mbps, atten_db, iface, MAX(ts) AS last_ts
     FROM plc_links WHERE ts > ?1 GROUP BY device, peer_mac`,
  ).bind(since).all<Record<string, unknown>>();
  const staleCutoff = Date.now() - 30 * 60_000;
  const links = (rows.results ?? []).map((r) => {
    const tx = toNum(r.tx_mbps);
    const rx = toNum(r.rx_mbps);
    const lastTs = toNum(r.last_ts);
    let health: "good" | "fair" | "poor" | "down";
    if (lastTs < staleCutoff || (tx === 0 && rx === 0)) health = "down";
    else if (rx >= 150) health = "good";
    else if (rx >= 80) health = "fair";
    else health = "poor";
    return {
      device: String(r.device),
      local_mac: toMac(r.local_mac),
      peer_mac: toMac(r.peer_mac),
      iface: toStr(r.iface as string, 16),
      tx_mbps: tx,
      rx_mbps: rx,
      atten_db: toNum(r.atten_db),
      last_ts: lastTs,
      age_minutes: Math.round((Date.now() - lastTs) / 60000),
      health,
    };
  });
  const nodes = new Set<string>();
  for (const l of links) {
    nodes.add(l.device);
    if (l.peer_mac) nodes.add(l.peer_mac);
  }
  return toolOk({
    topology: "star",
    nodes: [...nodes],
    links,
    sampled_within_minutes: maxAgeMinutes,
  });
}

// --- Tool: set_device_override_lane -----------------------------------------
interface LaneSpec {
  actions: string[];
  validate: (payload: Record<string, unknown>) => string | null;
}

const LANE_SPECS: Record<string, LaneSpec> = {
  telemetry_interval: {
    actions: ["set"],
    validate: (p) => {
      const s = toInt(p.seconds, 0, 0, 1e9);
      if (s < 30 || s > 900) return "payload.seconds must be 30-900";
      return null;
    },
  },
  steering_mode: {
    actions: ["set"],
    validate: (p) => {
      const mode = toStr(p.mode, 16);
      if (!["balanced", "aggressive", "disabled"].includes(mode)) {
        return "payload.mode must be balanced|aggressive|disabled";
      }
      return null;
    },
  },
  guest_grant: {
    actions: ["grant", "revoke"],
    validate: (p) => {
      if (!toMac(p.mac)) return "payload.mac must be a valid MAC address";
      if (p.minutes !== undefined && (toInt(p.minutes, 0, 0, 1e9) < 5 || toInt(p.minutes, 0, 0, 1e9) > 1440)) {
        return "payload.minutes must be 5-1440";
      }
      return null;
    },
  },
  config_apply: {
    actions: ["apply"],
    validate: (p) => {
      const bundle = toStr(p.bundle, 64, "latest");
      if (bundle !== "latest") return "payload.bundle must be 'latest'";
      return null;
    },
  },
  service_restart: {
    actions: ["restart"],
    validate: (p) => {
      const svc = toStr(p.service, 24);
      if (!["network", "firewall", "wireless", "usteer", "agent"].includes(svc)) {
        return "payload.service must be network|firewall|wireless|usteer|agent";
      }
      return null;
    },
  },
  reboot: {
    actions: ["schedule"],
    validate: (p) => {
      const d = toInt(p.delay_seconds, 0, 0, 1e9);
      if (d < 0 || d > 3600) return "payload.delay_seconds must be 0-3600";
      return null;
    },
  },
  plc_scan: {
    actions: ["now"],
    validate: () => null,
  },
};

async function toolSetDeviceOverrideLane(args: Record<string, unknown>, env: Env): Promise<ToolOutput> {
  if (args.confirm !== true) {
    return toolErr("refusing to write override lane: confirm=true is required (10-minute rollback matrix will engage on device)");
  }
  const deviceId = toStr(args.device_id, 64);
  const lane = toStr(args.lane, 32);
  const action = toStr(args.action, 32);
  if (!/^[a-z0-9_-]{1,64}$/.test(deviceId)) return toolErr("device_id must match [a-z0-9_-]{1,64}");
  if (!OVERIDE_LANES.has(lane)) return toolErr(`unknown lane '${lane}'`);
  const spec = LANE_SPECS[lane];
  if (!spec.actions.includes(action)) return toolErr(`lane '${lane}' supports actions: ${spec.actions.join("|")}`);
  const payload = (args.payload && typeof args.payload === "object" ? args.payload : {}) as Record<string, unknown>;
  const validationError = spec.validate(payload);
  if (validationError) return toolErr(validationError);
  const ttlMinutes = toInt(args.ttl_minutes, 60, 1, 1440);

  const stub = env.COMMANDS.get(env.COMMANDS.idFromName("global"));
  const resp = await stub.fetch("https://do.internal/commands", {
    method: "POST",
    body: JSON.stringify({
      device_id: deviceId, lane, action, payload, ttl_minutes: ttlMinutes,
      confirm: true, requested_by: "mcp",
    }),
  });
  if (!resp.ok) {
    return toolErr(`command lane rejected the override: HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as Record<string, unknown>;
  return toolOk({
    ...data,
    execution_guarantee: "agent applies under 10-minute rollback matrix; requires gateway ping + Cloudflare health verification to confirm",
  });
}

// --- Tool: evaluate_guest_requests ------------------------------------------
function heuristicGuestScore(req: { mac: string; hostname: string; note: string }): {
  decision: "allow" | "deny" | "review"; score: number; reason: string;
} {
  let score = 50;
  if (req.hostname) score += 15;
  if (!req.note) score += 15;
  else score -= 10;
  const reason = score >= 60
    ? "heuristic: ordinary client profile"
    : score >= 40
      ? "heuristic: ambiguous request, needs review"
      : "heuristic: request profile looks hostile";
  const decision = score >= 60 ? "allow" : score >= 40 ? "review" : "deny";
  return { decision, score, reason };
}

async function toolEvaluateGuestRequests(args: Record<string, unknown>, env: Env): Promise<ToolOutput> {
  const autoApply = args.auto_apply === true;
  const maxRequests = toInt(args.max_requests, 5, 1, 10);
  const pending = await env.DB.prepare(
    "SELECT id, ts, device, mac, hostname, note FROM guest_requests WHERE status = 'pending' ORDER BY ts LIMIT ?1",
  ).bind(maxRequests).all<Record<string, unknown>>();
  const requests = pending.results ?? [];
  if (requests.length === 0) return toolOk({ evaluated: 0, decisions: [] });

  // Workers AI budget guard — $5/mo tier discipline
  const dayKey = `ai_budget:${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
  const used = toInt(await env.CACHE_KV.get(dayKey), 0, 0, 1e9);
  const budget = toInt(env.GUEST_EVAL_AI_BUDGET_PER_DAY, 500, 0, 100000);
  const aiAvailable = used < budget;

  const decisions: Array<Record<string, unknown>> = [];
  for (const req of requests) {
    const id = String(req.id);
    const candidate = {
      mac: toMac(req.mac),
      hostname: toStr(req.hostname as string, 64, ""),
      note: toStr(req.note as string, 256, ""),
      device: String(req.device),
      requested_ts: toNum(req.ts),
    };
    let outcome = heuristicGuestScore(candidate);
    if (aiAvailable && env.AI) {
      try {
        await env.CACHE_KV.put(dayKey, String(used + 1), { expirationTtl: 90000 });
        const aiResp = (await env.AI.run(AI_MODEL, {
          messages: [
            {
              role: "system",
              content:
                "You are the AVANZA guest network access policy engine. Evaluate the request strictly: deny requests whose note contains URLs, credentials, or pressure language; allow ordinary personal devices; anything ambiguous is review. Respond with STRICT JSON only: {\"decision\":\"allow\"|\"deny\"|\"review\",\"score\":0-100,\"reason\":\"<=200 chars\"}",
            },
            { role: "user", content: JSON.stringify(candidate) },
          ],
          max_tokens: 200,
          temperature: 0.1,
        })) as { response?: string };
        const match = typeof aiResp.response === "string" ? /\{[\s\S]*\}/.exec(aiResp.response) : null;
        if (match) {
          const parsed = JSON.parse(match[0]) as { decision?: string; score?: number; reason?: string };
          const d = toStr(parsed.decision, 8);
          if (["allow", "deny", "review"].includes(d)) {
            outcome = {
              decision: d as "allow" | "deny" | "review",
              score: toInt(parsed.score, outcome.score, 0, 100),
              reason: toStr(parsed.reason, 200, outcome.reason),
            };
          }
        }
      } catch {
        // AI lane is best-effort; heuristic outcome already populated
      }
    }
    const ttlExpires = outcome.decision === "allow" ? Date.now() + 4 * 3600_000 : null;
    await env.DB.prepare(
      "UPDATE guest_requests SET status = 'evaluated', score = ?1, decision = ?2, ttl_expires = ?3 WHERE id = ?4",
    ).bind(outcome.score, outcome.decision, ttlExpires, id).run();
    if (autoApply && outcome.decision === "allow") {
      const stub = env.COMMANDS.get(env.COMMANDS.idFromName("global"));
      await stub.fetch("https://do.internal/commands", {
        method: "POST",
        body: JSON.stringify({
          device_id: candidate.device, lane: "guest_grant", action: "grant",
          payload: { mac: candidate.mac, minutes: 240 },
          ttl_minutes: 120, confirm: true, requested_by: "mcp:guest_eval",
        }),
      });
    }
    decisions.push({ request_id: id, ...candidate, ...outcome, ttl_expires: ttlExpires, ai_used: aiAvailable });
  }
  await env.DB.prepare(
    "INSERT INTO audit_log (ts, actor, action, target, payload) VALUES (?, ?, ?, ?, ?)",
  ).bind(Date.now(), "mcp:evaluate_guest_requests", "batch", "guest_requests",
    JSON.stringify({ count: decisions.length, auto_apply: autoApply })).run();
  return toolOk({ evaluated: decisions.length, ai_budget: { used: used + 1, daily: budget }, decisions });
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 / MCP dispatcher
// ---------------------------------------------------------------------------
async function dispatchTool(name: string, args: Record<string, unknown>, env: Env): Promise<ToolOutput> {
  switch (name) {
    case "get_fleet_status":
      return await toolGetFleetStatus(args, env);
    case "get_powerline_topology":
      return await toolGetPowerlineTopology(args, env);
    case "set_device_override_lane":
      return await toolSetDeviceOverrideLane(args, env);
    case "evaluate_guest_requests":
      return await toolEvaluateGuestRequests(args, env);
    default:
      return toolErr(`unknown tool '${name}'`);
  }
}

async function handleRpc(request: Request, env: Env, rawBody: string): Promise<Response> {
  let msg: unknown;
  try {
    msg = JSON.parse(rawBody);
  } catch {
    return jsonRpcError(null, -32700, "Parse error");
  }
  if (Array.isArray(msg)) {
    return jsonRpcError(null, -32600, "Invalid Request: JSON-RPC batching is not supported");
  }
  const req = msg as JsonRpcRequest;
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return jsonRpcError(req.id ?? null, -32600, "Invalid Request");
  }
  const isNotification = req.id === undefined || req.id === null;
  const sessionHeader = request.headers.get("MCP-Session-Id");
  if (sessionHeader !== null && !/^[0-9a-f-]{36}$/.test(sessionHeader)) {
    return jsonRpcError(req.id ?? null, -32600, "Invalid Request: malformed MCP-Session-Id");
  }
  const protoHeader = request.headers.get("MCP-Protocol-Version");
  if (protoHeader !== null && !MCP_SUPPORTED_VERSIONS.has(protoHeader)) {
    return jsonRpcError(req.id ?? null, -32600, `Unsupported MCP-Protocol-Version: ${protoHeader}`);
  }

  switch (req.method) {
    case "initialize": {
      const requested = String((req.params?.protocolVersion as string) ?? MCP_PROTOCOL_VERSION);
      const negotiated = MCP_SUPPORTED_VERSIONS.has(requested) ? requested : MCP_PROTOCOL_VERSION;
      const res = jsonRpcResult(req.id ?? null, {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "AVANZA edge fleet bridge. Use tools to read fleet telemetry/powerline topology and to write confirmed override commands. Mutating tools require confirm=true and execute on-device under a 10-minute rollback matrix.",
      });
      res.headers.set("MCP-Session-Id", crypto.randomUUID());
      return res;
    }
    case "notifications/initialized":
      return new Response(null, { status: 202 });
    case "ping":
      return jsonRpcResult(req.id ?? null, {});
    case "tools/list":
      return jsonRpcResult(req.id ?? null, { tools: TOOLS });
    case "tools/call": {
      const name = String((req.params?.name as string) ?? "");
      if (!name) return jsonRpcError(req.id ?? null, -32602, "Invalid params: tools/call requires a tool name");
      const rawArgs = req.params?.arguments;
      const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};
      try {
        const output = await dispatchTool(name, args, env);
        return jsonRpcResult(req.id ?? null, output as unknown as Record<string, unknown>);
      } catch (e) {
        const message = e instanceof Error ? e.message : "internal tool failure";
        if (isNotification) return new Response(null, { status: 202 });
        return jsonRpcError(req.id ?? null, -32603, "Internal error", { detail: message });
      }
    }
    default:
      return jsonRpcError(req.id ?? null, -32601, `Method not found: ${req.method}`);
  }
}

// ---------------------------------------------------------------------------
// Edge API routes
// ---------------------------------------------------------------------------
function ttlSeconds(env: Env): number {
  return toInt(env.CACHE_TTL_SECONDS, 60, 10, 3600);
}

async function readBodyOr413(request: Request): Promise<string | null> {
  const len = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) return null;
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return null;
  return raw;
}

async function pruneRetention(env: Env): Promise<void> {
  const days = toInt(env.TELEMETRY_RETENTION_DAYS, 30, 7, 365);
  const cutoff = Date.now() - days * 86_400_000;
  const guestCutoff = Date.now() - 90 * 86_400_000;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM telemetry WHERE ts < ?1").bind(cutoff),
    env.DB.prepare("DELETE FROM plc_links WHERE ts < ?1").bind(cutoff),
    env.DB.prepare("DELETE FROM speedtests WHERE ts < ?1").bind(cutoff),
    env.DB.prepare("DELETE FROM anomalies WHERE ts < ?1").bind(cutoff),
    env.DB.prepare("DELETE FROM audit_log WHERE ts < ?1").bind(cutoff),
    env.DB.prepare("DELETE FROM guest_requests WHERE ts < ?1").bind(guestCutoff),
  ]);
}

async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/health") {
    return Response.json({
      ok: true,
      service: "avanza-mcp-bridge",
      schema_version: toInt(env.SCHEMA_VERSION, 2, 1, 99),
      server_ts: Date.now(),
    }, { headers: securityHeaders({ "Cache-Control": "no-store" }) });
  }

  // Agent data-plane endpoints (HMAC-SHA256)
  if (path === "/api/ingest" && request.method === "POST") {
    const raw = await readBodyOr413(request);
    if (raw === null) return httpError(413, "payload_size", "body exceeds ingest cap");
    const auth = await authenticate(request, env, raw);
    if (!auth.ok) return auth.response;
    const stub = env.TELEMETRY.get(env.TELEMETRY.idFromName("global"));
    return await stub.fetch("https://do.internal/ingest", {
      method: "POST",
      body: raw,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (path === "/api/commands/pending" && request.method === "GET") {
    const auth = await authenticate(request, env, null);
    if (!auth.ok) return auth.response;
    const stub = env.COMMANDS.get(env.COMMANDS.idFromName("global"));
    return await stub.fetch(`https://do.internal/commands?${url.searchParams.toString()}`);
  }

  if (path === "/api/commands/ack" && request.method === "POST") {
    const raw = await readBodyOr413(request);
    if (raw === null) return httpError(413, "payload_size", "body exceeds ack cap");
    const auth = await authenticate(request, env, raw);
    if (!auth.ok) return auth.response;
    const stub = env.COMMANDS.get(env.COMMANDS.idFromName("global"));
    return await stub.fetch("https://do.internal/ack", {
      method: "POST",
      body: raw,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Dashboard / read-plane (edge-cached, optional read token)
  if (path === "/api/fleet/version" && request.method === "GET") {
    if (!dashboardAuthorized(request, env)) return httpError(401, "read_token", "invalid dashboard read token");
    return await cachedJson(request, ctx, ttlSeconds(env), async () => {
      const version = (await env.CACHE_KV.get("fleet/version")) ?? "unknown";
      let manifest: unknown = {};
      try { manifest = JSON.parse((await env.CACHE_KV.get("fleet/manifest")) ?? "{}"); } catch { manifest = {}; }
      return { ok: true, version, manifest };
    });
  }

  if (path === "/api/fleet/bundle/latest" && request.method === "GET") {
    if (!dashboardAuthorized(request, env)) return httpError(401, "read_token", "invalid dashboard read token");
    const obj = await env.FIRMWARE.get("fleet/latest.tar.gz");
    if (obj === null) return httpError(404, "no_bundle", "fleet bundle not uploaded yet");
    const headers = securityHeaders({
      "Content-Type": "application/gzip",
      "Content-Length": String(obj.size),
      "ETag": obj.httpEtag,
      "Cache-Control": "no-store",
    });
    return new Response(obj.body, { headers });
  }

  if (path === "/api/dashboard/telemetry" && request.method === "GET") {
    if (!dashboardAuthorized(request, env)) return httpError(401, "read_token", "invalid dashboard read token");
    return await cachedJson(request, ctx, ttlSeconds(env), async () => {
      const stub = env.TELEMETRY.get(env.TELEMETRY.idFromName("global"));
      const snapResp = await stub.fetch("https://do.internal/snapshot");
      const snapshot = (await snapResp.json()) as { devices?: unknown[] };
      const anomalies = await env.DB.prepare(
        "SELECT ts, device, kind, severity, detail FROM anomalies ORDER BY ts DESC LIMIT 20",
      ).all<Record<string, unknown>>();
      const speedtests = await env.DB.prepare(
        "SELECT ts, device, mbps, duration_ms FROM speedtests ORDER BY ts DESC LIMIT 20",
      ).all<Record<string, unknown>>();
      const plc = await env.DB.prepare(
        `SELECT device, peer_mac, tx_mbps, rx_mbps, MAX(ts) AS last_ts
         FROM plc_links WHERE ts > ?1 GROUP BY device, peer_mac`,
      ).bind(Date.now() - 6 * 3600_000).all<Record<string, unknown>>();
      const version = (await env.CACHE_KV.get("fleet/version")) ?? "unknown";
      return {
        ok: true,
        fleet_version: version,
        server_ts: Date.now(),
        devices: snapshot.devices ?? [],
        plc_links: plc.results ?? [],
        anomalies: anomalies.results ?? [],
        speedtests: speedtests.results ?? [],
      };
    });
  }

  if (path === "/api/ui/layout" && request.method === "GET") {
    if (!dashboardAuthorized(request, env)) return httpError(401, "read_token", "invalid dashboard read token");
    return await cachedJson(request, ctx, ttlSeconds(env), async () => ({
      ok: true,
      schema: "avanza.ui/1",
      revision: 2,
      title: "AVANZA Ecosystem Matrix",
      blocks: [
        {
          id: "fleet-health", type: "stat_grid", title: "Fleet Health",
          data: "/api/dashboard/telemetry",
          fields: ["devices", "mem_avail_kb", "conntrack", "plc_rx_mbps"],
        },
        {
          id: "device-table", type: "device_table", title: "Devices",
          data: "/api/dashboard/telemetry",
        },
        {
          id: "powerline", type: "topology_list", title: "Powerline Backhaul (HomePlug AV)",
          data: "/api/dashboard/telemetry", field: "plc_links",
        },
        {
          id: "anomalies", type: "feed", title: "Anomaly Stream",
          data: "/api/dashboard/telemetry", field: "anomalies",
        },
        {
          id: "speedtests", type: "bar_series", title: "Edge Throughput History",
          data: "/api/dashboard/telemetry", field: "speedtests",
        },
        {
          id: "fleet-version", type: "footer_chip", title: "GitOps Version",
          data: "/api/fleet/version",
        },
      ],
    }));
  }

  if (path === "/api/speedtest/payload" && request.method === "GET") {
    const obj = await env.FIRMWARE.get("speedtest/payload.bin");
    if (obj === null) return httpError(404, "no_payload", "speedtest payload not provisioned");
    return new Response(obj.body, {
      headers: securityHeaders({
        "Content-Type": "application/octet-stream",
        "Content-Length": String(obj.size),
        "Cache-Control": "public, s-maxage=3600",
      }),
    });
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { Allow: "GET, POST, OPTIONS" },
    });
  }

  return httpError(404, "route", `unknown API route ${path}`);
}

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/rpc") {
        if (request.method !== "POST") {
          return httpError(405, "method", "MCP endpoint requires POST (Streamable HTTP, application/json responses)");
        }
        if (rateLimited(clientIp(request))) return httpError(429, "rate_limited", "slow down");
        const raw = await readBodyOr413(request);
        if (raw === null) return httpError(413, "payload_size", "body exceeds RPC cap");
        const auth = await authenticate(request, env, raw);
        if (!auth.ok) return auth.response;
        return await handleRpc(request, env, raw);
      }
      if (url.pathname.startsWith("/api/")) {
        if (rateLimited(clientIp(request))) return httpError(429, "rate_limited", "slow down");
        return await handleApi(request, env, ctx);
      }
      return await env.ASSETS.fetch(request);
    } catch (e) {
      return httpError(500, "worker_error", e instanceof Error ? e.message : "unhandled worker failure");
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      try {
        const tel = env.TELEMETRY.get(env.TELEMETRY.idFromName("global"));
        await tel.fetch("https://do.internal/flush", { method: "POST" });
        const cmd = env.COMMANDS.get(env.COMMANDS.idFromName("global"));
        await cmd.fetch("https://do.internal/sweep", { method: "POST" });
        const now = new Date();
        if (now.getUTCHours() === 3 && now.getUTCMinutes() < 5) {
          await pruneRetention(env);
        }
      } catch {
        // cron is best-effort; DO alarms independently drive flush/sweep
      }
    })());
  },
};
