import { AvanzaState } from "./state_do";
import { runOutageScan } from "./outage_oracle";
import {
	fetchDO,
	LANE_DSCP,
	type FleetVersionToken,
	type DeviceRecord,
	type Env,
	type IngestResponse,
	type Lane,
	type LaneDirective,
	type TelemetryPayload,
} from "./types";

import { buildWeeklyReport } from "./weekly_report";
import { handleMcp } from "./mcp_server";

export { AvanzaState };

export async function scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
	if (event.cron === "0 7 * * 1") ctx.waitUntil(buildWeeklyReport(env));
	else ctx.waitUntil(runOutageScan(env));
}

const REPLAY_WINDOW_S = 300;
const DIGEST_CAP = 64;
const AI_BATCH_CAP = 12;
const DIRECTIVE_TTL_S = 900;

type FlowClass =
	| "realtime"
	| "streaming-video"
	| "bulk-transfer"
	| "background-telemetry"
	| "local-discovery"
	| "system"
	| "unknown";

interface ClassVerdict {
	class: FlowClass;
	lane: Lane;
	confidence: number;
	reason: string;
}

const CLASS_LANE: Record<FlowClass, Lane> = {
	realtime: "priority",
	"streaming-video": "video",
	"bulk-transfer": "bulk",
	"background-telemetry": "bulk",
	"local-discovery": "normal",
	system: "normal",
	unknown: "normal",
};

function deterministicClassify(
	proto: string,
	dportRaw: string,
	conns: number,
	bytes: number,
): ClassVerdict | null {
	const dport = Number.parseInt(dportRaw, 10);
	if (Number.isNaN(dport)) {
		if (proto === "icmp")
			return verdict("system", 0.9, "icmp control traffic");
		return null;
	}
	const v = (c: FlowClass, conf: number, reason: string): ClassVerdict => verdict(c, conf, reason);

	if (proto === "udp" && (dport === 3478 || dport === 3479 || dport === 3480))
		return v("realtime", 0.95, "STUN/TURN media path (voice/game realtime)");
	if (proto === "udp" && dport >= 27000 && dport <= 27100)
		return v("realtime", 0.9, "Steam in-game UDP");
	if (dport === 3074) return v("realtime", 0.9, "Xbox Live / GFW (3074)");
	if (proto === "udp" && (dport === 4380 || dport === 27015 || dport === 27016))
		return v("realtime", 0.85, "game server query/in-game port");
	if (dport === 5223 || dport === 5228 || dport === 5229 || dport === 5230)
		return v("background-telemetry", 0.9, "mobile push channel (APNs/FCM)");
	if (dport === 1900) return v("local-discovery", 0.95, "SSDP/UPnP discovery");
	if (dport === 5353) return v("local-discovery", 0.95, "mDNS reflection lane");
	if (dport === 8008 || dport === 8009 || dport === 8060 || dport === 7000 || dport === 7100)
		return v("streaming-video", 0.9, "cast protocol (Chromecast/Roku/AirPlay)");
	if (dport === 123) return v("system", 0.98, "NTP");
	if (dport === 53 || dport === 853) return v("system", 0.98, "DNS/DoT resolver");
	if (dport === 27031 || dport === 27036)
		return v("bulk-transfer", 0.85, "Steam content download");
	if ((dport === 443 || dport === 80) && bytes > 40_000_000 && conns <= 4)
		return v("streaming-video", 0.6, "high-volume low-conn HTTPS (video CDN profile)");
	if (dport === 443 || dport === 80) return null;
	return null;
}

function verdict(c: FlowClass, confidence: number, reason: string): ClassVerdict {
	return { class: c, lane: CLASS_LANE[c], confidence, reason };
}

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json",
			"access-control-allow-origin": "*",
			"access-control-allow-headers": "*",
			"access-control-allow-methods": "GET,POST,OPTIONS",
			...extraHeaders,
		},
	});
}

function timingSafeEqualStr(a: string, b: string): boolean {
	const enc = new TextEncoder();
	const ba = enc.encode(a);
	const bb = enc.encode(b);
	if (ba.length !== bb.length) return false;
	let diff = 0;
	for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
	return diff === 0;
}

async function verifyAgentAuth(request: Request, body: string, env: Env): Promise<boolean> {
	const sigHeader = request.headers.get("x-avanza-signature");
	if (sigHeader) {
		const parts = Object.fromEntries(
			sigHeader.split(",").map((kv) => kv.split("=") as [string, string]),
		);
		const t = Number.parseInt(parts.t, 10);
		const v1 = parts.v1;
		if (!t || !v1) return false;
		const now = Math.floor(Date.now() / 1000);
		if (Math.abs(now - t) > REPLAY_WINDOW_S) return false;
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(env.AGENT_HMAC_KEY),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`));
		const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
		return timingSafeEqualStr(hex, v1);
	}
	const token = request.headers.get("x-avanza-token");
	return !!token && timingSafeEqualStr(token, env.AGENT_HMAC_KEY);
}

function verifyAppAuth(request: Request, env: Env): boolean {
	const token = request.headers.get("x-avanza-app-token") || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
	return !!token && timingSafeEqualStr(token, env.APP_CONTROL_KEY);
}

function validPayload(p: unknown): p is TelemetryPayload {
	const t = p as TelemetryPayload;
	return (
		!!t &&
		t.v === 1 &&
		typeof t.device === "string" &&
		typeof t.ts === "number" &&
		Array.isArray(t.digest) &&
		Array.isArray(t.events)
	);
}

function getStateDO(env: Env, device: string) {
	return env.AVANZA_STATE.idFromName(device || env.AVANZA_DEVICE || "avanza-router");
}

async function doFetch(
	env: Env,
	device: string,
	path: string,
	body?: unknown,
): Promise<any> {
	const id = getStateDO(env, device);
	const res = await fetchDO(id, `https://avanza-state${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return res.json();
}

interface AmbiguousFlow {
	key: string;
	proto: string;
	dst: string;
	dport: string;
	conns: number;
	bytes: number;
}

async function classifyAmbiguousBatch(
	env: Env,
	flows: AmbiguousFlow[],
): Promise<Map<string, ClassVerdict>> {
	const out = new Map<string, ClassVerdict>();
	const misses: AmbiguousFlow[] = [];

	for (const f of flows) {
		const cached = await env.AVANZA_KV.get<ClassVerdict>(`cls:${f.key}`, "json");
		if (cached && typeof cached.class === "string") out.set(f.key, cached);
		else misses.push(f);
	}

	const batch = misses.slice(0, AI_BATCH_CAP);
	if (batch.length === 0) return out;

	const lines = batch
		.map(
			(f, i) =>
				`${i + 1}. proto=${f.proto} dst=${f.dst} dport=${f.dport} conns=${f.conns} bytes=${f.bytes}`,
		)
		.join("\n");

	try {
		const raw = await env.AI.run(env.AI_MODEL as "@cf/meta/llama-3.2-3b-instruct", {
			messages: [
				{
					role: "system",
					content:
						"You are a network flow classifier for a home router QoS engine. Respond ONLY with a JSON array. Each element: {\"i\":<number>,\"class\":\"realtime|streaming-video|bulk-transfer|background-telemetry|system|unknown\",\"confidence\":0..1,\"reason\":\"<6 words\"}. Classify by destination address owner and traffic profile. No prose, no code fences.",
				},
				{ role: "user", content: `Classify these aggregated flows:\n${lines}` },
			],
			max_tokens: 400,
			temperature: 0,
		});
		const text = typeof raw === "string" ? raw : ((raw as { response?: string }).response ?? "");
		const cleaned = text.replace(/```(?:json)?/g, "").trim();
		const parsed = JSON.parse(cleaned) as Array<{
			i: number;
			class: FlowClass;
			confidence: number;
			reason: string;
		}>;
		for (const item of parsed) {
			const flow = batch[item.i - 1];
			if (!flow || !(item.class in CLASS_LANE)) continue;
			const v: ClassVerdict = {
				class: item.class,
				lane: CLASS_LANE[item.class],
				confidence: Math.min(Math.max(item.confidence || 0.5, 0), 1),
				reason: String(item.reason || "ai-classified").slice(0, 60),
			};
			out.set(flow.key, v);
			await env.AVANZA_KV.put(`cls:${flow.key}`, JSON.stringify(v), {
				expirationTtl: 86400,
			});
		}
	} catch (err) {
		console.error("ai classification failed", err);
	}
	return out;
}

function privacyGrade(dev: DeviceRecord): string {
	const dstCount = dev.top_destinations.length;
	if (dev.zone === "iot" && dstCount > 5) return "D";
	if (dstCount > 6) return "C";
	if (dstCount > 3) return "B";
	return "A";
}

async function handleIngest(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const raw = await request.text();
	if (raw.length > 65536) return jsonResponse({ ok: false, error: "payload too large" }, 413);
	if (!(await verifyAgentAuth(request, raw, env)))
		return jsonResponse({ ok: false, error: "unauthorized" }, 401);

	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		return jsonResponse({ ok: false, error: "invalid json" }, 400);
	}
	if (!validPayload(payload))
		return jsonResponse({ ok: false, error: "schema mismatch" }, 422);

	const device = payload.device;
	payload.digest = payload.digest.slice(0, DIGEST_CAP);

	const doAck = await doFetch(env, device, "/ingest", payload);
	const snapshot = await doFetch(env, device, "/snapshot");
	const devices: DeviceRecord[] = snapshot?.devices ?? [];
	const deviceByIp = new Map(devices.map((d) => [d.ip, d]));
	const overrides: Record<string, Lane> = snapshot?.manual_overrides ?? {};

	const hostBytes = new Map<string, { total: number; byLane: Map<Lane, number>; reasons: Map<Lane, string> }>();
	const ambiguous: AmbiguousFlow[] = [];
	const seenKeys = new Set<string>();

	for (const entry of payload.digest) {
		if (!entry.src || !entry.src.startsWith("192.168.")) continue;
		let v = deterministicClassify(entry.proto, String(entry.dport), entry.conns || 0, entry.bytes || 0);
		if (!v) {
			const key = `${entry.proto}:${entry.dst}:${entry.dport}`;
			if (!seenKeys.has(key)) {
				seenKeys.add(key);
				ambiguous.push({ key, proto: entry.proto, dst: entry.dst, dport: String(entry.dport), conns: entry.conns || 0, bytes: entry.bytes || 0 });
			}
			v = null;
		}
		if (!v) continue;
		let h = hostBytes.get(entry.src);
		if (!h) {
			h = { total: 0, byLane: new Map(), reasons: new Map() };
			hostBytes.set(entry.src, h);
		}
		h.total += entry.bytes || 0;
		h.byLane.set(v.lane, (h.byLane.get(v.lane) || 0) + (entry.bytes || 1));
		if (!h.reasons.has(v.lane)) h.reasons.set(v.lane, v.reason);
	}

	const aiVerdicts =
		ambiguous.length > 0 ? await classifyAmbiguousBatch(env, ambiguous) : new Map<string, ClassVerdict>();
	for (const entry of payload.digest) {
		if (!entry.src || !entry.src.startsWith("192.168.")) continue;
		const key = `${entry.proto}:${entry.dst}:${entry.dport}`;
		const v = aiVerdicts.get(key);
		if (!v) continue;
		let h = hostBytes.get(entry.src);
		if (!h) {
			h = { total: 0, byLane: new Map(), reasons: new Map() };
			hostBytes.set(entry.src, h);
		}
		h.total += entry.bytes || 0;
		h.byLane.set(v.lane, (h.byLane.get(v.lane) || 0) + (entry.bytes || 0));
		if (!h.reasons.has(v.lane)) h.reasons.set(v.lane, v.reason);
	}

	const directives: LaneDirective[] = [];
	for (const [ip, h] of hostBytes) {
		let lane: Lane = "normal";
		let best = -1;
		let reason = "insufficient signal";
		for (const [l, b] of h.byLane) {
			if (l !== "normal" && b > best) {
				best = b;
				lane = l;
				reason = h.reasons.get(l) || "dominant flow class";
			}
		}
		if (overrides[ip]) {
			lane = overrides[ip];
			reason = "manual override";
		}
		const known = deviceByIp.get(ip);
		if (known && known.lane === lane && known.lane_source !== "static") continue;
		directives.push({
			ip,
			lane,
			dscp: LANE_DSCP[lane],
			ttl: DIRECTIVE_TTL_S,
			reason,
		});
	}
	const capped = directives.slice(0, 16);

	ctx.waitUntil(
		(async () => {
			for (const d of capped) {
				await doFetch(env, device, "/override-lane", { ip: d.ip, lane: d.lane, ttl: 0 });
			}
			for (const ip of hostBytes.keys()) {
				const dev = deviceByIp.get(ip);
				if (dev) {
					const grade = privacyGrade(dev);
					if (grade !== dev.privacy_grade)
						await doFetch(env, device, "/record-privacy", { ip, grade });
				}
			}
		})(),
	);

	const outageRaw = await env.AVANZA_KV.get<{ state: string; detail: string }>(
		"outage:current",
		"json",
	);

	let versionToken: { token: string; sha256?: string } | null = null;
	const fleetVer = await env.AVANZA_KV.get<FleetVersionToken>("fleet:config:version", "json");
	if (fleetVer?.version) {
		const side = payload.role === "secondary" ? fleetVer.secondary : fleetVer.primary;
		versionToken = { token: fleetVer.version, sha256: side?.sha256 };
	}

	if (payload.speedtest && typeof payload.speedtest === "object") {
		await env.AVANZA_KV.put("speedtest:latest", JSON.stringify(payload.speedtest), {
			expirationTtl: 30 * 24 * 3600,
		});
	}
	if (typeof payload.backup_b64 === "string" && payload.backup_b64.length > 64) {
		const meta = { ts: Date.now(), device, bytes: payload.backup_b64.length };
		if (env.AVANZA_R2) {
			const bin = Uint8Array.from(atob(payload.backup_b64), (c) => c.charCodeAt(0));
			await env.AVANZA_R2.put("backups/latest.tar.gz", bin, {
				httpMetadata: { contentType: "application/gzip" },
				customMetadata: { ts: String(meta.ts), device },
			});
			await env.AVANZA_KV.put("backup:meta", JSON.stringify({ ...meta, store: "r2" }));
		} else {
			await env.AVANZA_KV.put("backup:latest", JSON.stringify({ ...meta, b64: payload.backup_b64 }));
		}
	}

	const response: IngestResponse = {
		ok: true,
		device,
		server_ts: Math.floor(Date.now() / 1000),
		directives: capped,
		temp_access: doAck?.pending_temp_access ?? [],
		actions: doAck?.pending_actions ?? [],
		outage: {
			state: outageRaw?.state ?? "UNKNOWN",
			detail: outageRaw?.detail ?? "oracle has not run yet",
		},
		config: { interval: 60, digest_limit: DIGEST_CAP, version: versionToken },
	};
	return jsonResponse(response);
}

function buildSduiProgram(snapshot: any, outage: any, qos: any): string {
	const lines: string[] = [];
	const devRows: string[] = [];
	let n = 0;
	const devices: DeviceRecord[] = snapshot?.devices ?? [];
	const zones: Record<string, string[]> = { Management: [], "Media / Streaming": [], "Smart Home IoT": [] };
	for (const d of devices) {
		n += 1;
		const id = `d${n}`;
		devRows.push(
			`${id} = DeviceRow("${d.hostname || d.ip}", "${d.ip}", "${d.lane}", "${d.privacy_grade}")`,
		);
		const bucket =
			d.zone === "lan" ? "Management" : d.zone === "media" ? "Media / Streaming" : d.zone === "iot" ? "Smart Home IoT" : null;
		if (bucket) zones[bucket].push(id);
	}
	lines.push("root = AvanzaDashboard([banner, tiles, zones])");
	lines.push(
		`banner = OutageBanner("${outage?.state ?? "HEALTHY"}", "${String(outage?.detail ?? "").replace(/"/g, "'")}", ${outage?.confidence ?? 0.9})`,
	);
	lines.push("tiles = StatRow([t1, t2, t3])");
	lines.push(`t1 = StatTile("Priority lane", "${qos?.priority_pkts ?? 0}", "pkts")`);
	lines.push(`t2 = StatTile("Video lane", "${qos?.video_pkts ?? 0}", "pkts")`);
	lines.push(`t3 = StatTile("Lateral blocked", "${qos?.lateral_blocked_total ?? 0}", "pkts")`);
	lines.push("zones = ZoneGrid([z1, z2, z3])");
	lines.push(`z1 = ZoneCard("Management", "192.168.10.0/24", [${zones["Management"].join(", ")}])`);
	lines.push(`z2 = ZoneCard("Media / Streaming", "192.168.20.0/24", [${zones["Media / Streaming"].join(", ")}])`);
	lines.push(`z3 = ZoneCard("Smart Home IoT", "192.168.30.0/24", [${zones["Smart Home IoT"].join(", ")}])`);
	lines.push(...devRows);
	return lines.join("\n") + "\n";
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "OPTIONS") return jsonResponse({}, 204);

		if (url.pathname === "/mcp" || url.pathname === "/mcp/") return handleMcp(request, env);

		try {
			if (url.pathname === "/health" && request.method === "GET") {
				return jsonResponse({ ok: true, ts: Date.now(), worker: "avanza-edge-orchestrator" });
			}

			if (url.pathname === "/api/telemetry/ingest" && request.method === "POST") {
				return await handleIngest(request, env, ctx);
			}

			if (url.pathname === "/api/control/lane" && request.method === "POST") {
				if (!verifyAppAuth(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
				const body = (await request.json()) as { ip: string; lane: Lane; ttl?: number };
				if (!body?.ip || !(body.lane in LANE_DSCP))
					return jsonResponse({ ok: false, error: "ip + valid lane required" }, 400);
				await doFetch(env, env.AVANZA_DEVICE, "/override-lane", {
					ip: body.ip,
					lane: body.lane,
					ttl: body.ttl ?? 3600,
				});
				return jsonResponse({
					ok: true,
					directive: {
						ip: body.ip,
						lane: body.lane,
						dscp: LANE_DSCP[body.lane],
						ttl: body.ttl ?? 3600,
						reason: "manual override via app",
					},
					note: "agent materializes as nft set element on next ingest cycle (<=60s)",
				});
			}

			if (url.pathname === "/api/control/temp-access" && request.method === "POST") {
				if (!verifyAppAuth(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
				const body = (await request.json()) as { device_ip: string; phone_ip: string; ttl?: number };
				if (!body?.device_ip || !body?.phone_ip)
					return jsonResponse({ ok: false, error: "device_ip + phone_ip required" }, 400);
				const res = await doFetch(env, env.AVANZA_DEVICE, "/queue-temp-access", {
					phone_ip: body.phone_ip,
					device_ip: body.device_ip,
					ttl: Math.min(body.ttl ?? 900, 3600),
				});
				return jsonResponse({
					ok: true,
					queued: res,
					note: "delivered on next agent ingest; agent snapshots config, adds scoped UCI ACCEPT rule, arms 10-min rollback",
				});
			}

			if (url.pathname === "/api/control/register" && request.method === "POST") {
				if (!verifyAppAuth(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
				const body = (await request.json()) as { ip: string; hostname?: string; os?: string };
				if (!body?.ip) return jsonResponse({ ok: false, error: "ip required" }, 400);
				const res = await doFetch(env, env.AVANZA_DEVICE, "/register-device", body);
				return jsonResponse({ ok: true, registry: res });
			}

			if (url.pathname === "/api/control/push-register" && request.method === "POST") {
				if (!verifyAppAuth(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
				const body = (await request.json()) as { token: string };
				if (!body?.token) return jsonResponse({ ok: false, error: "token required" }, 400);
				const tokens = (await env.AVANZA_KV.get<string[]>("push:devices", "json")) ?? [];
				const next = [...new Set([...tokens, body.token])].slice(-100);
				await env.AVANZA_KV.put("push:devices", JSON.stringify(next));
				return jsonResponse({ ok: true, registered: next.length });
			}

			if (url.pathname === "/api/control/pause" && request.method === "POST") {
				if (!verifyAppAuth(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
				const body = (await request.json()) as { ip: string; minutes?: number; resume?: boolean };
				if (!body?.ip) return jsonResponse({ ok: false, error: "ip required" }, 400);
				const action = body.resume
					? { type: "resume" as const, ip: body.ip }
					: {
							type: "pause" as const,
							ip: body.ip,
							until: (body.minutes ?? 0) > 0 ? Math.floor(Date.now() / 1000) + body.minutes! * 60 : 0,
						};
				const res = await doFetch(env, env.AVANZA_DEVICE, "/queue-action", action);
				return jsonResponse({
					ok: true,
					queued: res,
					note: body.resume
						? "REJECT rule removed on next agent cycle"
						: "snapshot-first UCI REJECT rule armed on next agent cycle; auto-expires at until",
				});
			}

			if (url.pathname === "/api/control/speedtest" && request.method === "POST") {
				if (!verifyAppAuth(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
				const res = await doFetch(env, env.AVANZA_DEVICE, "/queue-action", { type: "speedtest" });
				return jsonResponse({ ok: true, queued: res, note: "result appears via GET /api/speedtest after next ingest" });
			}

			if (url.pathname === "/api/control/backup" && request.method === "POST") {
				if (!verifyAppAuth(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
				const res = await doFetch(env, env.AVANZA_DEVICE, "/queue-action", { type: "backup" });
				return jsonResponse({ ok: true, queued: res, note: "tar.gz of /etc/config arrives base64-encoded on next ingest" });
			}

			if (url.pathname === "/api/control/restore" && request.method === "POST") {
				if (!verifyAppAuth(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
				const backup = await env.AVANZA_KV.get<{ b64?: string; ts?: number }>("backup:latest", "json");
				if (!backup?.b64) return jsonResponse({ ok: false, error: "no cloud backup stored yet" }, 404);
				const res = await doFetch(env, env.AVANZA_DEVICE, "/queue-action", { type: "restore", b64: backup.b64 });
				return jsonResponse({ ok: true, queued: res, backup_ts: backup.ts ?? 0, note: "agent snapshots, extracts, reloads, arms rollback" });
			}

			if (url.pathname === "/api/speedtest" && request.method === "GET") {
				const cur = await env.AVANZA_KV.get("speedtest:latest", "json");
				return jsonResponse(cur ?? { error: "no speedtest recorded yet" });
			}

			if (url.pathname === "/api/backup" && request.method === "GET") {
				if (!verifyAppAuth(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
				if (env.AVANZA_R2) {
					const obj = await env.AVANZA_R2.get("backups/latest.tar.gz");
					if (obj)
						return new Response(obj.body, {
							headers: {
								"content-type": "application/gzip",
								"content-disposition": 'attachment; filename="avanza-config-backup.tar.gz"',
								"x-avanza-backup-ts": obj.customMetadata?.ts ?? "",
							},
						});
				}
				const cur = await env.AVANZA_KV.get("backup:latest", "json");
				if (!cur) return jsonResponse({ ok: false, error: "no backup stored yet" }, 404);
				return jsonResponse(cur);
			}

			if (url.pathname === "/api/firmware/status" && request.method === "GET") {
				const cur = await env.AVANZA_KV.get("firmware:status", "json");
				return jsonResponse(cur ?? { checked: false, note: "oracle has not run a firmware check yet" });
			}

			if (url.pathname === "/api/devices" && request.method === "GET") {
				if (!verifyAppAuth(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
				const snapshot = await doFetch(env, env.AVANZA_DEVICE, "/snapshot");
				return jsonResponse({ ok: true, devices: snapshot?.devices ?? [], at: Date.now() });
			}

			if (url.pathname === "/api/outage/status" && request.method === "GET") {
				// L6 cache layer: badge/app/extension polls are served from the edge cache
				const edge = caches.default;
				const key = new Request(url.origin + url.pathname, { method: "GET" });
				const hit = await edge.match(key);
				if (hit) return hit;
				const cur = await env.AVANZA_KV.get("outage:current", "json");
				const res = jsonResponse(cur ?? { state: "UNKNOWN", detail: "oracle has not run yet" }, 200, {
					"cache-control": "s-maxage=60",
				});
				ctx.waitUntil(edge.put(key, res.clone()));
				return res;
			}

			if (url.pathname === "/api/outage/scan" && request.method === "POST") {
				if (!verifyAppAuth(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
				ctx.waitUntil(runOutageScan(env));
				return jsonResponse({ ok: true, started: true });
			}

			if (url.pathname === "/sdui/manifest" && request.method === "GET") {
				const snapshot = await doFetch(env, env.AVANZA_DEVICE, "/snapshot");
				const outage = await env.AVANZA_KV.get("outage:current", "json");
				const program = buildSduiProgram(snapshot, outage, snapshot?.qos ?? {});
				if (url.searchParams.get("stream") === "1") {
					const encoder = new TextEncoder();
					const stream = new ReadableStream({
						async start(controller) {
							for (const line of program.split("\n")) {
								controller.enqueue(encoder.encode(line + "\n"));
								await new Promise((r) => setTimeout(r, 16));
							}
							controller.close();
						},
					});
					return new Response(stream, {
						headers: {
							"content-type": "text/plain; charset=utf-8",
							"x-openui-lang": "1",
							"access-control-allow-origin": "*",
						},
					});
				}
				const edge = caches.default;
				const key = new Request(url.origin + url.pathname, { method: "GET" });
				const hit = await edge.match(key);
				if (hit) return hit;
				const res = new Response(program, {
					headers: {
						"content-type": "text/plain; charset=utf-8",
						"x-openui-lang": "1",
						"access-control-allow-origin": "*",
						"cache-control": "s-maxage=15",
					},
				});
				ctx.waitUntil(edge.put(key, res.clone()));
				return res;
			}

			if (url.pathname === "/api/fleet/bundle" && request.method === "GET") {
				const tokenHdr = request.headers.get("x-avanza-token");
				if (!tokenHdr || !timingSafeEqualStr(tokenHdr, env.AGENT_HMAC_KEY))
					return jsonResponse({ ok: false, error: "unauthorized" }, 401);
				const device = url.searchParams.get("device") === "secondary" ? "secondary" : "primary";
				const fleetVer = await env.AVANZA_KV.get<FleetVersionToken>("fleet:config:version", "json");
				if (!env.AVANZA_R2 || !fleetVer?.version)
					return jsonResponse({ ok: false, error: "no fleet bundle published" }, 404);
				const obj =
					(await env.AVANZA_R2.get(`fleet/${fleetVer.version}/${device}.tar.gz`)) ??
					(await env.AVANZA_R2.get(`fleet/latest/${device}.tar.gz`));
				if (!obj) return jsonResponse({ ok: false, error: "bundle not found in R2" }, 404);
				return new Response(obj.body, {
					headers: {
						"content-type": "application/gzip",
						"x-avanza-fleet-version": fleetVer.version,
						"x-avanza-sha256": (device === "secondary" ? fleetVer.secondary?.sha256 : fleetVer.primary?.sha256) ?? "",
					},
				});
			}

			if (url.pathname === "/api/fleet/syslog" && request.method === "POST") {
				const raw = await request.text();
				if (raw.length > 262144) return jsonResponse({ ok: false, error: "too large" }, 413);
				if (!(await verifyAgentAuth(request, raw, env)))
					return jsonResponse({ ok: false, error: "unauthorized" }, 401);
				let body: { device?: string; lines?: string[] };
				try {
					body = JSON.parse(raw);
				} catch {
					return jsonResponse({ ok: false, error: "invalid json" }, 400);
				}
				const lines = Array.isArray(body.lines) ? body.lines.slice(0, 200) : [];
				if (!env.AVANZA_HISTORY) return jsonResponse({ ok: true, stored: 0, note: "D1 not bound" });
				const device = String(body.device ?? "unknown").slice(0, 32);
				const ts = Math.floor(Date.now() / 1000);
				try {
					const stmt = env.AVANZA_HISTORY.prepare(
						"INSERT INTO fleet_syslog (ts, device, line) VALUES (?1, ?2, ?3)",
					);
					const batch = lines.map((l) => stmt.bind(ts, device, String(l).slice(0, 400)));
					await env.AVANZA_HISTORY.batch(batch);
				} catch (err) {
					console.warn("syslog D1 insert failed", String(err).slice(0, 60));
				}
				return jsonResponse({ ok: true, stored: lines.length });
			}

			if (url.pathname === "/status" && request.method === "GET") {
				const edge = caches.default;
				const key = new Request(url.origin + "/status", { method: "GET" });
				const hit = await edge.match(key);
				if (hit) return hit;
				const cur = await env.AVANZA_KV.get<Record<string, unknown>>("outage:current", "json");
				const spd = await env.AVANZA_KV.get<Record<string, unknown>>("speedtest:latest", "json");
				const state = String(cur?.state ?? "UNKNOWN");
				const tone = state === "HEALTHY" ? "#22c55e" : state === "UNKNOWN" ? "#8aa0bf" : "#f59e0b";
				const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60"><title>Avanza network status</title><style>body{background:#060913;color:#e6edf7;font:15px/1.6 ui-sans-serif,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.c{max-width:520px;padding:30px;border:1px solid #1c2a45;border-radius:18px;background:#0d1526}.s{font-size:26px;font-weight:900;letter-spacing:.12em;color:${tone}}.d{color:#8aa0bf;font-size:13px;margin-top:10px}.m{color:#475569;font-size:11px;margin-top:18px;font-family:ui-monospace,monospace}</style></head><body><div class="c"><div class="s">${state.replace(/_/g, " ")}</div><div class="d">${String(cur?.detail ?? "oracle has not run yet").replace(/</g, "&lt;").slice(0, 220)}</div><div class="m">avanza edge oracle · updated ${cur?.updated_at ? new Date(Number(cur.updated_at)).toISOString() : "n/a"}${spd?.down_kbps ? ` · last speedtest ↓${(Number(spd.down_kbps) / 1000).toFixed(0)}/↑${(Number(spd.up_kbps) / 1000).toFixed(0)} Mb/s` : ""}</div></div></body></html>`;
				const res = new Response(page, {
					headers: { "content-type": "text/html; charset=utf-8", "cache-control": "s-maxage=60", "access-control-allow-origin": "*" },
				});
				ctx.waitUntil(edge.put(key, res.clone()));
				return res;
			}

			if (url.pathname === "/guest" && request.method === "GET") {
				const sitekey = env.TURNSTILE_SITEKEY ?? "";
				const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Avanza · request internet access</title><style>body{background:#060913;color:#e6edf7;font:14px/1.6 ui-sans-serif,system-ui,sans-serif;display:flex;justify-content:center;padding:32px 16px;margin:0}.c{width:100%;max-width:420px;background:#0d1526;border:1px solid #1c2a45;border-radius:16px;padding:22px}h1{font-size:14px;letter-spacing:.2em;margin:0 0 6px}p{color:#8aa0bf;font-size:12.5px}input,textarea{width:100%;box-sizing:border-box;background:#0a1120;border:1px solid #1c2a45;border-radius:9px;color:#e6edf7;padding:10px;font:13px ui-monospace,monospace;margin:6px 0 12px}button{width:100%;padding:12px;border-radius:10px;border:1px solid rgba(34,197,94,.6);background:#0a1120;color:#22c55e;font-weight:900;font-size:12px;letter-spacing:.08em;cursor:pointer}#msg{margin-top:12px;font-size:12px;font-family:ui-monospace,monospace;color:#8aa0bf}</style><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer><\/script></head><body><div class="c"><h1>REQUEST INTERNET ACCESS</h1><p>Paused or blocked on the Avanza network? Send a request — the owner approves it from their phone. (Turnstile-protected, free, no tracking.)</p><form id="f"><label style="font-size:10px;color:#64748b;letter-spacing:.15em">DEVICE IP (shown in your Wi-Fi settings)</label><input name="ip" required pattern="192\\.168\\.[0-9]+\\.[0-9]+" placeholder="192.168.20.41"><label style="font-size:10px;color:#64748b;letter-spacing:.15em">REASON (optional)</label><textarea name="reason" rows="2" placeholder="Homework finished!"></textarea>${sitekey ? `<div class="cf-turnstile" data-sitekey="${sitekey}"></div>` : '<p style="color:#f59e0b">Turnstile sitekey not configured — requests will be rejected.</p>'}<button type="submit">SEND REQUEST</button></form><div id="msg"></div></div><script>document.getElementById("f").addEventListener("submit",async(e)=>{e.preventDefault();const m=document.getElementById("msg");const fd=new FormData(e.target);const token=(window.turnstile&&turnstile.getResponse())||"";try{const r=await fetch("/api/guest/request",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ip:fd.get("ip"),reason:fd.get("reason")||"",token})});const j=await r.json();m.textContent=j.ok?"✓ request sent — the owner will see it on their phone":("✗ "+(j.error||"failed"));}catch(err){m.textContent="✗ "+err}});<\/script></body></html>`;
				return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
			}

			if (url.pathname === "/api/guest/request" && request.method === "POST") {
				const body = (await request.json()) as { ip?: string; reason?: string; token?: string };
				if (!body?.ip || !/^192\.168\.\d{1,3}\.\d{1,3}$/.test(body.ip))
					return jsonResponse({ ok: false, error: "valid LAN ip required" }, 400);
				if (env.TURNSTILE_SECRET) {
					if (!body.token) return jsonResponse({ ok: false, error: "turnstile challenge required" }, 403);
					const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
						method: "POST",
						headers: { "content-type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: body.token }),
					});
					const vj = (await verify.json()) as { success?: boolean };
					if (!vj.success) return jsonResponse({ ok: false, error: "turnstile verification failed" }, 403);
				} else {
					return jsonResponse({ ok: false, error: "guest portal not configured" }, 501);
				}
				const existing = (await env.AVANZA_KV.get<Array<Record<string, unknown>>>("guest:requests", "json")) ?? [];
				const next = [...existing.filter((r) => r.ip !== body.ip), { ip: body.ip, reason: String(body.reason ?? "").slice(0, 140), ts: Date.now() }].slice(-20);
				await env.AVANZA_KV.put("guest:requests", JSON.stringify(next));
				return jsonResponse({ ok: true, queued: next.length });
			}

			if (url.pathname === "/api/guest/requests" && request.method === "GET") {
				if (!verifyAppAuth(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
				const list = (await env.AVANZA_KV.get("guest:requests", "json")) ?? [];
				return jsonResponse({ ok: true, requests: list });
			}

			if (url.pathname === "/api/guest/approve" && request.method === "POST") {
				if (!verifyAppAuth(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
				const body = (await request.json()) as { ip?: string };
				if (!body?.ip) return jsonResponse({ ok: false, error: "ip required" }, 400);
				const existing = (await env.AVANZA_KV.get<Array<Record<string, unknown>>>("guest:requests", "json")) ?? [];
				await env.AVANZA_KV.put("guest:requests", JSON.stringify(existing.filter((r) => r.ip !== body.ip)));
				const res = await doFetch(env, env.AVANZA_DEVICE, "/queue-action", { type: "resume", ip: body.ip });
				return jsonResponse({ ok: true, unblock_queued: res });
			}

			if (url.pathname === "/report/latest" && request.method === "GET") {
				if (env.AVANZA_R2) {
					const obj = await env.AVANZA_R2.get("reports/latest.html");
					if (obj)
						return new Response(obj.body, {
							headers: { "content-type": "text/html; charset=utf-8", "cache-control": "s-maxage=300" },
						});
				}
				const kvReport = await env.AVANZA_KV.get("report:latest_html");
				if (kvReport) return new Response(kvReport, { headers: { "content-type": "text/html; charset=utf-8" } });
				return jsonResponse({ ok: false, error: "no report generated yet (cron: Mondays 07:00 UTC)" }, 404);
			}

			if (url.pathname === "/api/history/summary" && request.method === "GET") {
				if (!verifyAppAuth(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
				if (!env.AVANZA_HISTORY) return jsonResponse({ ok: false, error: "D1 not bound" }, 501);
				const since = Math.floor((Date.now() - 7 * 24 * 3600 * 1000) / 1000);
				const res = await env.AVANZA_HISTORY.prepare(
					"SELECT COUNT(*) AS buckets, COALESCE(SUM(ingests),0) AS ingests, COALESCE(SUM(wan_down_30m),0) AS wan_downs, COALESCE(MAX(devices),0) AS devices FROM telemetry_history WHERE ts > ?1",
				)
					.bind(since)
					.first();
				return jsonResponse({ ok: true, window_days: 7, ...(res ?? {}) });
			}

			if (url.pathname === "/api/history/outages" && request.method === "GET") {
				if (!verifyAppAuth(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
				if (!env.AVANZA_HISTORY) return jsonResponse({ ok: false, error: "D1 not bound" }, 501);
				const since = Math.floor((Date.now() - 30 * 24 * 3600 * 1000) / 1000);
				const res = await env.AVANZA_HISTORY.prepare(
					"SELECT ts, state, detail, confidence FROM outage_events WHERE ts > ?1 ORDER BY ts DESC LIMIT 100",
				)
					.bind(since)
					.all();
				return jsonResponse({ ok: true, events: res.results ?? [] });
			}

			if (env.ASSETS) {
				return env.ASSETS.fetch(request);
			}
			return jsonResponse({ ok: false, error: "not found" }, 404);
		} catch (err) {
			console.error("worker error", err);
			return jsonResponse({ ok: false, error: "internal" }, 500);
		}
	},
} satisfies ExportedHandler<Env>;
