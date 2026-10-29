#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${WINDOWS_SMOKE_HOST_SECRET:?Required pairing issuance secret}"
private=$(mktemp -d /tmp/omarchy-windows-service-XXXXXX)
export HOME=$private/home XDG_RUNTIME_DIR=$private/run TMPDIR=$private/tmp
export XDG_CONFIG_HOME=$HOME/.config XDG_DATA_HOME=$HOME/.local/share XDG_CACHE_HOME=$HOME/.cache
mkdir -p "$HOME" "$XDG_RUNTIME_DIR" "$TMPDIR" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"
export OMARCHY_BOT_SWAY_BUNDLE_DIR=/src/.lane/dist/sway
export OMARCHY_BOT_FONT_DIR=/src/.lane/fonts OMARCHY_BOT_BROWSER_PACK_DIR=/src/.lane/browser
export OMARCHY_BOT_WORKERS_DIR=/src/tests/integration/fake-workers
export OMARCHY_BOT_HOST=127.0.0.1 OMARCHY_BOT_DEV=0 OMARCHY_BOT_SCREEN_PROFILE=720p
cc /src/scripts/sway-runtime/conformance/x11-fixture.c -lX11 -o /src/.lane/windows-app/x11-fixture
children=()
cleanup() { for pid in "${children[@]}"; do kill "$pid" 2>/dev/null || true; done; wait || true; rm -rf "$private"; }
trap cleanup EXIT
trap 'exit 0' TERM INT
for port in 7431 7432; do
  dir=$private/service-$port
  mkdir -p "$dir/data/conformance" "$dir/state"
  printf '{"ok":true}\n' > "$dir/data/conformance/pi-fake-pi-1.json"
  printf '%s\n' "$WINDOWS_SMOKE_HOST_SECRET" > "$dir/state/pairing-host-secret"
  if [[ $port == 7432 ]]; then
    openssl req -x509 -newkey rsa:2048 -nodes -keyout "$private/untrusted.key" -out "$private/untrusted.pem" -days 1 -subj /CN=untrusted.invalid >/dev/null 2>&1
    export OMARCHY_BOT_TLS_CERT=$private/untrusted.pem OMARCHY_BOT_TLS_KEY=$private/untrusted.key
    export OMARCHY_BOT_HOST=0.0.0.0
  fi
  OMARCHY_BOT_HOME=$dir/data OMARCHY_BOT_STATE=$dir/state OMARCHY_BOT_PORT=$port \
    bun tests/e2e/daemon-boot.ts > "/src/.lane/windows-app/evidence/service-$port.log" 2>&1 &
  children+=("$!")
done
wait -n "${children[@]}"
# Either Service exiting is a failed fixture; do not leave a healthy-looking half fixture.
exit 1
