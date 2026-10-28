export interface Env {
	AVANZA_KV: KVNamespace;
	AVANZA_STATE: DurableObjectNamespace;
	AVANZA_HISTORY?: D1Database;
	AVANZA_R2?: R2Bucket;
	AI: Ai;
	AGENT_HMAC_KEY: string;
	APP_CONTROL_KEY: string;
	EXPO_ACCESS_TOKEN?: string;
	RADAR_API_TOKEN?: string;
	IODA_API_URL?: string;
	TG_BOT_TOKEN?: string;
	TG_CHAT_ID?: string;
	ASSETS?: Fetcher;
	TURNSTILE_SITEKEY?: string;
	TURNSTILE_SECRET?: string;
	PUBLIC_BASE?: string;
	ACCOUNT_API_TOKEN?: string;
	HEALTH_ACCOUNT_ID?: string;
	HEALTH_CHECK_ID?: string;
	MCP_HMAC_KEY?: string;
	FLEET_PRIMARY?: string;
	FLEET_SECONDARY?: string;
	RADAR_REGION: string;
	AVANZA_DEVICE: string;
	FLUSH_INTERVAL_MIN: string;
	AI_MODEL: string;
}

export interface ConntrackEntry {
	proto: string;
	src: string;
	dst: string;
	dport: string;
	conns: number;
	bytes: number;
}

export interface PlcSample {
	tx_mbps?: string;
	rx_mbps?: string;
	atten_db?: string;
	iface?: string;
	raw?: string;
}

export interface WanEvent {
	ts: number;
	up: boolean;
}

export interface SpeedtestResult {
	down_kbps: number;
	up_kbps: number;
	latency_ms: number;
	ts: number;
	server?: string;
	error?: string;
}

export type AgentActionType = "speedtest" | "backup" | "restore" | "pause" | "resume";

export interface AgentAction {
	type: AgentActionType;
	ip?: string;
	until?: number;
	b64?: string;
	queued_at?: number;
}

export interface TelemetryPayload {
	v: number;
	device: string;
	ts: number;
	agent_version: string;
	wan: {
		up: boolean;
		proto: string;
		addr: string;
		uptime: number;
		rx_errors: number;
		tx_errors: number;
		carrier_changes: number;
	};
	sys: {
		load: number;
		mem_total: number;
		mem_free: number;
		uptime: number;
		overlay_pct: number;
		wifi_stations: number;
		openwrt_version?: string;
		mem_available?: number;
	};
	qos: {
		priority_pkts: number;
		video_pkts: number;
		bulk_pkts: number;
		lateral_blocked_total: number;
		lateral_blocked_delta: number;
	};
	tunnel: string;
	role?: string;
	plc?: PlcSample | null;
	fdb?: Record<string, number>;
	ct?: { count: number; max: number };
	fleet?: { config_version: string; apply_state: string };
	digest: ConntrackEntry[];
	events: WanEvent[];
	speedtest?: SpeedtestResult | null;
	backup_b64?: string | null;
	rollback: { pending: boolean; last: string };
}

export type Lane = "priority" | "video" | "bulk" | "normal";

export interface LaneDirective {
	ip: string;
	lane: Lane;
	dscp: string;
	ttl: number;
	reason: string;
}

export interface TempAccessDirective {
	phone_ip: string;
	device_ip: string;
	ttl: number;
}

export interface DeviceRecord {
	ip: string;
	zone: "lan" | "media" | "iot" | "guest" | "wan";
	hostname: string;
	lane: Lane;
	lane_source: "static" | "worker" | "manual";
	last_seen: number;
	bytes_today: number;
	top_destinations: string[];
	temp_access_until: number;
	paused_until: number;
	privacy_grade: string;
}

export interface OutageState {
	state:
		| "HEALTHY"
		| "REGIONAL_DEGRADATION_WATCH"
		| "REGIONAL_OUTAGE"
		| "LOCAL_FAULT_SUSPECTED";
	detail: string;
	confidence: number;
	sources: Record<string, unknown>;
	updated_at: number;
}

export interface IngestResponse {
	ok: boolean;
	device: string;
	server_ts: number;
	directives: LaneDirective[];
	temp_access: TempAccessDirective[];
	actions: AgentAction[];
	outage: { state: string; detail: string };
	config: {
		interval: number;
		digest_limit: number;
		version?: { token: string; sha256?: string } | null;
	};
}

export interface FleetVersionToken {
	version: string;
	primary?: { sha256?: string };
	secondary?: { sha256?: string };
}

export const LANE_DSCP: Record<Lane, string> = {
	priority: "0x2e",
	video: "0x28",
	bulk: "0x08",
	normal: "0x00",
};

export function fetchDO(
	id: DurableObjectId,
	url: string,
	init?: RequestInit,
): Promise<Response> {
	// id.fetch remains the wire protocol for DO request forwarding; current
	// workers-types only expose it via the RPC stub surface, hence the cast.
	return (id as unknown as { fetch: (u: string, i?: RequestInit) => Promise<Response> }).fetch(
		url,
		init,
	);
}
