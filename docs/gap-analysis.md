# SPEC GAP ANALYSIS — end-to-end review vs. the consumer/enthusiast router feature spec

Status legend: ✅ shipped in v1 · 🆕 added in this revision (file paths listed) · 📄 documented recipe (RAM/hardware-conscious, in READMEs) · ⛔ excluded with reason

## 🛡️ Security & Access Control

| Spec item | v1 status | Resolution |
|---|---|---|
| Guest Network (isolated visitor SSID) | ❌ missed | 🆕 4th fw4 zone `guest` (192.168.40.0/24, input DROP + DHCP/DNS/NTP-only, forward DROP, masq, client isolation, no umdns reflection) — `configs/firewall.yml`, provisioning + DHCP batch in `avanza-router-core/README.md` §1b, guest zone rendered in artifact + Devices tab |
| Parental Controls — internet pause / block per device | ❌ missed | 🆕 `pause`/`resume` agent actions → snapshot-first UCI REJECT rule (`rule_avanza_pause_<ip>`), TTL or indefinite, auto-expiry in agent loop — `router/lightweight_agent.sh`, Worker `POST /api/control/pause`, artifact Inspector + Devices tab, app inspector button |
| Parental Controls — content filtering | ✅ partial (1.1.1.3 family DNS) | 🆕 UI-level control: Security tab DNS-filter level switch (Off/Malware/Family) mapping to real `https-dns-proxy` UCI; per-child profiles documented as Zero-Trast Gateway upgrade path |
| Parental Controls — screen time tracking | ❌ missed | 🆕 per-device `bytes_today` + first/last-seen in DO device registry (`/api/devices`), shown in artifact Devices tab + app; `nlbwmon` documented for per-host/per-protocol historical accounting |
| Firewall & security suite one-click toggles | ❌ missed (engine existed, no surface) | 🆕 artifact **Security tab**: DNS filter level, adblock-fast, hardcoded-DNS hijack, WireGuard server, tunnel, posture table, live `avanza_lateral_blocked` counter — each toggle logs the exact UCI/apk/fw4 command it represents |
| Ad-blocking & DNS encryption (spec §💎) | ✅ partial (DoH only) | 🆕 `adblock-fast` recipe (RAM-safe lists on Extroot) + 🆕 DNS-hijack DNAT redirects for hardcoded-DNS devices (Roku/Google/Camera class) as a first-class `redirects:` section — `configs/firewall.yml`, transpiler extended |

## 🚀 Performance & Optimization

| Spec item | v1 status | Resolution |
|---|---|---|
| QoS priority interface | ✅ lane control per node | 🆕 Performance tab adds lane **rosters** (live membership per EF/AF41/CS1 lane) + CAKE/bufferbloat status card |
| Band steering (Smart Connect) | ❌ missed | 📄+🆕 `usteer` (the OpenWrt answer to Smart Connect: ~small C daemon, 802.11k/v assisted steering) + same-SSID dual-band + 802.11r recipe — README §6; status/toggle card in Performance tab. True vendor-style server-side steering doesn't exist in OpenWrt; usteer + k/v/r is the honest equivalent |
| Speed test from the router | ❌ missed | 🆕 `scripts/speedtest.sh` (zero new deps: `uclient-fetch` against `speed.cloudflare.com`, `/proc/uptime` timing — no Ookla binary exists for MIPS) + full loop: app/artifact button → Worker `POST /api/control/speedtest` → DO action queue → agent runs it → result rides next telemetry → KV `speedtest:latest` → `GET /api/speedtest` → UI cards |
| Multi-WAN failover / USB tethering (spec §💎) | ❌ missed | 📄+🆕 `mwan3` recipe with wan (PPPoE) + wanb (USB tether `rndis`/NCM or 4G dongle), tracked failover that coordinates with the outage oracle; Multi-WAN card in Performance tab. Excluded from default install: mwan3 + a second uplink is optional hardware |

## 📱 Device & Network Management

| Spec item | v1 status | Resolution |
|---|---|---|
| Network map / client list w/ nickname + block | ✅ topology artifact | 🆕 **Devices tab**: full registry table (name, IP, MAC, zone, lane, MB today) with rename (writes DHCP host record), pause/block, and inspect actions |
| Mesh / node wizard | ⛔ excluded | Single SoC, two radios: this hardware cannot be a mesh node+backhaul sensibly. Documented roadmap: wired APs + `usteer`, or 802.11s/wpad-mesh on added hardware |
| USB sharing / media server | ❌ missed | 📄 `ksmbd` (in-kernel SMB — the only RAM-honest option at 128 MB) + miniDLNA recipe, with the Extroot caveat: share a second partition/stick, never the extroot partition itself — README §8 |

## 🛠️ Maintenance & Support

| Spec item | v1 status | Resolution |
|---|---|---|
| Firmware updates (one-button check/install) | ❌ missed | 🆕 Oracle checks the official ASU `versions.json` daily for `ath79/generic · tplink_archer-c7-v5`, compares against the agent-reported `openwrt_version`, publishes `GET /api/firmware/status`; Maintenance tab check button + pill. Install itself stays a deliberate `owut` / attended-sysupgrade step (documented) — auto-flashing a 16 MB-flash router from a dashboard is how bricks happen |
| Backup & restore | ✅ partial (rollback snapshots) | 🆕 full loop: `POST /api/control/backup` → agent `tar czf /etc/config | base64` (≈15–30 KB) rides next telemetry → KV `backup:latest` → app/artifact download (real file) or `POST /api/control/restore` → agent snapshots, extracts, reloads, arms the 10-min rollback watchdog. Maintenance tab exposes all of it + the snapshot list |

## 💎 First-class enthusiast features

| Spec item | v1 status | Resolution |
|---|---|---|
| WireGuard server & client | ✅ tools, ❌ no config | 📄+🆕 full WG **server** UCI batch (udp/51820, phone peer, QR-able) + whole-house WG **client** via `pbr` policy routing recipe — README §7; Security tab shows peers/handshake |
| True SQM (CAKE/FQ-CoDel) | ✅ shipped | — (CAKE + diffserv3 + host fairness; FQ-CoDel fallback documented) |
| VLAN segmentation | ✅ shipped | 📄 extended: bridge-vlan trunk batch (VLAN 10/20/30/40 tagged to a wired AP) — README §1 |
| Granular traffic inspection / per-device data | ✅ partial (top-24 digest) | 🆕 DO registry tracks per-device bytes/day + destinations; `nlbwmon` documented for deep per-protocol history on Extroot |
| Unlock hardware / package library / longevity | ✅ shipped | apk-based install lists, 25.12 support window |

## Verification added this revision

- Transpiler extended (`redirects:` → `firewall.redirect`) and re-tested dry-run: 5 zones, 6 forwards, 17 rules, 3 redirects, sqm, umdns.
- Agent: `sh -n` clean; new action dispatch (speedtest/backup/restore/pause/resume) + pause expiry integrated into the rollback matrix.
- Worker + app: strict `tsc` clean again after all edits; SDUI program still parses (contract unchanged).
- Artifact JS: `node --check` clean; now 5 tabs, 4 zones, 12 devices.
