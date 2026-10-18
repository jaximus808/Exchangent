#!/bin/sh
# Run the agent runner inside the Docker sandbox (agents/Dockerfile). The container sees only:
#   - agents/.state           -> /state (identities, Inkbox agent keys, the runner lock)
#   - the principals file     -> /run/exchangent/principals.json (read-only)
#   - agents/.env.local       -> environment (TRANSPORT, BACKEND_URL, MCP_URL, INKBOX_API_KEY, ...)
#   - CLAUDE_CODE_OAUTH_TOKEN -> Claude login for the turns (create one with `claude setup-token`)
# The root filesystem is read-only, all capabilities are dropped, and no host home directory is mounted.
# Stop any runner started with `npm start` first: two runners on one set of Inkbox identities fight.
set -eu
cd "$(dirname "$0")/.."
IMAGE=${IMAGE:-exchangent-agents}
ENV_FILE=${ENV_FILE:-.env.local}
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE (copy .env.example)" >&2; exit 1; }
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "CLAUDE_CODE_OAUTH_TOKEN is not set. Run \`claude setup-token\` and export the token it prints, e.g.:" >&2
  echo "  export CLAUDE_CODE_OAUTH_TOKEN=...   (keep it out of files and git)" >&2
  exit 1
fi
# PRINCIPALS_FILE from the env file, resolved against agents/ like the runner does.
PRINCIPALS=$(sed -n 's/^PRINCIPALS_FILE=//p' "$ENV_FILE" | tail -1)
PRINCIPALS=${PRINCIPALS_FILE:-${PRINCIPALS:-../backend/.demo-principals.json}}
case "$PRINCIPALS" in /*) ;; *) PRINCIPALS="$(pwd)/$PRINCIPALS" ;; esac
[ -f "$PRINCIPALS" ] || { echo "principals file not found: $PRINCIPALS" >&2; exit 1; }
mkdir -p .state
docker build -q -t "$IMAGE" . >/dev/null
exec docker run --rm -it --name exchangent-agents \
  --read-only --tmpfs /tmp --tmpfs /home/agent:uid=10001,gid=10001 \
  --cap-drop ALL --security-opt no-new-privileges \
  --user 10001:10001 \
  --env-file "$ENV_FILE" \
  -e CLAUDE_CODE_OAUTH_TOKEN \
  -e STATE_DIR=/state -e PRINCIPALS_FILE=/run/exchangent/principals.json -e HOME=/home/agent \
  -v "$(pwd)/.state:/state" \
  -v "$PRINCIPALS:/run/exchangent/principals.json:ro" \
  "$IMAGE" "$@"
