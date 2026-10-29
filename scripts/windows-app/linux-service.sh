#!/usr/bin/env bash
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
: "${GITHUB_RUN_ID:?A unique CI run id is required}"
name=omarchy-windows-smoke-$GITHUB_RUN_ID
if [[ ${1:-} == stop ]]; then
  docker stop "$name"
  exit 0
fi
: "${WINDOWS_SMOKE_HOST_SECRET:?Set the protected environment pairing secret}"
mkdir -p "$root/.lane/windows-app/evidence"
docker build --build-arg "linux_app_uid=$(id -u)" -t omarchy-bot-linux-app -f "$root/scripts/linux-app/Dockerfile" "$root/scripts/linux-app"
[[ -d "$root/.lane/dist/sway" ]] || bash "$root/scripts/build-sway-runtime.sh" "$root/.lane/dist"
[[ -d "$root/.lane/fonts" ]] || bash "$root/scripts/prepare-fonts.sh" "$root/.lane/fonts"
if [[ ! -f "$root/.lane/browser/.omarchy-bot-browser-pack" ]]; then
  docker run --rm --user "$(id -u):$(id -g)" -v "$root:/src" -w /src -e HOME=/tmp omarchy-bot-linux-app bash scripts/package-browser-pack.sh /src /src/.lane/browser-pack
  archives=("$root"/.lane/browser-pack/omarchy-bot-browser-*-x86_64.tar.zst)
  [[ ${#archives[@]} == 1 && -f ${archives[0]} ]] || { echo 'Expected one pinned browser archive' >&2; exit 1; }
  docker run --rm --user "$(id -u):$(id -g)" -v "$root:/src" -w /src -e HOME=/tmp omarchy-bot-linux-app bun scripts/install-browser-pack.ts "/src/.lane/browser-pack/$(basename -- "${archives[0]}")" /src/.lane/browser
fi
docker run --detach --rm --init --network host --name "$name" --user "$(id -u):$(id -g)" --shm-size=1g \
  -v "$root:/src" -w /src \
  -e WINDOWS_SMOKE_HOST_SECRET omarchy-bot-linux-app bash scripts/windows-app/service.sh
for attempt in {1..150}; do
  if curl --fail --silent http://127.0.0.1:7431/api/health >/dev/null && curl --insecure --fail --silent https://127.0.0.1:7432/api/health >/dev/null; then exit 0; fi
  sleep 1
done
echo 'Linux Service fixture did not become ready' >&2
exit 1
