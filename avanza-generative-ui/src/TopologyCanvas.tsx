import React, { useEffect, useMemo, useRef, useState } from "react";
import {
	Activity,
	Cloud,
	Gamepad2,
	KeyRound,
	Laptop,
	Lock,
	Router as RouterIcon,
	Server,
	ShieldAlert,
	Smartphone,
	Speaker,
	Thermometer,
	Tv,
	Video,
	Wifi,
	Zap,
} from "lucide-react";

export type ZoneId = "mgmt" | "media" | "iot";
export type LaneId = "priority" | "video" | "bulk" | "normal";

export interface DeviceNode {
	id: string;
	name: string;
	ip: string;
	mac: string;
	zone: ZoneId;
	lane: LaneId;
	icon: React.ComponentType<{ className?: string; size?: number }>;
	privacy: {
		grade: string;
		destinations: string[];
		collects: string[];
		note: string;
	};
	mdns: boolean;
}

export const DEFAULT_DEVICES: DeviceNode[] = [
	{
		id: "laptop",
		name: "Admin Laptop",
		ip: "192.168.10.21",
		mac: "A4:2B:B0:1C:21:0A",
		zone: "mgmt",
		lane: "normal",
		icon: Laptop,
		privacy: {
			grade: "A+",
			destinations: ["github.com", "openwrt.org", "workers.dev"],
			collects: ["Nothing — OS telemetry disabled"],
			note: "Trusted management host. Full cross-zone rights.",
		},
		mdns: true,
	},
	{
		id: "phone",
		name: "Your Phone",
		ip: "192.168.10.22",
		mac: "F0:18:98:2A:77:C1",
		zone: "mgmt",
		lane: "priority",
		icon: Smartphone,
		privacy: {
			grade: "A",
			destinations: ["exp.host (push)", "avanza workers.dev"],
			collects: ["Expo push token (yours only)"],
			note: "Control plane identity. Temporary-access grants originate here.",
		},
		mdns: true,
	},
	{
		id: "nas",
		name: "NAS / Extroot Mirror",
		ip: "192.168.10.30",
		mac: "00:11:32:0D:44:9B",
		zone: "mgmt",
		lane: "bulk",
		icon: Server,
		privacy: {
			grade: "A+",
			destinations: ["(local only)"],
			collects: ["Nothing — snapshots + config backups"],
			note: "Rollback snapshot mirror for the router's Extroot array.",
		},
		mdns: true,
	},
	{
		id: "firetv",
		name: "Fire TV Stick 4K",
		ip: "192.168.20.41",
		mac: "FC:65:DE:A2:11:3E",
		zone: "media",
		lane: "video",
		icon: Tv,
		privacy: {
			grade: "D+",
			destinations: ["primevideo CDN", "amazon telemetry", "ad networks → blocked @1.1.1.3"],
			collects: ["Viewing history", "Alexa voice recordings", "Ad identifier"],
			note: "Cast target via umdns mDNS reflection from Management zone.",
		},
		mdns: true,
	},
	{
		id: "console",
		name: "Game Console",
		ip: "192.168.20.43",
		mac: "7C:1E:52:9B:03:AA",
		zone: "media",
		lane: "priority",
		icon: Gamepad2,
		privacy: {
			grade: "C+",
			destinations: ["xboxlive.com", "msftconnecttest", "game CDNs"],
			collects: ["Match telemetry", "Voice-chat metadata"],
			note: "Static EF baseline (firewall.yml) + STUN/TURN 3478 → CAKE voice tin.",
		},
		mdns: false,
	},
	{
		id: "tv",
		name: "Living Room TV",
		ip: "192.168.20.42",
		mac: "38:FD:FE:5C:81:20",
		zone: "media",
		lane: "video",
		icon: Tv,
		privacy: {
			grade: "C",
			destinations: ["panel vendor ACR", "streaming CDNs"],
			collects: ["ACR screen fingerprints (opt-out applied)"],
			note: "Second cast target; ACR domains sinkholed by Gateway family filter.",
		},
		mdns: true,
	},
	{
		id: "speaker",
		name: "Smart Speaker",
		ip: "192.168.30.51",
		mac: "44:65:0D:77:12:FF",
		zone: "iot",
		lane: "bulk",
		icon: Speaker,
		privacy: {
			grade: "D",
			destinations: ["vendor voice cloud", "music CDNs"],
			collects: ["Wake-word audio", "Voice recordings", "Room profiles"],
			note: "Egress via 1.1.1.3 family filter; CS1 bulk tin keeps it polite.",
		},
		mdns: false,
	},
	{
		id: "camera",
		name: "IP Camera (Door)",
		ip: "192.168.30.52",
		mac: "C8:3A:35:9E:40:17",
		zone: "iot",
		lane: "bulk",
		icon: Video,
		privacy: {
			grade: "F",
			destinations: ["vendor P2P cloud relay"],
			collects: ["24/7 video via vendor relay", "Motion metadata"],
			note: "Repeat offender: lateral probes toward the NAS are dropped by fw4 (nft counter avanza_lateral_blocked).",
		},
		mdns: false,
	},
	{
		id: "plugs",
		name: "Smart Plugs ×3",
		ip: "192.168.30.53",
		mac: "50:FF:99:12:8C:31",
		zone: "iot",
		lane: "bulk",
		icon: Zap,
		privacy: {
			grade: "B",
			destinations: ["local MQTT (optional cloud)"],
			collects: ["Switch state", "Power draw"],
			note: "Flashed to local-only mode; cloud relay disabled.",
		},
		mdns: false,
	},
	{
		id: "thermo",
		name: "Thermostat",
		ip: "192.168.30.54",
		mac: "18:B4:30:AA:5D:02",
		zone: "iot",
		lane: "bulk",
		icon: Thermometer,
		privacy: {
			grade: "C",
			destinations: ["vendor schedule cloud"],
			collects: ["Occupancy schedule", "Temperature history"],
			note: "NTP pinned to router; DNS/NTP-only lateral rules.",
		},
		mdns: false,
	},
];

export const ROUTER_NODE = {
	id: "router",
	name: "TP-Link Archer C7 v5",
	ip: "192.168.10.1",
	mac: "B0:4E:26:71:9C:44",
	zone: "mgmt" as ZoneId,
	lane: "normal" as LaneId,
	icon: RouterIcon,
	privacy: {
		grade: "A+",
		destinations: ["*.workers.dev (orchestrator)", "1.1.1.3 (DoH)", "pool.ntp.org"],
		collects: ["Metadata-only telemetry (HMAC-signed)", "No payloads, ever"],
		note: "OpenWrt 25.12.6 · CAKE 400/20 · fw4 · umdns · Extroot 7.1 GB (41% used) · cloudflared QUIC",
	},
	mdns: true,
};

const LANE_META: Record<LaneId, { label: string; color: string; dscp: string; set: string }> = {
	priority: { label: "🎮 PRIORITY · EF", color: "#22c55e", dscp: "0x2e", set: "avanza_lane_priority" },
	video: { label: "📺 VIDEO · AF41", color: "#a78bfa", dscp: "0x28", set: "avanza_lane_video" },
	bulk: { label: "📦 BULK · CS1", color: "#f59e0b", dscp: "0x08", set: "avanza_lane_bulk" },
	normal: { label: "BEST EFFORT", color: "#8aa0bf", dscp: "0x00", set: "—" },
};

const ZONE_META: Record<ZoneId, { label: string; sub: string; stroke: string; tint: string }> = {
	mgmt: { label: "Management Zone", sub: "192.168.10.0/24 · br-lan · forward: DROP", stroke: "#155e75", tint: "rgba(8,51,68,0.35)" },
	media: { label: "Media / Streaming Zone", sub: "192.168.20.0/24 · br-media · forward: DROP", stroke: "#5b21b6", tint: "rgba(46,16,101,0.30)" },
	iot: { label: "Smart Home IoT Zone", sub: "192.168.30.0/24 · br-iot · lateral: BLOCKED", stroke: "#7f1d1d", tint: "rgba(69,10,10,0.30)" },
};

const NODE_POS: Record<string, { x: number; y: number }> = {
	laptop: { x: 48, y: 560 },
	phone: { x: 220, y: 560 },
	nas: { x: 48, y: 692 },
	firetv: { x: 438, y: 560 },
	tv: { x: 438, y: 692 },
	console: { x: 610, y: 560 },
	speaker: { x: 828, y: 560 },
	camera: { x: 1000, y: 560 },
	plugs: { x: 828, y: 692 },
	thermo: { x: 1000, y: 692 },
};

const LANE_PATHS: Record<string, string> = {
	laptop: "M 126 560 L 126 528 C 126 508 170 500 210 496 C 210 452 520 430 555 364 L 572 300 C 578 250 420 190 340 138",
	phone: "M 298 560 L 298 522 C 298 506 252 500 210 496 C 210 452 520 430 555 364 L 572 300 C 578 250 420 190 340 138",
	firetv: "M 516 560 L 516 524 C 516 508 560 500 600 496 C 600 452 600 420 600 364 L 600 300 C 600 255 560 190 512 138",
	tv: "M 516 692 L 516 660 C 516 640 545 636 566 640 C 590 600 600 540 600 496 C 600 452 600 420 600 364 L 600 300 C 600 255 560 190 512 138",
	console: "M 688 560 L 688 524 C 688 508 645 500 600 496 C 600 452 600 420 600 364 L 600 300 C 600 260 630 200 684 138",
	speaker: "M 906 560 L 906 524 C 906 508 950 500 990 496 C 990 452 680 430 645 364 L 628 300 C 620 252 570 190 545 138",
	camera: "M 1078 560 L 1078 524 C 1078 508 1035 500 990 496 C 990 452 680 430 645 364 L 628 300 C 620 252 570 190 545 138",
	plugs: "M 906 692 L 906 660 C 906 640 935 636 956 640 C 980 600 990 540 990 496 C 990 452 680 430 645 364 L 628 300 C 620 252 570 190 545 138",
	thermo: "M 1078 692 L 1078 660 C 1078 640 1050 636 1029 640 C 1005 600 990 540 990 496 C 990 452 680 430 645 364 L 628 300 C 620 252 570 190 545 138",
};

const MDNS_PATH = "M 300 496 C 330 452 470 452 500 496";
const BLOCKED_PATH = "M 1078 620 C 1000 720 800 828 600 834 C 400 840 220 800 130 744";

interface Particle {
	t: number;
	speed: number;
	el: SVGCircleElement;
	len: number;
	blocked?: boolean;
}

export default function TopologyCanvas() {
	const [devices, setDevices] = useState<DeviceNode[]>(DEFAULT_DEVICES);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [tempAccess, setTempAccess] = useState<Record<string, number>>({});
	const [now, setNow] = useState(Date.now());
	const [blockedCount, setBlockedCount] = useState(1284);
	const [log, setLog] = useState<string[]>([
		"[agent] boot · time verified 2026-10-26T21:40:02Z · overlay 41% of 7.1G",
		"[worker] ingest ok · 24 digest entries · HMAC verified (t±300s)",
		"[oracle] radar 8.2 · rss quiet · verdict HEALTHY (0.9)",
	]);
	const [stats, setStats] = useState({ pps: 1240, mbps: 386, mdns: 12 });

	const svgRef = useRef<SVGSVGElement | null>(null);
	const laneRefs = useRef<Record<string, SVGPathElement | null>>({});
	const particleLayer = useRef<SVGGElement | null>(null);
	const blockedPathRef = useRef<SVGPathElement | null>(null);
	const shieldRef = useRef<SVGGElement | null>(null);
	const particles = useRef<Particle[]>([]);
	const blockedParticles = useRef<Particle[]>([]);

	const pushLog = (line: string) =>
		setLog((l) => [...l.slice(-30), `${new Date().toLocaleTimeString()} ${line}`]);

	useEffect(() => {
		const iv = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(iv);
	}, []);

	useEffect(() => {
		const iv = setInterval(() => {
			setStats((s) => ({
				pps: Math.max(200, Math.min(4000, s.pps + Math.round((Math.random() - 0.5) * 300))),
				mbps: Math.max(50, Math.min(460, s.mbps + Math.round((Math.random() - 0.5) * 40))),
				mdns: Math.max(2, Math.min(40, s.mdns + Math.round((Math.random() - 0.5) * 6))),
			}));
		}, 2000);
		return () => clearInterval(iv);
	}, []);

	useEffect(() => {
		let raf = 0;
		let last = performance.now();
		const spawnTimers: Record<string, number> = {};

		const ensureParticles = () => {
			if (!particleLayer.current) return;
			for (const dev of devices) {
				const path = laneRefs.current[dev.id];
				if (!path) continue;
				const len = path.getTotalLength();
				const want = dev.lane === "priority" ? 5 : dev.lane === "video" ? 4 : dev.lane === "bulk" ? 3 : 2;
				const have = particles.current.filter((p) => (p.el.dataset.dev === dev.id));
				for (let i = have.length; i < want; i++) {
					const el = document.createElementNS("http://www.w3.org/2000/svg", "circle");
					el.setAttribute("r", dev.lane === "priority" ? "4" : "3");
					el.dataset.dev = dev.id;
					particleLayer.current.appendChild(el);
					particles.current.push({
						t: Math.random() * len,
						speed: (dev.lane === "priority" ? 260 : dev.lane === "video" ? 170 : 110) * (0.8 + Math.random() * 0.4),
						el,
						len,
					});
				}
				for (const p of have) {
					p.el.setAttribute("fill", LANE_META[dev.lane].color);
					p.len = len;
				}
			}
			const bpath = blockedPathRef.current;
			if (bpath && blockedParticles.current.length < 2 && particleLayer.current) {
				const len = bpath.getTotalLength();
				for (let i = blockedParticles.current.length; i < 2; i++) {
					const el = document.createElementNS("http://www.w3.org/2000/svg", "circle");
					el.setAttribute("r", "3.5");
					el.setAttribute("fill", "#ef4444");
					particleLayer.current.appendChild(el);
					blockedParticles.current.push({ t: Math.random() * len * 0.4, speed: 90, el, len, blocked: true });
				}
			}
		};

		const tick = (ts: number) => {
			const dt = Math.min((ts - last) / 1000, 0.05);
			last = ts;
			ensureParticles();
			for (const dev of devices) {
				const path = laneRefs.current[dev.id];
				if (!path) continue;
				for (const p of particles.current) {
					if (p.el.dataset.dev !== dev.id) continue;
					p.t += p.speed * dt;
					if (p.t > p.len) p.t -= p.len;
					const pt = path.getPointAtLength(p.t);
					p.el.setAttribute("cx", String(pt.x));
					p.el.setAttribute("cy", String(pt.y));
					p.el.setAttribute("opacity", p.t > p.len - 30 ? String((p.len - p.t) / 30) : "0.95");
				}
			}
			const bpath = blockedPathRef.current;
			if (bpath) {
				for (const p of blockedParticles.current) {
					p.t += p.speed * dt;
					const wall = p.len * 0.52;
					if (p.t >= wall) {
						p.t = -40 - Math.random() * 120;
						setBlockedCount((c) => c + 1);
						shieldRef.current?.classList.add("shield-hit");
						setTimeout(() => shieldRef.current?.classList.remove("shield-hit"), 400);
					}
					if (p.t < 0) {
						p.el.setAttribute("opacity", "0");
						continue;
					}
					const pt = bpath.getPointAtLength(p.t);
					p.el.setAttribute("cx", String(pt.x));
					p.el.setAttribute("cy", String(pt.y));
					p.el.setAttribute("opacity", "0.9");
				}
			}
			spawnTimers._ = ts;
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [devices]);

	const selected = useMemo(
		() => (selectedId === "router" ? ROUTER_NODE : devices.find((d) => d.id === selectedId) ?? null),
		[selectedId, devices],
	);

	const setLane = (id: string, lane: LaneId) => {
		setDevices((ds) => ds.map((d) => (d.id === id ? { ...d, lane } : d)));
		const dev = devices.find((d) => d.id === id);
		if (!dev) return;
		pushLog(`[agent] nft add element inet fw4 ${LANE_META[lane].set} { ${dev.ip} timeout 3600s }`);
		pushLog(`[worker] override cached · ${dev.ip} → ${lane} (${LANE_META[lane].dscp})`);
	};

	const toggleTempAccess = (id: string) => {
		const dev = devices.find((d) => d.id === id);
		if (!dev) return;
		setTempAccess((t) => {
			const cur = t[id];
			if (cur && cur > Date.now()) {
				pushLog(`[agent] temp-access REVOKED · uci delete firewall.rule_avanza_tmpaccess_${dev.ip.replaceAll(".", "_")} · fw4 reload`);
				const { [id]: _drop, ...rest } = t;
				return rest;
			}
			pushLog(`[agent] snapshot ${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)} → rollback ARMED (600s)`);
			pushLog(`[agent] uci set firewall.rule_avanza_tmpaccess_${dev.ip.replaceAll(".", "_")}=firewall.rule · src=lan dest=${dev.zone === "iot" ? "iot" : "media"} · 192.168.10.22 → ${dev.ip} ACCEPT · fw4 reload`);
			return { ...t, [id]: Date.now() + 15 * 60 * 1000 };
		});
	};

	const phone = NODE_POS.phone;

	return (
		<div className="min-h-screen bg-[#060913] text-slate-200 font-sans">
			<header className="flex items-center gap-3 px-5 py-3 border-b border-[#1c2a45] bg-[#0a1120]">
				<Cloud size={22} className="text-sky-400" />
				<h1 className="text-sm font-black tracking-[0.25em] text-slate-100">
					AVANZA · LIVING TOPOLOGY MATRIX
				</h1>
				<div className="ml-auto flex items-center gap-2 text-[10px] font-bold">
					<span className="px-2 py-1 rounded-full border border-emerald-500/60 text-emerald-400">WAN UP · CAKE 400/20</span>
					<span className="px-2 py-1 rounded-full border border-sky-500/60 text-sky-400">TUNNEL QUIC</span>
					<span className="px-2 py-1 rounded-full border border-emerald-500/60 text-emerald-400">ORACLE HEALTHY</span>
					<span className="px-2 py-1 rounded-full border border-[#1c2a45] text-slate-400 font-mono">
						{new Date(now).toLocaleTimeString()}
					</span>
				</div>
			</header>

			<main className="grid grid-cols-[1fr_340px] gap-4 p-4">
				<section className="rounded-2xl border border-[#1c2a45] bg-[#0a1120] p-2 overflow-hidden">
					<svg ref={svgRef} viewBox="0 0 1200 920" className="w-full h-auto select-none">
						<style>{`
							.lane-base { fill:none; stroke-width:3; opacity:0.18; }
							.lane-flow { fill:none; stroke-width:2; stroke-dasharray:10 14; opacity:0.75; animation: dashflow 1.6s linear infinite; }
							@keyframes dashflow { to { stroke-dashoffset: -48; } }
							.mdns { fill:none; stroke:#f59e0b; stroke-width:2; stroke-dasharray:2 8; opacity:0.85; animation: dashflow 2.4s linear infinite; }
							.blocked { fill:none; stroke:#ef4444; stroke-width:2.5; stroke-dasharray:6 10; opacity:0.7; animation: dashflow 1.2s linear infinite; }
							.node-card { cursor:pointer; }
							.node-card:hover .card-bg { stroke:#38bdf8; }
							.shield-hit circle { fill:#7f1d1d !important; }
							.ctrl { fill:none; stroke:#22d3ee; stroke-width:1; stroke-dasharray:2 6; opacity:0.4; animation: dashflow 3s linear infinite; }
							.temp-link { fill:none; stroke:#22c55e; stroke-width:2; stroke-dasharray:4 8; opacity:0.9; animation: dashflow 1s linear infinite; }
						`}</style>

						<g>
							<rect x={240} y={14} width={720} height={150} rx={26} fill="#0b1322" stroke="#1f3a5f" />
							<text x={600} y={40} textAnchor="middle" fontSize={11} fontWeight={800} letterSpacing={3} fill="#38bdf8">
								CLOUDFLARE EDGE · FREE-TIER OFFLOAD PLANE
							</text>
							{[
								{ x: 262, t: "Tunnel", s: "cloudflared · QUIC", i: <Cloud key="c" size={16} /> },
								{ x: 434, t: "Gateway 1.1.1.3", s: "DNS L7 filtering", i: <ShieldAlert key="s" size={16} /> },
								{ x: 606, t: "Workers AI", s: "L7 flow classifier", i: <Activity key="a" size={16} /> },
								{ x: 778, t: "Outage Oracle", s: "cron 5m · Radar+RSS", i: <Wifi key="w" size={16} /> },
							].map((b) => (
								<g key={b.t}>
									<rect x={b.x} y={58} width={156} height={78} rx={12} fill="#0d1526" stroke="#1c2a45" />
									<foreignObject x={b.x + 12} y={70} width={24} height={24} className="text-sky-400">
										{b.i}
									</foreignObject>
									<text x={b.x + 44} y={82} fontSize={12} fontWeight={700} fill="#e6edf7">{b.t}</text>
									<text x={b.x + 44} y={98} fontSize={9.5} fill="#8aa0bf">{b.s}</text>
								</g>
							))}
						</g>

						{(Object.keys(ZONE_META) as ZoneId[]).map((z, i) => {
							const x = 24 + i * 390;
							const m = ZONE_META[z];
							return (
								<g key={z}>
									<rect x={x} y={496} width={372} height={396} rx={18} fill={m.tint} stroke={m.stroke} strokeWidth={1.5} />
									<text x={x + 18} y={527} fontSize={13} fontWeight={800} fill="#e6edf7" letterSpacing={1}>{m.label}</text>
									<text x={x + 18} y={544} fontSize={9.5} fill="#8aa0bf" fontFamily="monospace">{m.sub}</text>
								</g>
							);
						})}

						<g>
							{devices.map((d) => (
								<g key={d.id}>
									<path
										ref={(el) => { laneRefs.current[d.id] = el; }}
										d={LANE_PATHS[d.id]}
										className="lane-base"
										stroke={LANE_META[d.lane].color}
									/>
									<path d={LANE_PATHS[d.id]} className="lane-flow" stroke={LANE_META[d.lane].color} />
								</g>
							))}
							<path d={MDNS_PATH} className="mdns" />
							<text x={400} y={446} textAnchor="middle" fontSize={9.5} fill="#f59e0b" fontFamily="monospace">
								mDNS UDP 5353 · umdns reflection (mgmt ⇄ media)
							</text>
							<path ref={blockedPathRef} d={BLOCKED_PATH} className="blocked" />
						</g>

						<g ref={particleLayer} />

						<g ref={shieldRef} className="shield">
							<circle cx={600} cy={834} r={20} fill="#450a0a" stroke="#ef4444" strokeWidth={1.5} />
							<ShieldAlert size={20} x={590} y={824} className="text-red-400" />
							<text x={600} y={872} textAnchor="middle" fontSize={9.5} fontWeight={800} fill="#f87171" letterSpacing={1}>
								LATERAL DROP · {blockedCount} blocked
							</text>
							<text x={600} y={886} textAnchor="middle" fontSize={8.5} fill="#8aa0bf" fontFamily="monospace">
								nft counter avanza_lateral_blocked · fw4 iot→mgmt/media REJECT
							</text>
						</g>

						<g className="node-card" onClick={() => setSelectedId("router")}>
							<rect x={470} y={252} width={260} height={112} rx={14} fill="#0d1526" stroke={selectedId === "router" ? "#38bdf8" : "#1c2a45"} strokeWidth={selectedId === "router" ? 2 : 1} className="card-bg" />
							<RouterIcon size={20} x={486} y={268} className="text-emerald-400" />
							<text x={514} y={283} fontSize={13} fontWeight={800} fill="#e6edf7">{ROUTER_NODE.name}</text>
							<text x={486} y={302} fontSize={9.5} fill="#8aa0bf" fontFamily="monospace">OpenWrt 25.12.6 · fw4 · apk</text>
							<g fontSize={8.5} fontWeight={700}>
								{["CAKE 400/20", "umdns", "extroot 7.1G", "cloudflared"].map((b, i) => (
									<g key={b}>
										<rect x={486 + i * 58} y={316} width={54} height={16} rx={8} fill="#111c33" stroke="#1c2a45" />
										<text x={486 + i * 58 + 27} y={327} textAnchor="middle" fill="#7dd3fc">{b}</text>
									</g>
								))}
							</g>
							<text x={486} y={352} fontSize={9} fill="#8aa0bf" fontFamily="monospace">RAM 96/128MB · load 0.42 · ct 1284/8192</text>
						</g>

						{devices.map((d) => {
							const pos = NODE_POS[d.id];
							const Icon = d.icon;
							const laneColor = LANE_META[d.lane].color;
							const isSel = selectedId === d.id;
							const temp = tempAccess[d.id];
							const tempActive = temp && temp > now;
							return (
								<g key={d.id} className="node-card" onClick={() => setSelectedId(d.id)}>
									{tempActive && phone && (
										<path
											className="temp-link"
											d={`M ${phone.x + 78} ${phone.y + 44} L ${pos.x + 78} ${pos.y + 44}`}
										/>
									)}
									<rect className="card-bg" x={pos.x} y={pos.y} width={156} height={88} rx={12} fill="#0d1526" stroke={isSel ? "#38bdf8" : tempActive ? "#22c55e" : "#1c2a45"} strokeWidth={isSel || tempActive ? 2 : 1} />
									<foreignObject x={pos.x + 12} y={pos.y + 12} width={22} height={22} style={{ color: laneColor }}>
										<Icon size={20} />
									</foreignObject>
									<text x={pos.x + 42} y={pos.y + 24} fontSize={11.5} fontWeight={700} fill="#e6edf7">{d.name}</text>
									<text x={pos.x + 42} y={pos.y + 38} fontSize={9} fill="#8aa0bf" fontFamily="monospace">{d.ip}</text>
									<circle cx={pos.x + 140} cy={pos.y + 16} r={4} fill={laneColor} />
									<text x={pos.x + 12} y={pos.y + 62} fontSize={8.5} fontWeight={800} fill={laneColor} letterSpacing={0.5}>
										{LANE_META[d.lane].label}
									</text>
									<text x={pos.x + 12} y={pos.y + 78} fontSize={8.5} fill="#8aa0bf" fontFamily="monospace">
										{tempActive ? `🔓 temp access ${Math.ceil((temp - now) / 1000)}s` : `priv ${d.privacy.grade} · ${d.mac.slice(0, 8)}…`}
									</text>
								</g>
							);
						})}
					</svg>
				</section>

				<aside className="rounded-2xl border border-[#1c2a45] bg-[#0a1120] p-4 flex flex-col gap-3 overflow-y-auto max-h-[calc(100vh-120px)]">
					{!selected ? (
						<div className="text-slate-400 text-sm">
							<p className="font-black tracking-widest text-[10px] text-slate-500 mb-2">INSPECTOR</p>
							Click any node on the topology — router, Fire TV, console, camera — to inspect its
							privacy footprint, L7 lane assignment, and grant temporary phone access.
							<div className="mt-4 grid grid-cols-2 gap-2 text-[11px]">
								<div className="rounded-lg border border-[#1c2a45] p-2">🎮 realtime <b className="text-emerald-400">{stats.pps} pps</b></div>
								<div className="rounded-lg border border-[#1c2a45] p-2">📺 bulk video <b className="text-violet-400">{stats.mbps} Mb/s</b></div>
								<div className="rounded-lg border border-[#1c2a45] p-2">🔒 blocked <b className="text-red-400">{blockedCount}</b></div>
								<div className="rounded-lg border border-[#1c2a45] p-2">🟡 mDNS <b className="text-amber-400">{stats.mdns}/s</b></div>
							</div>
						</div>
					) : (
						<>
							<div className="flex items-center gap-2">
								<selected.icon size={22} className="text-sky-400" />
								<div>
									<p className="font-extrabold text-slate-100 text-sm">{selected.name}</p>
									<p className="font-mono text-[10px] text-slate-500">
										{selected.ip} · {selected.mac} · {ZONE_META[selected.zone].label}
									</p>
								</div>
							</div>

							<div className="rounded-xl border border-[#1c2a45] p-3">
								<p className="text-[9px] font-black tracking-[0.2em] text-slate-500 mb-1">PRIVACY FOOTPRINT</p>
								<div className="flex items-center gap-3">
									<span className="text-xl font-black text-emerald-400 border-2 border-emerald-500/40 rounded-lg px-2 py-1">
										{selected.privacy.grade}
									</span>
									<p className="text-[11px] text-slate-400">{selected.privacy.note}</p>
								</div>
								<p className="text-[10px] text-slate-500 mt-2">Destinations: {selected.privacy.destinations.join(" · ")}</p>
								<p className="text-[10px] text-slate-500">Collects: {selected.privacy.collects.join(" · ")}</p>
							</div>

							{selected.id !== "router" && (
								<div>
									<p className="text-[9px] font-black tracking-[0.2em] text-slate-500 mb-1">LAYER 7 PRIORITY LANE</p>
									<div className="grid grid-cols-2 gap-1.5">
										{(Object.keys(LANE_META) as LaneId[]).map((lane) => (
											<button
												key={lane}
												onClick={() => setLane(selected.id, lane)}
												className={`text-[10px] font-bold rounded-lg border px-2 py-2 transition-colors ${
													(selected as DeviceNode).lane === lane
														? "bg-[#111c33]"
														: "border-[#1c2a45] text-slate-500 hover:text-slate-300"
												}`}
												style={(selected as DeviceNode).lane === lane ? { borderColor: LANE_META[lane].color, color: LANE_META[lane].color } : undefined}
											>
												{LANE_META[lane].label}
											</button>
										))}
									</div>
								</div>
							)}

							{selected.id !== "router" && (
								<button
									onClick={() => toggleTempAccess(selected.id)}
									className={`rounded-xl border px-3 py-3 text-[11px] font-black tracking-wide transition-colors ${
										tempAccess[selected.id] && tempAccess[selected.id] > now
											? "bg-emerald-500 text-emerald-950 border-emerald-500"
											: "border-emerald-500/60 text-emerald-400 hover:bg-emerald-500/10"
									}`}
								>
									{tempAccess[selected.id] && tempAccess[selected.id] > now ? (
										<span className="flex items-center justify-center gap-2">
											<KeyRound size={14} /> PHONE ACCESS GRANTED ·{" "}
											{Math.floor((tempAccess[selected.id] - now) / 60000)}:
											{String(Math.floor(((tempAccess[selected.id] - now) % 60000) / 1000)).padStart(2, "0")} — tap to revoke
										</span>
									) : (
										<span className="flex items-center justify-center gap-2">
											<Lock size={14} /> GRANT TEMPORARY PHONE ACCESS (15 MIN)
										</span>
									)}
								</button>
							)}
						</>
					)}

					<div className="mt-auto rounded-xl border border-[#1c2a45] bg-[#060913] p-2 font-mono text-[9.5px] leading-4 text-emerald-300/80 max-h-44 overflow-y-auto">
						{log.map((l, i) => (
							<p key={i}>{l}</p>
						))}
					</div>
				</aside>
			</main>
		</div>
	);
}
