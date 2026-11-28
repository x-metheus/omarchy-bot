#!/usr/bin/env bash
set -euo pipefail
printf 'smoke-private-keyring-password\n' | gnome-keyring-daemon --foreground --unlock --components=secrets > "$METHEUS_SMOKE_DIR/keyring.log" 2>&1 &
keyring_pid=$!
gdbus wait --session --timeout 15 org.freedesktop.secrets
mkdir -p /src/.lane/linux-app/evidence
: > /src/.lane/linux-app/evidence/app-exits.log
# tauri-driver owns WebKitWebDriver; all processes share only this private bus.
export OPENAI_BASE_URL=http://127.0.0.1:18443/v1 METHEUS_DESKTOP_AGENT_PORT=18444
export OMARCHY_AGENT_RECALL_MODEL_SOURCE=http://127.0.0.1:1
export METHEUS_SMOKE_AGENT_PROFILE=$XDG_DATA_HOME/com.omarchy.bot/agent-daemon
export METHEUS_SMOKE_AGENT_ARCHIVE=/artifact/agent-daemon.tar.gz
export METHEUS_SMOKE_EVIDENCE=/src/.lane/linux-app/evidence
/usr/local/cargo/bin/tauri-driver --native-driver /usr/bin/WebKitWebDriver > "$METHEUS_SMOKE_DIR/driver.log" 2>&1 &
driver_pid=$!
prefix=
if [[ ${METHEUS_UPDATER_SMOKE:-0} == 1 ]]; then prefix=updater-; fi
cleanup() {
  kill "$driver_pid" 2>/dev/null || true
  kill "$keyring_pid" 2>/dev/null || true
  cp "$METHEUS_SMOKE_DIR/driver.log" "/src/.lane/linux-app/evidence/${prefix}driver.log"
  cp "$METHEUS_SMOKE_DIR/keyring.log" "/src/.lane/linux-app/evidence/${prefix}keyring.log"
  if [[ -f "$XDG_DATA_HOME/com.omarchy.bot/logs/metheus.log" ]]; then
    cp "$XDG_DATA_HOME/com.omarchy.bot/logs/metheus.log" "/src/.lane/linux-app/evidence/${prefix}metheus.log"
  fi
}
trap cleanup EXIT
{
  printf 'Bun '; bun --version
  printf 'WebKitGTK '; pkg-config --modversion webkit2gtk-4.1
  printf 'tauri-driver 2.1.0; tauri-cli 2.12.4 (Dockerfile --locked installs)\n'
  sha256sum /artifact/metheus.AppImage
} > "/src/.lane/linux-app/evidence/${prefix}environment.txt"
smoke=tools/release/agent-release-smoke.ts
if [[ ${METHEUS_UPDATER_SMOKE:-0} == 1 ]]; then
  bun install --cwd tools/release --frozen-lockfile
  smoke=tools/release/linux-app/updater-smoke.ts
fi
bun "$smoke" /artifact/metheus.AppImage 2>&1 | tee "/src/.lane/linux-app/evidence/${prefix}smoke.log"
