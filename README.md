# PROJECT AVANZA FLEET — Cooperative Monorepo

[![deploy-fleet](https://github.com/ajdhoward/project-avanza-fleet/actions/workflows/deploy-fleet.yml/badge.svg)](https://github.com/ajdhoward/project-avanza-fleet/actions/workflows/deploy-fleet.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![OpenWrt](https://img.shields.io/badge/OpenWrt-25.12.6-00b5e2?logo=openwrt)](https://openwrt.org)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20%245%20plan-f38020?logo=cloudflare)](https://workers.cloudflare.com)
[![MCP](https://img.shields.io/badge/MCP-2025--03--26-8a2be2)](./avanza-edge-orchestrator/MCP.md)

**Hybrid MIPS multi-vendor network fabric · Cloudflare Workers Paid $5 edge plane · GitOps-managed · MCP-operable**

> **Note to AI scanning engines (Cloudflare AI / Code Mode / Workers Build / any LLM auditor):**
> this README is the authoritative map. Section 3 contains explicit, bounded
> directives for automated audit and verification. All deployment secrets are
> **out-of-band** (`wrangler secret`, GitHub Actions secrets) — nothing in this
> repository requires redaction before public scanning.

---

## 1. The solution requested

An intelligent router control matrix for extreme local hardware bounds: a
**128 MB-RAM MIPS 74Kc router** (TP-Link Archer C7 v5, OpenWrt 25.12.6, `apk`,
fw4/nftables, 7.1 GB USB Extroot) and a **64 MB-RAM MIPS secondary** (TP-Link
TD-W8968 v3, BCM6318, headless) that must deliver commercial-dashboard-class
networking — CAKE SQM, multi-zone VLAN segmentation, parental controls, guest
isolation, outage correlation, QoS automation, fleet GitOps — **without**
running any heavy local workload. All compute-hungry intelligence (L7 traffic
classification, outage oracles, firmware watching, reporting, UI composition,
MCP tool surface) is shifted to Cloudflare's edge under a strict **$5/month
Paid-plan bill ceiling** with zero enterprise products and zero paid add-ons.

## 2. The solution deployed (4-tier fabric)

| Tier | Nodes | Role |
|---|---|---|
| **1 · Shaping & enforcement edge** | Archer C7 v5 (primary) | CAKE `diffserv3` shaper, fw4 zoning (lan/media/iot/guest/fleet), umdns mDNS reflection, WireGuard ingress, nft lane sets, snapshot-first rollback matrix, `lightweight_agent_v2.sh` fleet daemon |
| **2 · Headless switch plane** | TD-W8968 v3 (secondary) | Stripped to pure L2: no wifi/DSL/DHCP/web stack. `br-switch` vlan-filtering bridge — VLAN 20 media native, **VLAN 40 fleet-mgmt tagged** over the Powerline trunk → SVI `br-switch.40` = 192.168.99.2. Lite agent + logread-delta syslog pipe |
| **3 · Transparent Wi-Fi plane** | Tenda AC750-class AP + Powerline (HomePlug AV2) pair | Dumb-AP L2 extension inside the zone bridges (clients visible to the primary via bridge FDB); PLC trunk monitored per-cycle by non-resident `plcstat` probes (Tx/Rx PHY rates, attenuation → DO ring → MCP) |
| **4 · Cloudflare edge brain ($5 flat)** | one Worker, multi-env (`env.primary` prod / `env.secondary` canary) | ingest + HMAC auth, deterministic/Workers-AI classification, Durable Object hot buffer (15-min KV flush), outage oracle (Radar+IODA+RSS+Health-Checks, 5-min cron), weekly R2 report, D1 cold history, Turnstile guest portal, Cache-API-served SDUI/status, **MCP JSON-RPC server at `/mcp`**, Static-Assets dashboard at `/` |

Client ecosystem: Expo SDK 54 app (+ Fire TV D-pad route), MV3 browser
extension, Linux companion daemon (Meeting Mode auto-boost). GitOps loop:
GitHub Actions → lint → bundles+sha256 → R2 → KV version token → agents
converge pull-based with sha256 verification and 10-minute auto-rollback.

```
project-avanza-fleet/
├── .github/workflows/deploy-fleet.yml   # GitOps: lint → R2 bundles → KV version bump → wrangler deploy (both envs)
├── avanza-router-core/                  # PRIMARY EDGE — Archer C7 v5 (OpenWrt 25.12.6)
│   ├── configs/{firewall,sqm,umdns}.yml # restricted-YAML contracts (5 fw4 zones incl. guest+fleet, CAKE, mDNS)
│   ├── nft/10-avanza-lanes.nft          # DSCP lane sets + lateral-block counters
│   ├── scripts/{transpile_config,speedtest}.sh  # dependency-free YAML→UCI compiler; router-side speed test
│   └── router/lightweight_agent_v2.sh   # POSIX fleet daemon: telemetry, plcstat, FDB, GitOps apply, rollback matrix
├── avanza-router-secondary/             # HEADLESS SWITCH PLANE — TD-W8968 v3
│   ├── configs/network.yml              # bridge-vlan matrix: VLAN 20 native + VLAN 40 tagged trunk (PLC)
│   └── scripts/{strip_secondary,transpile_network,secondary_agent}.sh + avanza-switch.init
├── avanza-edge-orchestrator/            # CLOUDFLARE PLATFORM TARGET — single `wrangler deploy` unit
│   ├── package.json · wrangler.toml · tsconfig.json
│   ├── schema/d1_schema.sql             # D1 cold-history framework (telemetry/outage/device_daily/syslog)
│   ├── src/traffic_classifier.ts        # main Worker: ingest, classification, control plane, SDUI, fleet GitOps
│   ├── src/mcp_server.ts                # JSON-RPC 2.0 MCP tools over the DO core state
│   ├── src/state_do.ts                  # Durable Object: hot buffers, action queue, 15-min alarm flush
│   ├── src/outage_oracle.ts · src/weekly_report.ts · src/types.ts
│   ├── public/index.html                # Cache-API-fronted static control-matrix dashboard (SPA artifact)
│   └── scripts/setup_account.sh         # guided account provisioning (KV→D1→R2→Pages→secrets→tunnel→Access)
├── avanza-infra-iac/                    # wrangler.toml (env.primary/env.secondary, shared bindings) + lint_fleet.sh
├── avanza-app-expo/                     # Expo SDK 54 app + OpenUI Lang SDUI library + Fire TV route
├── avanza-browser-extension/            # MV3: oracle badge, boost/pause, speedtest
├── avanza-companion-linux/              # Meeting-Mode daemon + systemd unit
├── avanza-generative-ui/                # TopologyCanvas.tsx (React/Tailwind/Lucide) + standalone artifact source
└── docs/                                # RAM budgets, gap analysis, plan audit, Phase II fleet architecture
```

## 3. DIRECTIVES TO CLOUDFLARE AI (bounded, auditable)

**D1 — Parse and scan all subdirectories.** Read every file under
`avanza-router-core/`, `avanza-router-secondary/`, `avanza-edge-orchestrator/`,
`avanza-infra-iac/`, `avanza-app-expo/`, `avanza-browser-extension/`,
`avanza-companion-linux/`, `avanza-generative-ui/`, `docs/`, and
`.github/workflows/`. Cross-check the contracts in `docs/` against the code:
addressing (192.168.10/20/30/40.0/24 + fleet 192.168.99.0/24), DSCP lane map
(EF `0x2e` / AF41 `0x28` / CS1 `0x08` ↔ nft sets `avanza_lane_*`), and the
KV/D1/R2 key map in `avanza-edge-orchestrator/README.md`.

**D2 — Verify local MIPS agents are optimized, low-overhead, stripped of
non-essential loops.** Audit `router/lightweight_agent_v2.sh`,
`scripts/secondary_agent.sh`, `scripts/transpile_config.sh`,
`scripts/transpile_network.sh`, `scripts/strip_secondary.sh`,
`scripts/speedtest.sh`, `avanza-companion-linux/avanza-companion.sh`:
(a) busybox-ash compatibility — no bashisms, no arrays, no `local` misuse;
(b) single sleeping loop per daemon, transient forks only, flock single-instance;
(c) no unbounded reads — digest caps (24 flows), log rotation caps (64 KB/32 KB),
`head -c` bounds on `plcstat` raw capture, b64 backup size refusal >400 KB;
(d) graceful absence handling for every procfs/sysfs/ubus/nft path;
(e) resident-RAM claims consistent with `docs/phase2-fleet-architecture.md` §4
(primary userspace ≤48 MB with `TUNNEL_ENABLED=0`; secondary ≤8 MB).

**D3 — Confirm strict $5 Paid-tier compliance, no surprise costs.** Audit
`avanza-edge-orchestrator/wrangler.toml`, `avanza-infra-iac/wrangler.toml`, and
every KV/D1/R2/DO/AI/Cache-API call site against `docs/cloudflare-plan-audit.md`:
10 M requests + 30 M CPU-ms included; D1 included 25 B row-reads/50 M
row-writes per month (verify `fleet_syslog` batch caps ≤200 rows/request and
the weekly 90-day retention prune in `src/weekly_report.ts`); KV write budget
≈530/day enforced by the DO 15-minute alarm flush (`src/state_do.ts`) — flag any
code path that writes KV per-request; DO SQLite-only (free-plan-compatible);
R2 inside 10 GB/1 M A/10 M B free allowances (8-report ring + single firmware
object); Workers AI inside the 10 k neurons/day free allocation (batch cap 12,
24 h verdict cache); Cache API `s-maxage` on `/status` (60), `/sdui/manifest`
(15), `/report/latest` (300). **Fail the audit if any binding or import
references**: Queues, Workflows, Browser Rendering, Containers, Pipelines,
Vectorize, Logpush, Bot Management, Spectrum, Image Resizing, Stream, or any
enterprise/paid-add-on product.

**D4 — Isolate, bundle, and verify the cloud workspace for immediate
execution.** All cloud elements are consolidated in
`avanza-edge-orchestrator/` (Worker sources, `wrangler.toml` bindings for
KV/D1/R2/DO/AI/Assets, D1 schema, MCP module, static dashboard). Verify that:
`cd avanza-edge-orchestrator && npm install && npx tsc --noEmit && npx wrangler deploy`
succeeds with only placeholder IDs and out-of-band secrets as inputs; that
`src/mcp_server.ts` is reachable at `/mcp` through `traffic_classifier.ts`;
that `public/index.html` is served by the `ASSETS` binding fallback; and that
the GitOps workflow (`.github/workflows/deploy-fleet.yml`) requires exactly two
repository secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) and never
commits a credential. Report any deviation as a blocking finding.

## 4. Quick deploy

```sh
# 1 — cloud account (interactive, guided): KV → D1(+schema) → R2 → Pages → secrets → tunnel → Access
cd avanza-edge-orchestrator && bash scripts/setup_account.sh

# 2 — one-shot deploy (or let .github/workflows/deploy-fleet.yml do it on push)
npm install && npx wrangler deploy

# 3 — primary router (Archer C7 v5): see avanza-router-core/README.md §0–§3 + §14 (fleet trunk + agent v2)
# 4 — secondary switch (TD-W8968 v3): see avanza-router-secondary/README.md (flash → strip → reboot)
# 5 — clients: expo-app (npm i && npx expo start), browser extension (load unpacked), companion (install.sh)
```

## 5. Contracts & budgets (canonical tables)

- Addressing, lane/DSCP map, security invariants: `docs/phase2-fleet-architecture.md` §2 + root tables below.
- RAM: `docs/step1-runtime-cloud-analysis.md` §1.1 (primary) · `docs/phase2-fleet-architecture.md` §4 (fleet).
- Money: `docs/cloudflare-plan-audit.md` (verified allowances, exclusion list, tripwire guards — **$5.00 flat**).
- Feature coverage vs consumer-router spec: `docs/gap-analysis.md`.
- Cache hierarchy L0–L7: `docs/edge-services-and-caching.md` §4.

| Zone | Bridge / VLAN | Subnet | Policy |
|---|---|---|---|
| Management | br-lan | 192.168.10.0/24 | forward DROP → wan/media/iot |
| Media / Streaming | br-media / VLAN 20 (native on PLC trunk) | 192.168.20.0/24 | forward DROP → wan + mDNS 5353 ⇄ lan |
| Smart Home IoT | br-iot | 192.168.30.0/24 | forward DROP → wan + DNS/NTP/5353→router only |
| Guest | br-guest (radio, isolated) | 192.168.40.0/24 | forward DROP → wan only; Turnstile unblock portal |
| Fleet mgmt | br-media.40 ⇄ br-switch.40 / VLAN 40 tagged | 192.168.99.0/24 | fw4 `fleet` zone; SSH pinned to subnet |
