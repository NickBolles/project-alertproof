#!/usr/bin/env bash
# Flip AlertProof from mock/demo mode to real Shopify mode, then redeploy.
#
# Run this once the real client secret exists (launch plan B2). It prompts for
# secrets rather than taking them as arguments, and passes them onward through
# the environment rather than argv, so nothing lands in shell history or in a
# command line readable via /proc or `ps`.
#
# It refuses to disable mocks unless every credential is a real value. See the
# validation block for why that matters.
#
#   /usr/local/bin/alertproof-go-live.sh
#
# Everything it touches is backed up first. Re-running it is safe.
set -euo pipefail

ENV_FILE=/etc/vps-apps/alertproof.env
APP_DIR=/opt/vps-apps/project-alertproof
HOST=alertproof.nickbolles.com

# Values that mean "nobody has filled this in yet". Checked before the script is
# willing to disable mocks — see the guard block below.
is_placeholder() {
  case "$1" in
    "" | dev-key | dev-secret | CHANGE_ME | CHANGE_ME_* | alerts@example.com) return 0 ;;
    *) return 1 ;;
  esac
}

current_value() {
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1
}

# The key and value go in through the environment, never argv: anything passed
# as a command-line argument is readable by any other user on the box via /proc
# or `ps` for as long as the process lives.
set_key() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    AP_ENV_FILE="$ENV_FILE" AP_KEY="$key" AP_VALUE="$value" python3 <<'PY'
import os
path, key, value = os.environ["AP_ENV_FILE"], os.environ["AP_KEY"], os.environ["AP_VALUE"]
lines = open(path).read().splitlines()
out = [f"{key}={value}" if line.startswith(f"{key}=") else line for line in lines]
open(path, "w").write("\n".join(out) + "\n")
PY
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
  echo "  set $key"
}

prompt_secret() {
  local key="$1" label="$2" value
  read -rsp "$label (blank = leave unchanged): " value
  echo
  [ -n "$value" ] && set_key "$key" "$value" || echo "  $key left unchanged"
}

echo "== backing up $ENV_FILE =="
cp -a "$ENV_FILE" "$ENV_FILE.bak-$(date -u +%Y%m%d-%H%M%S)"

echo "== credentials =="
prompt_secret SHOPIFY_API_SECRET "Shopify client secret"
prompt_secret POSTMARK_API_TOKEN "Postmark server token"

read -rp "Verified EMAIL_FROM address (blank = leave unchanged): " email_from
[ -n "$email_from" ] && set_key EMAIL_FROM "$email_from"
read -rp "SHOPIFY_APP_PRICING_URL (blank = leave unchanged): " pricing_url
[ -n "$pricing_url" ] && set_key SHOPIFY_APP_PRICING_URL "$pricing_url"

# Validate BEFORE disabling mocks. Turning mocks off is what makes the adapters
# real, and every one of these values is selected on presence, not validity:
# getAdapterMode treats ANY non-empty POSTMARK_API_TOKEN as "use Postmark", so a
# leftover placeholder yields a deployment that passes /healthz while every
# email is rejected by Postmark. Failing here leaves the app in working mock
# mode, which is strictly better than a live app that silently drops alerts.
echo "== validating =="
blockers=()
for key in SHOPIFY_API_SECRET POSTMARK_API_TOKEN EMAIL_FROM; do
  value=$(current_value "$key")
  if is_placeholder "$value"; then
    blockers+=("$key is still a placeholder or empty")
  else
    echo "  $key looks real (${#value} chars)"
  fi
done

if [ ${#blockers[@]} -gt 0 ]; then
  echo >&2
  echo "REFUSING to disable mocks — the app stays in mock mode:" >&2
  printf '  - %s\n' "${blockers[@]}" >&2
  echo >&2
  echo "Re-run this script and supply every value. Nothing was changed except" >&2
  echo "any values you just entered; the backup above has the previous state." >&2
  exit 1
fi

if is_placeholder "$(current_value TWILIO_ACCOUNT_SID)"; then
  echo "  NOTE: no app-level Twilio. SMS for any shop without its own BYO"
  echo "        credentials falls back to the mock adapter and is recorded as"
  echo "        SENT while nothing leaves the server. Do not enable SMS rules"
  echo "        until credentials exist. (Tracked in the launch plan backlog.)"
fi

echo "== switching to real mode =="
set_key AUTH_MODE shopify
set_key ALERTPROOF_FORCE_MOCKS 0
set_key ALERTPROOF_AUTH_BYPASS 0
set_key NODE_ENV production
chmod 600 "$ENV_FILE"

echo "== redeploying =="
cd "$APP_DIR"
# -p alertproof is mandatory: without it Compose derives the project name from
# the directory (project-alertproof) and stands up a PARALLEL stack with an
# empty database instead of updating the running one.
docker compose -p alertproof --env-file .env.production \
  -f docker-compose.production.yml up -d --build

echo "== waiting for health =="
for i in $(seq 1 30); do
  code=$(curl -s -o /tmp/healthz.json -w '%{http_code}' "https://$HOST/healthz" || true)
  if [ "$code" = "200" ]; then
    echo "  /healthz 200: $(cat /tmp/healthz.json)"
    break
  fi
  [ "$i" = "30" ] && { echo "  FAILED: /healthz returned $code after 30 tries" >&2; exit 1; }
  sleep 5
done

echo "== security probes =="
printf '  invalid-HMAC webhook -> %s (want 401)\n' \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "https://$HOST/webhooks/shopify" \
     -H 'X-Shopify-Topic: orders/create' -H 'X-Shopify-Hmac-Sha256: bogus' \
     -H 'X-Shopify-Shop-Domain: alertproof-lab.myshopify.com' -H 'Content-Type: application/json' -d '{}')"
printf '  /dev/mock -> %s (want 404)\n' "$(curl -s -o /dev/null -w '%{http_code}' "https://$HOST/dev/mock")"
printf '  /app unauthenticated -> %s (want 410 or 302)\n' "$(curl -s -o /dev/null -w '%{http_code}' "https://$HOST/app")"

echo
echo "Done. Next: run 'shopify app config link' and 'shopify app deploy' from a"
echo "machine with a browser, then install on the dev store via real OAuth."
