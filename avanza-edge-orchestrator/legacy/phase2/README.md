# avanza-edge-orchestrator

Cloudflare Workers edge brain for Project Avanza. One Worker module graph:

| File | Role |
|---|---|
| `src/traffic_classifier.ts` | main `fetch` handler: HMAC-verified telemetry ingest, deterministic + Workers-AI L7 flow classification, lane directive emission, app control plane, OpenUI Lang `/sdui/manifest` emitter (streaming) |
| `src/state_do.ts` | `AvanzaState` Durable Object: in-memory device registry, WAN event log, digest ring buffer, temp-access queue; 15-min alarm flush to KV (free-tier write budget) |
| `src/outage_oracle.ts` | 5-min cron: Cloudflare Radar + IODA + ISP status RSS fusion, local-vs-regional correlation matrix, Expo Push / Telegram notification with cooldown |
| `src/types.ts` | shared contracts (payload, directives, device record, outage state, Env) |
| `src/mcp_server.ts` | **MCP endpoint** mounted at `/mcp` — JSON-RPC 2.0 (protocol 2025-03-26): `get_fleet_status`, `get_powerline_topology`, `set_device_override_lane`, `evaluate_guest_unblock_requests`; HMAC auth (`MCP_HMAC_KEY`, falls back to `AGENT_HMAC_KEY`); full docs in `MCP.md` |

## Deploy

```sh
cd avanza-edge-orchestrator   # repo root of this package
npm install
npx wrangler login
npx wrangler kv namespace create AVANZA_KV     # paste id into wrangler.toml
npx wrangler deploy
npx wrangler secret put AGENT_HMAC_KEY        # openssl rand -hex 32 ; same value -> /etc/avanza/agent.env
npx wrangler secret put APP_CONTROL_KEY       # openssl rand -hex 24 ; goes into the Expo app
npx wrangler secret put EXPO_ACCESS_TOKEN     # optional push
npx wrangler secret put RADAR_API_TOKEN       # optional; CF API token with Radar read
npx wrangler secret put TG_BOT_TOKEN          # optional fallback notifier
npx wrangler secret put TG_CHAT_ID
npx wrangler tail --format pretty             # watch live ingest
```

## API surface

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health` | none | agent health probe (rollback watchdog uses it) |
| `POST /api/telemetry/ingest` | HMAC-SHA256 (`X-Avanza-Signature: t=…,v1=…`, 300 s window) or `X-Avanza-Token` | telemetry in → `{directives[], temp_access[], outage}` out |
| `POST /api/control/lane` | `X-Avanza-App-Token` | `{ip, lane, ttl}` manual override (survives until TTL) |
| `POST /api/control/temp-access` | `X-Avanza-App-Token` | `{phone_ip, device_ip, ttl}` → queued for the next agent cycle |
| `POST /api/control/pause` | `X-Avanza-App-Token` | `{ip, minutes}` or `{ip, resume:true}` → parental pause (agent applies snapshot-first UCI REJECT) |
| `POST /api/control/speedtest` | `X-Avanza-App-Token` | queues router-side speed test (`speed.cloudflare.com` via uclient-fetch) |
| `POST /api/control/backup` | `X-Avanza-App-Token` | queues `tar czf /etc/config` → base64 → KV `backup:latest` |
| `POST /api/control/restore` | `X-Avanza-App-Token` | ships stored backup to the agent (snapshot-first restore + rollback armed) |
| `POST /api/control/register` | `X-Avanza-App-Token` | companion/extension self-registration (`{ip, hostname, os}` → device registry) |
| `GET /api/speedtest` | none | latest router-side speed test result |
| `GET /api/backup` | `X-Avanza-App-Token` | download the latest cloud config backup |
| `GET /api/firmware/status` | none | ASU firmware freshness verdict for ath79/generic · archer-c7-v5 |
| `GET /status` | none | public cache-cached verdict page (wall-tablet/bookmark friendly) |
| `GET /guest` | Turnstile | public unblock-request portal for paused household members |
| `POST /api/guest/request` | Turnstile token | queues an unblock request (KV `guest:requests`, capped 20) |
| `GET /api/guest/requests` · `POST /api/guest/approve` | `X-Avanza-App-Token` | owner review → `resume` action to the agent |
| `GET /report/latest` | none | weekly HTML report (R2 `reports/latest.html`, s-maxage 300) |
| `GET /api/history/summary` · `/api/history/outages` | `X-Avanza-App-Token` | D1 7-day rollups + 30-day outage log |
| `POST /api/fleet/syslog` | HMAC (agents) | secondary node logread-delta batches → D1 `fleet_syslog` (≤200 lines/req) |
| `GET /api/fleet/bundle?device=primary\|secondary` | `X-Avanza-Token` (agent key) | GitOps bundle stream from R2 `fleet/<token>/<device>.tar.gz` with sha256 header |
| `POST /mcp` | `X-Avanza-Signature` HMAC (MCP_HMAC_KEY) | **MCP JSON-RPC 2.0** tools for LLM fleet management (see `MCP.md`) |
| `GET /*` (fallback) | none | **Static Assets** — the full control-matrix dashboard served free from `public/` |
| `GET /api/devices` | `X-Avanza-App-Token` | device registry (zone, lane, privacy grade, top destinations, paused_until) |
| `GET /api/outage/status` | none | current oracle verdict |
| `POST /api/outage/scan` | `X-Avanza-App-Token` | force an oracle run |
| `GET /sdui/manifest[?stream=1]` | none (read-only) | OpenUI Lang program for the Expo `Renderer` |

## KV key map

```
tel:summary:<15min-stamp>     DO cold flush (7d TTL)
devices:registry              last flushed device table (7d TTL)
events:wan_down:<yyyy-mm-dd>  merged WAN-down events (30d TTL)
cls:<proto>:<dst>:<dport>     AI classification cache (24h TTL)
outage:current                live verdict (app + agent read path)
outage:history:<hour>         non-healthy snapshots (30d TTL)
outage:last_state / last_notify  notification dedupe + 30-min cooldown
config:outage_sources         {"feeds":[{"url","label"}],"keywords":[...],"fresh_hours":2}
push:devices                  ["ExponentPushToken[...]", ...]
speedtest:latest              last router-side speed test (30d TTL)
backup:latest / backup:meta   config backup (R2 binary preferred, KV b64 fallback)
firmware:status               ASU freshness {current, latest, update_available, install_hint}
firmware:checked_at           daily-check cooldown stamp
fleet:config:version          GitOps token {version, primary:{sha256}, secondary:{sha256}} — rides every ingest response
```

The ingest response now also carries an `actions[]` array (speedtest / backup /
restore / pause / resume) drained from the Durable Object queue — the router
stays egress-only: every control flow is request→response on the agent's own
60-second heartbeat.

## Free-tier budget math (why the DO exists)

KV free tier = **1 000 writes/day**. Persisting every 60-second ingest would need
1 440. The Durable Object buffers in memory and flushes once per 15 minutes
(2 writes ⇒ 192/day); the oracle writes `outage:current` per run (288/day);
AI class cache writes occur only on novel verdicts (~10–50/day).
Total ≈ **530 writes/day**, 47 % headroom. Requests ≈ 6 k/day of 100 k.

## Static assets & crons

`public/index.html` is the control-matrix artifact; sync it after edits:

```sh
cp ../../avanza-generative-ui/artifacts/avanza-topology-matrix.html public/index.html
```

Asset hits are unmetered. Crons: `*/5 * * * *` → outage oracle (incl. daily
ASU firmware check + Health-Check correlation) and `0 7 * * 1` → weekly HTML
report (D1+KV → R2, 8-report ring, 90-day D1 retention prune, Telegram link).

## Account provisioning & bindings

Run `scripts/setup_account.sh` once — it walks KV → D1 (+ `schema.sql`) → R2 →
Pages → secrets → tunnel token → Health Check → Access policy against your own
Cloudflare account and prints every ID that goes into `wrangler.toml`.

Optional bindings degrade gracefully when absent: `AVANZA_HISTORY` (D1 cold
history — telemetry buckets, outage events, per-device daily bytes) and
`AVANZA_R2` (binary backup store + firmware image mirror). Reads of
`/api/outage/status` and non-streamed `/sdui/manifest` are served through the
**Cache API** (s-maxage 60 / 15) so client polling costs ~nothing.

## Configure your ISP status feeds

```sh
npx wrangler kv key put config:outage_sources --namespace-id <ID> --body '{
  "feeds": [
    { "url": "https://status.your-isp.com/history.rss", "label": "isp-status" },
    { "url": "https://outage.report/your-isp/feed", "label": "outage-report" }
  ],
  "keywords": ["outage","down","degraded","incident","maintenance"],
  "fresh_hours": 2
}'
```

Register push tokens by `PUT push:devices` with a JSON array of Expo tokens
(the app can also self-register — see `avanza-app-expo/src/lib/api.ts`).
