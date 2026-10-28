# avanza-browser-extension

Manifest V3 extension (Chrome/Edge/Brave; Firefox note below) that turns any
browser on the LAN into an Avanza control surface — **without ever touching the
router directly**: everything goes through the orchestrator Worker with the same
app-token auth as the mobile app, so the router stays egress-only.

## Features

- **Live oracle badge**: `OK` / `!` (watch) / `ISP` (regional outage) / `LAN`
  (local fault suspected) — polls `GET /api/outage/status` every 5 min via
  `chrome.alarms` (served from the Worker's 60 s Cache-API layer, so polling is
  nearly free).
- **Desktop notifications** on verdict transitions (e.g. "REGIONAL_OUTAGE —
  your dropouts are not a hardware fault").
- **Device picker** from the live registry (`GET /api/devices`) showing zone,
  lane and pause state.
- **🎓 Boost 1 h** → `POST /api/control/lane {lane:"priority"}` — the meeting /
  ranked-match button. **Back to normal** clears the override.
- **⏸ Pause / ▶ Resume** → `POST /api/control/pause` (parental controls from
  the browser).
- **⚡ Speed test** → shows the latest router-side result and queues a new run.

## Install

1. Deploy the orchestrator and create your `APP_CONTROL_KEY` secret.
2. `chrome://extensions` → Developer mode → **Load unpacked** → select this folder.
3. Extension options → set orchestrator URL + app token (+ optional Pages
   dashboard URL).

**Firefox:** MV3 is supported; change `manifest.json` →
`"background": { "scripts": ["background.js"] }` and add
`"browser_specific_settings": { "gecko": { "id": "avanza@local" } }`, then load
via `about:debugging`.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3: storage + alarms + notifications, host perms limited to HTTPS |
| `background.js` | alarm-driven oracle poll, badge state machine, transition notifications |
| `popup.html/js` | device picker + boost/pause/resume/speedtest actions |
| `options.html/js` | orchestrator URL + app token (chrome.storage.sync) |

## Security notes

- The app token is powerful (lane/pause/backup). Keep it in your personal
  browser profile; the extension stores it in `chrome.storage.sync` (encrypted
  at rest by the browser's account sync).
- All calls are CORS-open **only** for reads; every mutation endpoint verifies
  the token server-side and every mutation on the router is snapshot-first +
  rollback-armed — a stolen token cannot brick the network, only inconvenience it.
- No analytics, no third-party origins, no content scripts — the extension
  never sees your browsing.
