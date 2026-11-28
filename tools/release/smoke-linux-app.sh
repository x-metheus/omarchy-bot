#!/usr/bin/env bash
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
artifact=${1:?Usage: bash tools/release/smoke-linux-app.sh path/to/omarchy-bot.AppImage}
artifact=$(realpath -- "$artifact")
[[ -f $artifact ]] || { echo "Missing AppImage: $artifact" >&2; exit 1; }
docker build --progress=plain --build-arg "linux_app_uid=$(id -u)" -t omarchy-bot-linux-app -f "$root/tools/release/linux-app/Dockerfile" "$root/tools/release/linux-app"
archive=$(realpath -- "${artifact%/*}/omarchy-agent-daemon_$(basename "$artifact" | cut -d_ -f2)_x86_64-unknown-linux-gnu.tar.gz")
[[ -f $archive ]] || { echo "Missing standalone Agent Daemon archive: $archive" >&2; exit 1; }
mkdir -p "$root/.lane/linux-app/evidence"
docker run --rm --init --shm-size=1g \
  -v "$root:/src" -v "$artifact:/artifact/omarchy-bot.AppImage:ro" -w /src \
  -v "$archive:/artifact/agent-daemon.tar.gz:ro" \
  -e USER=omarchy -e LOGNAME=omarchy -e OMARCHY_BOT_SMOKE_UID="$(id -u)" -e OMARCHY_BOT_SMOKE_GID="$(id -g)" \
  -e OMARCHY_BOT_UPDATER_SMOKE -e OMARCHY_BOT_UPDATE_ARTIFACT \
  omarchy-bot-linux-app bash /src/tools/release/linux-app/session.sh
