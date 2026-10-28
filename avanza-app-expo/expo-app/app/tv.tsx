import React, { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Stack } from "expo-router";
import {
	fetchOutage,
	getPhoneLanIp,
	getSpeedtest,
	requestSpeedtest,
	setLane,
	setPhoneLanIp,
	type OutageState,
	type SpeedtestResult,
} from "@/lib/api";

function Tile({
	focused,
	onFocusChange,
	onPress,
	title,
	sub,
	color,
}: {
	focused: boolean;
	onFocusChange: (f: boolean) => void;
	onPress: () => void;
	title: string;
	sub: string;
	color: string;
}) {
	return (
		<Pressable
			onFocus={() => onFocusChange(true)}
			onBlur={() => onFocusChange(false)}
			onPress={onPress}
			style={[styles.tile, focused && { borderColor: color, backgroundColor: "#101b31", transform: [{ scale: 1.03 }] }]}
		>
			<Text style={[styles.tileTitle, { color }]}>{title}</Text>
			<Text style={styles.tileSub}>{sub}</Text>
		</Pressable>
	);
}

export default function TvScreen() {
	const [focus, setFocus] = useState<string>("boost");
	const [outage, setOutage] = useState<OutageState | null>(null);
	const [speed, setSpeed] = useState<SpeedtestResult | null>(null);
	const [deviceIp, setDeviceIp] = useState("192.168.20.41");
	const [boosted, setBoosted] = useState(false);
	const [status, setStatus] = useState("ready");

	const refresh = useCallback(async () => {
		const [o, s] = await Promise.all([fetchOutage(), getSpeedtest()]);
		setOutage(o);
		setSpeed(s);
	}, []);

	useEffect(() => {
		getPhoneLanIp().then((ip) => ip && setDeviceIp(ip));
		refresh();
		const t = setInterval(refresh, 30000);
		return () => clearInterval(t);
	}, [refresh]);

	const boost = async () => {
		setStatus("boosting…");
		await setPhoneLanIp(deviceIp);
		const d = await setLane(deviceIp, boosted ? "video" : "priority", 7200);
		setBoosted(!boosted);
		setStatus(d ? (boosted ? "lane → VIDEO (AF41, 2h)" : "lane → PRIORITY (EF, 2h)") : "boost failed — check app token");
	};

	const runSpeed = async () => {
		setStatus("speedtest queued — runs on the router, result lands ≤2 min");
		const ok = await requestSpeedtest();
		if (!ok) setStatus("speedtest queue failed");
		setTimeout(refresh, 120000);
	};

	const tone = !outage || outage.state === "HEALTHY" ? "#22c55e" : outage.state === "REGIONAL_OUTAGE" ? "#ef4444" : "#f59e0b";

	return (
		<>
			<Stack.Screen options={{ headerShown: false }} />
			<View style={styles.root}>
				<Text style={styles.title}>AVANZA · TV COMPANION</Text>
				<View style={[styles.statusPill, { borderColor: tone }]}>
					<Text style={[styles.statusText, { color: tone }]}>
						{outage ? outage.state.replace(/_/g, " ") : "ORACLE PENDING"} · {status}
					</Text>
				</View>
				<ScrollView contentContainerStyle={styles.grid}>
					<Tile
						focused={focus === "boost"}
						onFocusChange={(f) => f && setFocus("boost")}
						onPress={boost}
						color="#22c55e"
						title={boosted ? "⚡ BOOSTED (EF)" : "⚡ BOOST THIS TV"}
						sub={
							boosted
								? "priority lane active 2h — tap to return to VIDEO/AF41"
								: "requests the EF realtime lane from CAKE for 2h (movie night vs. a big download)"
						}
					/>
					<Tile
						focused={focus === "speed"}
						onFocusChange={(f) => f && setFocus("speed")}
						onPress={runSpeed}
						color="#a78bfa"
						title="🌐 SPEED TEST"
						sub={
							speed?.down_kbps
								? `↓ ${(speed.down_kbps / 1000).toFixed(0)} · ↑ ${(speed.up_kbps! / 1000).toFixed(0)} Mb/s · ${speed.latency_ms} ms`
								: "run on the router via speed.cloudflare.com"
						}
					/>
					<Tile
						focused={focus === "cast"}
						onFocusChange={(f) => f && setFocus("cast")}
						onPress={() => setStatus("casting discovery relies on umdns reflection mgmt⇄media (udp/5353) — if the phone can't see this TV, check the mDNS switch")}
						color="#f59e0b"
						title="📺 CAST HELP"
						sub="mDNS 5353 reflection status + troubleshooting hint"
					/>
					<View style={styles.ipTile}>
						<Text style={styles.ipLabel}>THIS DEVICE'S LAN IP (stored for lane control)</Text>
						<TextInput
							value={deviceIp}
							onChangeText={setDeviceIp}
							style={styles.ipInput}
							placeholder="192.168.20.41"
							placeholderTextColor="#475569"
						/>
					</View>
				</ScrollView>
				<Text style={styles.hint}>
					D-pad: focus a tile → OK · sideload the same APK on Fire TV (adb install) · settings come from the
					phone app's orchestrator config
				</Text>
			</View>
		</>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: "#060913", padding: 32 },
	title: { color: "#e6edf7", fontSize: 26, fontWeight: "900", letterSpacing: 4 },
	statusPill: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 18, paddingVertical: 10, marginTop: 16, alignSelf: "flex-start", backgroundColor: "#0d1526" },
	statusText: { fontSize: 14, fontWeight: "800", letterSpacing: 1 },
	grid: { flexDirection: "row", flexWrap: "wrap", gap: 20, marginTop: 28 },
	tile: { width: 380, minHeight: 150, borderRadius: 18, borderWidth: 2, borderColor: "#1c2a45", backgroundColor: "#0d1526", padding: 22, justifyContent: "center" },
	tileTitle: { fontSize: 22, fontWeight: "900", letterSpacing: 1 },
	tileSub: { color: "#8aa0bf", fontSize: 13, marginTop: 10, lineHeight: 19 },
	ipTile: { width: 380, minHeight: 150, borderRadius: 18, borderWidth: 1, borderColor: "#1c2a45", backgroundColor: "#0d1526", padding: 22, justifyContent: "center" },
	ipLabel: { color: "#64748b", fontSize: 10, fontWeight: "800", letterSpacing: 2 },
	ipInput: { color: "#e6edf7", fontSize: 20, fontFamily: "monospace", marginTop: 12, borderBottomWidth: 1, borderBottomColor: "#1c2a45", paddingVertical: 6 },
	hint: { color: "#475569", fontSize: 11, marginTop: 28 },
});
