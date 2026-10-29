#!/usr/bin/env bash
# Usage: bash scripts/package-plugin-runtime.sh <repo-root> <out-dir> <sway-bundle.tar.gz> <font-dir>
set -euo pipefail

root=$(CDPATH= cd -- "${1:-$(dirname -- "$0")/..}" && pwd)
sha=${OMARCHY_BOT_PLUGIN_REVISION:-$(git -C "$root" rev-parse HEAD)}
out_dir=${2:-$root/dist-runtime}
mkdir -p "$out_dir"
out_dir=$(CDPATH= cd -- "$out_dir" && pwd)
asset=omarchy-bot-runtime-${sha}-x86_64.tar.zst

required=(
  apps/daemon/dist/native-pointer/omarchy-bot-wayland-input
  apps/daemon/dist/native-capture/omarchy-bot-wayland-capture
  apps/daemon/dist/native-bot-desktop/omarchy-bot-desktop
  package.json
  bun.lock
  node_modules
  scripts/serve.sh
)
for path in "${required[@]}"; do
  if [[ ! -e $root/$path ]]; then
    printf 'Omarchy Bot runtime package is missing %s\n' "$path" >&2
    exit 1
  fi
done
for helper in \
  apps/daemon/dist/native-pointer/omarchy-bot-wayland-input \
  apps/daemon/dist/native-capture/omarchy-bot-wayland-capture \
  apps/daemon/dist/native-bot-desktop/omarchy-bot-desktop
do
  if [[ ! -x $root/$helper ]]; then
    printf 'Omarchy Bot runtime package helper is not executable: %s\n' "$helper" >&2
    exit 1
  fi
done

sway_bundle=${3:-}
if [[ -z $sway_bundle || ! -r $sway_bundle || ! -f $sway_bundle ]]; then
  printf 'Omarchy Bot runtime package requires a readable Sway bundle: %s\n' "${sway_bundle:-<missing third argument>}" >&2
  exit 1
fi
pin_file=$root/apps/daemon/src/modules/computer/swayRuntimeSupply.ts
if [[ ! -r $pin_file ]]; then
  printf 'Omarchy Bot runtime package cannot read Sway pin: %s\n' "$pin_file" >&2
  exit 1
fi
pin_source=$(<"$pin_file")
sha_pattern='sha256: "([0-9a-f]{64})"'
release_pattern='SWAY_RUNTIME_RELEASE = "([^"]+)"'
if [[ ! $pin_source =~ $sha_pattern ]]; then
  printf 'Omarchy Bot runtime package is missing a valid Sway sha256 pin in %s\n' "$pin_file" >&2
  exit 1
fi
sway_sha256=${BASH_REMATCH[1]}
if [[ ! $pin_source =~ $release_pattern ]]; then
  printf 'Omarchy Bot runtime package is missing SWAY_RUNTIME_RELEASE in %s\n' "$pin_file" >&2
  exit 1
fi
sway_release=${BASH_REMATCH[1]}
received_sha256=$(sha256sum -- "$sway_bundle")
received_sha256=${received_sha256%% *}
if [[ $received_sha256 != "$sway_sha256" ]]; then
  printf 'Omarchy Bot Sway bundle checksum mismatch: expected %s, received %s\n' "$sway_sha256" "$received_sha256" >&2
  exit 1
fi

font_dir=${4:-${OMARCHY_BOT_FONT_ASSETS_DIR:-}}
if [[ -z $font_dir || ! -d $font_dir ]]; then
  printf 'Omarchy Bot runtime package requires a font directory: %s\n' "${font_dir:-<missing fourth argument>}" >&2
  exit 1
fi
font_pin=$root/apps/daemon/src/modules/computer/botComputerAssets.ts
font_source=$(<"$font_pin")
# The block terminator is distinct from brackets in variable-font filenames.
font_source=${font_source#*export const FONT_ASSETS}
font_source=${font_source%%']);'*}
font_pattern='file: "([^"]+)"[^}]*sha256: "([0-9a-f]{64})"'
font_files=()
while [[ $font_source =~ $font_pattern ]]; do
  font_file=${BASH_REMATCH[1]}
  expected=${BASH_REMATCH[2]}
  font_path=$font_dir/$font_file
  if [[ ! -f $font_path || ! -r $font_path ]]; then
    printf 'Omarchy Bot runtime package font file is unavailable: %s\n' "$font_path" >&2
    exit 1
  fi
  received=$(sha256sum -- "$font_path")
  received=${received%% *}
  if [[ $received != "$expected" ]]; then
    printf 'Omarchy Bot font checksum mismatch at %s: expected %s, received %s\n' "$font_path" "$expected" "$received" >&2
    exit 1
  fi
  font_files+=("$font_file")
  font_source=${font_source#*"${BASH_REMATCH[0]}"}
done
if [[ ${#font_files[@]} -eq 0 ]]; then
  printf 'Omarchy Bot runtime package is missing valid font pins in %s\n' "$font_pin" >&2
  exit 1
fi

staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT

payload=(
  package.json
  bun.lock
  bunfig.toml
  tsconfig.json
  tsconfig.base.json
  manifest.json
  apps
  packages
  workers
  patches
  scripts/serve.sh
)
existing=()
for path in "${payload[@]}"; do
  if [[ -e $root/$path ]]; then
    existing+=("$path")
  fi
done

# Keep the site workspace manifest, not publisher code, assets, or local secrets.
tar -C "$root" --exclude=node_modules \
  --exclude=apps/web/dist \
  --exclude=apps/omarchy-bot \
  --exclude=apps/site/public --exclude=apps/site/src --exclude=apps/site/dist \
  --exclude=apps/site/api --exclude=apps/site/server --exclude=apps/site/.vercel \
  --exclude='apps/site/.env*' \
  -cf - "${existing[@]}" | tar -C "$staging" -xf -
mkdir -p "$staging/sway"
tar -xzf "$sway_bundle" -C "$staging/sway"
printf '%s\n%s\n' "$sway_release" "$sway_sha256" > "$staging/sway/.omarchy-bot-runtime"
mkdir -p "$staging/fonts"
for font_file in "${font_files[@]}"; do
  cp -- "$font_dir/$font_file" "$staging/fonts/$font_file"
done
printf 'Installing frozen production dependencies in runtime staging\n' >&2
(
  cd "$staging"
  bun install --production --frozen-lockfile >&2
)

# Bun's dependency store uses hardlinks; the installer accepts only files, directories and symlinks.
tar --hard-dereference --zstd -cf "$out_dir/$asset" -C "$staging" .
(cd "$out_dir" && sha256sum -- "$asset" > "$asset.sha256")
printf '%s\n' "$out_dir/$asset"
