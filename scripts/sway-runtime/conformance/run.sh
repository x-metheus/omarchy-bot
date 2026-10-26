#!/bin/sh
# Real-Sway conformance for the published Bot Computer runtime bundle (ticket 04).
#
# Usage: scripts/sway-runtime/conformance/run.sh <omarchy-bot-sway-runtime-*-x86_64.tar.gz> [font-dir]
#
# Verifies the archive against its `.sha256` sidecar, then runs:
#   1. Ubuntu 22.04: the Bot Screen adapter driven only by the bundle. That
#      image has no Sway, grim, D-Bus daemon, Xwayland, or compiler.
#   2. Alpine (musl): every launcher starts through the bundled loader.
# Docker is required; the host itself is never modified.
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: $0 <omarchy-bot-sway-runtime-x86_64.tar.gz> [font-dir]" >&2
  exit 2
fi

archive=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
if [ ! -f "$archive" ]; then
  echo "error: bundle archive not found: $archive" >&2
  exit 2
fi

sidecar="$archive.sha256"
if [ ! -f "$sidecar" ]; then
  echo "error: missing SHA-256 sidecar: $sidecar" >&2
  exit 2
fi
expected=$(cut -d' ' -f1 <"$sidecar")
actual=$(sha256sum "$archive" | cut -d' ' -f1)
if [ "$expected" != "$actual" ]; then
  echo "error: bundle SHA-256 mismatch (sidecar $expected, archive $actual)" >&2
  exit 1
fi
echo "bundle sha256 verified: $actual"

repo=$(cd "$(dirname "$0")/../../.." && pwd)
fixtures="$repo/scripts/sway-runtime/conformance"
font_dir=${2:-${OMARCHY_BOT_FONT_DIR:-}}
if [ -z "$font_dir" ]; then
  font_dir="$repo/.lane/fonts"
  bash "$repo/scripts/prepare-fonts.sh" "$font_dir"
fi
font_dir=$(cd "$font_dir" && pwd)
image=omarchy-bot-sway-conformance:local

echo "building Ubuntu 22.04 conformance image"
docker build \
  --file "$fixtures/Dockerfile" \
  --tag "$image" \
  "$repo"

echo "running bundle-only real-Sway conformance (Ubuntu 22.04)"
docker run --rm \
  --tmpfs /tmp:rw,size=2g,exec \
  --volume "$archive:/bundle/archive.tar.gz:ro" \
  --volume "$font_dir:/bundle/fonts:ro" \
  --env OMARCHY_BOT_FONT_DIR=/bundle/fonts \
  --env OMARCHY_BOT_SWAY_BUNDLE=/bundle/archive.tar.gz \
  --env OMARCHY_BOT_X11_FIXTURE=/usr/local/bin/x11-fixture \
  "$image"

echo "running musl loader smoke (Alpine)"
docker run --rm \
  --volume "$archive:/bundle/archive.tar.gz:ro" \
  --volume "$fixtures/musl-smoke.sh:/usr/local/bin/musl-smoke.sh:ro" \
  alpine:3.21.3 \
  /bin/sh /usr/local/bin/musl-smoke.sh /bundle/archive.tar.gz

echo "sway runtime bundle conformance passed"
