#!/usr/bin/env bash
# Runs on the CT inside the new release, before it is activated (prod/bin/deploy.py). Idempotent.
set -euo pipefail
RELEASE="${1:?release directory}"
BASE=/opt/loosen-examples
USER=loosen-examples

id -u "$USER" &>/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin "$USER"
mkdir -p "$BASE/shared/loosend-data"      # loosend's snapshots: outside the release, or the first deployment would take them away
chown -R "$USER:$USER" "$BASE/shared"; chmod 700 "$BASE/shared/loosend-data"

# deploy.py installs the unit of the front only; the other two are installed here (same {{BASE}} template)
for unit in loosen-examples-loosend loosen-examples-shop; do
  sed "s|{{BASE}}|$BASE|g" "$RELEASE/deploy/$unit.service" > "/etc/systemd/system/$unit.service"
done
systemctl daemon-reload
systemctl enable -q loosen-examples-loosend loosen-examples-shop

chown -R "root:$USER" "$RELEASE"
chmod -R g+rX,o-rwx "$RELEASE"
chmod 640 "$RELEASE/.env"
chmod 750 "$RELEASE"/bin/*
echo "remote-setup done"
