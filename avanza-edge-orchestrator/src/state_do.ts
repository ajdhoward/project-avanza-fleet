import { DurableObject } from "cloudflare:workers";
import type {
	AgentAction,
	ConntrackEntry,
	DeviceRecord,
	Env,
	Lane,
	PlcSample,
	TelemetryPayload,
	TempAccessDirective,
	WanEvent,
} from "./types";

interface StateBuffers {
	devices: Record<string, DeviceRecord>;
	events: WanEvent[];
	digestRing: ConntrackEntry[][];
	pendingTempAccess: TempAccessDirective[];
	pendingActions: AgentAction[];
	openwrt_version: string;
	role: string;
	plcHistory: Array<PlcSample & { ts: number }>;
	fleet: { config_version: string; apply_state: string };
	last_sys: Record<string, number>;
	lastPayloadAt: number;
	ingestCount: number;
	lastFlushAt: number;
	manualOverrides: Record<string, { lane: Lane; until: number }>;
}

const RING_MAX = 24;
const EVENTS_MAX = 512;

function zoneOfIp(ip: string): DeviceRecord["zone"] {
	if (ip.startsWith("192.168.10.")) return "lan";
	if (ip.startsWith("192.168.20.")) return "media";
	if (ip.startsWith("192.168.30.")) return "iot";
	if (ip.startsWith("192.168.40.")) return "guest";
	return "wan";
}

export class AvanzaState extends DurableObject<Env> {
	private buffers: StateBuffers = {
		devices: {},
		events: [],
		digestRing: [],
		pendingTempAccess: [],
		pendingActions: [],
		openwrt_version: "",
		role: "",
		plcHistory: [],
		fleet: { config_version: "none", apply_state: "idle" },
		last_sys: {},
		lastPayloadAt: 0,
		ingestCount: 0,
		lastFlushAt: 0,
		manualOverrides: {},
	};

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		try {
			switch (url.pathname) {
				case "/ingest":
					return await this.onIngest(request);
				case "/snapshot":
					return json(this.snapshot());
				case "/queue-temp-access": {
					const body = (await request.json()) as TempAccessDirective;
					return json(this.queueTempAccess(body));
				}
				case "/drain-temp-access": {
					const drained = this.buffers.pendingTempAccess.splice(0);
					return json({ temp_access: drained });
				}
				case "/queue-action": {
					const body = (await request.json()) as AgentAction;
					return json(this.queueAction(body));
				}
				case "/override-lane": {
					const body = (await request.json()) as {
						ip: string;
						lane: Lane;
						ttl: number;
					};
					this.buffers.manualOverrides[body.ip] = {
						lane: body.lane,
						until: Date.now() + body.ttl * 1000,
					};
					this.setDeviceLane(body.ip, body.lane, "manual");
					return json({ ok: true });
				}
				case "/register-device": {
					const body = (await request.json()) as { ip: string; hostname?: string };
					if (!body?.ip) return json({ ok: false, error: "ip required" }, 400);
					const dev = this.touchDevice(body.ip, Date.now());
					if (body.hostname) dev.hostname = String(body.hostname).slice(0, 48);
					return json({ ok: true, ip: dev.ip, hostname: dev.hostname });
				}
				default:
					return new Response("not found", { status: 404 });
			}
		} catch (err) {
			return new Response(String(err), { status: 500 });
		}
	}

	private async onIngest(request: Request): Promise<Response> {
		const payload = (await request.json()) as TelemetryPayload;
		const now = Date.now();
		this.buffers.lastPayloadAt = payload.ts * 1000 || now;
		this.buffers.ingestCount += 1;
		if (payload.sys?.openwrt_version) this.buffers.openwrt_version = payload.sys.openwrt_version;
		if (payload.role) this.buffers.role = payload.role;
		if (payload.fleet) this.buffers.fleet = payload.fleet;
		this.buffers.last_sys = {
			mem_available: payload.sys?.mem_available ?? 0,
			ct_count: payload.ct?.count ?? 0,
			ct_max: payload.ct?.max ?? 0,
			overlay_pct: payload.sys?.overlay_pct ?? 0,
			load: payload.sys?.load ?? 0,
		};
		if (payload.plc && typeof payload.plc === "object") {
			this.buffers.plcHistory.push({ ts: payload.ts, ...payload.plc });
			if (this.buffers.plcHistory.length > 48) this.buffers.plcHistory.shift();
		}
		if (payload.fdb) {
			const fdb = payload.fdb as Record<string, number>;
			this.buffers.last_sys.fdb_total = Object.keys(fdb)
				.filter((k) => k !== "delta")
				.reduce((a, k) => a + (Number(fdb[k]) || 0), 0);
		}

		if (Array.isArray(payload.events)) {
			for (const ev of payload.events) {
				this.buffers.events.push(ev);
			}
			if (this.buffers.events.length > EVENTS_MAX) {
				this.buffers.events.splice(0, this.buffers.events.length - EVENTS_MAX);
			}
		}

		if (Array.isArray(payload.digest)) {
			this.buffers.digestRing.push(payload.digest);
			if (this.buffers.digestRing.length > RING_MAX) this.buffers.digestRing.shift();

			for (const entry of payload.digest) {
				const dev = this.touchDevice(entry.src, now);
				dev.bytes_today += entry.bytes || 0;
				if (entry.dst && !dev.top_destinations.includes(entry.dst)) {
					dev.top_destinations = [entry.dst, ...dev.top_destinations].slice(0, 8);
				}
			}
		}

		await this.ensureAlarm();
		await this.persistBestEffort();

		const pending = this.buffers.pendingTempAccess.splice(0);
		const actions = this.buffers.pendingActions.splice(0, 8);
		return json({
			ok: true,
			pending_temp_access: pending,
			pending_actions: actions,
			manual_overrides: this.activeOverrides(now),
			ack: { at: now, ingests: this.buffers.ingestCount },
		});
	}

	private touchDevice(ip: string, now: number): DeviceRecord {
		let dev = this.buffers.devices[ip];
		if (!dev) {
			dev = {
				ip,
				zone: zoneOfIp(ip),
				hostname: "",
				lane: "normal",
				lane_source: "static",
				last_seen: now,
				bytes_today: 0,
				top_destinations: [],
				temp_access_until: 0,
				paused_until: 0,
				privacy_grade: "?",
			};
			this.buffers.devices[ip] = dev;
		}
		dev.last_seen = now;
		return dev;
	}

	queueAction(body: AgentAction): { ok: boolean; queue_depth: number } {
		this.buffers.pendingActions = this.buffers.pendingActions.filter(
			(a) => !(a.type === body.type && a.ip === body.ip),
		);
		this.buffers.pendingActions.push({ ...body, queued_at: Date.now() });
		if (body.type === "pause" && body.ip) {
			const dev = this.touchDevice(body.ip, Date.now());
			dev.paused_until = body.until ?? 0;
		}
		if (body.type === "resume" && body.ip) {
			const dev = this.touchDevice(body.ip, Date.now());
			dev.paused_until = 0;
		}
		return { ok: true, queue_depth: this.buffers.pendingActions.length };
	}

	queueTempAccess(body: TempAccessDirective): { ok: boolean; queue_depth: number } {
		this.buffers.pendingTempAccess = this.buffers.pendingTempAccess.filter(
			(t) => t.device_ip !== body.device_ip,
		);
		this.buffers.pendingTempAccess.push({
			phone_ip: body.phone_ip,
			device_ip: body.device_ip,
			ttl: body.ttl || 900,
		});
		const dev = this.touchDevice(body.device_ip, Date.now());
		dev.temp_access_until = Date.now() + (body.ttl || 900) * 1000;
		return { ok: true, queue_depth: this.buffers.pendingTempAccess.length };
	}

	setDeviceLane(ip: string, lane: Lane, source: DeviceRecord["lane_source"]): void {
		const dev = this.touchDevice(ip, Date.now());
		dev.lane = lane;
		dev.lane_source = source;
	}

	setDevicePrivacy(ip: string, grade: string, hostname: string): void {
		const dev = this.touchDevice(ip, Date.now());
		if (grade) dev.privacy_grade = grade;
		if (hostname) dev.hostname = hostname;
	}

	private activeOverrides(now: number): Record<string, Lane> {
		const out: Record<string, Lane> = {};
		for (const [ip, ov] of Object.entries(this.buffers.manualOverrides)) {
			if (ov.until > now) out[ip] = ov.lane;
			else delete this.buffers.manualOverrides[ip];
		}
		return out;
	}

	snapshot() {
		const now = Date.now();
		return {
			devices: Object.values(this.buffers.devices),
			events: this.buffers.events.slice(-64),
			recent_digest: this.buffers.digestRing.slice(-4),
			manual_overrides: this.activeOverrides(now),
			openwrt_version: this.buffers.openwrt_version,
			role: this.buffers.role,
			plc_history: this.buffers.plcHistory,
			fleet: this.buffers.fleet,
			last_sys: this.buffers.last_sys,
			pending_actions: this.buffers.pendingActions.length,
			last_payload_at: this.buffers.lastPayloadAt,
			ingest_count: this.buffers.ingestCount,
			last_flush_at: this.buffers.lastFlushAt,
			wan_down_last_30m: this.buffers.events.filter(
				(e) => !e.up && now - e.ts * 1000 < 30 * 60 * 1000,
			).length,
		};
	}

	private async ensureAlarm(): Promise<void> {
		const existing = await this.ctx.storage.getAlarm();
		if (existing === null) {
			await this.ctx.storage.setAlarm(Date.now() + 15 * 60 * 1000);
		}
	}

	private async persistBestEffort(): Promise<void> {
		try {
			await this.ctx.storage.put("buffers", this.buffers);
		} catch {
			/* in-memory remains authoritative on free tier */
		}
	}

	async alarm(): Promise<void> {
		const env = this.env;
		const now = Date.now();
		const stamp = Math.floor(now / 900000) * 900000;
		const snap = this.snapshot();
		try {
			await env.AVANZA_KV.put(
				`tel:summary:${stamp}`,
				JSON.stringify({
					at: now,
					ingests: this.buffers.ingestCount,
					wan_down_30m: snap.wan_down_last_30m,
					devices: snap.devices.length,
					overrides: snap.manual_overrides,
				}),
				{ expirationTtl: 7 * 24 * 3600 },
			);
			await env.AVANZA_KV.put(`devices:registry`, JSON.stringify(snap.devices), {
				expirationTtl: 7 * 24 * 3600,
			});
			if (env.AVANZA_HISTORY) {
				try {
					await env.AVANZA_HISTORY.prepare(
						"INSERT INTO telemetry_history (ts, ingests, wan_down_30m, devices, last_payload_at) VALUES (?1, ?2, ?3, ?4, ?5)",
					)
						.bind(now, this.buffers.ingestCount, snap.wan_down_last_30m, snap.devices.length, this.buffers.lastPayloadAt)
						.run();
				} catch {
					/* D1 optional; KV remains authoritative */
				}
			}
			const downs = this.buffers.events.filter((e) => !e.up);
			if (downs.length > 0) {
				const day = new Date(now).toISOString().slice(0, 10);
				const key = `events:wan_down:${day}`;
				const prev = (await env.AVANZA_KV.get(key)) || "[]";
				let list: WanEvent[] = [];
				try {
					list = JSON.parse(prev) as WanEvent[];
				} catch {
					list = [];
				}
				const merged = [...list, ...downs].slice(-256);
				await env.AVANZA_KV.put(key, JSON.stringify(merged), {
					expirationTtl: 30 * 24 * 3600,
				});
			}
			this.buffers.lastFlushAt = now;
		} catch {
			/* KV quota or transient failure: retry on next alarm */
		}
		await this.ctx.storage.setAlarm(now + 15 * 60 * 1000);
	}
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
