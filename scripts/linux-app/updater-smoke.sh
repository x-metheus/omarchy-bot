#!/usr/bin/env bash
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
umask 077
mkdir -p .lane/linux-app/evidence .lane/linux-app/build-home
# The private test key exists only in this ignored worktree and is removed on exit.
keydir=$(mktemp -d "$root/.lane/linux-app/updater-key-XXXXXX")
trap 'rm -rf "$keydir"' EXIT
# Reuse the pinned toolchain; never install Cargo or WebKit onto the host.
docker build --progress=plain --build-arg "linux_app_uid=$(id -u)" -t omarchy-bot-linux-app -f scripts/linux-app/Dockerfile scripts/linux-app
docker run --rm --user "$(id -u):$(id -g)" -v "$keydir:/key" omarchy-bot-linux-app cargo tauri signer generate --ci --password '' --write-keys /key/updater > "$keydir/generate.log"
export TAURI_SIGNING_PRIVATE_KEY TAURI_UPDATER_PUBKEY
TAURI_SIGNING_PRIVATE_KEY=$(cat "$keydir/updater")
TAURI_UPDATER_PUBKEY=$(cat "$keydir/updater.pub")
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD= OMARCHY_BOT_UPDATER_SMOKE=1
export TAURI_UPDATER_ENDPOINT=http://127.0.0.1:7436/latest.json
APP_VERSION=0.1.0 bash scripts/build-linux-app.sh
APP_VERSION=0.1.1 bash scripts/build-linux-app.sh
# Do not pass signing material into the running app's test container.
unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD TAURI_UPDATER_PUBKEY
bash scripts/smoke-linux-app.sh .lane/dist/omarchy-bot_0.1.0_amd64.AppImage
