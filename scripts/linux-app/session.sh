#!/usr/bin/env bash
set -euo pipefail
umask 077
# Trust one ephemeral test certificate inside this disposable container only.
if [[ $(id -u) -eq 0 ]]; then
  if [[ ! -f /etc/omarchy-bot-linux-app || $(< /etc/omarchy-bot-linux-app) != omarchy-bot-linux-app-v1 ]] \
    || [[ ! -f /.dockerenv && ! -f /run/.containerenv ]]; then
    echo "CA trust requires the repository's Linux app container; refusing to modify host trust." >&2
    exit 1
  fi
  if [[ ! ${OMARCHY_BOT_SMOKE_UID:-} =~ ^[1-9][0-9]*$ || ! ${OMARCHY_BOT_SMOKE_GID:-} =~ ^[1-9][0-9]*$ ]] \
    || ! command -v setpriv >/dev/null \
    || ! setpriv --reuid="$OMARCHY_BOT_SMOKE_UID" --regid="$OMARCHY_BOT_SMOKE_GID" --clear-groups /bin/true; then
    echo "CA trust requires a working non-root smoke UID/GID and setpriv privilege drop." >&2
    exit 1
  fi
  trust=$(mktemp -d /tmp/omarchy-bot-trust-XXXXXX)
  read -r offhost_ip _ <<< "$(hostname -I)"
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$trust/key.pem" -out "$trust/cert.pem" -days 1 -subj /CN=localhost -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:$offhost_ip" > "$trust/openssl.log" 2>&1
  cp "$trust/cert.pem" /usr/local/share/ca-certificates/omarchy-bot-smoke.crt
  update-ca-certificates > "$trust/trust.log" 2>&1
  chown -R "$OMARCHY_BOT_SMOKE_UID:$OMARCHY_BOT_SMOKE_GID" "$trust"
  export OMARCHY_BOT_SMOKE_TRUST=$trust
  export OMARCHY_BOT_SMOKE_OFFHOST_IP=$offhost_ip NODE_EXTRA_CA_CERTS=$trust/cert.pem
  exec setpriv --reuid="$OMARCHY_BOT_SMOKE_UID" --regid="$OMARCHY_BOT_SMOKE_GID" --clear-groups bash /src/scripts/linux-app/session.sh
fi
session=$(mktemp -d /tmp/omarchy-bot-webkit-XXXXXX)
export HOME=$session/home XDG_RUNTIME_DIR=$session/run TMPDIR=$session/tmp
export XDG_CONFIG_HOME=$HOME/.config XDG_DATA_HOME=$HOME/.local/share XDG_CACHE_HOME=$HOME/.cache
mkdir -p "$HOME" "$XDG_RUNTIME_DIR" "$TMPDIR" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"
printf 'XDG_DOWNLOAD_DIR="$HOME/Downloads"\n' > "$XDG_CONFIG_HOME/user-dirs.dirs"
printf '0123456789abcdef0123456789abcdef\n' > "$session/app-machine-id"
export OMARCHY_BOT_MACHINE_ID_FILE=$session/app-machine-id
mkdir -p "$session/bin"
cat > "$session/bin/xdg-open" <<'EOF'
#!/bin/sh
printf '%s\n' "$1" >> "$OMARCHY_BOT_SMOKE_DIR/opened-urls"
EOF
chmod 755 "$session/bin/xdg-open"
export PATH="$session/bin:$PATH"
export DISPLAY=:99 LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
export APPIMAGE_EXTRACT_AND_RUN=1
export OMARCHY_BOT_SMOKE_DIR=$session OMARCHY_BOT_SMOKE_APP=$session/app
export OMARCHY_BOT_SWAY_BUNDLE_DIR=/src/.lane/dist/sway
export OMARCHY_BOT_FONT_DIR=/src/.lane/fonts OMARCHY_BOT_BROWSER_PACK_DIR=/src/.lane/browser
cleanup() { [[ -z ${xvfb_pid:-} ]] || kill "$xvfb_pid" 2>/dev/null || true; rm -rf "$session" "$OMARCHY_BOT_SMOKE_TRUST"; }
trap cleanup EXIT
Xvfb "$DISPLAY" -screen 0 1440x1000x24 -nolisten tcp > "$session/xvfb.log" 2>&1 &
xvfb_pid=$!
if [[ ${OMARCHY_BOT_UPDATER_SMOKE:-0} == 1 ]]; then
  # A writable real AppImage exercises replacement and restart, without FUSE.
  cp /artifact/omarchy-bot.AppImage "$session/installed.AppImage"
  chmod 755 "$session/installed.AppImage"
  cat > "$OMARCHY_BOT_SMOKE_APP" <<EOF
#!/bin/sh
exec "$session/installed.AppImage" "\$@"
EOF
  chmod 755 "$OMARCHY_BOT_SMOKE_APP"
else
  # Extract exactly the packaged filesystem for the general WebKit smoke.
  cd "$session"
  /artifact/omarchy-bot.AppImage --appimage-extract > extract.log
cat > "$OMARCHY_BOT_SMOKE_APP" <<EOF
#!/bin/sh
exec "$session/squashfs-root/AppRun" "\$@"
EOF
chmod 755 "$OMARCHY_BOT_SMOKE_APP"
cat > "$OMARCHY_BOT_SMOKE_APP-no-keyring" <<EOF
#!/bin/sh
export DBUS_SESSION_BUS_ADDRESS=unix:path=$session/unavailable-session-bus
exec "$session/squashfs-root/AppRun" "\$@"
EOF
chmod 755 "$OMARCHY_BOT_SMOKE_APP-no-keyring"
fi
cc /src/scripts/sway-runtime/conformance/x11-fixture.c -lX11 -o "$session/x11-fixture"
export OMARCHY_BOT_X11_FIXTURE=$session/x11-fixture
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$session/tls.key" -out "$session/tls.pem" -days 1 -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' > "$session/openssl.log" 2>&1
cd /src
dbus-run-session -- bash /src/scripts/linux-app/keyring-session.sh
