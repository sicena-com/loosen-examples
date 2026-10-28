#!/usr/bin/env bash
# ExecStartPost of loosen-examples-loosend: waits for loosend and (re)loads the catalog, so a restart never leaves it empty.
# (loosend also keeps snapshots in its data dir; this makes the state certain.) LOOSEND_ADMIN_KEY comes from the unit's EnvironmentFile.
set -euo pipefail
export H=http://127.0.0.1:8130
for _ in $(seq 1 100); do curl -fsS "$H/health" >/dev/null 2>&1 && break; sleep 0.2; done
exec "$(dirname "$0")/../scripts/load-catalog.sh"
