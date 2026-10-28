#!/usr/bin/env bash
# Defines the "apartments" catalog on a running loosend, loads the 186 items and sets a read key (see docs/INTEGRATION.md section 4).
#   scripts/load-catalog.sh        (settings: LOOSEND_PORT=8130, LOOSEND_ADMIN_KEY, READ_KEY, or H=http://host:port)
set -euo pipefail
cd "$(dirname "$0")/.."
H="${H:-http://127.0.0.1:${LOOSEND_PORT:-8130}}"
K="${LOOSEND_ADMIN_KEY:-examples-admin-key-0000}"        # the admin key: never in a browser
READ_KEY="${READ_KEY:-examples-read-key}"                # the read key: it is in the page's source, it is not a secret (section 4)
auth=(-H "Authorization: Bearer $K")

echo "1. define the catalog (numeric, text, set)"
curl -fsS -X PUT "$H/v1/catalogs/apartments" "${auth[@]}" -d '{"attributes":[
  {"name":"rent","kind":"numeric"},{"name":"rooms","kind":"numeric"},
  {"name":"minutesToUnil","kind":"numeric"},{"name":"minutesToCentre","kind":"numeric"},
  {"name":"town","kind":"text"},
  {"name":"furnished","kind":"numeric"},{"name":"kitchen","kind":"numeric"},{"name":"sharedKitchen","kind":"numeric"},{"name":"fittedKitchen","kind":"numeric"},
  {"name":"bathroom","kind":"numeric"},{"name":"sharedBathroom","kind":"numeric"},{"name":"bathtub","kind":"numeric"},
  {"name":"quiet","kind":"numeric"},{"name":"balcony","kind":"numeric"},{"name":"view","kind":"numeric"},{"name":"bus","kind":"numeric"},
  {"name":"parking","kind":"numeric"},{"name":"metroM1","kind":"numeric"},
  {"name":"features","kind":"set"}]}'; echo
echo "2. load the items (replace all): data/apartments.loosend.json = [{id, values}]"
curl -fsS -X PUT "$H/v1/catalogs/apartments/items" "${auth[@]}" --data-binary @data/apartments.loosend.json; echo
echo "3. set the read key (the widget sends it as X-Loosen-Key)"
curl -fsS -X PUT "$H/v1/catalogs/apartments/read-key" "${auth[@]}" -d "{\"readKey\":\"$READ_KEY\"}"; echo
echo "4. health"
curl -fsS "$H/health"; echo
