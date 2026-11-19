#!/bin/sh
# Post-deploy smoke test: does the deployed stack answer correctly through the
# real front door? Read-only — it never logs in, writes or publishes anything.
#
#   sh infra/vps/scripts/smoke-test.sh https://app.example.com
#
# Optional environment:
#   CURL_OPTS  extra curl flags, e.g. "-k --resolve app.socialith.test:18443:127.0.0.1"
#              (the local verification stack uses Caddy's internal CA)
#   COMPOSE    a compose prefix to also check container health from inside, e.g.
#              "docker compose -p socialith -f infra/vps/docker-compose.yml --env-file infra/vps/.env"
set -u

base="${1:?usage: smoke-test.sh <https://your-domain>}"
base="${base%/}"
opts="${CURL_OPTS:-}"
fail=0

check() {
  name="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "PASS  $name"; else echo "FAIL  $name"; fail=1; fi
}

# shellcheck disable=SC2086 — $opts is intentionally word-split
api_health()       { body=$(curl -fsS $opts "$base/api/health") && echo "$body" | grep -q '"database":true' && echo "$body" | grep -q '"redis":true' && echo "$body" | grep -q '"status":"ok"'; }
web_login_page()   { curl -fsS $opts "$base/login" | grep -qi "sign in"; }
hsts_header()      { curl -fsSI $opts "$base/login" | grep -qi "^strict-transport-security:"; }
api_route_is_api() { curl -sS $opts -o /dev/null -w '%{content_type}' "$base/api/this-route-does-not-exist" | grep -qi "application/json"; }
media_is_api()     { code=$(curl -sS $opts -o /dev/null -w '%{http_code}' "$base/media/does-not-exist.txt"); [ "$code" = "404" ]; }
no_server_banner() { ! curl -fsSI $opts "$base/login" | grep -qi "^server:"; }
auth_required()    { code=$(curl -sS $opts -o /dev/null -w '%{http_code}' "$base/api/accounts"); [ "$code" = "401" ]; }

check "API /api/health ok (database + redis up)" api_health
check "web serves the login page"                 web_login_page
check "HSTS header present"                       hsts_header
check "/api/* is routed to the API (JSON 404)"    api_route_is_api
check "/media/* is routed to the API (404)"       media_is_api
check "no Server banner leaked"                   no_server_banner
check "protected route refuses anonymous access"  auth_required

if [ -n "${COMPOSE:-}" ]; then
  # `{{.Status}}` reads e.g. "Up 5 minutes (healthy)" — the portable way to see
  # health across Compose versions (the {{.Health}} template field is empty in some).
  for svc in mysql redis api worker web; do
    # eval: $COMPOSE may contain quoted arguments (e.g. an --env-file path) that plain word-splitting would mangle.
    status=$(eval "$COMPOSE ps --format '{{.Status}}' $svc" 2>/dev/null | head -n1)
    case "$status" in
      *"(healthy)"*) echo "PASS  container $svc healthy" ;;
      *) echo "FAIL  container $svc: ${status:-not running}"; fail=1 ;;
    esac
  done
  check "container caddy is running" sh -c "$COMPOSE ps --status running --services | grep -qx caddy"
fi

[ "$fail" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
exit "$fail"
