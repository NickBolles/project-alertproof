#!/usr/bin/env bash
# Flip AlertProof from mock/demo mode to real Shopify mode, then redeploy.
#
# Run this once the real client secret exists (launch plan B2). It prompts for
# secrets rather than taking them as arguments, so nothing lands in shell
# history or the process table.
#
#   /usr/local/bin/alertproof-go-live.sh
#
# Everything it touches is backed up first. Re-running it is safe.
set -euo pipefail

ENV_FILE=/etc/vps-apps/alertproof.env
APP_DIR=/opt/vps-apps/project-alertproof
HOST=alertproof.nickbolles.com

set_key() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    python3 - "$ENV_FILE" "$key" "$value" <<'PY'
import sys
path, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
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

echo "== switching to real mode =="
set_key AUTH_MODE shopify
set_key ALERTPROOF_FORCE_MOCKS 0
set_key ALERTPROOF_AUTH_BYPASS 0
set_key NODE_ENV production
chmod 600 "$ENV_FILE"

if grep -q '^SHOPIFY_API_SECRET=dev-secret$' "$ENV_FILE"; then
  echo "REFUSING: SHOPIFY_API_SECRET is still the literal placeholder." >&2
  exit 1
fi

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
