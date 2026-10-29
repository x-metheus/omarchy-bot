#!/usr/bin/env bash
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
artifact=${1:?Usage: bash scripts/smoke-linux-app.sh path/to/omarchy-bot.AppImage}
artifact=$(realpath -- "$artifact")
[[ -f $artifact ]] || { echo "Missing AppImage: $artifact" >&2; exit 1; }
docker build --progress=plain --build-arg "linux_app_uid=$(id -u)" -t omarchy-bot-linux-app -f "$root/scripts/linux-app/Dockerfile" "$root/scripts/linux-app"
[[ -d "$root/.lane/dist/sway" ]] || bash "$root/scripts/build-sway-runtime.sh" "$root/.lane/dist"
[[ -d "$root/.lane/fonts" ]] || bash "$root/scripts/prepare-fonts.sh" "$root/.lane/fonts"
[[ -f "$root/.lane/browser/.omarchy-bot-browser-pack" ]] || {
  docker run --rm --user "$(id -u):$(id -g)" -v "$root:/src" -w /src -e HOME=/tmp omarchy-bot-linux-app bash scripts/package-browser-pack.sh /src /src/.lane/browser-pack
  mkdir -p "$root/.lane/browser"
  archives=("$root"/.lane/browser-pack/omarchy-bot-browser-*-x86_64.tar.zst)
  [[ ${#archives[@]} -eq 1 && -f ${archives[0]} ]] || { echo 'Expected one pinned browser archive' >&2; exit 1; }
  docker run --rm --user "$(id -u):$(id -g)" -v "$root:/src" -w /src -e HOME=/tmp omarchy-bot-linux-app bun scripts/install-browser-pack.ts "/src/.lane/browser-pack/$(basename -- "${archives[0]}")" /src/.lane/browser
}
mkdir -p "$root/.lane/linux-app/evidence"
docker run --rm --init --shm-size=1g \
  -v "$root:/src" -v "$artifact:/artifact/omarchy-bot.AppImage:ro" -w /src \
  -e USER=omarchy -e LOGNAME=omarchy -e OMARCHY_BOT_SMOKE_UID="$(id -u)" -e OMARCHY_BOT_SMOKE_GID="$(id -g)" \
  -e OMARCHY_BOT_UPDATER_SMOKE -e OMARCHY_BOT_UPDATE_ARTIFACT \
  omarchy-bot-linux-app bash /src/scripts/linux-app/session.sh
