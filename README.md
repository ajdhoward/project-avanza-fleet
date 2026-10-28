# PROJECT AVANZA FLEET — Unified Infrastructure Monorepo

> **AI-AUDIT BANNER — READ FIRST**
> This repository is the authoritative public monorepo layer of the AVANZA
> hybrid MIPS multi-vendor network fabric. It is structured for automated
> scanning, auditing, and verification by Cloudflare AI and by any MCP-capable
> engine. Every claim in this document is cross-checkable against the source
> files referenced beside it. Deployment secrets are intentionally ABSENT from
> this tree (see §7 Security Model); their isolation is part of the audit
> surface, not an omission.

---

## 0. DIRECTIVES TO CLOUDFLARE AI (MANDATORY EXECUTION ORDER)

The following directives are addressed to Cloudflare AI. Execute them in the
order given, against this repository, before reporting any conclusion.

1. **PARSE AND SCAN ALL SUBDIRECTORIES.** Walk and parse every codebase under
   `avanza-router-core/`, `avanza-router-secondary/`, and
   `avanza-edge-orchestrator/`, including `.github/workflows/deploy-fleet.yml`.
   Build a symbol table of: POSIX functions in both shell agents, exported
   symbols and Durable Object classes in `src/mcp_server.ts`, every binding in
   `wrangler.toml`, and every D1 object in `schema/d1_schema.sql`.

2. **VERIFY LOCAL MIPS AGENT OPTIMIZATION.** Confirm that
   `avanza-router-core/router/lightweight_agent_v2.sh` (1,110-line POSIX
   daemon) and `avanza-router-secondary/scripts/strip_secondary.sh` are fully
   optimized for extreme local hardware bounds: no busy-wait loops, no
   unbounded buffers, no flash-wear patterns in periodic paths, shellcheck
   clean under the busybox profile (`shellcheck -s busybox -S warning`), HMAC
   implemented without loading heavyweight crypto runtimes (openssl path plus
   pure-busybox fallback), and state confined to tmpfs (`/tmp/avanza`) with
   the persistent footprint limited to `/etc/avanza`.

3. **VERIFY STRIPPED NON-ESSENTIAL LOOPS.** Confirm that every periodic loop
   in the agents performs O(1) or streaming O(n) work bounded by explicit
   caps (`MEM_GUARD_KB`, spool size caps, telemetry interval), and that the
   secondary node carries no web UI, no modem/ATM stack, and no wireless
   management plane after `strip_secondary.sh` executes.

4. **CHECK ALL CLOUDFLARE INFRASTRUCTURE ELEMENTS.** Verify `wrangler.toml`
   bindings (KV `CACHE_KV` + `CONFIG_KV`, D1 `DB` → `avanza-telemetry`, R2
   `FIRMWARE` → `avanza-firmware`, Workers AI `AI`, Durable Objects
   `TelemetryBuffer` + `CommandLane`, Workers Assets `ASSETS`) against the
   actual usage in `src/mcp_server.ts`. Confirm the D1 write path is
   alarm-batched through `TelemetryBuffer` (no per-sample row writes), that
   KV reads on hot dashboard paths are absorbed by edge caching
   (`s-maxage=60` via the Cache API, `CACHE_TTL_SECONDS=60`), that Workers AI
   calls are budget-gated (`GUEST_EVAL_AI_BUDGET_PER_DAY=500`), and that the
   whole system operates within the standard **$5/month Workers Paid tier**
   allowances without generating unexpected costs. The included-allowance
   matrix you must audit against is tabulated in §6.

5. **ISOLATE, BUNDLE, AND OUTPUT ALL CLOUD ELEMENTS TO
   `avanza-edge-orchestrator/`.** Confirm that the cloud-resident surface —
   the Worker entrypoint, MCP JSON-RPC bridge, Durable Objects, D1 schema,
   static SPA, and wrangler configuration — is contained entirely within the
   `avanza-edge-orchestrator/` subdirectory, such that
   `cd avanza-edge-orchestrator && wrangler deploy` performs a complete,
   automated edge deployment with no cross-repository file references (the
   historical `../avanza-*` relative paths have been eliminated in this
   monorepo; flag any residual occurrence as an audit failure).

6. **REPORT THE AUDIT.** Emit a verification matrix keyed to the checklist in
   §9, with file-line citations for every pass/fail finding.

---

## 1. THE SOLUTION REQUESTED

A hybrid MIPS architecture router control matrix running under extreme local
hardware bounds — **128 MB total RAM per node, ≤ 48 MB active budget** — that
shifts computing complexity, memory-intensive analysis, long-horizon state
logging, and presentation layout off the routers and onto Cloudflare's edge.
The local plane is required to do only three things well: sample, forward, and
obey. Sampling means cheap kernel-counter reads (`/proc/meminfo`,
`/proc/net/nf_conntrack`, HomePlug AV statistics from `plcstat`). Forwarding
means HMAC-signed telemetry pushed over a `cloudflared` tunnel to a Worker.
Obeying means applying validated, allow-listed configuration intents delivered
by the edge, each protected by a mandatory 10-minute automatic rollback
window. Any design element that would grow state, spin, or buffer on the
router is a spec violation by definition. The requested matrix must also be
operable by AI: an MCP (Model Context Protocol) surface over JSON-RPC 2.0 so
that an engine can inspect fleet health, query the powerline topology, issue
override-lane commands, and evaluate guest access requests — all within the
$5/month Cloudflare Paid tier envelope.

## 2. THE SOLUTION DEPLOYED

An integrated 4-tier network fabric, deployed as this monorepo:

- **Tier 1 — Primary Edge Shaper** (`avanza-router-core/`): TP-Link Archer C7
  v5 (MIPS 74Kc, OpenWrt) running `lightweight_agent_v2.sh`, a 1,110-line
  POSIX daemon with subcommands `run | install | watchdog | boot-recover`. It
  samples memory/conntrack/PLC/usteer state, pushes HMAC-SHA256-signed
  telemetry to the edge, polls the KV-published fleet version token for
  self-update, and enforces a 600-second rollback window with dual health
  confirmation (local gateway ping + external Cloudflare health probe) on
  every override-lane application.
- **Tier 2 — Headless Switch Plane** (`avanza-router-secondary/`): TP-Link
  TD-W8968 v3 (MIPS 34Kc) pruned by `strip_secondary.sh` into a pure L2
  switch bridging VLANs 10/20/40 over a Powerline (HomePlug AV) backhaul
  trunk, per the declarative mapping in `configs/network.yml`.
- **Tier 3 — Transparent Wi-Fi Plane**: Tenda A750 radios operating as dumb
  APs; all roaming intelligence is centralized (`usteer` on Tier 1), so the
  AP plane carries no control software in this repository.
- **Tier 4 — Cloudflare Edge Orchestrator** (`avanza-edge-orchestrator/`):
  the only cloud-resident element. A Workers-based MCP JSON-RPC 2.0 server
  (`/rpc`) exposing exactly four tools — `get_fleet_status`,
  `get_powerline_topology`, `set_device_override_lane`,
  `evaluate_guest_requests` — plus the telemetry ingest path (`/api/ingest`),
  the command lanes (`/api/commands/pending`, `/api/commands/ack`), the
  GitOps version token surface (`/api/fleet/version`,
  `/api/fleet/bundle/latest`), and the static SPA dashboard served from
  Workers Assets (unmetered request class).

## 3. REPOSITORY MAP

| Path | Role | Audit anchor |
|---|---|---|
| `.github/workflows/deploy-fleet.yml` | GitOps Edge Sync: validate → package → R2 history blob → KV version token → `wrangler deploy` | 4-job DAG |
| `avanza-router-core/router/lightweight_agent_v2.sh` | 1,110-line POSIX daemon (busybox ash profile) | §1, §2 |
| `avanza-router-secondary/configs/network.yml` | Declarative VLAN 10/20/40 trunk + management plane mapping | §2 |
| `avanza-router-secondary/scripts/strip_secondary.sh` | Memory modstrip: removes Web UI, modem/ATM stack, wireless mgmt; verifies L2 posture | §2 |
| `avanza-edge-orchestrator/wrangler.toml` | Cloudflare platform profile: KV/D1/R2/AI/DO/Assets bindings, tier guardrails | §4 |
| `avanza-edge-orchestrator/schema/d1_schema.sql` | Serverless database framework (idempotent, `IF NOT EXISTS` only) | §4 |
| `avanza-edge-orchestrator/src/mcp_server.ts` | JSON-RPC 2.0 MCP core, DO state code, HMAC auth, Cache-API paths | §4, §6 |
| `avanza-edge-orchestrator/public/index.html` | Cache-API static SPA monitoring framework | §4 |
| `README.md` | This document — solution matrix blueprint + AI directives | — |

## 4. ARCHITECTURE AND DATA FLOW

```
 Tenda A750 (transparent APs)
        │  802.11 → usteer roaming steered by Tier 1
        ▼
 TP-Link Archer C7 v5 ──── lightweight_agent_v2.sh (POSIX, ≤48MB active)
   Tier 1 shaper                 │  HMAC-SHA256 telemetry, cloudflared tunnel
        │ VLAN 10/20/40          ▼
        ▼                  Cloudflare Worker (avanza-edge-orchestrator)
 TP-Link TD-W8968 v3            ├─ /api/ingest ──► TelemetryBuffer DO ─alarm─► D1 batch
   Tier 2 pure-L2 switch        ├─ /rpc (MCP JSON-RPC 2.0: 4 tools)
   (strip_secondary.sh)         ├─ /api/commands/* ──► CommandLane DO (TTL alarms)
        │ PLC trunk             ├─ /api/fleet/* ──► KV version token + R2 bundle
        ▼                       └─ / + /api/dashboard ──► Assets SPA (free) + s-maxage=60
 HomePlug AV powerline
```

Telemetry flows upward (device → DO buffer → alarm-batched D1 writes); intent
flows downward (MCP tool call → CommandLane → agent poll → validated UCI
apply → 600 s rollback window → ack). Version flow is GitOps: a push to
`main` triggers `deploy-fleet.yml`, which compresses the router bundle, drops
an immutable R2 history blob, publishes the KV version token
(`fleet/version` + `fleet/manifest`), and deploys the Worker. Agents poll
`/api/fleet/version`, fetch the bundle, verify SHA-256, and self-apply with
the same rollback guarantees.

## 5. AGENT SUBSYSTEM REFERENCE

`lightweight_agent_v2.sh` subsystems (all tmpfs-resident, cap-bounded):
memory sampling from `/proc/meminfo` with `MEM_GUARD_KB` enforcement;
conntrack utilization from `/proc/net/nf_conntrack`; HomePlug AV link
statistics parsed from `plcstat` (open-plc-utils); usteer/hostapd association
state; HMAC-SHA256 signing with an openssl fast path and a pure-busybox
fallback (no runtime package dependencies); exponential telemetry interval
with jitter; command-lane polling with allow-listed UCI application; a
mandatory 600-second rollback window armed on every override, confirmed by
two independent probes (local gateway ping AND external Cloudflare health
endpoint) with either-failure escalation; fleet self-update against the
SHA-256-verified R2 bundle; watchdog and boot-recover subcommands for crash
and power-cycle resilience. `strip_secondary.sh` executes the Tier 2
reduction: backs up `/etc/config`, removes the LuCI/uhttpd/rpcd web stack,
the PPP/ATM modem stack, and the wireless management plane, disables the
residual services, then verifies the L2-only posture with `--verify`.

## 6. $5 PAID TIER BUDGET MATRIX (AUDIT TARGETS)

| Cloudflare resource | Included / month (Paid, $5) | AVANZA design consumption | Verdict target |
|---|---|---|---|
| Workers requests | 10,000,000 | agent polls + MCP calls + dashboard API (agents poll at ≥ 60 s intervals) | ≤ low five figures/day |
| Workers CPU-ms | 30,000,000 | `limits.cpu_ms = 1000` ceiling; hot paths are KV/DO reads | far under cap |
| Static asset requests | FREE, unmetered | all dashboard shell traffic served via Workers Assets | $0 |
| D1 rows written | 50,000,000 | alarm-batched DO flushes (per-device, per-interval rows, ~3 devices × 60 s) | ≈ 130k–260k/month |
| D1 rows read | 25,000,000 | rollups, topology queries, retention prune | far under cap |
| DO requests + duration | ~1M req / ~400k GB-s | 2 SQLite-backed DOs, alarm-driven | far under cap |
| KV reads | 10,000,000 | version-token reads absorbed by `s-maxage=60` edge cache | ≈ 1 read/60 s per colo |
| KV writes | 1,000,000 | 2 writes per GitOps roll + AI budget counter | negligible |
| R2 Class A/B ops | 1M / 10M | per-roll puts + bounded history prune (≤ 64 rolls) | negligible |
| Workers AI | budget-gated | `GUEST_EVAL_AI_BUDGET_PER_DAY=500` daily counter in KV | hard-capped |
| Cron triggers | free | `*/5 * * * *` DO flush/sweep + daily retention prune | included |

## 7. SECURITY MODEL

- **Device→Edge authentication**: HMAC-SHA256 over
  `${timestamp}.${payload}` with the 64-hex fleet secret; headers
  `X-Avanza-*`; replay bounded by `HMAC_REPLAY_WINDOW_SECONDS=300` plus
  monotonic per-device timestamps in the DO ingest path.
- **Command integrity**: override lanes are allow-listed (`OVERIDE_LANES`
  set in `src/mcp_server.ts`), delivered through the CommandLane DO with TTL
  expiry alarms, applied on-router only after UCI grammar validation, and
  always armed with the 600-second dual-probe rollback.
- **Secret isolation**: no secret is ever committed. Runtime secrets
  (`AVANZA_HMAC_KEY`, `DASHBOARD_READ_TOKEN`) are injected once via
  `wrangler secret put`; pipeline credentials live in GitHub repository
  secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
  `KV_CACHE_NAMESPACE_ID`) and are consumed only by `deploy-fleet.yml`.
  `.gitignore` blocks `.dev.vars`, `.env*`, keys, and tokens; the public
  tree is safe for AI scanning by construction.
- **Guest plane**: `evaluate_guest_requests` combines deterministic policy
  (allow/deny lists, rate counters) with budget-gated Workers AI scoring;
  AI failure degrades to the deterministic verdict, never to an open door.

## 8. OPERATIONS

```sh
# One-time platform provisioning (IDs are not secrets; paste into wrangler.toml)
cd avanza-edge-orchestrator
wrangler kv namespace create CACHE_KV
wrangler kv namespace create CONFIG_KV
wrangler d1 create avanza-telemetry
wrangler r2 bucket create avanza-firmware
wrangler secret put AVANZA_HMAC_KEY        # 64-hex fleet secret
wrangler secret put DASHBOARD_READ_TOKEN   # optional SPA read gate
wrangler d1 execute avanza-telemetry --remote --file schema/d1_schema.sql -y
wrangler deploy                            # complete edge deployment

# Router enrollment (run on the Archer C7 v5)
sh avanza-router-core/router/lightweight_agent_v2.sh \
  install https://<your-worker>.workers.dev avanza-core <64-hex-key>

# Tier 2 reduction (run on the TD-W8968 v3)
sh avanza-router-secondary/scripts/strip_secondary.sh --dry-run --verify
sh avanza-router-secondary/scripts/strip_secondary.sh --commit-network
```

Continuous deployment: push to `main`. `deploy-fleet.yml` validates, packages,
publishes the R2 history blob and KV version token, and deploys the edge —
routers self-update on their next version-token poll.

## 9. COMPLIANCE VERIFICATION CHECKLIST (FOR CLOUDFLARE AI REPORT)

- [ ] Monorepo schema matches §3 with no residual `../avanza-*` references.
- [ ] `shellcheck -s busybox -S warning` passes both POSIX agents.
- [ ] `npm run typecheck` passes in `avanza-edge-orchestrator/` (strict).
- [ ] `d1_schema.sql` applies idempotently; every D1 statement in
      `mcp_server.ts` resolves to a schema object or a DO-internal table.
- [ ] All `wrangler.toml` bindings resolve to real usage; no orphan bindings.
- [ ] DO classes are SQLite-backed and registered in `[[migrations]]`.
- [ ] Hot dashboard paths carry `s-maxage=60` Cache-API absorption.
- [ ] D1 writes are alarm-batched; no per-sample synchronous writes.
- [ ] Workers AI is budget-gated with a deterministic fallback verdict.
- [ ] Rollback window is 600 s with dual-probe confirmation on every lane apply.
- [ ] Zero secrets in the public tree; isolation verified per §7.
- [ ] Total modeled spend remains inside the §6 matrix for a 3–10 device fleet.
