#!/usr/bin/env bash
# PROJECT AVANZA / one-shot Cloudflare account provisioning guide+runner.
# Walks the full free-tier stack against YOUR account: KV, D1, R2, Pages,
# secrets, tunnel token, Health Check, Access policy checklist.
# Run from the dashboard/ directory (needs wrangler). Idempotent-ish: creating
# an existing resource errors harmlessly; captured IDs are printed for
# wrangler.toml.
set -uo pipefail

cd "$(dirname "$0")/.."

say()  { printf "\n\033[1;36m== %s\033[0m\n" "$1"; }
warn() { printf "\033[1;33m!! %s\033[0m\n" "$1"; }
ask()  { printf "%s [y/N] " "$1"; read -r a; [ "${a:-N}" = "y" ] || [ "${a:-N}" = "Y" ]; }

command -v npx >/dev/null || { echo "node/npx required"; exit 1; }

say "0/8 · wrangler login"
npx wrangler whoami >/dev/null 2>&1 || npx wrangler login

say "1/8 · KV namespace (AVANZA_KV)"
if ask "create KV namespace avanza-kv?"; then
	npx wrangler kv namespace create AVANZA_KV
	warn "paste the printed id into wrangler.toml [[kv_namespaces]]"
fi

say "2/8 · D1 database (AVANZA_HISTORY) + schema"
if ask "create D1 database avanza-history?"; then
	npx wrangler d1 create avanza-history
	warn "paste the printed database_id into wrangler.toml [[d1_databases]]"
fi
if ask "apply schema.sql to the REMOTE database now? (requires the id above set first)"; then
	npx wrangler d1 execute avanza-history --remote --file=./schema/d1_schema.sql
fi

say "3/8 · R2 bucket (AVANZA_R2: backups + firmware mirror)"
if ask "create R2 bucket avanza-backups?"; then
	npx wrangler r2 bucket create avanza-backups
	warn "enable R2 in the dash once if the account never used R2 (free: 10GB, zero egress fees)"
fi

say "4/8 · Pages project (dashboard/artifact hosting)"
if ask "create Pages project 'avanza' for the generative-ui dashboard?"; then
	npx wrangler pages project create avanza --production-branch main
	cat <<'PAGES'
  deploy the artifact + a landing page:
    cd ../avanza-generative-ui
    mkdir -p /tmp/avanza-pages && cp artifacts/avanza-topology-matrix.html /tmp/avanza-pages/index.html
    npx wrangler pages deploy /tmp/avanza-pages --project-name avanza
  → https://avanza.pages.dev
PAGES
fi

say "5/8 · Worker secrets"
for secret in AGENT_HMAC_KEY APP_CONTROL_KEY EXPO_ACCESS_TOKEN RADAR_API_TOKEN TG_BOT_TOKEN TG_CHAT_ID IODA_API_URL; do
	if ask "set secret $secret now?"; then
		npx wrangler secret put "$secret"
	fi
done
warn "AGENT_HMAC_KEY must equal /etc/avanza/agent.env on the router (openssl rand -hex 32)"
warn "APP_CONTROL_KEY goes to: mobile app EXPO_PUBLIC_APP_CONTROL_KEY, browser extension options, Linux companion env"

say "6/8 · Cloudflare Tunnel token (router side)"
cat <<'TUNNEL'
  dash.one.cloudflare.com → Zero Trust → Networks → Tunnels → Create (cloudflared)
  copy the token, then on the router:
    uci set cloudflared.@cloudflared[0].token='<TOKEN>'   # or /etc/init.d/cloudflared per wiki
    /etc/init.d/cloudflared enable && /etc/init.d/cloudflared start
TUNNEL

say "7/8 · Health Check (independent WAN probe for the oracle)"
cat <<'HC'
  Requires an API token with Account Health Checks:Edit. Then (account_id from dash URL):
    curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/healthchecks" \
      -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
      --data '{"name":"avanza-tunnel","type":"HTTPS","destination":"router.avanza.example.com","active":true,"regions":["wnam","weur"],"interval":60,"retries":2,"timeout":5,"notification":{"suspended":true,"healthy":"always","unhealthy":"always"}}'
  Feed notification emails/webhooks into the oracle's RSS-style source list (KV config:outage_sources).
HC

say "8/8 · Zero Trust Access policy (gate the Pages dashboard)"
cat <<'ACCESS'
  Zero Trust → Access → Applications → Add: Self-hosted
    domain: avanza.pages.dev
    policy: Allow · include Emails: you@yourdomain
    (optional) require WebAuthn/OTP MFA
  Result: the dashboard is unreachable without SSO, and no port is open anywhere.
ACCESS

say "DONE"
cat <<'FINAL'
  extras (all free, all optional):
    · Turnstile: dash → Turnstile → add site (hostname of your Worker/Pages) →
      put the SITEKEY into wrangler.toml [vars] TURNSTILE_SITEKEY and
      `wrangler secret put TURNSTILE_SECRET` → enables the /guest unblock portal.
    · PUBLIC_BASE var: set it to your Worker/Pages origin so weekly-report
      Telegram links resolve (/report/latest).
    · Static assets: cp the generative-ui artifact to dashboard/public/index.html
      before deploying — it becomes the free dashboard at your Worker root.

  next:  npx wrangler deploy          # publishes the worker with all bindings
         npx wrangler tail --format pretty
  router: fill /etc/avanza/agent.env   (ORCH_URL + AGENT_HMAC_KEY)
  app:    set app.json extra.orchUrl + EXPO_PUBLIC_APP_CONTROL_KEY
FINAL
