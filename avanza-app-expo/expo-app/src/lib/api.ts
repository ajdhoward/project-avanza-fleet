import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

const extra = (Constants.expoConfig?.extra ?? {}) as { orchUrl?: string };
export const ORCH_URL = (extra.orchUrl ?? process.env.EXPO_PUBLIC_ORCH_URL ?? "").replace(/\/$/, "");

const KEY_STORE = "avanza.app_control_key";

export async function getControlKey(): Promise<string> {
	let key = await SecureStore.getItemAsync(KEY_STORE).catch(() => null);
	if (!key) {
		key = process.env.EXPO_PUBLIC_APP_CONTROL_KEY ?? "";
		if (key) await SecureStore.setItemAsync(KEY_STORE, key).catch(() => {});
	}
	return key ?? "";
}

export async function setControlKey(key: string): Promise<void> {
	await SecureStore.setItemAsync(KEY_STORE, key);
}

async function authHeaders(): Promise<Record<string, string>> {
	const key = await getControlKey();
	return {
		"content-type": "application/json",
		"x-avanza-app-token": key,
	};
}

export interface DeviceRecord {
	ip: string;
	zone: "lan" | "media" | "iot" | "wan";
	hostname: string;
	lane: "priority" | "video" | "bulk" | "normal";
	lane_source: "static" | "worker" | "manual";
	last_seen: number;
	bytes_today: number;
	top_destinations: string[];
	temp_access_until: number;
	paused_until: number;
	privacy_grade: string;
}

export interface SpeedtestResult {
	down_kbps?: number;
	up_kbps?: number;
	latency_ms?: number;
	ts?: number;
	error?: string;
}

export interface FirmwareStatus {
	checked?: boolean;
	current?: string;
	latest?: string;
	update_available?: boolean;
	install_hint?: string;
}

export interface OutageState {
	state: string;
	detail: string;
	confidence: number;
	sources?: Record<string, unknown>;
	updated_at?: number;
}

export interface LaneDirective {
	ip: string;
	lane: DeviceRecord["lane"];
	dscp: string;
	ttl: number;
	reason?: string;
}

export async function fetchDevices(): Promise<DeviceRecord[]> {
	const res = await fetch(`${ORCH_URL}/api/devices`, { headers: await authHeaders() });
	if (!res.ok) throw new Error(`devices http ${res.status}`);
	const data = (await res.json()) as { devices?: DeviceRecord[] };
	return data.devices ?? [];
}

export async function fetchOutage(): Promise<OutageState | null> {
	try {
		const res = await fetch(`${ORCH_URL}/api/outage/status`);
		if (!res.ok) return null;
		return (await res.json()) as OutageState;
	} catch {
		return null;
	}
}

export async function setLane(ip: string, lane: DeviceRecord["lane"], ttl = 3600): Promise<LaneDirective | null> {
	const res = await fetch(`${ORCH_URL}/api/control/lane`, {
		method: "POST",
		headers: await authHeaders(),
		body: JSON.stringify({ ip, lane, ttl }),
	});
	if (!res.ok) return null;
	const data = (await res.json()) as { directive?: LaneDirective };
	return data.directive ?? null;
}

export async function grantTempAccess(deviceIp: string, phoneIp: string, ttl = 900): Promise<boolean> {
	const res = await fetch(`${ORCH_URL}/api/control/temp-access`, {
		method: "POST",
		headers: await authHeaders(),
		body: JSON.stringify({ device_ip: deviceIp, phone_ip: phoneIp, ttl }),
	});
	return res.ok;
}

export const PHONE_IP_KEY = "avanza.phone_lan_ip";

export async function getPhoneLanIp(): Promise<string> {
	const stored = await SecureStore.getItemAsync(PHONE_IP_KEY).catch(() => null);
	if (stored) return stored;
	return "192.168.10.22";
}

export async function setPhoneLanIp(ip: string): Promise<void> {
	await SecureStore.setItemAsync(PHONE_IP_KEY, ip);
}

export async function pauseDevice(ip: string, minutes = 60): Promise<boolean> {
	const res = await fetch(`${ORCH_URL}/api/control/pause`, {
		method: "POST",
		headers: await authHeaders(),
		body: JSON.stringify({ ip, minutes }),
	});
	return res.ok;
}

export async function resumeDevice(ip: string): Promise<boolean> {
	const res = await fetch(`${ORCH_URL}/api/control/pause`, {
		method: "POST",
		headers: await authHeaders(),
		body: JSON.stringify({ ip, resume: true }),
	});
	return res.ok;
}

export async function requestSpeedtest(): Promise<boolean> {
	const res = await fetch(`${ORCH_URL}/api/control/speedtest`, {
		method: "POST",
		headers: await authHeaders(),
		body: "{}",
	});
	return res.ok;
}

export async function getSpeedtest(): Promise<SpeedtestResult | null> {
	try {
		const res = await fetch(`${ORCH_URL}/api/speedtest`);
		if (!res.ok) return null;
		const data = (await res.json()) as SpeedtestResult;
		return data.error ? null : data;
	} catch {
		return null;
	}
}

export async function requestBackup(): Promise<boolean> {
	const res = await fetch(`${ORCH_URL}/api/control/backup`, {
		method: "POST",
		headers: await authHeaders(),
		body: "{}",
	});
	return res.ok;
}

export async function getFirmwareStatus(): Promise<FirmwareStatus | null> {
	try {
		const res = await fetch(`${ORCH_URL}/api/firmware/status`);
		if (!res.ok) return null;
		return (await res.json()) as FirmwareStatus;
	} catch {
		return null;
	}
}

export async function registerPushToken(): Promise<string | null> {
	try {
		if (Platform.OS === "android") {
			await Notifications.setNotificationChannelAsync("outages", {
				name: "Outage alerts",
				importance: Notifications.AndroidImportance.HIGH,
				vibrationPattern: [0, 250, 250, 250],
				lightColor: "#22c55e",
			});
		}
		const status = await Notifications.getPermissionsAsync();
		if (status.status !== "granted") {
			const req = await Notifications.requestPermissionsAsync();
			if (req.status !== "granted") return null;
		}
		const token = (await Notifications.getExpoPushTokenAsync()).data;
		await fetch(`${ORCH_URL}/api/control/push-register`, {
			method: "POST",
			headers: await authHeaders(),
			body: JSON.stringify({ token }),
		});
		return token;
	} catch {
		return null;
	}
}

export function sduiManifestUrl(stream = true): string {
	return `${ORCH_URL}/sdui/manifest${stream ? "?stream=1" : ""}`;
}
