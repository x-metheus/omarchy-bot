#!/usr/bin/env bash
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
image=omarchy-bot-linux-app
mkdir -p "$root/.lane/linux-app/cargo" "$root/.lane/linux-app/build-home" "$root/.lane/linux-app/target" "$root/.lane/dist"
docker build --progress=plain --build-arg "linux_app_uid=$(id -u)" -t "$image" -f "$root/scripts/linux-app/Dockerfile" "$root/scripts/linux-app"
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$root:/src" -w /src \
  -e HOME=/src/.lane/linux-app/build-home \
  -e CARGO_HOME=/src/.lane/linux-app/cargo \
  -e CARGO_TARGET_DIR=/src/.lane/linux-app/target \
  "$image" bash /src/scripts/linux-app/build.sh
