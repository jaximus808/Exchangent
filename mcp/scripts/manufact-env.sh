#!/bin/sh
# Push an env file to a Manufact server without printing any value.
#   sh scripts/manufact-env.sh <server> [env-file]     (default: .env.production.local)
# Secret keys are stored write-only (--secret); empty values are skipped with a warning.
set -eu
server=${1:?usage: sh scripts/manufact-env.sh <server> [env-file]}
file=${2:-.env.production.local}
[ -f "$file" ] || { echo "missing $file" >&2; exit 1; }
secrets=" UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN EXCHANGENT_OAUTH_CLIENT_ID EXCHANGENT_OAUTH_CLIENT_SECRET MCP_USE_OAUTH_SECRET "
grep -E '^[A-Z_][A-Z0-9_]*=' "$file" | while IFS= read -r line; do
  key=${line%%=*}; value=${line#*=}
  if [ -z "$value" ]; then echo "skip  $key (empty)"; continue; fi
  case "$secrets" in
    *" $key "*) npx mcp-use servers env set "$server" "$key=$value" --secret --json >/dev/null && echo "secret $key" ;;
    *)          npx mcp-use servers env set "$server" "$key=$value" --json >/dev/null && echo "set   $key" ;;
  esac
done
