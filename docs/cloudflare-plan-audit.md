# CLOUDFLARE $5 WORKERS PAID PLAN AUDIT — zero-surprise bill guarantee

Verified against Cloudflare pricing pages, October 2026. Bottom line:

> **Avanza on the $5 Workers Paid plan bills $5.00 flat.** Every service used is
> either (a) inside the included allowances of the $5 minimum, or (b) inside a
> permanent free allocation. No enterprise product, no paid add-on, no
> metered service is on the default path. A tripwire section at the end lists
> what *could* move the bill and the guards already in the code.

---

## 1. What the $5 includes (verified)

| Fact | Source |
|---|---|
| Paid plan = $5/month minimum, **includes Workers, Pages Functions, Workers KV, Hyperdrive and Durable Objects usage** | developers.cloudflare.com/workers/platform/pricing |
| **10 M requests/month included**, $0.30 per additional million | cloudflare.com/plans/developer-platform-pricing |
| **30 M CPU-milliseconds/month included**, $0.02 per additional million | cloudflare.com/plans/developer-platform-pricing |
| Workers AI: **10,000 neurons/day free allocation even on Paid**, then $0.011/1k neurons | developers.cloudflare.com/workers-ai/platform/pricing |
| D1 Paid: **first 25 B row-reads/month and 50 M row-writes/month included**, 5 GB storage | developers.cloudflare.com/d1/platform/pricing |
| Durable Objects: **SQLite DOs work even on the Free plan**; free: 100k SQL rows written/day, 5 GB SQL storage; on Paid, DO usage is inside the $5 minimum | developers.cloudflare.com/durable-objects/platform/pricing |
| R2: **10 GB-month storage, 1 M Class A, 10 M Class B operations free**, zero egress fees | developers.cloudflare.com/r2/pricing |
| Zero Trust (Access, Gateway DNS filtering, WARP, Tunnels): **free up to 50 users** | cloudflare.com/plans + zerometric 2026 review |

## 2. Avanza projected usage vs allowances (single router household)

| Service | Avanza/month | Allowance | Headroom | Bill |
|---|---|---|---|---|
| Worker requests | ~180 k (ingest 1.4k + clients + oracle) | 10 M included | 55× | $0 |
| Worker CPU | ~10 s total (light JSON, no crypto loops) | 30 M CPU-ms included | ~3000× | $0 |
| KV reads | ~120 k | included in $5 (rate $0.50/M → $0.06 absorbed by minimum) | — | $0 |
| KV writes | ~16 k (530/day) | included in $5 (rate $5/M → $0.08 absorbed) | — | $0 |
| Durable Object | ~60 k requests, <1 MB SQLite | included in $5; free tier alone allows 100k rows/day | — | $0 |
| D1 | ~3 k writes (15-min buckets + events), ~30 k reads | 50 M writes / 25 B reads included | 4 orders of magnitude | $0 |
| R2 | ~12 backups + 4 reports + 1 firmware image ≈ 15 MB, ~2 k Class A/B | 10 GB + 1 M A + 10 M B free | huge | $0 |
| Workers AI | ~1.5 k neurons (ambiguous flows only, cached) | 10 k neurons/**day** free | ~200× | $0 |
| Static Assets (dashboard) | unlimited pages served | assets are free and unmetered | ∞ | $0 |
| Cron Triggers | 8,688 (5-min oracle + weekly report) | free | ∞ | $0 |
| Turnstile | guest-portal challenges | free, unlimited | ∞ | $0 |
| Cache API | SDUI/status/report edge caching | free | ∞ | $0 |
| Pages (optional host) | static dashboard | free, unlimited bandwidth | ∞ | $0 |
| Access / Gateway / WARP / Tunnel | ≤50 users | free tier | — | $0 |
| Health Checks | 1 check | free (1,000 checks) | — | $0 |
| Email Routing / Radar API | notification + oracle signal | free | — | $0 |
| **Total** | | | | **$5.00 flat** |

## 3. Free-plan fallback (the honest surprise)

Everything above **also runs on the $0 Workers Free plan** — that was the v1
design constraint (100 k req/day, 1 k KV writes/day, SQLite DOs, D1/R2/AI free
tiers). You only *need* the $5 plan when: client polling multiplies past
~100 k req/day (a fleet of routers/phones), you want >1 k KV writes/day
(multi-router history), or you opt into metered products below. The DO-buffered
KV-write design (530/day) exists precisely so the free plan keeps working.

## 4. Deliberately EXCLUDED — enterprise or extra-charge products

Never bundled into Avanza, per your instruction:

| Product | Why excluded |
|---|---|
| Bot Management | **Enterprise-only** |
| Spectrum (TCP/UDP proxy) | **Enterprise-only** |
| Magic Transit / Magic WAN / Magic Firewall | **Enterprise-only** |
| Logpush | paid add-on (Observability free tier suffices) |
| CASB / DLP / advanced device posture | paid Zero Trust tiers (free 50-user Access/Gateway/WARP covers us) |
| Super Bot Fight Mode | Pro+ plan feature (Turnstile covers our forms, free) |
| Argo Smart Routing | $5 add-on (CAKE + oracle beat it for this use case) |
| Image Resizing / Polish / Stream / Images | paid media add-ons (no media workload) |
| WAF managed rulesets (full) | paid add-on; we expose no public attack surface (egress-only router; Access-gated dashboard; Turnstile-gated guest portal) |
| Advanced Rate Limiting | paid; KV/DO-based logical rate limits implemented in code instead |
| Queues | metered ($0.40/M ops), **redundant** — the DO action queue already does this for free |
| Workflows | metered steps — our cron + DO alarms cover the same ground |
| Browser Rendering | metered pages — weekly report is server-rendered HTML string (no headless browser needed) |
| Containers / Pipelines / Vectorize-beyond-free / AutoRQL | metered or beta; roadmap-only (§6 of edge-services doc) |

## 5. New in this revision (all inside the allowances above)

1. **Worker-hosted dashboard (Static Assets)** — `dashboard/public/index.html`
   (the full control-matrix artifact) served by the Worker's free assets layer:
   unmetered, no invocation cost for cache/asset hits. `wrangler.toml` gains
   `assets = { directory = "./public", binding = "ASSETS" }`; unmatched routes
   fall through to `env.ASSETS.fetch()`.
2. **Public `/status` page** — cache-cached (s-maxage 60) verdict page you can
   bookmark or put on a wall tablet; no secrets, no auth.
3. **Turnstile-gated guest portal `/guest`** — a paused/blocked household member
   (or their parent 😉) submits an unblock request; Turnstile (free, unlimited)
   stops abuse; the request lands in KV `guest:requests`; owner approves from
   the app/extension (`POST /api/guest/approve`) → DO action queue → agent
   `resume`. Full approval trail, zero open relay.
4. **Weekly HTML report (cron Mondays 07:00)** — `weekly_report.ts` renders
   traffic/outage/speedtest history from D1+KV into a self-contained HTML file
   stored in **R2** (`reports/latest.html` + 8-week ring, older pruned),
   Telegram-notified with a link to `/report/latest`. Also runs the D1 90-day
   retention DELETEs. No Browser Rendering needed — pure string rendering.
5. **Health-Check correlation** — the oracle now folds an external Cloudflare
   Health Check on your tunnel hostname into the verdict matrix: probe-down +
   regional-signal → REGIONAL_OUTAGE; probe-down + router telemetry healthy →
   "tunnel/path issue" detail under LOCAL_FAULT_SUSPECTED.
6. **D1 history APIs** — `GET /api/history/summary` and `/api/history/outages`
   (7-day rollups) for app charts and the report.

## 6. Tripwires & built-in guards (how the bill stays $5.00)

| Risk | Guard already in code |
|---|---|
| KV write runaway | DO alarm flush caps at 2 writes/15 min; verdict cache writes only on novel classes; outage `current` = 288/day — total ~530/day, 47 % of even the *free* daily cap |
| Request volume growth (phones/tablets/TV polling) | `/api/outage/status` (60 s) and `/sdui/manifest` (15 s) served from **Cache API** — N clients ≈ 1 origin hit per TTL window |
| AI cost creep | deterministic classifier first; AI batch capped at 12 flows/cycle; verdicts cached 24 h in KV |
| D1/R2 growth | weekly report prunes D1 rows >90 days and keeps only 8 weekly reports in R2 |
| Firmware mirror bloat | single object, overwritten per release (`firmware/latest.bin`) |
| Abuse of public endpoints | `/status` is read-only + cached; `/guest` is Turnstile-gated + KV array capped at 20 pending; all mutations require the app token and every router-side mutation is snapshot + rollback-armed |
| Accidental paid product enablement | `wrangler.toml` binds only KV/D1/R2/DO/AI/Assets — nothing metered can be invoked by code that isn't bound |
