#!/usr/bin/env bash
set -euo pipefail
umask 077
session=$(mktemp -d /tmp/omarchy-bot-install-XXXXXX)
export HOME="$session/home with spaces" XDG_RUNTIME_DIR=$session/run TMPDIR=$session/tmp
export XDG_CONFIG_HOME=$HOME/.config XDG_DATA_HOME=$HOME/.local/share XDG_CACHE_HOME=$HOME/.cache
mkdir -p "$HOME" "$XDG_RUNTIME_DIR" "$TMPDIR" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"
export DISPLAY=:98 LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 OMARCHY_BOT_INSTALL_SMOKE_DIR=$session
export XDG_CURRENT_DESKTOP=GNOME:Unity
printf '[Default Applications]\nx-scheme-handler/omarchy-bot=foreign.desktop;\n' > "$XDG_CONFIG_HOME/gnome-mimeapps.list"
unset APPIMAGE_EXTRACT_AND_RUN WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS
cleanup() {
  kill "$xvfb_pid" 2>/dev/null || true
  for mount in "$TMPDIR"/.mount_*; do
    [[ ! -d $mount ]] || fusermount -uz "$mount" 2>/dev/null || true
  done
  rm -rf "$session"
}
trap cleanup EXIT
Xvfb "$DISPLAY" -screen 0 1440x1000x24 -nolisten tcp > "$session/xvfb.log" 2>&1 &
xvfb_pid=$!
dbus-run-session -- bash -c '
set -euo pipefail
printf "install-smoke-private-password\n" | gnome-keyring-daemon --foreground --unlock --components=secrets > "$OMARCHY_BOT_INSTALL_SMOKE_DIR/keyring.log" 2>&1 &
keyring_pid=$!
trap '\''kill "$keyring_pid" 2>/dev/null || true'\'' EXIT
gdbus wait --session --timeout 15 org.freedesktop.secrets
NODE_PATH=/src/apps/daemon/node_modules bun scripts/linux-app/install-smoke.ts 2>&1 | tee /src/.lane/linux-app/evidence/install-smoke.log
'
