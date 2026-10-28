# avanza-companion-linux

A ~5 KB POSIX-shell daemon that makes any Linux box on the LAN a first-class
Avanza citizen. No dependencies beyond `curl` (uses `pgrep`/`ss`/`notify-send`
when present, degrades gracefully when not).

## What it does

1. **Self-registration** — `POST /api/control/register` puts the machine's
   hostname/OS into the edge device registry, so the app, extension and
   artifact show "dev-box" instead of a bare IP.
2. **Meeting Mode** — every 30 s it looks for active call software
   (Zoom/Teams/WebEx processes) or live STUN/SIP flows (`:3478/:3479/:5060`).
   On detection it requests the **EF priority lane** for its own IP
   (`POST /api/control/lane`, TTL 1 h); the router agent materializes it as an
   `avanza_lane_priority` nft set element on the next cycle — CAKE's voice tin
   then protects the call from the Fire TV's 4K stream. Two clean cycles after
   the call ends, it releases the boost back to the static baseline.
3. **Outage awareness** — hourly `GET /api/outage/status`; non-healthy verdicts
   raise a `notify-send` desktop alert (stop rebooting the router during ISP
   outages — the oracle already knows).

## Install

```sh
# system-wide (root)
sudo sh install.sh
sudo vi /etc/avanza/companion.env        # ORCH_URL + APP_TOKEN

# or per-user session (no root)
sh install.sh
vi ~/.config/avanza/companion.env
```

Logs: `journalctl -u avanza-companion -f` (system) or
`journalctl --user -u avanza-companion -f`.

## Security

- Token lives in a `0600` env file; the systemd unit is hardened
  (`NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`).
- Outbound-only HTTPS to your Worker; nothing listens, nothing is exposed.
- Lane requests are TTL'd and manual-override classed at the edge — a rogue
  companion can at most over-prioritize itself for an hour, and the CAKE
  shaper still guarantees minimum bandwidth to every other host (host fairness
  is structural, not policy).
