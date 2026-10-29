#!/usr/bin/env bash
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
artifact=$(realpath -- "${1:?Usage: bash scripts/linux-app/install-smoke.sh path/to/app.AppImage}")
[[ -f $artifact && -f $artifact.sha256 ]] || { echo 'AppImage and SHA-256 sidecar required' >&2; exit 1; }
mkdir -p "$root/.lane/linux-app/evidence"
docker build --build-arg "linux_app_uid=$(id -u)" -t omarchy-bot-linux-app -f "$root/scripts/linux-app/Dockerfile" "$root/scripts/linux-app"
docker run --rm --init --shm-size=1g --device /dev/fuse --cap-add SYS_ADMIN --security-opt apparmor=unconfined \
  --user "$(id -u):$(id -g)" -v "$root:/src" -v "$artifact:/artifact/app.AppImage:ro" -v "$artifact.sha256:/artifact/app.AppImage.sha256:ro" \
  -w /src -e HOME=/tmp omarchy-bot-linux-app bash /src/scripts/linux-app/install-session.sh
