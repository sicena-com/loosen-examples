#!/usr/bin/env bash
# Serves the examples on http://localhost:8123/ (python3 or Go).
#   ./serve.sh                 static examples only (pages 1-6, 9)
#   ./serve.sh --with-server   also starts loosend (port 8130, needs Docker or a download) and the shop (port 8124)
#   ./serve.sh --stop          stops what a previous run started
#   PORT=9000 ./serve.sh       another port for the static examples
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8123}"; SHOP_PORT="${SHOP_PORT:-8124}"; LOOSEND_PORT="${LOOSEND_PORT:-8130}"
RUN=.run; mkdir -p "$RUN"
[ -f config.js ] || cp config.example.js config.js     # config.js is git-ignored: your licence goes there

stop() {
  for n in static shop; do
    if [ -f "$RUN/$n.pid" ]; then kill "$(cat "$RUN/$n.pid")" 2>/dev/null || true; rm -f "$RUN/$n.pid"; fi
  done
  scripts/run-loosend.sh --stop 2>/dev/null || true
  echo stopped
}
[ "${1:-}" = "--stop" ] && { stop; exit 0; }

wait_for() { for _ in $(seq 1 100); do curl -fsS -o /dev/null "$1" 2>/dev/null && return 0; sleep 0.1; done; echo "did not start: $1" >&2; return 1; }

if curl -fsS -o /dev/null "http://localhost:$PORT/" 2>/dev/null; then echo "port $PORT already serves something: ./serve.sh --stop, or PORT=... ./serve.sh" >&2; exit 1; fi

if [ "${1:-}" = "--with-server" ]; then
  go build -o .bin/shop ./cmd/shop
  .bin/shop -addr "127.0.0.1:$SHOP_PORT" -root . > "$RUN/shop.log" 2>&1 & echo $! > "$RUN/shop.pid"
  wait_for "http://localhost:$SHOP_PORT/"
  LOOSEND_PORT="$LOOSEND_PORT" PAGE_ORIGIN="http://localhost:$PORT" scripts/run-loosend.sh
  LOOSEND_PORT="$LOOSEND_PORT" scripts/load-catalog.sh
  echo "shop      http://localhost:$SHOP_PORT/"
  echo "loosend   http://localhost:$LOOSEND_PORT/health"
fi

if [ "${DETACH:-}" = "1" ]; then
  if command -v python3 >/dev/null; then QUIET=1 nohup python3 scripts/static_server.py "$PORT" > "$RUN/static.log" 2>&1 &
  else go build -o .bin/shop ./cmd/shop; nohup .bin/shop -landing -addr "127.0.0.1:$PORT" -root . > "$RUN/static.log" 2>&1 &
  fi
  echo $! > "$RUN/static.pid"
  wait_for "http://localhost:$PORT/"
  echo "examples  http://localhost:$PORT/   (stop: ./serve.sh --stop)"
else
  trap stop EXIT
  echo "examples  http://localhost:$PORT/   (Ctrl-C stops everything)"
  if command -v python3 >/dev/null; then python3 scripts/static_server.py "$PORT"
  else go build -o .bin/shop ./cmd/shop; .bin/shop -landing -addr "127.0.0.1:$PORT" -root .; fi
fi
