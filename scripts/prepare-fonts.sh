#!/usr/bin/env bash
# Usage: bash scripts/prepare-fonts.sh <out-dir> [pin-file]
set -euo pipefail

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
out_dir=${1:?Font output directory is required}
pin_file=${2:-$root/apps/daemon/src/modules/computer/botComputerAssets.ts}
font_source=$(<"$pin_file")
font_source=${font_source#*export const FONT_ASSETS}
font_source=${font_source%%']);'*}
font_pattern='file: "([^"]+)"[^}]*url: "([^"]+)"[^}]*sha256: "([0-9a-f]{64})"'
mkdir -p -- "$out_dir"
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
font_files=()
while [[ $font_source =~ $font_pattern ]]; do
  font_file=${BASH_REMATCH[1]}
  url=${BASH_REMATCH[2]}
  expected=${BASH_REMATCH[3]}
  match=${BASH_REMATCH[0]}
  curl --fail --location --silent --show-error --globoff --proto '=https' --output "$staging/$font_file" "$url"
  received=$(sha256sum -- "$staging/$font_file")
  received=${received%% *}
  if [[ $received != "$expected" ]]; then
    printf 'Omarchy Bot font checksum mismatch at %s: expected %s, received %s\n' "$out_dir/$font_file" "$expected" "$received" >&2
    exit 1
  fi
  font_files+=("$font_file")
  font_source=${font_source#*"$match"}
done
if [[ ${#font_files[@]} -eq 0 ]]; then
  printf 'Missing valid font pins in %s\n' "$pin_file" >&2
  exit 1
fi
for font_file in "${font_files[@]}"; do
  cp -- "$staging/$font_file" "$out_dir/$font_file"
done
printf 'Prepared Bot Computer fonts: %s\n' "$out_dir" >&2
