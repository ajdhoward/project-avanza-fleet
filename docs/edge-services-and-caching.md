# EDGE SERVICES, CLIENT ECOSYSTEM & CACHE ARCHITECTURE

Expansion layer for Project Avanza: Powerline (PLC) integration, full Cloudflare
account layering, companion clients (browser extension, Linux daemon, Fire TV),
and a seven-level cache hierarchy.

---

## 1. Powerline (PLC) adapters in the Avanza topology

**Role:** wired backhaul over house electrical wiring — the bridge between
"Ethernet cable where I need it" and "Wi-Fi for the Fire TV". Best use here:
router (Management) → Media zone, giving the Fire TV and console a *wired*
drop without pulling Cat6.

### Physical rules that decide success
1. **Same electrical phase/circuit group.** PLC pairs across different phases
   lose 40–70 % throughput. In a typical home, router room and living room on
   the same ring main = fine.
2. **Wall sockets only.** No power strips, no surge protectors, no UPS — the
   filtering capacitors eat the 2–68 MHz carrier. Passthrough-socket adapters
   (TL-PA9020P class) let the strip hang off the adapter, not the other way.
3. **Noise sources:** switching PSUs, LED dimmers, phone chargers, fridges.
   The artifact's PLC card reports attenuation; > 8 dB usually means relocate.
4. **Real vs rated:** AV2000 (≈ 110 MB/s theoretical) delivers ~90–190 Mbps
   in good conditions — still 3–8× a 5 GHz Wi-Fi link at distance, with a
   fraction of the jitter.

### How PLC fits the Avanza design (important specifics)
- **CAKE still rules.** The shaper lives at the router's WAN egress; PLC is
  just a LAN wire. Bufferbloat introduced by cheap PLC internal queues is
  minimal (small buffers), and any LAN-side congestion is absorbed by CAKE's
  AQM on the way out. No config change needed.
- **Zones are bridges, not cables.** A PLC pair is a transparent L2 segment:
  plug the far adapter into the Media zone's bridge port (lan2/lan3) and the
  Fire TV/console plug into the far adapter (or its built-in switch). The
  devices land in `192.168.20.0/24` exactly like copper.
- **VLAN trunking caveat:** consumer unmanaged PLC passes *untagged* frames
  only — one pair = one zone. To trunk VLANs 10/20/30/40 over one PLC pair you
  need VLAN-aware adapters (TL-PA9025P KIT style with multi-SSID/VLAN mapping)
  or one pair per zone. Provisioning stays the README §1 bridge-vlan batch.
- **Latency budget:** PLC adds ~1–3 ms + jitter under load. The console's EF
  lane (CAKE voice tin) protects game UDP even when the Fire TV saturates the
  same PLC link — this is exactly the host-fairness case CAKE was built for.
- **mwan3 note:** PLC is LAN-side, not a WAN member. Never put a PLC segment
  in the mwan3 track list — its brownouts look like ISP outages and would
  poison the oracle correlation.
- **Security:** modern kits use AES-128 pairing (press-pair button within
  2 min). Pair *before* plugging into shared building wiring (apartments!) —
  an unpaired adapter on the same phase can join your L2. Set a private
  network name (nmk) via `open-plc-utils` if you want paranoia mode:
  `apk add open-plc-utils` → `amphost`/`setkey` tooling, or vendor utility.

### Where it shows up
- Artifact: amber dotted **PLC backhaul** link router → Media zone + a
  Performance-tab card (pair rate, attenuation, phase warning).
- `avanza-router-core/README.md` §13: placement checklist + bridge mapping.

---

## 2. Cloudflare account layering (free-tier map)

What each service does for Avanza and why it's on/off:

| Service | Free tier | Avanza role | Status |
|---|---|---|---|
| Workers | 100k req/day | ingest, classifier, control plane, SDUI emitter | ✅ live |
| Workers AI | 10k neurons/day | ambiguous-flow classification (llama-3.2-3b) | ✅ live |
| KV | 100k R / 1k W/day | verdicts, outage state, config, push tokens | ✅ live |
| Durable Objects | 100k req/day | hot telemetry buffer, action queue, device registry | ✅ live |
| **D1 (SQLite)** | 5 GB, 5M reads/100k writes/day | cold history: telemetry 15-min buckets, outage events, per-device daily bytes → screen-time graphs | 🆕 `schema.sql` + guarded writes |
| **R2** | 10 GB, free egress | config backups (binary, not KV strings) **and a local mirror of the OpenWrt sysupgrade image** → LAN-speed firmware restores | 🆕 binding + backup path |
| **Cache API** | free | edge-cached `/sdui/manifest` (15 s) and `/api/outage/status` (60 s) → app polls cost ~0 origin work | 🆕 implemented |
| Pages | free | hosts the generative-ui dashboard/artifact at `avanza.pages.dev` | 🆕 in setup script |
| Tunnel (cloudflared) | free | egress-only remote access | ✅ live |
| Zero Trust **Access** | 50 users | gate the Pages dashboard + any router web surface behind SSO/MFA | 📄 setup script prints policy steps |
| **WARP** client | free | per-device (laptop/phone) encrypted egress + Gateway identity **without** routing through the C7's CPU | 📄 recommended for road devices |
| Health Checks | 1000 checks | external probe of your tunnel hostname → independent WAN-up signal for the oracle | 📄 curl recipe in setup script |
| Gateway 1.1.1.3 | free | DNS L7 filtering | ✅ live |
| Radar API | free w/ token | regional internet-quality signal | ✅ live |
| Queues | paid-ish limits | multi-router fleets (batch ingest) — **not** used, DO covers it | ⛔ |
| Browser Rendering | free tier | weekly PDF network report (roadmap) | 🔮 |
| Vectorize | free tier | flow-embedding similarity search "which device acts like the camera?" (roadmap) | 🔮 |
| Email Routing | free | outage digest to inbox (roadmap, Telegram already covers push) | 🔮 |

`avanza-edge-orchestrator/scripts/setup_account.sh` walks the whole provisioning
order against **your** account: login → KV → D1 (+schema apply) → R2 → Pages →
secrets → tunnel token → Health Check curl → Access policy checklist.

---

## 3. Client ecosystem ("apps that enhance the network")

All clients talk to the **orchestrator** (cloud), never directly to the router —
keeping the router egress-only and every client behind the same HMAC/app-token
auth. Changes reach the LAN on the agent's next 60 s cycle.

```
 Browser ext ─┐
 Linux daemon ─┤   app-token    ┌──────────────┐   HMAC    ┌─────────┐
 Phone (Expo) ─┼──────────────▶ │ Worker + DO  │ ◀──────── │  agent  │
 Fire TV app ─┘                │ KV/D1/R2/    │  actions  │ (router)│
                               │ Cache API    │ ─────────▶│ nft/uci │
                               └──────────────┘           └─────────┘
```

- **`avanza-browser-extension/`** (MV3, Chrome/Edge; FF note in README):
  badge shows oracle verdict color live; popup = device picker + 🎓 **Boost
  (priority 1 h)** / ⏸ Pause / ⚡ speedtest trigger / latest result; options
  page stores orchestrator URL + app token in `chrome.storage.sync`.
- **`avanza-companion-linux/`**: POSIX daemon + systemd unit. Registers the
  machine (`/api/control/register` → hostname in the device registry), then
  **Meeting Mode**: detects Zoom/Teams/Webex processes or live STUN/SIP flows
  (`:3478/:5060`), auto-requests the EF priority lane with TTL, releases it two
  clean cycles after the call ends; desktop notification when the oracle flips
  to `REGIONAL_OUTAGE` (so you stop rebooting your router during ISP outages).
- **Fire TV**: the Expo app gains a D-pad-first `tv` route (`app/tv.tsx`) —
  sideload the same APK (`adb install`), big focusable tiles: network status,
  **[⚡ Boost this TV]** (sets its own lane to video/priority for 2 h — the
  exact "app that works with the router" loop), speedtest results, cast hint
  (umdns reflection status). No separate codebase to maintain.
- **Phone**: already shipped (Expo SDK 54 + SDUI). New pause button and
  speedtest card wired this round.

---

## 4. Cache hierarchy (7 layers)

| L | Where | What | TTL / invalidation | Cost |
|---|---|---|---|---|
| 0 | router kernel | nft lane sets (verdict cache), conntrack, DSCP marks | set timeouts 900–3600 s; counters never invalidate | 0 |
| 1 | router userspace | dnsmasq DNS cache (1k entries), adblock-fast blocklist on Extroot, apk package cache | dnsmasq honors TTLs; lists refreshed 4 h | ~4 MB RAM, 0 flash wear (Extroot) |
| 2 | DO memory | device registry, digest ring, action queue, outage-local evidence | authoritative 15 min; best-effort `storage.put` | 0 writes |
| 3 | KV | AI class verdicts (24 h), outage state, config, push tokens | per-key `expirationTtl`; overwrite-on-change | ~530 writes/day |
| 4 | **D1** | telemetry history, outage events, per-device daily bytes | append-only; 90-day retention job | ~100 writes/day |
| 5 | **R2** | `backups/latest.tar.gz`, `firmware/openwrt-25.12.x-ath79-…-c7-v5-…bin` | versioned keys; firmware refreshed on ASU change | free egress |
| 6 | **Cache API** | `/sdui/manifest` (s-maxage 15), `/api/outage/status` (s-maxage 60), `/api/devices` (s-maxage 10, token-keyed) | TTL + explicit `caches.default.delete` on state change | 0 |
| 7 | clients | app: last-known SDUI program + device list rendered instantly (SWR) then refreshed; extension: `chrome.storage` outage snapshot; companion: lane state file | stale-while-revalidate; never blocks UI | 0 |

**Design laws:** the router caches *decisions* (kernel), the edge caches
*knowledge* (DO→KV→D1→R2 hot-to-cold), clients cache *presentation* (SWR).
Nothing that must be fresh (pause/revoke/rollback) is ever served from cache —
control-plane mutations bypass L4–L7 and ride the DO action queue.

**Firmware mirror detail (R2):** when the oracle sees a new ASU release it
downloads the sysupgrade image once into R2; a LAN device (or the router itself
via the tunnel) can pull it at local speed — 16 MB flash devices appreciate
this during outage windows, and it survives Cloudflare-status-page days less
well than it survives your ISP's.

---

## 5. Roadmap (not built, cheap to add)

1. **Queues** for fleet mode (multiple routers → one orchestrator).
2. **Browser Rendering**: cron-generated weekly PDF (traffic, blocks, outages)
   emailed via Email Routing.
3. **Vectorize**: embed flow digests; "devices that behave like X" anomaly
   detection (new camera firmware suddenly beaconing = flagged).
4. **Zero Trust posture**: WARP + Gateway per-device policy replacing the
   static app token for road devices.
5. **Turnstile** on the Pages dashboard login form if it's ever exposed
   publicly (it shouldn't be — Access-only).
