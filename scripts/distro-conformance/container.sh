#!/usr/bin/env bash
set -euo pipefail
umask 077
# This entry runs only inside a disposable container as uid 1000.
[[ $(id -u) != 0 && -f /.dockerenv ]] || { echo 'Run in a disposable non-root Docker container' >&2; exit 2; }
root=$(mktemp -d /tmp/dc.XXXXXX)
service=
cleanup() {
  code=$?
  trap - EXIT INT TERM
  if [[ -n $service ]]; then
    kill -INT "$service" 2>/dev/null || true
    wait "$service" || true
  fi
  if ((code != 0)); then cat "$root/service.log" 2>/dev/null || true; fi
  rm -rf -- "$root"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export HOME=$root/home XDG_RUNTIME_DIR=$root/r XDG_CONFIG_HOME=$root/config XDG_DATA_HOME=$root/data XDG_STATE_HOME=$root/state
export OMARCHY_BOT_HOME=$root/data/omarchy-bot OMARCHY_BOT_STATE=$root/state/omarchy-bot OMARCHY_BOT_PORT=17321
export OMARCHY_BOT_SCREEN_PROFILE=720p OMARCHY_BOT_SCREEN_CAPACITY=2
unset DISPLAY WAYLAND_DISPLAY SWAYSOCK DBUS_SESSION_BUS_ADDRESS HYPRLAND_INSTANCE_SIGNATURE
mkdir -p "$HOME" "$XDG_RUNTIME_DIR" "$OMARCHY_BOT_HOME" "$OMARCHY_BOT_STATE"
current=$OMARCHY_BOT_HOME/runtime/current
bun /src/scripts/distro-conformance/install.ts /bundle/runtime.tar.zst "$current" /bundle/browser.tar.zst
# Tests resolve application imports against the installed archive, never the checkout.
cp -R /src/tests "$current/tests"
mkdir -p "$current/scripts/distro-conformance"
cp /src/scripts/distro-conformance/smoke.ts "$current/scripts/distro-conformance/"
export OMARCHY_BOT_WORKERS_DIR=$current/tests/integration/fake-workers
export OMARCHY_BOT_SWAY_BUNDLE_DIR=$current/sway OMARCHY_BOT_DISTRO_SWAY_DIR=$current/sway OMARCHY_BOT_FONT_DIR=$current/fonts
export OMARCHY_BOT_BROWSER_PACK_DIR=$OMARCHY_BOT_HOME/runtime/browser
export OMARCHY_BOT_SWAY_BIN=$current/sway/bin/sway OMARCHY_BOT_SWAYMSG_BIN=$current/sway/bin/swaymsg
export OMARCHY_BOT_WLR_RANDR_BIN=$current/sway/bin/wlr-randr OMARCHY_BOT_WAYVNC_BIN=$current/sway/bin/wayvnc
export OMARCHY_BOT_GRIM_BIN=$current/sway/bin/grim OMARCHY_BOT_DBUS_DAEMON_BIN=$current/sway/bin/dbus-daemon
export OMARCHY_BOT_INPUT_HELPER_BIN=$current/sway/bin/omarchy-bot-wayland-input
export OMARCHY_BOT_CAPTURE_HELPER_BIN=$current/sway/bin/omarchy-bot-wayland-capture
export OMARCHY_BOT_DESKTOP_BIN=$current/sway/bin/omarchy-bot-desktop
export OMARCHY_BOT_X11_FIXTURE=/usr/local/bin/x11-fixture
[[ ! -e $XDG_RUNTIME_DIR/systemd/private ]] || { echo 'A real user manager must not be used' >&2; exit 1; }
# A container entrypoint supervises the same foreground entry used by systemd.
bash "$current/scripts/serve.sh" >"$root/service.log" 2>&1 &
service=$!
bun "$current/scripts/distro-conformance/smoke.ts"
kill -INT "$service"
wait "$service"
service=
cd "$current"
OMARCHY_BOT_REAL_SWAY=1 OMARCHY_BOT_REAL_PORTABLE_BROWSER=1 bun test \
  tests/integration/bot-screen-sway-bundle-conformance.test.ts \
  tests/integration/bot-screen-sway-layout.test.ts \
  tests/integration/bot-screen-portable-browser-conformance.test.ts
