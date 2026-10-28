# avanza-infra-iac

GitOps control tower for the Avanza fleet. Three responsibilities:

1. **`wrangler.toml`** — the authoritative multi-environment deployment config.
   One worker codebase (`../avanza-edge-orchestrator/dashboard/src/traffic_classifier.ts`),
   two environments over **shared** KV/D1/R2/DO/AI bindings:
   - `--env primary` → script `avanza-fleet-primary` (production; both router
     agents post here; owns the `AvanzaState` DO class + migrations; the MCP
     bridge cross-binds into it via `script_name`).
   - `--env secondary` → script `avanza-fleet-secondary` (canary; point one
     test device's `ORCH_URL` here to dry-run worker changes before production).
   Static assets binding serves the control-matrix dashboard from the worker
   root (free, unmetered). Crons: `*/5 * * * *` oracle + `0 7 * * 1` weekly
   report, inherited by both envs.

2. **`scripts/lint_fleet.sh`** — the CI dry-run linter (also runnable locally):
   `sh -n` on every shell program (both agents, both transpilers, strip script,
   companion, installer, init units), **both YAML→UCI transpilers executed in
   dry-run** with required-token assertions (fleet zone, guest zone, DNS-hijack
   redirects, bridge-vlan matrix, VLAN-40 trunk tokens), YAML/JSON parse,
   extension + artifact JS `node --check`, esbuild parse of all 13 TS/TSX
   files, and workflow sanity greps. Non-zero exit blocks the deploy job.

3. **`.github/workflows/deploy-fleet.yml`** (at the monorepo root, where GitHub
   reads it) — the authoritative loop:

```
push main (configs/nft/scripts/worker/artifact paths)
  ├─ lint job:   lint_fleet.sh + worker tsc --noEmit + MCP tsc --noEmit
  └─ deploy job:
      VERSION=git-<sha12>
      tar czf primary.tar.gz   {configs,nft,scripts,router}      + sha256
      tar czf secondary.tar.gz {configs,scripts}                 + sha256
      wrangler r2 object put  avanza-backups/fleet/$VERSION/{primary,secondary}.tar.gz
      wrangler r2 object put  avanza-backups/fleet/latest/…      (fallback path)
      wrangler kv key put fleet:config:version '{"version":…,"primary":{"sha256":…},"secondary":{…}}'
      cp artifact → dashboard/public/index.html                  (asset sync)
      wrangler deploy --env primary && --env secondary
      wrangler deploy (avanza-mcp-bridge)
```

Agents converge **pull-based**: the version token rides the ingest response;
on change the agent HMAC-fetches `/api/fleet/bundle?device=…`, verifies
**sha256**, snapshots, applies through the staged transpiler, and arms the
10-minute rollback window (3-point ping sweep: default GW + fleet peer
192.168.99.2 + 1.1.1.1, DNS/HTTPS via orchestrator `/health`, tunnel process
check when enabled). Fail ⇒ auto-restore + `fleet.apply_state=rolled_back`
reported upstream on the next heartbeat. No inbound port is ever opened for
configuration delivery.

## Required repository secrets (GitHub → Settings → Secrets)

| Secret | Scope |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Workers Scripts:Edit, KV:Edit, D1:Edit, R2:Edit, Workers Deploy |
| `CLOUDFLARE_ACCOUNT_ID` | account identifier |

## Local dry run

```sh
sh scripts/lint_fleet.sh            # full lint, ~20 s
VERSION=dev-$(date +%s)             # manual bundle rehearsal:
cd ../avanza-router-core && tar czf /tmp/primary.tar.gz configs nft scripts router && sha256sum /tmp/primary.tar.gz
```
