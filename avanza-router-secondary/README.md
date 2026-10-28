# avanza-router-secondary

Headless Layer-2 managed switch node: **TP-Link TD-W8968 v3** flashed with
OpenWrt 25.12.x (bmips/bcm6318, BCM6318 @ 333 MHz, **64 MB RAM**, 8 MB flash,
4× 100 M ports, DSA internal switch). All wireless, DSL/ATM, DHCP/DNS and web
stacks are stripped; management lives on tagged **VLAN 40** trunked over the
Powerline pair to the primary C7 v5.

> Hardware reality vs. common assumptions (OpenWrt TOH `tp-link_td-w8968_v3`):
> SoC is **Broadcom BCM6318** (not Ralink), RAM is **64 MB** (not 128), the DSL
> modem **never works under OpenWrt** (no FLOSS driver — which makes this box a
> perfect pure-switch candidate), and the b43 Broadcom WiFi is only partially
> supported — we remove the whole radio stack anyway. The strip script removes
> both the Broadcom and Ralink package candidate lists, guarded by
> `apk info -e`, and refuses to touch the safety package set.

## Flashing

1. Download `openwrt-25.12.x-bmips-bcm6318-tp-link_td-w8968-v3-squashfs-cfe.bin`.
2. Stock firmware web UI → system tools → firmware upgrade (or CFE web recovery:
   hold RESET at power-on, browse to 192.168.1.1).
3. After boot: set a temporary root password immediately (dropbear defaults).

## Provisioning order

```sh
scp -r avanza-router-secondary root@192.168.1.1:/tmp/avanza-secondary
ssh root@192.168.1.1
cd /tmp/avanza-secondary
apk update
apk add uclient-fetch jsonfilter openssl-util hexdump flock bridge ip-full
sh scripts/transpile_network.sh --dry-run       # inspect the bridge matrix
sh scripts/strip_secondary.sh                   # purge + bridge + firewall + agent
vi /etc/avanza/secondary.env                    # ORCH_URL + AGENT_HMAC_KEY (same key as primary)
/etc/init.d/avanza-switch restart
reboot                                          # unload purged kernel modules
```

Post-reboot checks (from the primary): `ping 192.168.99.2`,
`ssh root@192.168.99.2 free` (expect ~40 MB free of 64),
`bridge fdb show br-media | grep -c .` on the primary should now include the
secondary's clients through the trunk.

## What `strip_secondary.sh` does (idempotent, every step guarded)

1. Identity preflight (`ubus system board` model check, `--force` override) +
   meminfo/overlay bounds logging.
2. `wifi down`, stop/disable wpad/hostapd/usteer, then purge **both** wireless
   stacks: Broadcom (`kmod-b43`, `kmod-brcmsmac`, `kmod-bcma`, `kmod-ssb`,
   `kmod-mac80211`, `iwinfo`, firmwares) and the Ralink candidates from the
   mission list (`kmod-rt2800-pci`, `kmod-rt2x00-lib`, …).
3. DSL/ATM residue purge (`br2684ctl`, `linux-atm`, `kmod-atm`, `kmod-pppoa`,
   `dsl-*-firmware`, `ltq-*` …) — only what is actually installed.
4. Web/management purge: everything matching `luci*`, `uhttpd*`, `rpcd*`,
   `dnsmasq`, `odhcpd`, `avahi`, `miniupnpd`.
5. Refuses to remove the safety set (busybox, procd, ubusd, netifd, firewall4,
   nftables, uci, dropbear, uclient-fetch, jsonfilter, openssl, bridge tools).
6. Writes the L2 matrix via `transpile_network.sh --apply` (snapshot-first),
   applies the minimal fleet firewall (swmedia zone input DROP / forward ACCEPT
   for bridging, fleet zone for the VLAN 40 SVI, SSH pinned to 192.168.99.0/24,
   password auth off), locks dropbear to the fleet interface.
7. Installs `secondary_agent.sh` + procd unit + `/etc/avanza/secondary.env`.
8. Verification pass: free/df, leftover-process grep, package-residue count,
   overlay delta report.

## network.yml → bridge matrix

| Object | Result |
|---|---|
| `br-switch` | vlan-filtering bridge over lan1–lan4, STP off, IGMP snooping on |
| VLAN 20 | media zone, **native/untagged** on all four ports (`lan1*` trunk-side) |
| VLAN 40 | fleet management, **tagged on lan1 only** → SVI `br-switch.40` = 192.168.99.2/24, GW/DNS = primary .1 |
| `fleet` interface | static, gateway 192.168.99.1, DNS via the primary's dnsmasq |

Port-token syntax passes straight through to bridge-vlan UCI: `name` = member,
`name*` = untagged/native (PVID), `name:t` = tagged.

## secondary_agent.sh (resident cost ≈ 0.8 MB)

Per 120 s cycle: `/proc/meminfo` (MemTotal/MemAvailable), loadavg, uptime,
per-port sysfs error/collision counters, `bridge fdb` client count, uplink probe
(ping .99.1), conntrack count, fleet config version — one compact HMAC-signed
JSON POST to `/api/telemetry/ingest` (role=secondary, same DO fabric, device
id `avanza-switch`). Every second cycle ships a **logread-delta syslog batch**
to `/api/fleet/syslog` (deduped against the previous ring, ≤60 lines, D1-backed).
GitOps: when the ingest response carries a new `config.version` token it
downloads the bundle, **verifies sha256**, snapshots, applies through the
transpiler, and arms the same 10-minute rollback window (probe: primary ping +
bridge health + orchestrator /health).

## Tenda AC750-class AP — dumb-AP checklist (stock firmware)

1. Uplink cable into a **LAN** port; leave its WAN port empty (or disable it).
2. DHCP server **OFF**. Static LAN IP `192.168.10.250/24`, gateway `192.168.10.1`.
3. SSID/security cloned from the primary ("Avanza", WPA2/WPA3-mixed, same key)
   for seamless client-side roaming; channels: 2.4 G ch6 or ch11 (primary keeps
   ch1), 5 G 149–161 (primary keeps 36–48).
4. It hangs inside `br-lan`/`br-media` L2 — the primary sees every Tenda client
   MAC in `bridge fdb show` (presence telemetry), but **cannot read its RSSI**:
   stock APs expose no 802.11k/v hooks. `usteer` on the primary steers its own
   radios only. If the exact Tenda model gains an OpenWrt build, flash it and
   add `list network '192.168.10.250'` to `/etc/config/usteer` on the primary
   for true cross-AP steering.
