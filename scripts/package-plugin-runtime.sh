#!/usr/bin/env bash
# Usage: bash scripts/package-plugin-runtime.sh <repo-root> <out-dir> <sway-bundle.tar.gz>
set -euo pipefail

root=$(CDPATH= cd -- "${1:-$(dirname -- "$0")/..}" && pwd)
sha=${OMARCHY_BOT_PLUGIN_REVISION:-$(git -C "$root" rev-parse HEAD)}
out_dir=${2:-$root/dist-runtime}
mkdir -p "$out_dir"
out_dir=$(CDPATH= cd -- "$out_dir" && pwd)
asset=omarchy-bot-runtime-${sha}-x86_64.tar.zst

required=(
  apps/web/dist
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
  --exclude=apps/site/public --exclude=apps/site/src --exclude=apps/site/dist \
  --exclude=apps/site/api --exclude=apps/site/server --exclude=apps/site/.vercel \
  --exclude='apps/site/.env*' \
  -cf - "${existing[@]}" | tar -C "$staging" -xf -
mkdir -p "$staging/sway"
tar -xzf "$sway_bundle" -C "$staging/sway"
printf '%s\n%s\n' "$sway_release" "$sway_sha256" > "$staging/sway/.omarchy-bot-runtime"
printf 'Installing frozen production dependencies in runtime staging\n' >&2
(
  cd "$staging"
  bun install --production --frozen-lockfile >&2
)

tar --zstd -cf "$out_dir/$asset" -C "$staging" .
(cd "$out_dir" && sha256sum -- "$asset" > "$asset.sha256")
printf '%s\n' "$out_dir/$asset"
