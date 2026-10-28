import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { z } from "zod";
import { createLibrary, defineComponent } from "@openuidev/react-lang";

const palette = {
	bg: "#060913",
	card: "#0d1526",
	cardEdge: "#1c2a45",
	text: "#e6edf7",
	dim: "#8aa0bf",
	green: "#22c55e",
	violet: "#a78bfa",
	amber: "#f59e0b",
	red: "#ef4444",
	cyan: "#22d3ee",
};

type SelectListener = (ip: string) => void;
const selectListeners = new Set<SelectListener>();

export function onDeviceSelect(fn: SelectListener): () => void {
	selectListeners.add(fn);
	return () => {
		selectListeners.delete(fn);
	};
}

function emitDeviceSelect(ip: string): void {
	selectListeners.forEach((fn) => fn(ip));
}

const OutageBanner = defineComponent({
	name: "OutageBanner",
	description: "Regional outage oracle verdict banner (state, human detail, confidence 0..1).",
	props: z.object({
		state: z.string(),
		detail: z.string(),
		confidence: z.number().optional(),
	}),
	component: ({ props }) => {
		const { state, detail, confidence } = props;
		const tone =
			state === "HEALTHY"
				? palette.green
				: state === "REGIONAL_OUTAGE"
					? palette.red
					: state === "LOCAL_FAULT_SUSPECTED"
						? palette.amber
						: palette.cyan;
		return (
			<View style={[styles.banner, { borderLeftColor: tone }]}>
				<Text style={[styles.bannerState, { color: tone }]}>{state.replace(/_/g, " ")}</Text>
				<Text style={styles.bannerDetail} numberOfLines={3}>
					{detail}
				</Text>
				{confidence !== undefined && (
					<Text style={styles.dim}>confidence {(confidence * 100).toFixed(0)}%</Text>
				)}
			</View>
		);
	},
});

const StatTile = defineComponent({
	name: "StatTile",
	description: "Single KPI tile: label, value, optional unit.",
	props: z.object({
		label: z.string(),
		value: z.union([z.string(), z.number()]),
		unit: z.string().optional(),
	}),
	component: ({ props }) => {
		const { label, value, unit } = props;
		return (
			<View style={styles.tile}>
				<Text style={styles.tileLabel}>{label}</Text>
				<Text style={styles.tileValue}>
					{value}
					{unit ? <Text style={styles.tileUnit}> {unit}</Text> : null}
				</Text>
			</View>
		);
	},
});

const StatRow = defineComponent({
	name: "StatRow",
	description: "Horizontal row of StatTile children.",
	props: z.object({ children: z.array(StatTile.ref) }),
	component: ({ props, renderNode }) => (
		<View style={styles.row}>
			{props.children.map((child, i) => (
				<React.Fragment key={i}>{renderNode(child)}</React.Fragment>
			))}
		</View>
	),
});

const DeviceRow = defineComponent({
	name: "DeviceRow",
	description:
		"One LAN device: display name, ip, current QoS lane (priority|video|bulk|normal), privacy grade. Tapping opens the native device inspector.",
	props: z.object({
		name: z.string(),
		ip: z.string(),
		lane: z.string(),
		grade: z.string(),
	}),
	component: ({ props }) => {
		const { name, ip, lane, grade } = props;
		const laneColor =
			lane === "priority"
				? palette.green
				: lane === "video"
					? palette.violet
					: lane === "bulk"
						? palette.amber
						: palette.dim;
		return (
			<Pressable
				style={({ pressed }) => [styles.deviceRow, pressed && styles.pressed]}
				onPress={() => emitDeviceSelect(ip)}
			>
				<View style={{ flex: 1 }}>
					<Text style={styles.deviceName}>{name}</Text>
					<Text style={styles.dim}>{ip}</Text>
				</View>
				<View style={[styles.chip, { borderColor: laneColor }]}>
					<Text style={{ color: laneColor, fontSize: 11 }}>{lane.toUpperCase()}</Text>
				</View>
				<View style={[styles.chip, { borderColor: palette.cardEdge }]}>
					<Text style={{ color: palette.text, fontSize: 11 }}>priv {grade}</Text>
				</View>
			</Pressable>
		);
	},
});

const ZoneCard = defineComponent({
	name: "ZoneCard",
	description: "A network zone (name + CIDR) containing its DeviceRow children.",
	props: z.object({
		name: z.string(),
		cidr: z.string(),
		children: z.array(DeviceRow.ref),
	}),
	component: ({ props, renderNode }) => {
		const { name, cidr, children } = props;
		return (
			<View style={styles.zoneCard}>
				<View style={styles.zoneHeader}>
					<Text style={styles.zoneName}>{name}</Text>
					<Text style={styles.dim}>{cidr}</Text>
				</View>
				{children.map((child, i) => (
					<React.Fragment key={i}>{renderNode(child)}</React.Fragment>
				))}
			</View>
		);
	},
});

const ZoneGrid = defineComponent({
	name: "ZoneGrid",
	description: "Vertical stack of ZoneCards.",
	props: z.object({ children: z.array(ZoneCard.ref) }),
	component: ({ props, renderNode }) => (
		<View>
			{props.children.map((child, i) => (
				<React.Fragment key={i}>{renderNode(child)}</React.Fragment>
			))}
		</View>
	),
});

const AvanzaDashboard = defineComponent({
	name: "AvanzaDashboard",
	description: "Root server-driven dashboard: outage banner, KPI tile row, zone grid.",
	props: z.object({
		children: z.array(z.union([OutageBanner.ref, StatRow.ref, ZoneGrid.ref])),
	}),
	component: ({ props, renderNode }) => (
		<ScrollView style={styles.root} contentContainerStyle={{ paddingBottom: 32 }}>
			<Text style={styles.title}>AVANZA CONTROL MATRIX</Text>
			<Text style={[styles.dim, { marginBottom: 12 }]}>server-driven · streamed OpenUI Lang</Text>
			{props.children.map((child, i) => (
				<React.Fragment key={i}>{renderNode(child)}</React.Fragment>
			))}
		</ScrollView>
	),
});

export const avanzaLibrary = createLibrary({
	id: "avanza-dashboard",
	root: "AvanzaDashboard",
	components: [StatTile, StatRow, DeviceRow, ZoneCard, ZoneGrid, OutageBanner, AvanzaDashboard],
	componentGroups: [
		{ name: "layout", components: ["AvanzaDashboard", "StatRow", "ZoneGrid", "ZoneCard"] },
		{ name: "data", components: ["StatTile", "DeviceRow", "OutageBanner"] },
	],
});

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: palette.bg, paddingHorizontal: 16 },
	title: { color: palette.text, fontSize: 20, fontWeight: "800", letterSpacing: 2, marginTop: 8 },
	dim: { color: palette.dim, fontSize: 12 },
	banner: {
		backgroundColor: palette.card,
		borderLeftWidth: 4,
		borderRadius: 10,
		padding: 12,
		marginBottom: 12,
	},
	bannerState: { fontSize: 13, fontWeight: "800", letterSpacing: 1 },
	bannerDetail: { color: palette.text, fontSize: 12, marginTop: 4 },
	row: { flexDirection: "row", gap: 8, marginBottom: 12 },
	tile: {
		flex: 1,
		backgroundColor: palette.card,
		borderColor: palette.cardEdge,
		borderWidth: 1,
		borderRadius: 10,
		padding: 10,
	},
	tileLabel: { color: palette.dim, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 },
	tileValue: { color: palette.text, fontSize: 18, fontWeight: "700", marginTop: 4 },
	tileUnit: { color: palette.dim, fontSize: 11, fontWeight: "400" },
	zoneCard: {
		backgroundColor: palette.card,
		borderColor: palette.cardEdge,
		borderWidth: 1,
		borderRadius: 12,
		padding: 12,
		marginBottom: 12,
	},
	zoneHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 8 },
	zoneName: { color: palette.text, fontWeight: "700", fontSize: 14 },
	deviceRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		paddingVertical: 8,
		borderTopWidth: 1,
		borderTopColor: palette.cardEdge,
	},
	deviceName: { color: palette.text, fontSize: 13, fontWeight: "600" },
	chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
	pressed: { opacity: 0.6 },
});
