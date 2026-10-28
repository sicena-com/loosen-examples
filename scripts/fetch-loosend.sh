#!/usr/bin/env bash
# Downloads the released loosend binary and refuses to keep it unless its SHA-256 matches the published SHA256SUMS.
#   scripts/fetch-loosend.sh VERSION OS ARCH DEST     e.g.  scripts/fetch-loosend.sh 1.0.0 linux amd64 .bin/loosend-1.0.0
# Used by scripts/run-loosend.sh (your machine) and deploy/build.sh (the hosted demo). OS: linux|darwin. ARCH: amd64|arm64 (x86_64, aarch64 also accepted).
set -euo pipefail
VERSION="${1:?version}"; os="${2:?os}"; arch="${3:?arch}"; DEST="${4:?destination file}"
SITE=https://loosen.sicena.com/downloads/loosend/v1
case "$arch" in x86_64|amd64) arch=amd64;; aarch64|arm64) arch=arm64;; *) echo "no loosend build for $arch" >&2; exit 1;; esac
case "$os" in linux|darwin) ;; *) echo "on $os download the archive by hand: https://loosen.sicena.com/downloads" >&2; exit 1;; esac
archive="loosend-$VERSION-$os-$arch.tar.gz"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$SITE/$archive" -o "$tmp/$archive"; curl -fsSL "$SITE/SHA256SUMS" -o "$tmp/SHA256SUMS"
# verify the archive against the published SHA256SUMS before running anything from it
expected="$(awk -v f="$archive" '$2 == f {print $1}' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || { echo "$archive is not listed in SHA256SUMS" >&2; exit 1; }
if command -v sha256sum >/dev/null; then actual="$(sha256sum "$tmp/$archive" | cut -d' ' -f1)"; else actual="$(shasum -a 256 "$tmp/$archive" | cut -d' ' -f1)"; fi
[ "$expected" = "$actual" ] || { echo "SHA-256 mismatch for $archive (expected $expected, got $actual)" >&2; exit 1; }
echo "SHA-256 verified: $actual  $archive"
mkdir "$tmp/x"; tar -xzf "$tmp/$archive" -C "$tmp/x"
mkdir -p "$(dirname "$DEST")"
install -m 0755 "$(find "$tmp/x" -type f -name loosend | head -1)" "$DEST"
