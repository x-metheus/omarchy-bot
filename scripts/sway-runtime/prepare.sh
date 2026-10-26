#!/usr/bin/env bash
# Usage: bash scripts/sway-runtime/prepare.sh <sway-bundle.tar.gz> [pin-file]
# Extract a verified development bundle beside the archive.
set -euo pipefail

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
sway_bundle=${1:?Sway bundle archive is required}
pin_file=${2:-$root/apps/daemon/src/modules/computer/swayRuntimeSupply.ts}
pin_source=$(<"$pin_file")
sha_pattern='sha256: "([0-9a-f]{64})"'
release_pattern='SWAY_RUNTIME_RELEASE = "([^"]+)"'
if [[ ! $pin_source =~ $sha_pattern ]]; then
  printf 'Missing a valid Sway sha256 pin in %s\n' "$pin_file" >&2
  exit 1
fi
sway_sha256=${BASH_REMATCH[1]}
if [[ ! $pin_source =~ $release_pattern ]]; then
  printf 'Missing SWAY_RUNTIME_RELEASE in %s\n' "$pin_file" >&2
  exit 1
fi
sway_release=${BASH_REMATCH[1]}
received_sha256=$(sha256sum -- "$sway_bundle")
received_sha256=${received_sha256%% *}
if [[ $received_sha256 != "$sway_sha256" ]]; then
  printf 'Omarchy Bot Sway bundle checksum mismatch: expected %s, received %s\n' "$sway_sha256" "$received_sha256" >&2
  exit 1
fi

destination=$(dirname -- "$sway_bundle")/sway
mkdir -p -- "$destination"
rm -f -- "$destination/.omarchy-bot-runtime"
tar -xzf "$sway_bundle" -C "$destination"
printf '%s\n%s\n' "$sway_release" "$sway_sha256" > "$destination/.omarchy-bot-runtime"
printf 'Prepared Sway bundle: %s\n' "$destination" >&2
