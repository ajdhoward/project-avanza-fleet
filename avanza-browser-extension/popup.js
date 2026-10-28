"use strict";

let ORCH = "";
let TOKEN = "";

async function loadSettings() {
	const s = await chrome.storage.sync.get(["orchUrl", "appToken", "dashboardUrl"]);
	ORCH = (s.orchUrl || "").replace(/\/$/, "");
	TOKEN = s.appToken || "";
	document.getElementById("open-dash").addEventListener("click", (e) => {
		e.preventDefault();
		if (s.dashboardUrl) chrome.tabs.create({ url: s.dashboardUrl });
		else chrome.runtime.openOptionsPage();
	});
}

function headers(json = true) {
	const h = { "x-avanza-app-token": TOKEN };
	if (json) h["content-type"] = "application/json";
	return h;
}

async function api(path, opts = {}) {
	if (!ORCH || !TOKEN) throw new Error("set orchestrator URL + app token in options first");
	const res = await fetch(`${ORCH}${path}`, opts);
	if (!res.ok) throw new Error(`${path} → http ${res.status}`);
	return res.json();
}

async function showOutage() {
	const el = document.getElementById("o-state");
	const dt = document.getElementById("o-detail");
	try {
		const cached = (await chrome.storage.local.get(["lastOutage"])).lastOutage;
		if (cached) {
			el.textContent = (cached.state || "UNKNOWN").replace(/_/g, " ");
			el.style.color = cached.state === "HEALTHY" ? "#22c55e" : cached.state && cached.state !== "UNKNOWN" ? "#f59e0b" : "#8aa0bf";
			dt.textContent = (cached.detail || "").slice(0, 140);
		}
		const fresh = await api("/api/outage/status");
		el.textContent = (fresh.state || "UNKNOWN").replace(/_/g, " ");
		el.style.color = fresh.state === "HEALTHY" ? "#22c55e" : fresh.state && fresh.state !== "UNKNOWN" ? "#f59e0b" : "#8aa0bf";
		dt.textContent = (fresh.detail || "").slice(0, 140);
	} catch (err) {
		el.textContent = "OFFLINE";
		el.style.color = "#ef4444";
		dt.textContent = String(err.message || err);
	}
}

async function loadDevices() {
	const sel = document.getElementById("devices");
	try {
		const data = await api("/api/devices", { headers: headers(false) });
		sel.innerHTML = "";
		const devs = (data.devices || []).filter((d) => d.zone !== "wan");
		if (devs.length === 0) {
			sel.innerHTML = '<option value="">no devices seen yet</option>';
			return;
		}
		for (const d of devs) {
			const o = document.createElement("option");
			o.value = d.ip;
			o.textContent = `${d.hostname || d.ip} · ${d.zone} · ${d.lane}${d.paused_until > Date.now() ? " · ⏸" : ""}`;
			sel.appendChild(o);
		}
	} catch (err) {
		sel.innerHTML = `<option value="">${String(err.message || err).slice(0, 40)}</option>`;
	}
}

function result(msg, isError = false) {
	const r = document.getElementById("result");
	r.textContent = msg;
	r.style.color = isError ? "#f87171" : "#86efac";
}

async function bind() {
	const selIp = () => document.getElementById("devices").value;

	document.getElementById("boost").addEventListener("click", async () => {
		try {
			await api("/api/control/lane", { method: "POST", headers: headers(), body: JSON.stringify({ ip: selIp(), lane: "priority", ttl: 3600 }) });
			result(`boost queued: ${selIp()} → EF priority (1h) · applies ≤60s`);
			loadDevices();
		} catch (e) { result(String(e.message || e), true); }
	});

	document.getElementById("normal").addEventListener("click", async () => {
		try {
			await api("/api/control/lane", { method: "POST", headers: headers(), body: JSON.stringify({ ip: selIp(), lane: "normal", ttl: 60 }) });
			result(`lane cleared for ${selIp()} (back to static baseline)`);
			loadDevices();
		} catch (e) { result(String(e.message || e), true); }
	});

	document.getElementById("pause").addEventListener("click", async () => {
		if (!confirm(`Pause internet for ${selIp()} for 1 hour?`)) return;
		try {
			await api("/api/control/pause", { method: "POST", headers: headers(), body: JSON.stringify({ ip: selIp(), minutes: 60 }) });
			result(`pause queued: UCI REJECT rule, snapshot-first, auto-expire 60m`);
			loadDevices();
		} catch (e) { result(String(e.message || e), true); }
	});

	document.getElementById("resume").addEventListener("click", async () => {
		try {
			await api("/api/control/pause", { method: "POST", headers: headers(), body: JSON.stringify({ ip: selIp(), resume: true }) });
			result(`resume queued for ${selIp()}`);
			loadDevices();
		} catch (e) { result(String(e.message || e), true); }
	});

	document.getElementById("speed").addEventListener("click", async () => {
		try {
			const st = await api("/api/speedtest");
			if (st && st.down_kbps) {
				const when = st.ts ? new Date(st.ts * 1000).toLocaleString() : "";
				result(`last: ↓ ${(st.down_kbps / 1000).toFixed(1)} Mb/s · ↑ ${(st.up_kbps / 1000).toFixed(1)} Mb/s · ${st.latency_ms} ms (${when})`);
			}
			await api("/api/control/speedtest", { method: "POST", headers: headers(), body: "{}" });
			result(`new test queued — runs on router via uclient-fetch; click again in ~2 min for the result`);
		} catch (e) { result(String(e.message || e), true); }
	});

	document.getElementById("open-options").addEventListener("click", (e) => {
		e.preventDefault();
		chrome.runtime.openOptionsPage();
	});
}

document.addEventListener("DOMContentLoaded", async () => {
	await loadSettings();
	await bind();
	await showOutage();
	await loadDevices();
});
