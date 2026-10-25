#!/bin/sh
# Musl loader smoke for the published Bot Computer runtime bundle.
#
# Runs inside a bare alpine container with no extra packages: every launcher
# must start through the bundled loader from an arbitrary directory.
set -eu

archive=$1
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
tar -xzf "$archive" -C "$root"

bin=$root/bin
if [ ! -d "$bin" ]; then
  for candidate in "$root"/*/bin; do
    [ -d "$candidate" ] && bin=$candidate && break
  done
fi
[ -d "$bin" ] || { echo "error: bundle has no bin/ directory" >&2; exit 1; }

fail=0
for entry in sway swaymsg wayvnc wlr-randr Xwayland grim dbus-daemon dbus-send \
  omarchy-bot-wayland-input omarchy-bot-wayland-capture omarchy-bot-desktop; do
  launcher=$bin/$entry
  if [ ! -x "$launcher" ]; then
    echo "FAIL $entry: missing or not executable" >&2
    fail=1
    continue
  fi
  case $entry in
    sway) set -- -v ;;
    swaymsg) set -- --help ;;
    Xwayland) set -- -version ;;
    grim) set -- -h ;;
    wlr-randr) set -- --help ;;
    wayvnc) set -- --help ;;
    *) set -- --version ;;
  esac
  # A launcher that cannot find its own loader or libraries prints one of these
  # and exits 127; that is the failure this smoke exists to catch.
  output=$("$launcher" "$@" 2>&1) && status=0 || status=$?
  case $output in
    *"error while loading shared libraries"*|*"not found"*|*"No such file or directory"*)
      echo "FAIL $entry: $output" >&2
      fail=1
      continue
      ;;
  esac
  if [ "$status" -eq 127 ]; then
    echo "FAIL $entry: launcher exited 127" >&2
    fail=1
    continue
  fi
  echo "ok $entry: $(printf '%s' "$output" | head -n 1)"
done

exit "$fail"
