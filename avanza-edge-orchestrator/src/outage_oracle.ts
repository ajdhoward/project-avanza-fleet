import { fetchDO, type Env, type OutageState } from "./types";

interface RssFeedConfig {
	url: string;
	label: string;
}

interface OutageSourcesConfig {
	feeds: RssFeedConfig[];
	keywords: string[];
	fresh_hours: number;
}

const DEFAULT_SOURCES: OutageSourcesConfig = {
	feeds: [],
	keywords: [
		"outage",
		"down",
		"degraded",
		"incident",
		"maintenance",
		"network issue",
		"service disruption",
	],
	fresh_hours: 2,
};

const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;
const RADAR_DEGRADED_BELOW = 6.0;
const IODA_DEGRADED_BELOW = 60;
const RSS_HITS_THRESHOLD = 2;

function findKeyDeep(obj: unknown, key: string): unknown {
	if (obj === null || typeof obj !== "object") return undefined;
	if (Array.isArray(obj)) {
		for (const item of obj) {
			const found = findKeyDeep(item, key);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	const rec = obj as Record<string, unknown>;
	if (rec[key] !== undefined) return rec[key];
	for (const v of Object.values(rec)) {
		const found = findKeyDeep(v, key);
		if (found !== undefined) return found;
	}
	return undefined;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms = 8000): Promise<Response> {
	return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

async function fetchRadar(env: Env): Promise<{ score: number | null; label: string }> {
	if (!env.RADAR_API_TOKEN) return { score: null, label: "radar: no token" };
	try {
		const region = env.RADAR_REGION || "US-WA";
		const res = await fetchWithTimeout(
			`https://api.cloudflare.com/client/v4/radar/internet_quality/score?location=${encodeURIComponent(region)}&format=json`,
			{ headers: { Authorization: `Bearer ${env.RADAR_API_TOKEN}` } },
		);
		if (!res.ok) return { score: null, label: `radar: http ${res.status}` };
		const data: unknown = await res.json();
		const raw = findKeyDeep(data, "internetQualityScore") ?? findKeyDeep(data, "score");
		const score = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? ""));
		return {
			score: Number.isFinite(score) ? score : null,
			label: `radar(${region}): ${Number.isFinite(score) ? score.toFixed(2) : "n/a"}`,
		};
	} catch (err) {
		return { score: null, label: `radar: error ${String(err).slice(0, 60)}` };
	}
}

async function fetchIoda(env: Env): Promise<{ score: number | null; label: string }> {
	if (!env.IODA_API_URL) return { score: null, label: "ioda: not configured" };
	try {
		const res = await fetchWithTimeout(env.IODA_API_URL, {});
		if (!res.ok) return { score: null, label: `ioda: http ${res.status}` };
		const data: unknown = await res.json();
		const raw =
			findKeyDeep(data, "visibility") ?? findKeyDeep(data, "infodex") ?? findKeyDeep(data, "value");
		const score = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? ""));
		return {
			score: Number.isFinite(score) ? score : null,
			label: `ioda: ${Number.isFinite(score) ? score.toFixed(1) : "n/a"}`,
		};
	} catch (err) {
		return { score: null, label: `ioda: error ${String(err).slice(0, 60)}` };
	}
}

async function fetchRssSignals(env: Env): Promise<{ hits: number; titles: string[]; label: string }> {
	let cfg: OutageSourcesConfig = DEFAULT_SOURCES;
	try {
		const stored = await env.AVANZA_KV.get<OutageSourcesConfig>("config:outage_sources", "json");
		if (stored && Array.isArray(stored.feeds)) cfg = { ...DEFAULT_SOURCES, ...stored };
	} catch {
		/* defaults */
	}
	if (cfg.feeds.length === 0) return { hits: 0, titles: [], label: "rss: no feeds configured" };

	const freshCutoff = Date.now() - cfg.fresh_hours * 3600 * 1000;
	let hits = 0;
	const titles: string[] = [];

	for (const feed of cfg.feeds.slice(0, 5)) {
		try {
			const res = await fetchWithTimeout(feed.url, {});
			if (!res.ok) continue;
			const xml = await res.text();
			const items = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/g) ?? [];
			for (const item of items.slice(0, 25)) {
				const title = (item.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? "")
					.replace(/<!\[CDATA\[|\]\]>/g, "")
					.trim();
				const dateStr =
					item.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/)?.[1] ??
					item.match(/<updated[^>]*>([\s\S]*?)<\/updated>/)?.[1] ??
					item.match(/<dc:date[^>]*>([\s\S]*?)<\/dc:date>/)?.[1];
				const ts = dateStr ? Date.parse(dateStr.trim()) : NaN;
				const fresh = Number.isNaN(ts) ? true : ts >= freshCutoff;
				const matched = cfg.keywords.some((k) => title.toLowerCase().includes(k));
				if (fresh && matched && title) {
					hits += 1;
					titles.push(`${feed.label}: ${title.slice(0, 90)}`);
				}
			}
		} catch {
			/* per-feed isolation */
		}
	}
	return { hits, titles: titles.slice(0, 6), label: `rss: ${hits} fresh keyword hits` };
}

async function fetchHealthCheck(env: Env): Promise<{ ok: boolean | null; label: string }> {
	if (!env.ACCOUNT_API_TOKEN || !env.HEALTH_ACCOUNT_ID || !env.HEALTH_CHECK_ID)
		return { ok: null, label: "healthcheck: not configured" };
	try {
		const res = await fetchWithTimeout(
			`https://api.cloudflare.com/client/v4/accounts/${env.HEALTH_ACCOUNT_ID}/healthchecks/${env.HEALTH_CHECK_ID}/status?page=1&per_page=1`,
			{ headers: { Authorization: `Bearer ${env.ACCOUNT_API_TOKEN}` } },
		);
		if (!res.ok) return { ok: null, label: `healthcheck: http ${res.status}` };
		const data: unknown = await res.json();
		const st = findKeyDeep(data, "health_status");
		const ok = st === "healthy" ? true : st === "unhealthy" ? false : null;
		return { ok, label: `healthcheck(tunnel-host): ${String(st ?? "n/a")}` };
	} catch (err) {
		return { ok: null, label: `healthcheck: error ${String(err).slice(0, 50)}` };
	}
}

async function getLocalEvidence(env: Env): Promise<{ downs30m: number; label: string }> {
	try {
		const id = env.AVANZA_STATE.idFromName(env.AVANZA_DEVICE || "avanza-router");
		const res = await fetchDO(id, "https://avanza-state/snapshot");
		const snap = (await res.json()) as { wan_down_last_30m?: number };
		const downs = snap?.wan_down_last_30m ?? 0;
		return { downs30m: downs, label: `local: ${downs} wan-down events in 30m` };
	} catch (err) {
		const day = new Date().toISOString().slice(0, 10);
		const stored = await env.AVANZA_KV.get<Array<{ ts: number; up: boolean }>>(
			`events:wan_down:${day}`,
			"json",
		);
		const cutoff = Date.now() / 1000 - 1800;
		const downs = (stored ?? []).filter((e) => !e.up && e.ts >= cutoff).length;
		return { downs30m: downs, label: `local(kv): ${downs} wan-down events in 30m (${String(err).slice(0, 40)})` };
	}
}

export async function runOutageScan(env: Env): Promise<OutageState> {
	const [radar, ioda, rss, local, hc] = await Promise.all([
		fetchRadar(env),
		fetchIoda(env),
		fetchRssSignals(env),
		getLocalEvidence(env),
		fetchHealthCheck(env),
	]);

	const regionalSignals =
		(radar.score !== null && radar.score < RADAR_DEGRADED_BELOW ? 1 : 0) +
		(ioda.score !== null && ioda.score < IODA_DEGRADED_BELOW ? 1 : 0) +
		(rss.hits >= RSS_HITS_THRESHOLD ? 1 : 0);
	const regional = regionalSignals > 0;
	const localDown = local.downs30m > 0;

	let state: OutageState["state"];
	let detail: string;
	let confidence: number;

	if ((localDown || hc.ok === false) && regional) {
		state = "REGIONAL_OUTAGE";
		detail = `WAN drops${hc.ok === false ? " + external probe down" : ""} coincide with ${regionalSignals} regional signal(s): ${[radar.label, ioda.label, rss.label, hc.label].join(" | ")}. Not a hardware fault.`;
		confidence = Math.min(0.55 + regionalSignals * 0.15 + (hc.ok === false ? 0.1 : 0), 0.97);
	} else if ((localDown || hc.ok === false) && !regional) {
		state = "LOCAL_FAULT_SUSPECTED";
		detail =
			hc.ok === false && !localDown
				? `External probe cannot reach the home network while router telemetry stays healthy → suspect tunnel/cloudflared or path issue, not ISP. ${hc.label} | ${radar.label}`
				: `${local.downs30m} WAN-down event(s) with all regional sources nominal. Suspect local line/hardware; agent rollback matrix engaged. ${radar.label} | ${rss.label} | ${hc.label}`;
		confidence = 0.6;
	} else if (!localDown && regional) {
		state = "REGIONAL_DEGRADATION_WATCH";
		detail = `Regional degradation detected but your link is stable (watch mode). ${[radar.label, ioda.label, rss.label].join(" | ")}`;
		confidence = Math.min(0.4 + regionalSignals * 0.15, 0.9);
	} else {
		state = "HEALTHY";
		detail = `All sources nominal. ${local.label} | ${radar.label} | ${rss.label}`;
		confidence = 0.9;
	}

	const outage: OutageState = {
		state,
		detail,
		confidence,
		sources: { radar: radar.label, ioda: ioda.label, rss: rss.label, local: local.label, healthcheck: hc.label, rss_titles: rss.titles },
		updated_at: Date.now(),
	};

	await env.AVANZA_KV.put("outage:current", JSON.stringify(outage));

	if (state !== "HEALTHY") {
		await env.AVANZA_KV.put(
			`outage:history:${Math.floor(Date.now() / 3600000)}`,
			JSON.stringify(outage),
			{ expirationTtl: 30 * 24 * 3600 },
		);
	}

	await notifyIfChanged(env, outage);
	await checkFirmware(env);
	return outage;
}

const ASU_VERSIONS_URL = "https://sysupgrade.openwrt.org/api/json/v1/versions.json";
const FW_TARGET = "ath79/generic";
const FW_PROFILE_HINT = "archer-c7-v5";
const FW_CHECK_INTERVAL_MS = 20 * 3600 * 1000;

async function checkFirmware(env: Env): Promise<void> {
	try {
		const lastRaw = await env.AVANZA_KV.get("firmware:checked_at");
		const last = lastRaw ? Number.parseInt(lastRaw, 10) : 0;
		if (Date.now() - last < FW_CHECK_INTERVAL_MS) return;
		await env.AVANZA_KV.put("firmware:checked_at", String(Date.now()));

		const res = await fetchWithTimeout(ASU_VERSIONS_URL, {}, 15000);
		if (!res.ok) {
			console.warn("firmware check: ASU http", res.status);
			return;
		}
		const data = (await res.json()) as Record<string, unknown>;
		const target = data[FW_TARGET] as Record<string, unknown> | undefined;
		if (!target) return;
		const profileKey = Object.keys(target).find((k) => k.toLowerCase().includes(FW_PROFILE_HINT));
		if (!profileKey) return;
		const raw = target[profileKey];
		const latestRaw =
			typeof raw === "string" ? raw : ((findKeyDeep(raw, "version") as string | undefined) ?? "");
		const latest = String(latestRaw).replace(/^OpenWrt\s*/i, "").replace(/^v/, "").trim();
		if (!latest) return;

		let current = "";
		try {
			const id = env.AVANZA_STATE.idFromName(env.AVANZA_DEVICE || "avanza-router");
			const snapRes = await fetchDO(id, "https://avanza-state/snapshot");
			const snap = (await snapRes.json()) as { openwrt_version?: string };
			current = (snap?.openwrt_version ?? "").replace(/^OpenWrt\s*/i, "").trim();
		} catch {
			/* current unknown — report latest only */
		}

		await env.AVANZA_KV.put(
			"firmware:status",
			JSON.stringify({
				checked: true,
				checked_at: Date.now(),
				target: FW_TARGET,
				profile: profileKey,
				current: current || "unknown",
				latest,
				update_available: !!current && current !== latest,
				install_hint: "ssh to router: owut check && owut upgrade   (attended sysupgrade; config kept with -c)",
			}),
		);
	} catch (err) {
		console.warn("firmware check failed:", String(err).slice(0, 80));
	}
}

async function notifyIfChanged(env: Env, outage: OutageState): Promise<void> {
	try {
		const prevState = await env.AVANZA_KV.get("outage:last_state");
		const lastNotifyRaw = await env.AVANZA_KV.get("outage:last_notify");
		const lastNotify = lastNotifyRaw ? Number.parseInt(lastNotifyRaw, 10) : 0;
		const changed = prevState !== outage.state;
		const cooledDown = Date.now() - lastNotify > NOTIFY_COOLDOWN_MS;
		await env.AVANZA_KV.put("outage:last_state", outage.state);
		if (changed && env.AVANZA_HISTORY) {
			try {
				await env.AVANZA_HISTORY.prepare(
					"INSERT INTO outage_events (ts, state, detail, confidence) VALUES (?1, ?2, ?3, ?4)",
				)
					.bind(Date.now(), outage.state, outage.detail, outage.confidence)
					.run();
			} catch {
				/* D1 optional */
			}
		}
		if (!changed || !cooledDown || outage.state === "HEALTHY") return;

		const title = `Avanza: ${outage.state.replace(/_/g, " ")}`;
		const body = outage.detail.slice(0, 180);
		await env.AVANZA_KV.put("outage:last_notify", String(Date.now()));

		const messages: string[] = [`${title}\n${body}`];

		if (env.EXPO_ACCESS_TOKEN) {
			try {
				const tokens = (await env.AVANZA_KV.get<string[]>("push:devices", "json")) ?? [];
				if (tokens.length > 0) {
					await fetchWithTimeout(
						"https://exp.host/--/api/v2/push/send",
						{
							method: "POST",
							headers: {
								Authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}`,
								"content-type": "application/json",
								"accept-encoding": "gzip, deflate",
							},
							body: JSON.stringify(
								tokens.slice(0, 100).map((to) => ({
									to,
									title,
									body,
									data: { state: outage.state },
									sound: "default",
									priority: "high",
								})),
							),
						},
						10000,
					);
					messages.push("expo push: sent");
				}
			} catch (err) {
				messages.push(`expo push failed: ${String(err).slice(0, 60)}`);
			}
		}

		if (env.TG_BOT_TOKEN && env.TG_CHAT_ID) {
			try {
				await fetchWithTimeout(
					`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: `${title}\n\n${body}` }),
					},
					10000,
				);
				messages.push("telegram: sent");
			} catch (err) {
				messages.push(`telegram failed: ${String(err).slice(0, 60)}`);
			}
		}
		console.log("outage notify:", messages.join(" | "));
	} catch (err) {
		console.error("notifyIfChanged failed", err);
	}
}

export async function scheduled(
	_event: ScheduledEvent,
	env: Env,
	ctx: ExecutionContext,
): Promise<void> {
	ctx.waitUntil(runOutageScan(env));
}
