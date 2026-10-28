#!/usr/bin/env bash
# Refreshes vendor/loosen.mjs and vendor/loosen.iife.js and writes vendor/SOURCE.txt.
#   scripts/sync-widget.sh                 download the published v1 files from https://loosen.sicena.com/widget/v1/
#   scripts/sync-widget.sh --from DIR      copy dist/loosen.mjs and dist/loosen.iife.js from a local checkout of the widget (DIR = its dist/ folder)
set -euo pipefail
cd "$(dirname "$0")/.."
BASE=https://loosen.sicena.com/widget/v1
src="$BASE"; commit="(published file, no commit)"
if [ "${1:-}" = "--from" ]; then
  dir="$(cd "$2" && pwd)"; src="a local checkout of the widget (dist/)"
  commit="$(git -C "$dir" rev-parse HEAD 2>/dev/null || echo unknown)"
  cp "$dir/loosen.mjs" vendor/loosen.mjs; cp "$dir/loosen.iife.js" vendor/loosen.iife.js
else
  curl -fsS "$BASE/loosen.mjs" -o vendor/loosen.mjs
  curl -fsS "$BASE/loosen.js" -o vendor/loosen.iife.js
fi
version="$(sed -n 's/.*const VERSION = "\([^"]*\)".*/\1/p' vendor/loosen.mjs | head -1)"
sri() { printf 'sha384-%s' "$(openssl dgst -sha384 -binary "$1" | openssl base64 -A)"; }
cat > vendor/SOURCE.txt <<TXT
Loosen widget, vendored for the examples. Refresh with scripts/sync-widget.sh.

version : ${version}
source  : ${src}
commit  : ${commit}
synced  : $(date -u +%Y-%m-%dT%H:%M:%SZ)

vendor/loosen.mjs        $(sri vendor/loosen.mjs)
vendor/loosen.iife.js    $(sri vendor/loosen.iife.js)

The published files are https://loosen.sicena.com/widget/v1/loosen.mjs and loosen.js (the classic script is the same file as loosen.iife.js).
The widget is distributed under Loosen's terms (https://loosen.sicena.com/terms); see NOTICE.
React 18.3.1 (react.production.min.js, react-dom.production.min.js) comes from https://unpkg.com/react@18.3.1/umd/ and is MIT (vendor/LICENSES).
TXT
echo "vendor/ updated: widget ${version}"
