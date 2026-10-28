# avanza-router-core

Local router half of Project Avanza. Zero-weight by design: CAKE shapes in-kernel,
fw4 enforces zoning in-kernel, umdns reflects multicast in ~300 KB of RAM, and all
L7 intelligence lives in `avanza-edge-orchestrator`.

## 0. Package installation (OpenWrt 25.12, apk)

```sh
apk update
apk add ip-full tc kmod-sched-cake sqm-scripts-cake
apk add wireguard-tools kmod-wireguard
apk add umdns https-dns-proxy
apk add uclient-fetch jsonfilter openssl-util hexdump flock
apk add cloudflared        # optional but recommended (egress-only tunnel)
apk add usteer adblock-fast  # band steering + ad/tracker blocking (both RAM-light)
# optional, documented below: mwan3 (multi-WAN), nlbwmon (per-host accounting), ksmbd-server (USB sharing)
```

Note: on 25.12 `apk add sqm-scripts` alone can fail to resolve its `tc/ip`
providers (openwrt/packages#29500) — install `ip-full` and `tc` explicitly first.

Do **not** install `avahi-daemon`, `luci-app-sqm` (unless you accept the LuCI RAM
cost), or any local DPI engine. The 128 MB budget is itemized in
`docs/step1-runtime-cloud-analysis.md`.

## 1. One-time network provisioning (zones/bridges/SSIDs)

The YAML configs assume interfaces `lan` (br-lan, 192.168.10.1/24),
`media` (br-media, 192.168.20.1/24) and `iot` (br-iot, 192.168.30.1/24) exist.
DSA switch ports on the Archer C7 v5 are `lan1..lan4` + `wan`; example split:
lan4 → Management, lan2+lan3 → Media, lan1 → IoT, one IoT SSID on radio0.

```sh
uci -q batch <<'EOF'
set network.lan=interface
set network.lan.device=br-lan
set network.lan.proto=static
set network.lan.ipaddr=192.168.10.1
set network.lan.netmask=255.255.255.0
delete network.lan.type
set network.dev_br_lan=device
set network.dev_br_lan.type=bridge
set network.dev_br_lan.name=br-lan
add_list network.dev_br_lan.ports=lan4
set network.media=interface
set network.media.device=br-media
set network.media.proto=static
set network.media.ipaddr=192.168.20.1
set network.media.netmask=255.255.255.0
set network.dev_br_media=device
set network.dev_br_media.type=bridge
set network.dev_br_media.name=br-media
add_list network.dev_br_media.ports=lan2
add_list network.dev_br_media.ports=lan3
set network.iot=interface
set network.iot.device=br-iot
set network.iot.proto=static
set network.iot.ipaddr=192.168.30.1
set network.iot.netmask=255.255.255.0
set network.dev_br_iot=device
set network.dev_br_iot.type=bridge
set network.dev_br_iot.name=br-iot
add_list network.dev_br_iot.ports=lan1
set wireless.iot_ap=wifi-iface
set wireless.iot_ap.device=radio0
set wireless.iot_ap.mode=ap
set wireless.iot_ap.ssid=Avanza-IoT
set wireless.iot_ap.encryption=sae-mixed
set wireless.iot_ap.key=CHANGE_ME_12_CHARS_MIN
set wireless.iot_ap.network=iot
set wireless.iot_ap.isolate=1
EOF
uci commit network
uci commit wireless
/etc/init.d/network restart
```

DHCP pools per zone (dnsmasq) and the static leases matching the addressing
contract in the root README should be added to `/etc/config/dhcp`
(`192.168.20.41` Fire TV, `.42` Living TV, `.43` Console, `192.168.30.51-54` IoT).

### 1b. Guest network (4th zone, fully isolated)

```sh
uci -q batch <<'GUESTEOF'
set network.guest=interface
set network.guest.device=br-guest
set network.guest.proto=static
set network.guest.ipaddr=192.168.40.1
set network.guest.netmask=255.255.255.0
set network.dev_br_guest=device
set network.dev_br_guest.type=bridge
set network.dev_br_guest.name=br-guest
set wireless.guest_ap=wifi-iface
set wireless.guest_ap.device=radio1
set wireless.guest_ap.mode=ap
set wireless.guest_ap.ssid=Avanza-Guest
set wireless.guest_ap.encryption=sae-mixed
set wireless.guest_ap.key=CHANGE_ME_GUEST_KEY
set wireless.guest_ap.network=guest
set wireless.guest_ap.isolate=1
set dhcp.guest=dnsmasq
set dhcp.guest.interface=guest
set dhcp.guest.start=101
set dhcp.guest.limit=50
set dhcp.guest.leasetime=24h
GUESTEOF
uci commit network; uci commit wireless; uci commit dhcp
/etc/init.d/network restart
```

The matching firewall policy ships in `configs/firewall.yml`: guest zone with
input DROP / forward DROP / masq on, egress WAN-only; DHCP (67/68), DNS (53)
and NTP (123) accepted to the router only; AP client-isolation on; **no umdns
reflection**; the DNS-hijack DNAT redirect catches guests with hardcoded
resolvers; 24 h leases keep the tables small.

Family DNS filtering (1.1.1.3 via DoH, near-zero RAM):

```sh
uci -q batch <<'EOF'
set https-dns-proxy.@https-dns-proxy[0]=https-dns-proxy
set https-dns-proxy.@https-dns-proxy[0].bootstrap_dns=1.1.1.1,1.0.0.1
set https-dns-proxy.@https-dns-proxy[0].resolver_url=https://family.cloudflare-dns.com/dns-query
set https-dns-proxy.@https-dns-proxy[0].listen_addr=127.0.0.1
set https-dns-proxy.@https-dns-proxy[0].listen_port=5053
EOF
uci commit https-dns-proxy
/etc/init.d/https-dns-proxy restart
```

## 2. Transpile YAML → UCI

```sh
cd /overlay/avanza/repo/avanza-router-core
sh scripts/transpile_config.sh --dry-run     # inspect the generated uci batch
sh scripts/transpile_config.sh --apply       # backup + install + reload + verify
sh scripts/transpile_config.sh --rollback    # restore latest snapshot if needed
```

What `--apply` does: snapshots `/etc/config/{firewall,sqm,umdns,network,wireless,dhcp}`
to `/overlay/avanza/backup/<stamp>/` (last 6 kept), deletes previous `*avanza*`
UCI sections (idempotent re-apply), compiles `configs/*.yml` into a `uci batch`,
installs `nft/10-avanza-lanes.nft` into `/usr/share/nftables.d/ruleset.d/`,
commits, restarts firewall/sqm/umdns and verifies with `fw4 print` +
`nft list table inet fw4`.

## 3. Agent + procd service

```sh
mkdir -p /usr/libexec/avanza /etc/avanza
cp router/lightweight_agent.sh scripts/speedtest.sh /usr/libexec/avanza/
chmod 755 /usr/libexec/avanza/lightweight_agent.sh /usr/libexec/avanza/speedtest.sh
cp router/avanza.env /etc/avanza/agent.env
chmod 600 /etc/avanza/agent.env       # contains the HMAC key
vi /etc/avanza/agent.env              # set ORCH_URL + AGENT_HMAC_KEY
cp router/avanza.init /etc/init.d/avanza
chmod 755 /etc/init.d/avanza
/etc/init.d/avanza enable
/etc/init.d/avanza start
logread -f -t avanza
```

The agent per 60 s cycle: verifies hardware clock sanity (forced NTP below
`MIN_EPOCH`), guards `/overlay` free space (warn 85 %, crit 94 % with automatic
prune), health-monitors `cloudflared`, builds a metadata-only conntrack digest
(top-24 flows by bytes, RFC1918 sources only), reads `ubus`
(`network.interface.wan`, `system info`), sysfs NIC error/carrier counters,
nft lane + lateral-block counters, signs the payload with HMAC-SHA256
(`openssl dgst`) and posts it to the orchestrator with `uclient-fetch`.

Response handling: `directives[]` → `nft add element inet fw4 avanza_lane_*
{ ip timeout Ns }` (self-expiring, crash-safe); `temp_access[]` → snapshot,
add a scoped UCI ACCEPT rule (phone → device, exact IPs only), `fw4 reload`,
arm the rollback marker; expiry removes the rule automatically.

## 4. Rollback safety matrix (10 minutes)

1. **Snapshot-first** — every UCI mutation is preceded by a full config snapshot.
2. **Arm** — `pending_rollback` marker records `<snapshot> <epoch>`.
3. **Watch** — each cycle inside the 600 s window runs a 3-point health probe
   (WAN up via ubus, default-gateway ping, orchestrator `/health`). Two failures
   → immediate restore of the snapshot + service restarts.
4. **Disarm** — at window expiry with health OK the change is confirmed; the
   snapshot stays on Extroot for manual `--rollback <stamp>`.
5. **Report** — rollback events ride up in the next telemetry payload
   (`rollback.last`) so the edge/app always know the router self-healed.

## 5. Cloudflare Tunnel (optional, egress-only)

```sh
cloudflared tunnel login                       # one-time, on a desktop
cloudflared tunnel create avanza-router
mkdir -p /etc/cloudflared
cat > /etc/cloudflared/config.yml <<'EOF'
tunnel: avanza-router
credentials-file: /etc/cloudflared/<TUNNEL-UUID>.json
ingress:
  - hostname: router.avanza.example.com
    service: http://127.0.0.1:8080
  - service: http_status:404
EOF
uci set cloudflared.@cloudflared[0].env=GOMEMLIMIT=24MiB
uci set cloudflared.@cloudflared[1].env=GOGC=40 2>/dev/null
/etc/init.d/cloudflared enable && /etc/init.d/cloudflared start
```

Memory is bounded via `GOMEMLIMIT`; the agent restarts the tunnel if it dies,
and telemetry degrades gracefully to direct HTTPS when the tunnel is down.

## 6. Band steering ("Smart Connect") — usteer

OpenWrt has no vendor-style server-side steering; the honest equivalent is
`usteer` (small C daemon, 802.11k/v assisted) plus one SSID on both radios
with 802.11k/v/r so clients roam and band-switch cleanly:

```sh
uci -q batch <<'STEEREOF'
set wireless.wifimgmt.ssid=Avanza
set wireless.wifi5.ssid=Avanza
set wireless.wifimgmt.ieee80211k=1
set wireless.wifi5.ieee80211k=1
set wireless.wifimgmt.bss_transition=1
set wireless.wifi5.bss_transition=1
set wireless.wifimgmt.wnm_sleep_mode=1
set wireless.wifi5.wnm_sleep_mode=1
set wireless.wifimgmt.ieee80211r=1
set wireless.wifi5.ieee80211r=1
set wireless.wifimgmt.mobility_domain=4f57
set wireless.wifi5.mobility_domain=4f57
set usteer.@usteer[0]=usteer
set usteer.@usteer[0].enabled=1
set usteer.@usteer[0].band_steering=1
set usteer.@usteer[0].ssid=Avanza
STEEREOF
uci commit wireless; uci commit usteer
/etc/init.d/wireless restart
/etc/init.d/usteer enable && /etc/init.d/usteer start
```

RAM cost ≈ 0.3–0.6 MB. The Archer C7 v5 has 2.4 G + 5 G radios only — no 6 GHz.

## 7. WireGuard server (remote access) + whole-house VPN client

```sh
# Server: the ONLY WAN-open service (rule Avanza-WAN-WireGuard-Ingress already ships)
wg genkey > /tmp/wg.priv && wg pubkey < /tmp/wg.priv > /tmp/wg.pub
uci set network.wg0=interface
uci set network.wg0.proto=wireguard
uci set network.wg0.private_key="$(cat /tmp/wg.priv)"
uci set network.wg0.listen_port=51820
uci add_list network.wg0.addresses=192.168.9.1/24
uci set network.wg_phone=wireguard_wg0
uci set network.wg_phone.public_key=<PHONE_PUBKEY>
uci add_list network.wg_phone.allowed_ips=192.168.9.2/32
uci commit network && /etc/init.d/network reload && shred -u /tmp/wg.priv
```

Client mode (exit the whole house — or one zone — via another WG endpoint such
as a VPS): add a second `wireguard` interface and use **`pbr`** (policy-based
routing, successor to vpn-bypass) to select which zones/devices exit through it.
No DNS leaks by construction: every zone already resolves through the router's
DoH, and the DNS-hijack redirects catch hardcoded resolvers.

## 8. USB sharing / media server (ksmbd — the RAM-honest choice)

The 7.1 GB stick is the Extroot. To share storage, add a second partition or a
second stick — never share the extroot partition itself. `ksmbd` serves SMB
**in-kernel** (~0 MB userspace) vs Samba's ~8–15 MB RSS; `minidlna` (~1.5 MB)
covers DLNA casting to the media zone:

```sh
apk add ksmbd-server        # and/or: apk add minidlna
# /etc/config/ksmbd: share -> /mnt/share, browseable, guest-ok off, smb3
```

## 9. Multi-WAN failover + USB tethering (mwan3)

```sh
apk add mwan3
uci set network.wanb=interface
uci set network.wanb.proto=dhcp
uci add_list network.wanb.device=usb0        # USB-tethered phone (rndis) or 4G dongle
uci set network.wanb.metric=20
# mwan3: interface wan (track 1.1.1.2 rtt), interface wanb,
#        policy wan_fb (list use_interface wan wanb), rule default_route
uci commit network mwan3 && /etc/init.d/mwan3 restart
```

Failover cooperates with the outage oracle: when the agent reports WAN-down the
oracle classifies regional (stay on wanb; the ISP will recover) vs local (check
your line/hardware). During an outage, plug your phone into the USB port and
wanb becomes instant backup internet.

## 10. Ad-blocking + hardcoded-DNS hijack

`adblock-fast` with small lists (adaway + oisd-lite ≈ 42k domains) costs ~2–4 MB
RSS with the blocklist on Extroot; bigger lists are a no-go at 128 MB. Devices
that ignore DHCP DNS (Roku, Google, many cameras) are caught by the DNAT
redirects in `configs/firewall.yml` (`redirects:` → `firewall.redirect`:
media/iot/guest :53 → their zone gateway), so filtering cannot be bypassed.

## 11. Firmware updates (deliberate, not automatic)

```sh
apk add owut
owut check        # installed vs ASU for target ath79/generic, profile tplink_archer-c7-v5
owut upgrade      # attended sysupgrade; config preserved; checksum-verified image
```

The edge oracle checks the official ASU `versions.json` daily (KV-cached) and
pushes an "update available" notification with the exact `owut` command; the
flash itself stays a deliberate SSH step — auto-flashing a 16 MB-flash router
from a dashboard is how bricks happen.

## 12. Cloud backup & restore + router-side speed test

```sh
# manual backup (the agent performs this on demand from the app/artifact):
tar czf /tmp/backup.tar.gz -C / etc/config
base64 < /tmp/backup.tar.gz | tr -d '\n'   # ~15-30 KB; rides ONE telemetry cycle to KV

# manual speed test (same script the agent invokes on a Worker action):
/usr/libexec/avanza/speedtest.sh           # speed.cloudflare.com via uclient-fetch
cat /tmp/avanza/speedtest.json
```

Restore path: app → `POST /api/control/restore` → Worker attaches the KV-stored
base64 → agent snapshots config, verifies the archive (`tar tzf`), extracts over
`/etc/config`, reloads services and arms the 10-minute rollback watchdog.

## 14. Fleet mode (Phase II): agent v2 + PLC trunk + GitOps

Install `lightweight_agent_v2.sh` in place of v1 (same init unit; update
`/etc/avanza/agent.env` — new keys: `DEVICE_ROLE=primary`, `PLC_ENABLED=1`,
`PLC_IF=lan1`, `FLEET_PEER_IP=192.168.99.2`, `TUNNEL_ENABLED=0` default to stay
inside the ≤48 MB userspace budget; flip to 1 only if you accept +25–32 MB).

```sh
apk add open-plc-utils      # plcstat for the Powerline telemetry pipeline
```

Primary-side trunk provisioning (lan1 becomes the PLC trunk: media VLAN 20
native + fleet VLAN 40 tagged; IoT moves to its SSID or to secondary lan4 via
VLAN 30 — see the secondary README):

```sh
uci -q batch <<'TRUNKEOF'
set network.dev_br_media.vlan_filtering=1
set network.bv_media_20=bridge-vlan
set network.bv_media_20.device=br-media
set network.bv_media_20.vlan=20
add_list network.bv_media_20.ports=lan1*
add_list network.bv_media_20.ports=lan2
add_list network.bv_media_20.ports=lan3
set network.bv_fleet_40=bridge-vlan
set network.bv_fleet_40.device=br-media
set network.bv_fleet_40.vlan=40
add_list network.bv_fleet_40.ports=lan1:t
set network.fleet=interface
set network.fleet.device=br-media.40
set network.fleet.proto=static
set network.fleet.ipaddr=192.168.99.1
set network.fleet.netmask=255.255.255.0
TRUNKEOF
uci commit network && /etc/init.d/network restart
sh scripts/transpile_config.sh --apply     # fleet fw4 zone ships in firewall.yml
ping -c2 192.168.99.2                      # secondary SVI reachable over PLC
plcstat -m -i lan1                         # verify PLC link stats parse
```

Agent v2 adds per-cycle: `/proc/meminfo` MemAvailable, `nf_conntrack_count/max`,
non-resident `plcstat -m` probe (Tx/Rx PHY rates + attenuation → DO 48-sample
ring → MCP `get_powerline_topology`), per-zone `bridge fdb` client presence
(the Tenda AP's clients included, via L2 trunking), and the **GitOps loop**:
version token in the ingest response → HMAC GET `/api/fleet/bundle` → **sha256
verify** → snapshot → staged `transpile_config.sh --apply` → 10-minute window
with the 3-point ping sweep (GW, fleet peer .99.2, 1.1.1.1) + DNS/HTTPS +
tunnel validation → commit or auto-restore, with `fleet.apply_state` reported
upstream either way.

## 13. Powerline (PLC) adapters — wired drops over house wiring

Use a PLC pair as the **Media-zone backhaul**: router LAN port → adapter A
(wall socket), adapter B in the media room → its built-in switch feeds the
Fire TV, Living TV and console with real Ethernet. Placement rules that decide
success:

1. **Wall sockets only** — power strips/surge protectors/UPS filter out the
   2–68 MHz carrier. Passthrough-socket adapters let the strip hang off them.
2. **Same electrical phase** — cross-phase pairs lose 40–70 % throughput.
3. **Pair before plugging into shared wiring** (apartments): press-pair within
   2 min, or set a private network key (`apk add open-plc-utils`).
4. Expect **90–190 Mbps real** from AV2000-class kits — still 3–8× a distant
   5 GHz link, at a fraction of the jitter (+1–3 ms).

Design notes: a PLC pair is a transparent L2 segment, so devices plugged into
the far adapter simply join `br-media` (192.168.20.0/24) — zones, firewall,
DSCP lanes and umdns behave identically to copper. Consumer (unmanaged) PLC
carries **untagged** frames: one pair per zone, or VLAN-aware kits for trunking
10/20/30/40. CAKE keeps doing all shaping at the WAN egress, so a saturated
PLC link still gets host-fair treatment, and PLC brownouts are deliberately
**never** mwan3 track members (they would poison the outage oracle's local-vs-
regional correlation). Full analysis: `docs/edge-services-and-caching.md` §1.
