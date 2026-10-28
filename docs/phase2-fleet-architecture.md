# PHASE II — HYBRID FLEET ARCHITECTURE & HARDWARE DISCOVERY

Fleet: Archer C7 v5 (primary edge) · TD-W8968 v3 (headless L2 switch node) ·
Tenda AC750-class AP (transparent L2 radio extension) · Powerline trunk ·
Cloudflare $5 Paid control plane · GitOps via GitHub Actions → R2/KV.

---

## 1. Hardware discovery (verified, with two spec corrections)

### Primary — TP-Link Archer C7 v5
QCA9563 @ 775 MHz (MIPS 74Kc), **128 MB RAM**, 16 MB flash + 7.1 GB USB
Extroot. Unchanged from Phase I; full budget in `step1-runtime-cloud-analysis.md`.

### Secondary — TP-Link TD-W8968 v3 (corrections vs. the mission brief)
Per the OpenWrt TOH hardware data (openwrt.org/toh/hwdata/tp-link/tp-link_td-w8968_v3):

| Claimed in brief | Verified reality | Consequence |
|---|---|---|
| Ralink RT63365 | **Broadcom BCM6318** (bmips/bcm6318 target, MIPS32 @ 333 MHz) | wifi strip targets `b43/brcmsmac/bcma/ssb` stacks, not (only) `rt2800` — `strip_secondary.sh` handles both lists defensively |
| 128 MB RAM | **64 MB RAM** | resident userspace target set to **≤ 8 MB** (pure L2 + agent loop); still trivially inside the "under 48 MB" goal |
| (implied) DSL stack present | **DSL never works under OpenWrt on BCM63xx** (no FLOSS driver) — the ATM/DSL packages are typically absent | strip script removes `br2684ctl/linux-atm/*atm*/ltq-*/dsl-*` **only if installed** (guarded `apk info -e`) |
| — | **8 MB flash**, 4× 100 Mbit ports, internal switch (DSA), USB 2.0 | no Extroot — config-only overlay; squashfs sysupgrade image `tp-link_td-w8968-v3`; supported through 25.12 ✓ |

Resident budget after strip (measured-class): kernel + b53/DSA + bridge ≈
16–24 MB used total; userspace = procd/ubusd/netifd/dropbear/agent ≈ 4–6 MB.
Wire-speed L2 on four 100 M ports at 333 MHz: no load concern (bridging is
kernel-path; no br_netfilter).

### Wi-Fi fabric — Tenda AC750-class dual-band AP ("A750")
Stock firmware, **dumb-AP mode**: uplink cable into a LAN port (WAN port
unused/disabled), DHCP server OFF, static management IP `192.168.10.250` in the
Management zone, SSIDs/security cloned from the primary for client-side roaming,
non-overlapping channels (2.4 G: primary ch1 / Tenda ch6 or ch11; 5 G: primary
36–48 / Tenda 149–161).

**usteer honesty (important):** `usteer` steers clients on APs that run the
usteer agent (OpenWrt hostapd). A stock Tenda cannot be steered or RSSI-probed
remotely. What Avanza actually delivers:
- `usteer` on the primary's own radios (band steering 2.4⇄5, 802.11k/v/r).
- **Fleet-wide client presence** via bridge FDB on the primary: because the
  Tenda hangs L2 inside `br-media`/`br-lan`, every client MAC it serves appears
  in `bridge fdb show` — agent v2 exports per-zone FDB counts + new-MAC deltas.
- RSSI/SNR for clients associated to the *primary's* radios via `iwinfo`.
- Roadmap: if an OpenWrt build exists for the exact Tenda model, flash it and
  add it as a usteer satellite (`option usteer_hosts` on the primary) — config
  snippet in the secondary README §Tenda.

### Powerline trunk
Primary `lan1` ⇄ PLC-A … PLC-B ⇄ secondary `lan1`. Plain HomePlug AV2 adapters
are transparent 802.1Q bridges — VLAN 20 (media, native/untagged) and VLAN 40
(fleet mgmt, tagged) trunk over the pair. Rules: wall sockets only, same phase,
AES pair-bonded before deployment. `open-plc-utils` (`plcstat`) runs
**non-resident**: invoked once per 60 s agent cycle, output parsed for Tx/Rx PHY
rates + attenuation, ring-buffered in the Durable Object (48 samples), exposed
via MCP `get_powerline_topology()` and cold-stored in D1. Parsing is defensive
(raw-output fallback field) because `plcstat` table formats vary by chipset
firmware.

## 2. Addressing (Phase II additions)

| Network | VLAN | Subnet | Members |
|---|---|---|---|
| `fleet` (NEW) | 40 (tagged on PLC trunk) | 192.168.99.0/24 | primary `br-media.40` = .1 · secondary `br-switch.40` = .2 |
| media (extended) | 20 (native on trunk) | 192.168.20.0/24 | secondary ports lan2–lan4 = media drops; Tenda 5G bridge |
| guest wifi | untagged bridge on primary radio1 | 192.168.40.0/24 | never crosses the PLC trunk — VLAN 40 collision impossible |

fw4 on the primary gains a `fleet` zone (input ACCEPT — DNS/NTP/ssh from the
switch; forward DROP; fleet→wan forward for the secondary agent's HTTPS; lan→
fleet forward for admin reachability). Bridged media traffic on the secondary
never traverses any firewall (L2 only, br_netfilter off).

## 3. GitOps loop (GitHub Actions → R2/KV → agent v2)

```
push to main (configs/**, nft/**, scripts/**, worker src)
  └─▶ CI: lint_fleet.sh (sh -n, transpiler dry-runs, YAML/JSON parse, tsc)
       └─▶ build bundles: primary.tar.gz, secondary.tar.gz (+ sha256)
            └─▶ wrangler r2 object put avanza-backups/fleet/<ver>/<device>.tar.gz
                 └─▶ wrangler kv key put fleet:config:version '{"version",..,"sha256"}'
                      └─▶ wrangler deploy --env primary && --env secondary (canary)
                           └─▶ agent v2 sees new token in ingest response
                                └─▶ GET /api/fleet/bundle (HMAC) → sha256 verify
                                     └─▶ snapshot → staging → transpile --apply
                                          └─▶ 10-min rollback window:
                                              3-point ping sweep (gw, .99.2, 1.1.1.1)
                                              + DNS + orchestrator HTTPS + tunnel check
                                              ├─ healthy → commit fleet_version
                                              └─ impaired → auto-restore snapshot,
                                                 report fleet_apply.status=rolled_back
```

Convergence is **pull-based and authenticated**: routers never accept inbound
config pushes; they poll the version token on their own HMAC-signed heartbeat
and fail closed to last-known-good.

## 4. RAM compliance ("≤48 MB resident" audit)

| Node | Kernel+drivers | Userspace resident | Verdict |
|---|---|---|---|
| C7 v5 | ~50–58 MB (2 radios + CAKE + nft + conntrack) | ~27–38 MB (hostapd×2, netifd stack, dnsmasq+hdp, umdns, usteer, adblock-fast, sqm glue, agent, dropbear idle) | ✅ ≤48 MB userspace; **cloudflared OFF by default** in fleet mode (agent posts direct HTTPS; +25–32 MB if enabled — `TUNNEL_ENABLED=0` default in v2) |
| W8968 v3 | ~16–20 MB (DSA switch + bridge) | ~4–6 MB (procd/ubusd/netifd/dropbear idle/secondary agent) | ✅ ≤8 MB target, far under 48 MB |

## 5. $5-plan compliance delta (Phase II additions)

| New load | Volume | Inside allowance |
|---|---|---|
| 2nd device ingest (secondary agent, 120 s) | +720 req/day | 10 M/mo included ✓ |
| Syslog batches → D1 (`/api/fleet/syslog`) | ≤2 batch-writes/min/device ≈ 5.7 k rows/day | D1 paid: 50 M row-writes/mo included ✓ |
| MCP tool calls (LLM-driven, sporadic) | <1 k/mo | ✓ |
| GitOps bundle fetches | per deploy (rare) | ✓ |
| R2 fleet bundles + reports + firmware | <50 MB, <10 k ops/mo | R2 free 10 GB/1 M A/10 M B ✓ |
| Static assets (dashboard) | unmetered | ✓ |

Nothing added touches Queues/Workflows/Browser Rendering/Containers; no
enterprise product enters the architecture (audit unchanged:
`cloudflare-plan-audit.md`).
