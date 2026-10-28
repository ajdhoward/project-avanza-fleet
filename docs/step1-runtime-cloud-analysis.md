# STEP 1 — Lightweight Runtime & Cloud Service Analysis

Target: TP-Link Archer C7 v5 · QCA9563 @ 775 MHz (MIPS 74Kc) · **128 MB RAM** ·
16 MB NOR flash · OpenWrt 25.12.6 (`apk`, fw4/nftables) · 7.1 GB USB Extroot.

Critical constraint: **Extroot expands flash, not RAM.** Every resident process,
every loaded kernel module and every conntrack entry still lives in the same
128 MB. Package selection discipline is therefore the primary architectural lever.

---

## 1.1 Lightweight Package Selection Evaluation

### Steady-state RAM budget (measured-class estimates, headless)

| Component | RSS / kernel cost | Notes |
|---|---|---|
| Linux 74Kc kernel + ath79/ath9k drivers | ~34–40 MB | two radios, DMA rings |
| netifd + ubus + procd + odhcpd | ~5–7 MB | mandatory base |
| hostapd ×2 (wlan0/wlan1, WPA3-SAE) | ~12–18 MB | scales with client count |
| dnsmasq + https-dns-proxy | ~3–4 MB | DoH to 1.1.1.3 |
| nftables/fw4 ruleset (~180 rules) | ~2–4 MB | in-kernel, zero userspace |
| conntrack (limit 8 192) | ~3–6 MB | ~350 B/entry |
| **sqm-scripts-cake** | **~0.3 MB idle** | shell glue only; CAKE lives in-kernel (`kmod-sched-cake`, few KB/flow) |
| **wireguard-tools + kmod-wireguard** | **~0.5 MB** | ~64 B/peer in kernel; `wg` binary runs only at setup |
| **umdns** | **~0.2–0.4 MB** | uloop event-driven, single binary, no D-Bus |
| cloudflared (GOMEMLIMIT=24 MiB, GOGC=40) | ~25–32 MB | the single heaviest item — bounded, restart-guarded by procd |
| avanza agent (ash + cron-less loop) | ~1 MB | forks are transient (uclient-fetch, awk) |
| **Total** | **≈ 88–110 MB / 128 MB** | 15–25 % headroom for bursts |

### Why `sqm-scripts-cake` beats the bloated alternatives

1. **Zero resident daemon.** `sqm-scripts` is invoked at boot/`reload` to program
   `tc`; the runtime shaper is the in-kernel **CAKE** qdisc. Per-packet work never
   leaves the kernel — no userspace round-trips, no per-flow daemon.
2. **Host fairness for free.** CAKE's default triple-isolation + `nat` awareness
   gives per-(src,dst)-host fairness, so one Fire TV 4K stream cannot starve the
   game console. Alternatives like plain `fq_codel` prevent bufferbloat but do
   **not shape** below line rate, and HTB hand-rolls need per-class maintenance.
3. **Diffserv3 tins consume our nft DSCP marks.** fw4 `target DSCP` rules and the
   agent-driven `avanza_lane_*` nft sets feed EF/AF41/CS1 straight into CAKE's
   voice/video/bulk tins — QoS logic stays entirely in-kernel.
4. **Rejected alternatives:** `ntopng` (~100 MB+ RSS), `snort/suricata`
   (>200 MB, impossible on MIPS/128 MB), `nlbwmon` (acceptable but adds a
   daemon; our agent digests `/proc/net/nf_conntrack` directly for free),
   local DPI (all L7 intelligence is delegated to Workers AI instead — §1.2).
5. **CPU ceiling:** QCA9563 sustains ≈ 400–500 Mbps through CAKE+NAT. We shape at
   ~85–90 % of line rate (400/20 example in `configs/sqm.yml`) so the qdisc, not
   the CPU, is the bottleneck — that is what kills bufferbloat.
6. **apk/25.12 caveat (real, documented):** `apk add sqm-scripts` on 25.12 can
   fail to pull its `tc/ip` providers (openwrt/packages#29500). Install
   explicitly: `apk add ip-full tc kmod-sched-cake sqm-scripts-cake`.

### Why `wireguard-tools` beats OpenVPN here

- Crypto is **in-kernel** (ChaCha20-Poly1305, well-suited to MIPS without AES-NI);
  OpenVPN runs TLS + crypto in userspace: ~6–15 MB RSS and 2–4× the CPU per Mbps.
- WireGuard keeps ~64 B of state per peer; no per-connection handshake daemons.
- Realistic throughput on this SoC (~90–150 Mbps) far exceeds what remote
  management needs; bulk media stays on the local CAKE path.
- Egress model: peers connect **in** to udp/51820 (the only WAN-open port);
  everything else remote goes through the Cloudflare Tunnel (§1.2), so WireGuard
  idle cost is what we pay — near zero.

### Why native `umdns` beats Avahi/Broadcom-style discovery

- `umdns` is a single C binary on `uloop`/`libubox`: ~0.2–0.4 MB RSS, no D-Bus,
  no expat, no `avahi-daemon`+`dbus-daemon` pair (~2.5–4 MB combined RSS).
- It is **multi-interface by design**: listing `br-lan` and `br-media` makes it
  reflect mDNS/DNS-SD between the Management and Media zones — exactly the
  casting/remote-discovery sequence (Fire TV ⇄ phone) the product needs.
- Paired with two fw4 rules (udp/5353 media↔lan) it needs zero extra firewall
  surface; IoT is deliberately left out of reflection by default (privacy).

---

## 1.2 Cloudflare Zero-Trust Offloading

### `cloudflared` (Tunnel) — replacing inbound attack surface

- Egress-only QUIC/HTTP2 connection to the edge: **no port forwards, no DMZ,
  works behind CGNAT**. The router exposes nothing; the cloud pulls nothing.
- Named tunnel + Cloudflare Access policies gate the agent status endpoint and
  (optionally) LuCI to specific identities — MFA enforced at the edge, not on
  a 775 MHz MIPS CPU.
- Memory discipline on 128 MB: run with `GOMEMLIMIT=24MiB`, `GOGC=40`,
  `--protocol quic --edge-ip-version auto`; procd respawns it on OOM. It is the
  heaviest single item in the budget, so the agent health-monitors it and the
  rollback watchdog treats tunnel loss as non-fatal (telemetry falls back to
  direct HTTPS to the `*.workers.dev` route).

### Cloudflare Gateway / 1.1.1.3 — L7 DNS filtering at the edge

- All LAN resolvers forward via `https-dns-proxy` (DoH, ~60 KB, tiny RSS) to
  **1.1.1.3** (malware + adult-content blocking). Every DNS decision is an L7
  inspection performed on Cloudflare's fleet: category filtering, malware
  intel, DNSSEC — costing the router one UDP/TLS forward.
- If the account is later enrolled in Zero Trust, the same DoH identity upgrades
  to full Gateway policies (per-device, per-identity HTTP filtering) with **zero
  additional local footprint** — the enforcement point never moves to the router.
- IoT egress inherits family filtering for free: cheap cameras and plugs cannot
  resolve C2/malware domains even though we cannot inspect their payloads locally.

### Workers AI — L7 traffic classification off-device

- The agent exports a **metadata-only** conntrack digest (proto, src, dst, dport,
  connection count, byte totals — never payloads, never SNI sniffing on MIPS).
- The classifier Worker applies a deterministic port/protocol table first
  (3478→STUN/realtime, 8008/8009→cast, 27031-6→Steam, …). Only the ambiguous
  tail is batched to **Workers AI** (`@cf/meta/llama-3.2-3b-instruct`) — typically
  a few dozen inferences per day, cached in KV for 24 h. AI cost per flow ≈ 0.
- Verdicts return as lane directives `{ip, lane, dscp, ttl}`; the agent materializes
  them as `nft add element inet fw4 avanza_lane_* { <ip> timeout <ttl>s }` —
  self-expiring, crash-safe, no config rewrite.
- **Fail-safe rule:** the cloud only *advises*. If the edge is unreachable the
  router keeps the last-known-good static DSCP baseline from `firewall.yml`.
  Routing, NAT and enforcement never depend on cloud availability.

### Trust boundaries

| Vector | Control |
|---|---|
| Telemetry spoofing/replay | HMAC-SHA256 body signature, `t=` timestamp, 300 s window, per-device rate limit |
| App control channel | Separate `APP_CONTROL_KEY` bearer; lane/temp-access mutations are idempotent + TTL'd |
| Edge compromise | Directives can only touch lane nft sets / temporary UCI rules; every UCI change is snapshot + 10-min rollback watched |
| Data minimization | Metadata-only export; KV values bucketed; 7-day TTL; no payloads anywhere |

---

## 1.3 Upstream Telemetry Outage Integration ("is it me or the ISP?")

### Pipeline

```
agent (60 s)                     Worker ingest                    cron (5 min)
─────────────                    ─────────────                    ────────────
wan up/down transitions  ──▶  AvanzaState DO ring buffer  ──▶  outage_oracle.ts
rx/tx errors, carrier flips      │ alarm 15 min                   │
conntrack digest                 ▼                                ▼
                              KV cold snapshot              signal fusion:
                              tel:<dev>:<bucket>            1. Cloudflare Radar API
                                                            2. IODA API (optional)
                                                            3. ISP status RSS (regex)
                                                                   │
                                                                   ▼
                                                            correlation matrix
                                                                   │
                                                     KV outage:current  ──▶ app banner
                                                                   │        artifact pill
                                                     notify: Expo Push + Telegram
```

- **Local evidence (agent):** WAN `up` transitions, PPPoE re-auth churn,
  `carrier_changes`, rx/tx error deltas, gateway ping RTT.
- **Regional evidence (oracle, all free):**
  1. **Cloudflare Radar API** — `internet_quality/score` per region with a free
     CF API token; a drop below threshold = regional degradation signal.
  2. **IODA** (Internet Outage Detection & Analysis, Georgia Tech) — ASN/region
     visibility deltas; free research API, optional token, configurable base URL.
  3. **ISP status pages via RSS/Atom** — `<item><title>` regex scan with outage
     keywords, freshness window 2 h; feed list lives in KV (`config:outage_sources`)
     so it is editable without redeploy.
- **Correlation matrix:**

| Local WAN-down events (30 min) | Regional signals | Verdict |
|---|---|---|
| ≥1 | ≥1 source degraded | `REGIONAL_OUTAGE` — "not your hardware" push notification |
| ≥1 | none | `LOCAL_FAULT_SUSPECTED` — trigger agent diagnostics + rollback check |
| 0 | ≥1 | `REGIONAL_DEGRADATION_WATCH` — silent banner |
| 0 | none | `HEALTHY` |

- **Free-tier arithmetic:** KV writes are the binding limit (1 000/day). Raw
  60-second persistence would need 1 440 writes/day — therefore the Durable
  Object buffers in memory and flushes one summary per 15 min (**96 writes/day**),
  and AI-class cache writes only occur on new verdicts (~10–50/day). Cron runs
  288×/day; each run makes ≤5 outbound fetches. Total ≈ 6 % of the free request
  budget.
- **Notification fan-out:** state changes (with 30-min cooldown via KV) push to
  Expo (`exp.host/--/api/v2/push/send`, device tokens in `push:devices`) and a
  Telegram bot as the no-account fallback.

### Files implementing this section

- `avanza-edge-orchestrator/dashboard/src/outage_oracle.ts` (cron + correlation + notify)
- `avanza-edge-orchestrator/dashboard/src/state_do.ts` (DO buffer, alarm flush)
- `avanza-edge-orchestrator/dashboard/src/traffic_classifier.ts` (ingest, classify, directives, `/api/outage/status`)
- `avanza-router-core/router/lightweight_agent.sh` (event capture, digest export, rollback interlock)
