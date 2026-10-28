"use strict";

const ALARM_NAME = "avanza-outage-poll";
const BADGE = {
	HEALTHY: { text: "OK", color: "#16a34a" },
	REGIONAL_DEGRADATION_WATCH: { text: "!", color: "#d97706" },
	REGIONAL_OUTAGE: { text: "ISP", color: "#dc2626" },
	LOCAL_FAULT_SUSPECTED: { text: "LAN", color: "#dc2626" },
	UNKNOWN: { text: "?", color: "#475569" },
};

async function getSettings() {
	const s = await chrome.storage.sync.get(["orchUrl"]);
	return { orchUrl: (s.orchUrl || "").replace(/\/$/, "") };
}

async function pollOutage() {
	const { orchUrl } = await getSettings();
	if (!orchUrl) {
		await chrome.action.setBadgeText({ text: "SET" });
		await chrome.action.setBadgeBackgroundColor({ color: "#475569" });
		return;
	}
	try {
		const res = await fetch(`${orchUrl}/api/outage/status`, { cache: "no-store" });
		const data = await res.json();
		const state = data.state || "UNKNOWN";
		const b = BADGE[state] || BADGE.UNKNOWN;
		await chrome.action.setBadgeText({ text: b.text });
		await chrome.action.setBadgeBackgroundColor({ color: b.color });
		await chrome.storage.local.set({ lastOutage: { ...data, fetched_at: Date.now() } });
		const prev = (await chrome.storage.local.get(["notifiedState"])).notifiedState;
		if (state !== prev) {
			await chrome.storage.local.set({ notifiedState: state });
			if (state !== "HEALTHY" && state !== "UNKNOWN" && prev) {
				chrome.notifications.create({
					type: "basic",
					iconUrl: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTIiIGZpbGw9IiMwNjA5MTMiLz48cGF0aCBkPSJNMzIgMTJMMTQgNDJoMzZ6IiBmaWxsPSIjMjJjNTVlIi8+PC9zdmc+",
					title: `Avanza: ${state.replace(/_/g, " ")}`,
					message: String(data.detail || "").slice(0, 200),
					priority: 2,
				});
			}
		}
	} catch (err) {
		await chrome.action.setBadgeText({ text: "ERR" });
		await chrome.action.setBadgeBackgroundColor({ color: "#475569" });
	}
}

chrome.runtime.onInstalled.addListener(async () => {
	await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 5 });
	pollOutage();
});

chrome.runtime.onStartup.addListener(async () => {
	await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 5 });
	pollOutage();
});

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === ALARM_NAME) pollOutage();
});
