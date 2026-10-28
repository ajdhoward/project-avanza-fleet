import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
	ActivityIndicator,
	Modal,
	Pressable,
	RefreshControl,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { Renderer } from "@openuidev/react-lang";
import { SafeAreaView } from "react-native-safe-area-context";
import { avanzaLibrary, onDeviceSelect } from "@/sdui/library";
import { useOpenUIStream } from "@/sdui/useOpenUIStream";
import {
	fetchDevices,
	fetchOutage,
	getPhoneLanIp,
	getSpeedtest,
	grantTempAccess,
	pauseDevice,
	requestSpeedtest,
	resumeDevice,
	setLane,
	type DeviceRecord,
	type OutageState,
	type SpeedtestResult,
} from "@/lib/api";

const LANES: DeviceRecord["lane"][] = ["priority", "video", "bulk", "normal"];
const LANE_COLORS: Record<string, string> = {
	priority: "#22c55e",
	video: "#a78bfa",
	bulk: "#f59e0b",
	normal: "#8aa0bf",
};
const ZONE_META: Record<DeviceRecord["zone"], { name: string; cidr: string }> = {
	lan: { name: "Management Zone", cidr: "192.168.10.0/24" },
	media: { name: "Media / Streaming Zone", cidr: "192.168.20.0/24" },
	iot: { name: "Smart Home IoT Zone", cidr: "192.168.30.0/24" },
	wan: { name: "Upstream", cidr: "wan" },
};

function useCountdown(until: number): string | null {
	const [, tick] = useState(0);
	useEffect(() => {
		const t = setInterval(() => tick((n) => n + 1), 1000);
		return () => clearInterval(t);
	}, []);
	if (!until || until <= Date.now()) return null;
	const s = Math.floor((until - Date.now()) / 1000);
	return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function DeviceInspector({
	device,
	onClose,
	onChanged,
}: {
	device: DeviceRecord | null;
	onClose: () => void;
	onChanged: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [grantedUntil, setGrantedUntil] = useState(0);
	const countdown = useCountdown(Math.max(grantedUntil, device?.temp_access_until ?? 0));
	const pausedLeft = useCountdown(device?.paused_until ?? 0);

	useEffect(() => {
		setGrantedUntil(0);
	}, [device?.ip]);

	if (!device) return null;
	const zone = ZONE_META[device.zone];

	const applyLane = async (lane: DeviceRecord["lane"]) => {
		setBusy(true);
		const d = await setLane(device.ip, lane, 3600);
		setBusy(false);
		if (d) onChanged();
	};

	const togglePause = async () => {
		setBusy(true);
		const isPaused = (device.paused_until ?? 0) > Date.now();
		const ok = isPaused ? await resumeDevice(device.ip) : await pauseDevice(device.ip, 60);
		setBusy(false);
		if (ok) onChanged();
	};

	const toggleTempAccess = async () => {
		setBusy(true);
		const phoneIp = await getPhoneLanIp();
		const ok = await grantTempAccess(device.ip, phoneIp, 900);
		setBusy(false);
		if (ok) {
			setGrantedUntil(Date.now() + 900 * 1000);
			onChanged();
		}
	};

	return (
		<Modal visible transparent animationType="slide" onRequestClose={onClose}>
			<View style={styles.sheetBackdrop}>
				<View style={styles.sheet}>
					<View style={styles.sheetHeader}>
						<View style={{ flex: 1 }}>
							<Text style={styles.sheetTitle}>{device.hostname || device.ip}</Text>
							<Text style={styles.dim}>
								{device.ip} · {zone.name} ({zone.cidr})
							</Text>
						</View>
						<Pressable onPress={onClose} hitSlop={12}>
							<Text style={styles.closeX}>✕</Text>
						</Pressable>
					</View>

					<ScrollView>
						<Text style={styles.sectionTitle}>PRIVACY FOOTPRINT</Text>
						<View style={styles.gradeRow}>
							<View
								style={[
									styles.gradeBadge,
									{
										borderColor:
											device.privacy_grade <= "B" ? LANE_COLORS.priority : device.privacy_grade === "C" ? LANE_COLORS.bulk : LANE_COLORS.video,
									},
								]}
							>
								<Text style={styles.gradeText}>{device.privacy_grade || "?"}</Text>
							</View>
							<View style={{ flex: 1 }}>
								<Text style={styles.dim}>Top observed destinations (metadata only):</Text>
								{(device.top_destinations.length
									? device.top_destinations
									: ["no flows observed yet"]
								).map((d) => (
									<Text key={d} style={styles.mono}>
										· {d}
									</Text>
								))}
							</View>
						</View>

						<Text style={styles.sectionTitle}>LAYER 7 PRIORITY LANE</Text>
						<View style={styles.laneRow}>
							{LANES.map((lane) => (
								<Pressable
									key={lane}
									disabled={busy}
									onPress={() => applyLane(lane)}
									style={[
										styles.laneBtn,
										device.lane === lane && { borderColor: LANE_COLORS[lane], backgroundColor: "#111c33" },
									]}
								>
									<Text
										style={[
											styles.laneBtnText,
											{ color: device.lane === lane ? LANE_COLORS[lane] : "#8aa0bf" },
										]}
									>
										{lane === "priority" ? "🎮 EF" : lane === "video" ? "📺 AF41" : lane === "bulk" ? "📦 CS1" : "· BE"}
									</Text>
								</Pressable>
							))}
						</View>
						<Text style={styles.dim}>
							source: {device.lane_source} · {(device.bytes_today / 1e6).toFixed(1)} MB today
						</Text>

						<Text style={styles.sectionTitle}>INTERNET ACCESS · PARENTAL</Text>
						<Pressable
							disabled={busy}
							onPress={togglePause}
							style={[styles.tempBtn, (device.paused_until ?? 0) > Date.now() && { borderColor: "#ef4444" }]}
						>
							<Text
								style={[
									styles.tempBtnText,
									{ color: (device.paused_until ?? 0) > Date.now() ? "#ef4444" : "#f59e0b" },
								]}
							>
								{(device.paused_until ?? 0) > Date.now()
									? `⏹ INTERNET PAUSED${pausedLeft ? ` · ${pausedLeft} left` : " · indefinitely"} — TAP TO RESUME`
									: "⏸ PAUSE INTERNET FOR 1 HOUR"}
							</Text>
						</Pressable>
						<Text style={styles.dim}>
							Applies a snapshot-first UCI REJECT rule (fw4) on the router; auto-expires and is
							rollback-protected.
						</Text>

						<Text style={styles.sectionTitle}>LATERAL ACCESS</Text>
						<Pressable
							disabled={busy}
							onPress={toggleTempAccess}
							style={[
								styles.tempBtn,
								countdown && styles.tempBtnActive,
							]}
						>
							{busy ? (
								<ActivityIndicator color="#22c55e" />
							) : (
								<Text style={[styles.tempBtnText, countdown && { color: "#052e16" }]}>
									{countdown
										? `🔓 PHONE ACCESS GRANTED · ${countdown} remaining — tap to renew`
										: "🔒 Grant Temporary Phone Access (15 min)"}
								</Text>
							)}
						</Pressable>
						<Text style={styles.dim}>
							Queued to the router agent; applies as a scoped UCI ACCEPT rule (this phone → this
							device only) under snapshot-first rollback protection, auto-expires after the TTL.
						</Text>
					</ScrollView>
				</View>
			</View>
		</Modal>
	);
}

export default function HomeScreen() {
	const sdui = useOpenUIStream(60000);
	const [devices, setDevices] = useState<DeviceRecord[]>([]);
	const [outage, setOutage] = useState<OutageState | null>(null);
	const [speedtest, setSpeedtest] = useState<SpeedtestResult | null>(null);
	const [selected, setSelected] = useState<DeviceRecord | null>(null);
	const [refreshing, setRefreshing] = useState(false);

	const loadNative = useCallback(async () => {
		const [devs, out, st] = await Promise.all([
			fetchDevices().catch(() => []),
			fetchOutage(),
			getSpeedtest(),
		]);
		setDevices(devs);
		setOutage(out);
		setSpeedtest(st);
		setSelected((cur) => (cur ? devs.find((d) => d.ip === cur.ip) ?? cur : cur));
	}, []);

	useEffect(() => {
		loadNative();
		const t = setInterval(loadNative, 60000);
		const off = onDeviceSelect((ip) => {
			fetchDevices()
				.then((devs) => setSelected(devs.find((d) => d.ip === ip) ?? null))
				.catch(() => {});
		});
		return () => {
			clearInterval(t);
			off();
		};
	}, [loadNative]);

	const onRefresh = useCallback(async () => {
		setRefreshing(true);
		sdui.reload();
		await loadNative();
		setRefreshing(false);
	}, [loadNative, sdui]);

	const grouped = useMemo(() => {
		const out: Record<string, DeviceRecord[]> = { lan: [], media: [], iot: [] };
		for (const d of devices) if (out[d.zone]) out[d.zone].push(d);
		return out;
	}, [devices]);

	const outageTone =
		outage?.state === "HEALTHY" || !outage
			? "#22c55e"
			: outage.state === "REGIONAL_OUTAGE"
				? "#ef4444"
				: "#f59e0b";

	return (
		<SafeAreaView style={styles.root} edges={["bottom"]}>
			<ScrollView
				style={{ flex: 1 }}
				refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#8aa0bf" />}
			>
				<View style={[styles.pill, { borderColor: outageTone }]}>
					<View style={[styles.dot, { backgroundColor: outageTone }]} />
					<Text style={[styles.pillText, { color: outageTone }]}>
						{outage ? outage.state.replace(/_/g, " ") : "ORACLE PENDING"}
					</Text>
					<Text style={styles.dim} numberOfLines={1}>
						{outage?.detail?.slice(0, 60) ?? "waiting for first cron scan"}
					</Text>
				</View>

				{outage && outage.state !== "HEALTHY" && (
					<View style={styles.alertBox}>
						<Text style={styles.alertText}>
							{outage.state === "REGIONAL_OUTAGE"
								? "📡 Regional ISP issue detected — your dropouts are NOT a hardware fault."
								: outage.state === "LOCAL_FAULT_SUSPECTED"
									? "⚠️ Local fault suspected — rollback matrix is verifying the last config change."
									: "👀 Regional degradation watch — your link is currently stable."}
						</Text>
					</View>
				)}

				<View style={styles.sduiFrame}>
					{!sdui.program && !sdui.error && (
						<View style={styles.sduiPlaceholder}>
							<ActivityIndicator color="#22c55e" />
							<Text style={styles.dim}>streaming OpenUI Lang manifest…</Text>
						</View>
					)}
					<Renderer
						response={sdui.program}
						library={avanzaLibrary}
						isStreaming={sdui.streaming}
						onError={(errs) => console.warn("openui:", errs.map((e) => e.code).join(","))}
					/>
				</View>

				{devices.length > 0 && (
					<>
						<View style={styles.speedRow}>
							<Text style={styles.nativeSection}>WAN SPEEDTEST (router-side)</Text>
							<Pressable
								style={styles.speedBtn}
								onPress={() => requestSpeedtest().then(() => setTimeout(loadNative, 90000))}
							>
								<Text style={styles.speedBtnText}>⚡ RUN</Text>
							</Pressable>
						</View>
						<View style={styles.zoneCard}>
							{speedtest?.down_kbps ? (
								<Text style={styles.deviceName}>
									↓ {(speedtest.down_kbps / 1000).toFixed(1)} Mb/s · ↑{" "}
									{(speedtest.up_kbps! / 1000).toFixed(1)} Mb/s · {speedtest.latency_ms} ms
									<Text style={styles.dim}>
										{"  "}· {new Date((speedtest.ts ?? 0) * 1000).toLocaleString()} · speed.cloudflare.com
									</Text>
								</Text>
							) : (
								<Text style={styles.dim}>
									no result yet — RUN queues the agent to measure via uclient-fetch; result lands on
									the next telemetry cycle (≤60 s)
								</Text>
							)}
						</View>

						<Text style={styles.nativeSection}>LOCAL DEVICE REGISTRY (live)</Text>
						{(["lan", "media", "iot"] as const).map((zone) => (
							<View key={zone} style={styles.zoneCard}>
								<Text style={styles.zoneTitle}>
									{ZONE_META[zone].name} · {ZONE_META[zone].cidr}
								</Text>
								{grouped[zone].length === 0 && <Text style={styles.dim}>no devices observed yet</Text>}
								{grouped[zone].map((d) => (
									<Pressable key={d.ip} style={styles.deviceRow} onPress={() => setSelected(d)}>
										<View style={{ flex: 1 }}>
											<Text style={styles.deviceName}>{d.hostname || d.ip}</Text>
											<Text style={[styles.mono, styles.dim]}>
												{d.ip}
												{(d.paused_until ?? 0) > Date.now() ? " · ⏸ PAUSED" : ""}
											</Text>
										</View>
										<View style={[styles.chip, { borderColor: LANE_COLORS[d.lane] }]}>
											<Text style={{ color: LANE_COLORS[d.lane], fontSize: 11 }}>
												{d.lane.toUpperCase()}
											</Text>
										</View>
									</Pressable>
								))}
							</View>
						))}
					</>
				)}
			</ScrollView>

			<DeviceInspector
				device={selected}
				onClose={() => setSelected(null)}
				onChanged={loadNative}
			/>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: "#060913", paddingHorizontal: 12 },
	dim: { color: "#8aa0bf", fontSize: 11 },
	mono: { fontFamily: "monospace", fontSize: 11 },
	pill: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		borderWidth: 1,
		borderRadius: 999,
		paddingHorizontal: 12,
		paddingVertical: 8,
		marginTop: 8,
		backgroundColor: "#0d1526",
	},
	pillText: { fontWeight: "800", fontSize: 11, letterSpacing: 1 },
	dot: { width: 8, height: 8, borderRadius: 4 },
	alertBox: {
		backgroundColor: "#1a1206",
		borderColor: "#f59e0b44",
		borderWidth: 1,
		borderRadius: 10,
		padding: 10,
		marginTop: 8,
	},
	alertText: { color: "#fbbf24", fontSize: 12, lineHeight: 17 },
	sduiFrame: { marginTop: 8 },
	sduiPlaceholder: { gap: 8, alignItems: "center", paddingVertical: 16 },
	nativeSection: {
		color: "#8aa0bf",
		fontSize: 11,
		letterSpacing: 2,
		marginTop: 16,
		marginBottom: 6,
		fontWeight: "700",
	},
	speedRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
	speedBtn: {
		borderColor: "#22d3ee",
		borderWidth: 1,
		borderRadius: 8,
		paddingHorizontal: 12,
		paddingVertical: 5,
	},
	speedBtnText: { color: "#22d3ee", fontWeight: "900", fontSize: 11 },
	zoneCard: {
		backgroundColor: "#0d1526",
		borderColor: "#1c2a45",
		borderWidth: 1,
		borderRadius: 12,
		padding: 12,
		marginBottom: 10,
	},
	zoneTitle: { color: "#e6edf7", fontWeight: "700", marginBottom: 6 },
	deviceRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		paddingVertical: 8,
		borderTopWidth: 1,
		borderTopColor: "#1c2a45",
	},
	deviceName: { color: "#e6edf7", fontWeight: "600", fontSize: 13 },
	chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
	sheetBackdrop: { flex: 1, backgroundColor: "#000a", justifyContent: "flex-end" },
	sheet: {
		backgroundColor: "#0d1526",
		borderTopLeftRadius: 20,
		borderTopRightRadius: 20,
		padding: 16,
		maxHeight: "82%",
		borderTopWidth: 1,
		borderTopColor: "#1c2a45",
	},
	sheetHeader: { flexDirection: "row", alignItems: "center", marginBottom: 8 },
	sheetTitle: { color: "#e6edf7", fontSize: 17, fontWeight: "800" },
	closeX: { color: "#8aa0bf", fontSize: 18 },
	sectionTitle: {
		color: "#8aa0bf",
		fontSize: 10,
		letterSpacing: 2,
		fontWeight: "700",
		marginTop: 16,
		marginBottom: 6,
	},
	gradeRow: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
	gradeBadge: {
		width: 44,
		height: 44,
		borderRadius: 12,
		borderWidth: 2,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: "#111c33",
	},
	gradeText: { color: "#e6edf7", fontSize: 18, fontWeight: "800" },
	laneRow: { flexDirection: "row", gap: 6 },
	laneBtn: {
		flex: 1,
		borderWidth: 1,
		borderColor: "#1c2a45",
		borderRadius: 10,
		paddingVertical: 10,
		alignItems: "center",
		backgroundColor: "#0a1120",
	},
	laneBtnText: { fontSize: 11, fontWeight: "700" },
	tempBtn: {
		borderWidth: 1,
		borderColor: "#22c55e",
		borderRadius: 12,
		paddingVertical: 14,
		alignItems: "center",
		marginTop: 4,
		backgroundColor: "#0a1120",
	},
	tempBtnActive: { backgroundColor: "#22c55e" },
	tempBtnText: { color: "#22c55e", fontWeight: "800", fontSize: 12, textAlign: "center", paddingHorizontal: 8 },
});
