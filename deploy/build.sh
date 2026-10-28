#!/usr/bin/env bash
# Fills the directory that is uploaded as a release of the hosted demo (prod/bin/deploy.py calls it from a clone of the commit):
#   deploy/build.sh <destination> <environment>        the generated .env is already at <destination>/.env
# Result:  bin/{front,shop,loosend}   www/ (ONLY the public files, with a generated config.js)   data/   scripts/   deploy/
set -euo pipefail
DEST="${1:?destination directory}"; ENV="${2:?environment}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SRC"
export PATH="/usr/local/go/bin:$PATH"

# the licence key of the hosted demo is public (it is in config.js, bound to the demo domain): read it from the generated .env without sourcing it
read_env() { sed -n "s/^$1=//p" "$DEST/.env" | head -1 | sed "s/^'//; s/'\$//"; }
LICENCE="$(read_env LOOSEN_LICENCE)"
[ -n "$LICENCE" ] || { echo "LOOSEN_LICENCE is missing in config/$ENV.env" >&2; exit 1; }

echo "Build the Go programs (Linux amd64, static)"
go vet ./...
mkdir -p "$DEST/bin"
for p in front shop; do CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o "$DEST/bin/$p" "./cmd/$p"; done

echo "Fetch loosend (SHA-256 checked against the published SHA256SUMS)"
VERSION="$(sed -n 's/^VERSION=//p' scripts/run-loosend.sh | head -1)"
scripts/fetch-loosend.sh "$VERSION" linux amd64 "$DEST/bin/loosend"

echo "Copy the public files only"
W="$DEST/www"; mkdir -p "$W/cmd/shop" "$W/scripts"
cp index.html "$W/"
cp -R examples assets vendor data "$W/"
mkdir -p "$W/docs" && cp -R docs/img "$W/docs/img"
cp cmd/shop/main.go "$W/cmd/shop/main.go"                        # shown in the "Source" block of the shop page
cp scripts/run-loosend.sh scripts/load-catalog.sh "$W/scripts/"  # shown in the "Source" block of the server page
cat > "$W/config.js" <<JS
// Generated at deploy time (deploy/build.sh); not in git. The licence is bound to the host loosen.sicena.com, so it is fine in public JavaScript.
window.LOOSEN_LICENCE = "$LICENCE";
window.LOOSEN_HOSTED = true;                       // hides the "run it locally" hints
window.LOOSEN_SHOP = "shop/";                      // relative to the examples root (https://loosen.sicena.com/demo/)
window.LOOSEN_SERVER = {endpoint: "api", catalog: "apartments", key: "examples-read-key"};   // same origin: the front allows only POST api/v1/catalogs/apartments/explain
JS

echo "Copy what the services run on the CT"
mkdir -p "$DEST/data" "$DEST/scripts"
cp data/apartments.loosend.json "$DEST/data/"
cp scripts/load-catalog.sh "$DEST/scripts/"
cp -R deploy "$DEST/deploy"
echo "Build done"
