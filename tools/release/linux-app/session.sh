#!/usr/bin/env bash
set -euo pipefail
umask 077
# Run the native smoke as a disposable, unprivileged user inside the image.
if [[ $(id -u) -eq 0 ]]; then
  if [[ ! -f /etc/metheus-linux-app || $(< /etc/metheus-linux-app) != metheus-linux-app-v1 ]] \
    || [[ ! -f /.dockerenv && ! -f /run/.containerenv ]]; then
    echo "Root entry requires the repository's Linux app container." >&2
    exit 1
  fi
  if [[ ! ${METHEUS_SMOKE_UID:-} =~ ^[1-9][0-9]*$ || ! ${METHEUS_SMOKE_GID:-} =~ ^[1-9][0-9]*$ ]] \
    || ! command -v setpriv >/dev/null \
    || ! setpriv --reuid="$METHEUS_SMOKE_UID" --regid="$METHEUS_SMOKE_GID" --clear-groups /bin/true; then
    echo "The private smoke requires a working non-root smoke UID/GID and setpriv privilege drop." >&2
    exit 1
  fi
  exec setpriv --reuid="$METHEUS_SMOKE_UID" --regid="$METHEUS_SMOKE_GID" --clear-groups bash /src/tools/release/linux-app/session.sh
fi
session=$(mktemp -d /tmp/metheus-webkit-XXXXXX)
export HOME=$session/home XDG_RUNTIME_DIR=$session/run TMPDIR=$session/tmp
export XDG_CONFIG_HOME=$HOME/.config XDG_DATA_HOME=$HOME/.local/share XDG_CACHE_HOME=$HOME/.cache
mkdir -p "$HOME" "$XDG_RUNTIME_DIR" "$TMPDIR" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"
printf 'XDG_DOWNLOAD_DIR="$HOME/Downloads"\n' > "$XDG_CONFIG_HOME/user-dirs.dirs"
mkdir -p "$session/bin"
cat > "$session/bin/xdg-open" <<'EOF'
#!/bin/sh
printf '%s\n' "$1" >> "$METHEUS_SMOKE_DIR/opened-urls"
EOF
chmod 755 "$session/bin/xdg-open"
export PATH="$session/bin:$PATH"
export DISPLAY=:99 LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
export APPIMAGE_EXTRACT_AND_RUN=1
export METHEUS_SMOKE_DIR=$session METHEUS_SMOKE_APP=$session/app
cleanup() { [[ -z ${xvfb_pid:-} ]] || kill "$xvfb_pid" 2>/dev/null || true; rm -rf "$session"; }
trap cleanup EXIT
Xvfb "$DISPLAY" -screen 0 1440x1000x24 -nolisten tcp > "$session/xvfb.log" 2>&1 &
xvfb_pid=$!
if [[ ${METHEUS_UPDATER_SMOKE:-0} == 1 ]]; then
  # A writable real AppImage exercises replacement and restart, without FUSE.
  cp /artifact/metheus.AppImage "$session/installed.AppImage"
  chmod 755 "$session/installed.AppImage"
  cat > "$METHEUS_SMOKE_APP" <<EOF
#!/bin/sh
exec "$session/installed.AppImage" "\$@"
EOF
  chmod 755 "$METHEUS_SMOKE_APP"
else
  # Extract exactly the packaged filesystem for the general WebKit smoke.
  cd "$session"
  /artifact/metheus.AppImage --appimage-extract > extract.log
  test -x squashfs-root/usr/bin/metheus-agent-daemon
cat > "$METHEUS_SMOKE_APP" <<EOF
#!/bin/sh
"$session/squashfs-root/AppRun" "\$@" 2> "/src/.lane/linux-app/evidence/app-\$\$.stderr.log" &
app_pid=\$!
printf 'wrapper_pid=%s app_pid=%s started\\n' "\$\$" "\$app_pid" >> /src/.lane/linux-app/evidence/app-exits.log
wait "\$app_pid"
status=\$?
printf 'wrapper_pid=%s app_pid=%s exit_code=%s\\n' "\$\$" "\$app_pid" "\$status" >> /src/.lane/linux-app/evidence/app-exits.log
exit "\$status"
EOF
chmod 755 "$METHEUS_SMOKE_APP"
fi
cd /src
dbus-run-session -- bash /src/tools/release/linux-app/keyring-session.sh
