#!/usr/bin/env bash
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
artifact=${1:?Usage: bash tools/release/smoke-linux-app.sh path/to/metheus.AppImage}
artifact=$(realpath -- "$artifact")
[[ -f $artifact ]] || { echo "Missing AppImage: $artifact" >&2; exit 1; }
docker build --progress=plain --build-arg "linux_app_uid=$(id -u)" -t metheus-linux-app -f "$root/tools/release/linux-app/Dockerfile" "$root/tools/release/linux-app"
archive=$(realpath -- "${artifact%/*}/metheus-agent-daemon_$(basename "$artifact" | cut -d_ -f2)_x86_64-unknown-linux-gnu.tar.gz")
[[ -f $archive ]] || { echo "Missing standalone Agent Daemon archive: $archive" >&2; exit 1; }
mkdir -p "$root/.lane/linux-app/evidence"
docker run --rm --init --shm-size=1g \
  -v "$root:/src" -v "$artifact:/artifact/metheus.AppImage:ro" -w /src \
  -v "$archive:/artifact/agent-daemon.tar.gz:ro" \
  -e USER=metheus -e LOGNAME=metheus -e METHEUS_SMOKE_UID="$(id -u)" -e METHEUS_SMOKE_GID="$(id -g)" \
  -e METHEUS_UPDATER_SMOKE -e METHEUS_UPDATE_ARTIFACT \
  metheus-linux-app bash /src/tools/release/linux-app/session.sh
