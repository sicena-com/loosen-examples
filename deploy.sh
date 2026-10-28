#!/usr/bin/env bash
# Deploys the hosted demo of the examples (https://loosen-demo.sicena.com) to CT 147 with the common tool prod/bin/deploy.py: it refuses uncommitted changes,
# pushes, clones the commit, builds, uploads a release to /opt/loosen-examples/releases/, switches `current`, checks health and rolls
# back by itself on failure.
#
#   ./deploy.sh [--ignore-local-changes]
#   ./deploy.sh --rollback      # back to the previous release
#   ./deploy.sh --status
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for candidate in "$HOME/Nextcloud/david/chat/prod/bin/deploy.py" "$HOME/dev/prod/bin/deploy.py"; do
  [ -x "$candidate" ] && DEPLOY_PY="$candidate" && break
done
[ -n "${DEPLOY_PY:-}" ] || { echo "bin/deploy.py of the prod repository not found" >&2; exit 1; }
COMMON=()
MODE=deploy
for arg in "$@"; do
  case "$arg" in
    --ignore-local-changes) COMMON+=("$arg") ;;
    --rollback) MODE=rollback ;;
    --status) MODE=status ;;
    *) echo "usage: $0 [--ignore-local-changes] | --rollback | --status" >&2; exit 1 ;;
  esac
done
cd "$DIR"
case "$MODE" in
  rollback | status) exec "$DEPLOY_PY" loosen-examples "--$MODE" ;;
esac
exec "$DEPLOY_PY" loosen-examples prod "${COMMON[@]}"
