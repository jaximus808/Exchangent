#!/bin/sh
# Throwaway postgres:16 container: apply InsForge stubs + every migration in order,
# then run the real-database tests one file at a time (they share the database and
# the demo seed). The container is removed on exit.
set -eu
cd "$(dirname "$0")/../.."
DOCKER=${DOCKER:-docker}
NAME=exchangent-negotiation-test-$$
PORT=${TEST_PG_PORT:-55432}
$DOCKER run -d --rm --name "$NAME" -e POSTGRES_PASSWORD=test -p "127.0.0.1:$PORT:5432" postgres:16 >/dev/null
trap '$DOCKER rm -f "$NAME" >/dev/null 2>&1 || true' EXIT INT TERM
# TCP readiness: the image's init-time server listens on the Unix socket only.
i=0; until $DOCKER exec "$NAME" pg_isready -q -h 127.0.0.1 -U postgres; do
 i=$((i+1)); [ "$i" -lt 60 ] || { echo 'postgres did not start' >&2; exit 1; }; sleep 1; done
for f in test/sql/stubs.sql ../migrations/*.sql; do
 echo "apply $f"
 $DOCKER exec -i "$NAME" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres < "$f"
done
DATABASE_URL="postgres://postgres:test@127.0.0.1:$PORT/postgres" node --test --test-concurrency=1 test/sql/*.db.ts
