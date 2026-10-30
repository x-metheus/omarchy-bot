#!/usr/bin/env bash
set -euo pipefail
printf 'smoke-private-keyring-password\n' | gnome-keyring-daemon --foreground --unlock --components=secrets > "$OMARCHY_BOT_SMOKE_DIR/keyring.log" 2>&1 &
keyring_pid=$!
gdbus wait --session --timeout 15 org.freedesktop.secrets
mkdir -p /src/.lane/linux-app/evidence
: > /src/.lane/linux-app/evidence/app-exits.log
# tauri-driver owns WebKitWebDriver; all processes share only this private bus.
/usr/local/cargo/bin/tauri-driver --native-driver /usr/bin/WebKitWebDriver > "$OMARCHY_BOT_SMOKE_DIR/driver.log" 2>&1 &
driver_pid=$!
prefix=
if [[ ${OMARCHY_BOT_UPDATER_SMOKE:-0} == 1 ]]; then prefix=updater-; fi
cleanup() {
  kill "$driver_pid" 2>/dev/null || true
  kill "$keyring_pid" 2>/dev/null || true
  cp "$OMARCHY_BOT_SMOKE_DIR/driver.log" "/src/.lane/linux-app/evidence/${prefix}driver.log"
  cp "$OMARCHY_BOT_SMOKE_DIR/keyring.log" "/src/.lane/linux-app/evidence/${prefix}keyring.log"
  if [[ -f "$XDG_DATA_HOME/com.omarchy.bot/logs/omarchy-bot.log" ]]; then
    cp "$XDG_DATA_HOME/com.omarchy.bot/logs/omarchy-bot.log" "/src/.lane/linux-app/evidence/${prefix}omarchy-bot.log"
  fi
}
trap cleanup EXIT
{
  printf 'Bun '; bun --version
  printf 'WebKitGTK '; pkg-config --modversion webkit2gtk-4.1
  printf 'tauri-driver 2.1.0; tauri-cli 2.12.4 (Dockerfile --locked installs)\n'
  sha256sum /artifact/omarchy-bot.AppImage
} > "/src/.lane/linux-app/evidence/${prefix}environment.txt"
smoke=scripts/linux-app/smoke.ts
if [[ ${OMARCHY_BOT_UPDATER_SMOKE:-0} == 1 ]]; then smoke=scripts/linux-app/updater-smoke.ts; fi
NODE_PATH=/src/apps/daemon/node_modules bun "$smoke" /artifact/omarchy-bot.AppImage 2>&1 | tee "/src/.lane/linux-app/evidence/${prefix}smoke.log"
