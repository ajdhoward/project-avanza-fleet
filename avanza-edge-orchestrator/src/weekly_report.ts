import type { Env } from "./types";

function esc(s: string): string {
	return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface TelRow {
	ts: number;
	ingests: number;
	wan_down_30m: number;
	devices: number;
}

interface OutageRow {
	ts: number;
	state: string;
	detail: string;
}

async function d1All<T>(env: Env, sql: string, bind: number): Promise<T[]> {
	if (!env.AVANZA_HISTORY) return [];
	try {
		const res = await env.AVANZA_HISTORY.prepare(sql).bind(bind).all();
		return (res.results ?? []) as T[];
	} catch {
		return [];
	}
}

export async function buildWeeklyReport(env: Env): Promise<void> {
	const now = Date.now();
	const weekAgoSec = Math.floor((now - 7 * 24 * 3600 * 1000) / 1000);

	const [tel, outages] = await Promise.all([
		d1All<TelRow>(
			env,
			"SELECT ts, ingests, wan_down_30m, devices FROM telemetry_history WHERE ts > ?1 ORDER BY ts",
			weekAgoSec,
		),
		d1All<OutageRow>(
			env,
			"SELECT ts, state, detail FROM outage_events WHERE ts > ?1 ORDER BY ts DESC",
			weekAgoSec,
		),
	]);

	const registryRaw = await env.AVANZA_KV.get("devices:registry");
	let devices: Array<{ ip: string; hostname: string; zone: string; lane: string; bytes_today: number; privacy_grade: string }> = [];
	try {
		devices = registryRaw ? JSON.parse(registryRaw) : [];
	} catch {
		devices = [];
	}
	const speed = await env.AVANZA_KV.get("speedtest:latest", "json");
	const outage = await env.AVANZA_KV.get<{ state?: string; detail?: string }>("outage:current", "json");

	const ingests = tel.reduce((a, r) => a + (r.ingests ?? 0), 0);
	const wanDowns = tel.reduce((a, r) => a + (r.wan_down_30m ?? 0), 0);
	const topDevices = [...devices].sort((a, b) => (b.bytes_today ?? 0) - (a.bytes_today ?? 0)).slice(0, 8);
	const outageByState: Record<string, number> = {};
	for (const o of outages) outageByState[o.state] = (outageByState[o.state] ?? 0) + 1;

	const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Avanza weekly network report</title>
<style>body{background:#060913;color:#e6edf7;font:14px/1.6 ui-sans-serif,system-ui,sans-serif;margin:0;padding:28px}
main{max-width:760px;margin:0 auto}h1{font-size:17px;letter-spacing:.24em;color:#38bdf8}
h2{font-size:11px;letter-spacing:.2em;color:#64748b;margin:26px 0 8px;text-transform:uppercase}
.card{background:#0d1526;border:1px solid #1c2a45;border-radius:12px;padding:14px}
table{width:100%;border-collapse:collapse;font-size:12.5px}td,th{padding:6px 8px;border-bottom:1px solid #12203a;text-align:left}
th{color:#64748b;font-size:10px;letter-spacing:.12em;text-transform:uppercase}
.g{color:#22c55e}.v{color:#a78bfa}.a{color:#f59e0b}.r{color:#ef4444}.m{font-family:ui-monospace,monospace;font-size:11.5px;color:#8aa0bf}
.big{font-size:22px;font-weight:900}.foot{margin-top:30px;color:#475569;font-size:11px}</style></head><body><main>
<h1>AVANZA · WEEKLY NETWORK REPORT</h1>
<div class="m">generated ${new Date(now).toISOString()} · window: last 7 days · source: D1 telemetry_history + KV registry</div>
<h2>Headline</h2><div class="card">
<span class="big ${outage?.state === "HEALTHY" || !outage ? "g" : "a"}">${esc(outage?.state ?? "UNKNOWN")}</span>
<div class="m">${esc(outage?.detail ?? "oracle has not reported yet")}</div></div>
<h2>Reliability</h2><div class="card"><table>
<tr><th>metric</th><th>value</th></tr>
<tr><td>telemetry buckets recorded (15-min)</td><td class="m">${tel.length}</td></tr>
<tr><td>agent ingest cycles acknowledged</td><td class="m">${ingests}</td></tr>
<tr><td>WAN-down events observed</td><td class="m ${wanDowns > 0 ? "a" : "g"}">${wanDowns}</td></tr>
<tr><td>oracle state changes</td><td class="m">${Object.entries(outageByState).map(([k, v]) => `${k}×${v}`).join(" · ") || "none"}</td></tr>
</table></div>
<h2>Last router-side speed test</h2><div class="card">${
		speed && (speed as { down_kbps?: number }).down_kbps
			? `<span class="big g">↓ ${(((speed as any).down_kbps / 1000) as number).toFixed(1)} Mb/s</span> · <span class="big v">↑ ${(((speed as any).up_kbps / 1000) as number).toFixed(1)} Mb/s</span> · RTT ${(speed as any).latency_ms} ms <span class="m">(${new Date((speed as any).ts * 1000).toISOString()})</span>`
			: '<span class="m">no speed test recorded this week</span>'
	}</div>
<h2>Top devices by bytes (rolling day)</h2><div class="card"><table>
<tr><th>device</th><th>zone</th><th>lane</th><th>privacy</th><th>MB</th></tr>
${topDevices
	.map(
		(d) =>
			`<tr><td>${esc(d.hostname || d.ip)}</td><td class="m">${esc(d.zone)}</td><td class="m">${esc(d.lane)}</td><td class="m">${esc(d.privacy_grade)}</td><td class="m">${((d.bytes_today ?? 0) / 1e6).toFixed(0)}</td></tr>`,
	)
	.join("\n") || '<tr><td colspan="5" class="m">no devices recorded</td></tr>'}
</table></div>
<h2>Outage & fault log</h2><div class="card"><table>
<tr><th>when</th><th>state</th><th>detail</th></tr>
${outages
	.slice(0, 20)
	.map(
		(o) =>
			`<tr><td class="m">${new Date(o.ts * 1000).toISOString().slice(0, 16).replace("T", " ")}</td><td class="m ${o.state === "HEALTHY" ? "g" : "r"}">${esc(o.state)}</td><td class="m">${esc((o.detail ?? "").slice(0, 140))}</td></tr>`,
	)
	.join("\n") || '<tr><td colspan="3" class="m">quiet week — no state changes</td></tr>'}
</table></div>
<div class="foot">Project Avanza · rendered server-side by weekly_report.ts (no Browser Rendering needed) · stored in R2 reports/latest.html · retention: D1 90 days, R2 8 reports</div>
</main></body></html>`;

	if (env.AVANZA_R2) {
		try {
			const week = `week-${new Date(now).toISOString().slice(0, 10)}`;
			await env.AVANZA_R2.put("reports/latest.html", html, {
				httpMetadata: { contentType: "text/html; charset=utf-8" },
				customMetadata: { generated: String(now) },
			});
			await env.AVANZA_R2.put(`reports/${week}.html`, html, {
				httpMetadata: { contentType: "text/html; charset=utf-8" },
			});
			const listed = await env.AVANZA_R2.list({ prefix: "reports/week-" });
			const olds = listed.objects
				.map((o) => o.key)
				.sort()
				.slice(0, Math.max(0, listed.objects.length - 8));
			for (const key of olds) await env.AVANZA_R2.delete(key);
		} catch (err) {
			console.warn("report R2 store failed:", String(err).slice(0, 80));
		}
	} else {
		await env.AVANZA_KV.put("report:latest_html", html);
	}

	// retention: D1 90-day prune (cheap, once a week)
	if (env.AVANZA_HISTORY) {
		try {
			const cutoff = Math.floor((now - 90 * 24 * 3600 * 1000) / 1000);
			await env.AVANZA_HISTORY.batch([
				env.AVANZA_HISTORY.prepare("DELETE FROM telemetry_history WHERE ts < ?1").bind(cutoff),
				env.AVANZA_HISTORY.prepare("DELETE FROM outage_events WHERE ts < ?1").bind(cutoff),
			]);
		} catch {
			/* retention best-effort */
		}
	}

	if (env.TG_BOT_TOKEN && env.TG_CHAT_ID) {
		try {
			const link = env.PUBLIC_BASE ? `${env.PUBLIC_BASE.replace(/\/$/, "")}/report/latest` : "(PUBLIC_BASE unset — see R2 reports/latest.html)";
			await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					chat_id: env.TG_CHAT_ID,
					text: `📊 Avanza weekly report ready\nWAN-down events: ${wanDowns} · oracle changes: ${outages.length}\n${link}`,
					disable_web_page_preview: false,
				}),
				signal: AbortSignal.timeout(10000),
			});
		} catch {
			/* notification best-effort */
		}
	}
}
