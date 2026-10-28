# avanza-generative-ui

Server-driven UI half of Project Avanza.

- **`artifacts/avanza-topology-matrix.html`** — the **zero-dependency standalone
  artifact** (inline CSS/SVG/JS, no CDN — opens anywhere, including sandboxed
  preview panes). This is the file to present/demo. Five sections behind a tab
  bar:
  - 🔍 **INSPECT** — click any of the 12 nodes (4 zones incl. Guest): privacy
    footprint + grade, Layer-7 lane segmented control, mDNS reflection switch,
    **parental pause/block** (snapshot-first UCI REJECT + countdown),
    **[Grant Temporary Phone Access]** with 15-min countdown and live green
    phone↔device key-link.
  - 🛡 **SECURITY** — DNS filter level (1.1.1.1/.2/.3 → `https-dns-proxy`),
    adblock-fast, hardcoded-DNS hijack, WireGuard server, tunnel toggles, full
    fw4 posture table, live lateral-block counter, guest isolation summary.
  - 🚀 **PERF** — CAKE/SQM status + re-measure, live QoS lane rosters,
    router-side **speed test** (phased progress → down/up/RTT + history),
    usteer band-steering card, mwan3 multi-WAN card with failover drill.
  - 📱 **DEVICES** — full client table (zone/lane/MB-today) with inspect,
    pause/resume and rename (DHCP host record) actions.
  - 🛠 **MAINT** — firmware (ASU daily check + `owut` hint), cloud **backup /
    download / restore**, rollback snapshot list with restore buttons, Extroot +
    KV-budget storage bars, agent health card.

- **`src/TopologyCanvas.tsx`** — the production *Living Topology* React component
  (Tailwind CSS utility classes + `lucide-react` icons): animated SVG lanes with
  requestAnimationFrame particles along `getPointAtLength`, zone separation,
  the red blocked-lateral path with a live `avanza_lateral_blocked` shield
  counter, the amber umdns mDNS-reflection arc, click-to-inspect nodes and a
  rolling agent/worker console. Drop it into any Tailwind v4 host
  (`import TopologyCanvas from "@avanza/generative-ui"`).

The visual language maps 1:1 to the runtime contracts:

| Visual | Real mechanism |
|---|---|
| 🎮 green lane + fast particles | DSCP EF `0x2e` → CAKE voice tin (console static rule + Worker directives via `avanza_lane_priority` nft set) |
| 📺 violet lane | DSCP AF41 `0x28` → CAKE video tin (`avanza_lane_video`) |
| 📦 amber IoT lanes | DSCP CS1 `0x08` → CAKE bulk tin (`avanza_lane_bulk`) |
| 🔴 dashed path + shield flash | `nft counter avanza_lateral_blocked` + fw4 zone-policy REJECT (iot→mgmt/media) |
| 🟡 dotted arc | umdns reflection br-lan⇄br-media + fw4 udp/5353 ACCEPT rules |
| 🔓 green key link | agent-added scoped UCI ACCEPT rule (phone→device, TTL'd, rollback-armed) |
| cyan hairlines to cloud | HMAC telemetry up / lane directives down / outage verdicts (cloudflared QUIC) |
| console ticker | real log lines emitted by `lightweight_agent.sh` + `traffic_classifier.ts` |

## Local preview

```sh
# artifact (no build step)
open artifacts/avanza-topology-matrix.html

# React component (host project with Tailwind + React 18/19)
npm i lucide-react
# then render <TopologyCanvas/> ; DEFAULT_DEVICES is exported for live-data wiring
```

To wire live data instead of the built-in simulation, replace `DEFAULT_DEVICES`
with a fetch of `GET /api/devices` from the orchestrator and feed
`blockedCount` from `qos.lateral_blocked_total` in the ingest response.
