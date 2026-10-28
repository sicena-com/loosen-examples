#!/usr/bin/env bash
# Starts a local loosend (the Loosen server) for examples/server.html on http://localhost:8130.
#   scripts/run-loosend.sh            start (Docker image if Docker works, else the downloaded binary)
#   scripts/run-loosend.sh --stop     stop it
# Settings (environment): LOOSEND_PORT=8130  PAGE_ORIGIN=http://localhost:8123  LOOSEND_ADMIN_KEY=...  LOOSEND_LICENCE=LSN1...  LOOSEND_MODE=docker|binary
# Without LOOSEND_LICENCE loosend runs in evaluation mode (1000 items): 186 apartments fit.
# The admin key below is for this local example only; never reuse it.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=1.0.0
IMAGE="ghcr.io/sicena-com/loosend:$VERSION"
PORT="${LOOSEND_PORT:-8130}"
export LOOSEND_ADMIN_KEY="${LOOSEND_ADMIN_KEY:-examples-admin-key-0000}"
PAGE_ORIGIN="${PAGE_ORIGIN:-http://localhost:8123}"
# CORS allow-list: the origin of the page that hosts the widget (scheme + host + port, no trailing slash)
export LOOSEND_ALLOWED_ORIGINS="${LOOSEND_ALLOWED_ORIGINS:-$PAGE_ORIGIN,${PAGE_ORIGIN/localhost/127.0.0.1}}"
RUN=.run; mkdir -p "$RUN" .bin
NAME=loosend-examples

if [ "${1:-}" = "--stop" ]; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if [ -f "$RUN/loosend.pid" ]; then kill "$(cat "$RUN/loosend.pid")" 2>/dev/null || true; rm -f "$RUN/loosend.pid"; fi
  exit 0
fi

healthy() { curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; }
if healthy; then echo "loosend already answers on port $PORT"; exit 0; fi

mode="${LOOSEND_MODE:-}"
if [ -z "$mode" ]; then if command -v docker >/dev/null && docker info >/dev/null 2>&1; then mode=docker; else mode=binary; fi; fi

if [ "$mode" = docker ]; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --rm --name "$NAME" -p "127.0.0.1:$PORT:8080" \
    -e LOOSEND_ADMIN_KEY -e LOOSEND_ALLOWED_ORIGINS -e "LOOSEND_LICENCE=${LOOSEND_LICENCE:-}" "$IMAGE" >/dev/null
else
  if [ ! -x ".bin/loosend-$VERSION" ]; then scripts/fetch-loosend.sh "$VERSION" "$(uname -s | tr A-Z a-z)" "$(uname -m)" ".bin/loosend-$VERSION"; fi
  LOOSEND_DATA_DIR="$RUN/loosend-data" nohup ".bin/loosend-$VERSION" --addr "127.0.0.1:$PORT" > "$RUN/loosend.log" 2>&1 &
  echo $! > "$RUN/loosend.pid"
fi

for _ in $(seq 1 100); do healthy && { echo "loosend ($mode) on http://localhost:$PORT  (CORS: $LOOSEND_ALLOWED_ORIGINS)"; exit 0; }; sleep 0.2; done
echo "loosend did not start; see 'docker logs $NAME' or $RUN/loosend.log" >&2; exit 1
