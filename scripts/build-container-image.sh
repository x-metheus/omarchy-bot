#!/usr/bin/env bash
# Usage: bash scripts/build-container-image.sh <runtime.tar.zst> [image-tag] [asset-cache]
# Requires Docker and Bun 1.4+; only cache misses need network access.
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
archive=${1:?Usage: $0 runtime.tar.zst [image-tag] [asset-cache]}
image=${2:-omarchy-bot:local}
cache=${3:-$root/.lane/container-assets}
[[ $# -le 3 ]] || { printf 'Too many arguments\n' >&2; exit 2; }
bun_bin=${OMARCHY_BOT_BUN:-$(command -v bun)}
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
mkdir -p "$cache"
"$bun_bin" "$root/scripts/container-image/prepare.ts" "$archive" "$cache" "$staging"
cp "$root/scripts/container-image/"{Dockerfile,entrypoint.sh,provision-browser.ts} "$staging/"
# Runtime, Bun and the verified browser pack are local; installation has no network.
docker build --pull=false --network=none -t "$image" "$staging"
printf 'Image: %s\n' "$image"
