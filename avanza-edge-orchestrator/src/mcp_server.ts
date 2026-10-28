/**
 * PROJECT AVANZA / avanza-mcp-bridge / MCP server on a Cloudflare Worker.
 * JSON-RPC 2.0, Streamable-HTTP style POST transport, zero dependencies.
 * Auth: X-Avanza-Signature: t=<unix>,v1=<hmac-sha256(MCP_HMAC_KEY, "t.body")>
 * with a 300 s replay window (same scheme as the router agents), or
 * X-Avanza-Token static fallback.
 * Tools: get_fleet_status, get_powerline_topology, set_device_override_lane,
 * evaluate_guest_unblock_requests.
 */

import type { Env } from "./types";

const MCP_PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "avanza-mcp", version: "2.0.0" };
const REPLAY_WINDOW_S = 300;

function mcpKey(env: Env): string {
	return env.MCP_HMAC_KEY || env.AGENT_HMAC_KEY;
}

type JsonRpcId = string | number | null;

const LANE_DSCP: Record<string, string> = {
	priority: "0x2e",
	video: "0x28",
	bulk: "0x08",
	normal: "0x00",
};

const TOOLS = [
	{
		name: "get_fleet_status",
		description:
			"Operational telemetry for the whole Avanza fleet: primary edge router (Archer C7 v5) and secondary headless L2 switch (TD-W8968 v3). Returns uptime, RAM, overlay, conntrack, WAN state, lane counters, device registry size, outage-oracle verdict, firmware status and GitOps convergence state.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "get_powerline_topology",
		description:
			"Powerline (HomePlug AV2) link telemetry parsed from non-resident plcstat probes on the primary: latest Tx/Rx PHY rates, attenuation in dB, a 48-sample ring history, and a derived link-quality grade with remediation advice.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "set_device_override_lane",
		description:
			"Inject an instant QoS lane override for a LAN device. The router materializes it as a timeout-scoped nft set element (DSCP EF/AF41/CS1 into CAKE tins) on its next 60 s heartbeat; no reboot, no config rewrite.",
		inputSchema: {
			type: "object",
			properties: {
				ip: { type: "string", description: "RFC1918 IPv4 of the device, e.g. 192.168.20.43" },
				lane: { type: "string", enum: ["priority", "video", "bulk", "normal"] },
				duration_secs: { type: "number", minimum: 60, maximum: 86400 },
			},
			required: ["ip", "lane", "duration_secs"],
			additionalProperties: false,
		},
	},
	{
		name: "evaluate_guest_unblock_requests",
		description:
			"Read Turnstile-protected unblock requests submitted via the public /guest portal, and optionally resolve them. Approved IPs are queued as parental resume actions on the router agent; denials are simply removed from the pending list.",
		inputSchema: {
			type: "object",
			properties: {
				approve: { type: "array", items: { type: "string" }, description: "IPs to approve (resume internet)" },
				deny: { type: "array", items: { type: "string" }, description: "IPs to deny (drop request)" },
			},
			additionalProperties: false,
		},
	},
];

function jsonrpc(id: JsonRpcId, result: unknown): Response {
	return jsonOut({ jsonrpc: "2.0", id, result });
}

function jsonrpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Response {
	return jsonOut({ jsonrpc: "2.0", id, error: { code, message, data } });
}

function jsonOut(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json",
			"access-control-allow-origin": "*",
			"access-control-allow-headers": "*",
			"access-control-allow-methods": "POST,GET,OPTIONS",
		},
	});
}

function toolResult(id: JsonRpcId, payload: unknown, isError = false): Response {
	return jsonrpc(id, {
		content: [{ type: "text", text: JSON.stringify(payload, null, 1) }],
		isError,
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

async function verify(request: Request, rawBody: string, env: Env): Promise<boolean> {
	const sig = request.headers.get("x-avanza-signature");
	if (sig) {
		const parts = Object.fromEntries(sig.split(",").map((kv) => kv.split("=") as [string, string]));
		const t = Number.parseInt(parts.t, 10);
		if (!t || !parts.v1) return false;
		if (Math.abs(Math.floor(Date.now() / 1000) - t) > REPLAY_WINDOW_S) return false;
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(mcpKey(env)),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`));
		const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
		return timingSafeEqualStr(hex, parts.v1);
	}
	const token = request.headers.get("x-avanza-token");
	return !!token && timingSafeEqualStr(token, mcpKey(env));
}

function doFetch(env: Env, device: string, path: string, body?: unknown): Promise<Response> {
	const id = env.AVANZA_STATE.idFromName(device);
	const f = (id as unknown as { fetch: (u: string, i?: RequestInit) => Promise<Response> }).fetch;
	return f.call(id, `https://avanza-state${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

function plcGrade(tx: number, atten: number): { grade: string; advice: string } {
	if (tx >= 150 && atten < 8) return { grade: "A", advice: "link excellent — keep topology" };
	if (tx >= 80 && atten < 12) return { grade: "B", advice: "good; avoid adding power strips on the pair" };
	if (tx >= 40) return { grade: "C", advice: "marginal — check phase/circuit, move adapter to wall socket" };
	return { grade: "D", advice: "poor — suspect cross-phase or noise source (LED dimmers, chargers); consider Ethernet run" };
}

async function toolGetFleetStatus(env: Env): Promise<unknown> {
	const primary = env.FLEET_PRIMARY || "avanza-router";
	const secondary = env.FLEET_SECONDARY || "avanza-switch";
	const [pSnap, sSnap, outage, firmware, speed] = await Promise.all([
		doFetch(env, primary, "/snapshot").then((r) => r.json()).catch(() => null),
		doFetch(env, secondary, "/snapshot").then((r) => r.json()).catch(() => null),
		env.AVANZA_KV.get("outage:current", "json").catch(() => null),
		env.AVANZA_KV.get("firmware:status", "json").catch(() => null),
		env.AVANZA_KV.get("speedtest:latest", "json").catch(() => null),
	]);
	const summarize = (snap: Record<string, any> | null) =>
		snap
			? {
					online: Date.now() - Number(snap.last_payload_at ?? 0) < 5 * 60 * 1000,
					openwrt: snap.openwrt_version || "unknown",
					role: snap.role || "unknown",
					fleet_config: snap.fleet ?? null,
					sys: snap.last_sys ?? null,
					devices: (snap.devices ?? []).length,
					ingests: snap.ingest_count ?? 0,
					wan_down_30m: snap.wan_down_last_30m ?? 0,
					last_seen: snap.last_payload_at ?? 0,
				}
			: { online: false, note: "no telemetry ever received" };
	return {
		primary: { device: primary, ...summarize(pSnap as Record<string, any> | null) },
		secondary: { device: secondary, ...summarize(sSnap as Record<string, any> | null) },
		outage_oracle: outage ?? { state: "UNKNOWN" },
		firmware: firmware ?? { checked: false },
		last_speedtest: speed ?? null,
		server_ts: Date.now(),
	};
}

async function toolGetPowerlineTopology(env: Env): Promise<unknown> {
	const primary = env.FLEET_PRIMARY || "avanza-router";
	const snap = (await doFetch(env, primary, "/snapshot")
		.then((r) => r.json())
		.catch(() => null)) as Record<string, any> | null;
	const history: Array<Record<string, any>> = snap?.plc_history ?? [];
	const latest = history.length ? history[history.length - 1] : null;
	if (!latest)
		return {
			available: false,
			reason: "no plcstat samples yet (open-plc-utils installed? PLC_ENABLED=1? PLC_IF correct?)",
		};
	const tx = Number.parseFloat(String(latest.tx_mbps ?? "0")) || 0;
	const rx = Number.parseFloat(String(latest.rx_mbps ?? "0")) || 0;
	const atten = Number.parseFloat(String(latest.atten_db ?? "0")) || 0;
	const g = plcGrade(tx, atten);
	return {
		available: true,
		interface: latest.iface ?? "?",
		latest: { tx_mbps: tx, rx_mbps: rx, attenuation_db: atten, ts: latest.ts },
		grade: g.grade,
		advice: g.advice,
		history_samples: history.length,
		history: history.slice(-24).map((h) => ({
			ts: h.ts,
			tx: Number.parseFloat(String(h.tx_mbps ?? "0")) || 0,
			rx: Number.parseFloat(String(h.rx_mbps ?? "0")) || 0,
			atten: Number.parseFloat(String(h.atten_db ?? "0")) || 0,
		})),
		trunk: "primary lan1 ⇄ PLC pair ⇄ secondary lan1 · VLAN 20 native + VLAN 40 tagged",
	};
}

async function toolSetDeviceOverrideLane(
	env: Env,
	args: Record<string, unknown>,
): Promise<unknown> {
	const ip = String(args.ip ?? "");
	const lane = String(args.lane ?? "");
	const duration = Number(args.duration_secs ?? 900);
	if (!/^192\.168\.\d{1,3}\.\d{1,3}$/.test(ip)) throw new Error("ip must be a 192.168.x.x LAN address");
	if (!(lane in LANE_DSCP)) throw new Error(`lane must be one of ${Object.keys(LANE_DSCP).join(", ")}`);
	if (!Number.isFinite(duration) || duration < 60 || duration > 86400)
		throw new Error("duration_secs must be 60..86400");
	const primary = env.FLEET_PRIMARY || "avanza-router";
	await doFetch(env, primary, "/override-lane", { ip, lane, ttl: Math.floor(duration) });
	return {
		queued: true,
		directive: { ip, lane, dscp: LANE_DSCP[lane], ttl: Math.floor(duration), reason: "mcp override" },
		router_command: `nft add element inet fw4 avanza_lane_${lane} { ${ip} timeout ${Math.floor(duration)}s }`,
		applies_within_secs: 60,
	};
}

async function toolEvaluateGuestUnblockRequests(
	env: Env,
	args: Record<string, unknown>,
): Promise<unknown> {
	const approve = Array.isArray(args.approve) ? args.approve.map(String) : [];
	const deny = Array.isArray(args.deny) ? args.deny.map(String) : [];
	const pending = (await env.AVANZA_KV.get<Array<Record<string, unknown>>>("guest:requests", "json")) ?? [];
	const approved: string[] = [];
	const denied: string[] = [];
	const primary = env.FLEET_PRIMARY || "avanza-router";
	for (const req of pending) {
		const ip = String(req.ip ?? "");
		if (approve.includes(ip)) {
			await doFetch(env, primary, "/queue-action", { type: "resume", ip });
			approved.push(ip);
		} else if (deny.includes(ip)) {
			denied.push(ip);
		}
	}
	const remaining = pending.filter((r) => !approved.includes(String(r.ip)) && !denied.includes(String(r.ip)));
	await env.AVANZA_KV.put("guest:requests", JSON.stringify(remaining));
	return { pending_before: pending.length, approved, denied, remaining };
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
	{
		const url = new URL(request.url);
		if (request.method === "OPTIONS") return jsonOut({}, 204);

		if (url.pathname === "/health") return jsonOut({ ok: true, server: SERVER_INFO.name });

		if (url.pathname !== "/mcp") return jsonOut({ error: "not found" }, 404);
		if (request.method !== "POST")
			return new Response("method not allowed — this server implements POST-only Streamable HTTP", {
				status: 405,
				headers: { allow: "POST, OPTIONS" },
			});

		const raw = await request.text();
		if (!(await verify(request, raw, env))) return jsonOut({ error: "unauthorized" }, 401);

		let msg: { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: Record<string, unknown> };
		try {
			msg = JSON.parse(raw);
		} catch {
			return jsonrpcError(null, -32700, "Parse error");
		}
		if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string")
			return jsonrpcError(msg.id ?? null, -32600, "Invalid Request");

		const id = msg.id ?? null;
		const isNotification = msg.id === undefined;

		try {
			switch (msg.method) {
				case "initialize":
					return jsonrpc(id, {
						protocolVersion: MCP_PROTOCOL_VERSION,
						capabilities: { tools: { listChanged: false } },
						serverInfo: SERVER_INFO,
					});
				case "notifications/initialized":
				case "notifications/cancelled":
					return new Response(null, { status: 202 });
				case "ping":
					return jsonrpc(id, {});
				case "tools/list":
					return jsonrpc(id, { tools: TOOLS });
				case "tools/call": {
					const name = String(msg.params?.name ?? "");
					const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
					switch (name) {
						case "get_fleet_status":
							return toolResult(id, await toolGetFleetStatus(env));
						case "get_powerline_topology":
							return toolResult(id, await toolGetPowerlineTopology(env));
						case "set_device_override_lane":
							return toolResult(id, await toolSetDeviceOverrideLane(env, args));
						case "evaluate_guest_unblock_requests":
							return toolResult(id, await toolEvaluateGuestUnblockRequests(env, args));
						default:
							return jsonrpcError(id, -32602, `Unknown tool: ${name}`);
					}
				}
				default:
					return jsonrpcError(id, -32601, `Method not found: ${msg.method}`);
			}
		} catch (err) {
			if (isNotification) return new Response(null, { status: 202 });
			return toolResult(id, { error: String((err as Error)?.message ?? err) }, true);
		}
	}
}
