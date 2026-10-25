#!/bin/sh
# Assert-based smoke test for a built Sway runtime bundle.
#
# Usage: selfcheck.sh <archive.tar.gz>
#
# Runs inside a container with no Sway, grim, D-Bus or compiler installed: every
# executable it exercises must come from the archive itself.
set -eu

archive=${1:?usage: selfcheck.sh <archive.tar.gz>}
failures=0

fail() {
  printf 'FAIL %s\n' "$1" >&2
  failures=$((failures + 1))
}

pass() {
  printf 'ok   %s\n' "$1"
}

assert_file() {
  if [ -f "$1" ]; then pass "present $2"; else fail "missing $2 ($1)"; fi
}

assert_exec() {
  if [ -x "$1" ]; then pass "executable $2"; else fail "not executable: $2 ($1)"; fi
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tar -xzf "$archive" -C "$work"
root=$work

[ -f "$root/manifest.json" ] || fail "manifest.json missing at archive root"
assert_file "$root/lib/ld-musl-x86_64.so.1" "bundled musl loader"
assert_file "$root/share/X11/xkb/rules/evdev" "bundled XKB rules"
assert_file "$root/share/X11/xkb/rules/evdev.xml" "bundled XKB rules xml"
assert_file "$root/share/dbus-1/session.conf" "bundled D-Bus session config"

for name in sway swaymsg wayvnc wlr-randr Xwayland grim dbus-daemon dbus-send xkbcomp \
            omarchy-bot-wayland-input omarchy-bot-wayland-capture omarchy-bot-desktop; do
  assert_exec "$root/bin/$name" "bin/$name"
  assert_file "$root/libexec/$name" "libexec/$name"
done

# Every bundled executable must resolve its whole dynamic closure from the
# bundle: ask the bundled loader, which reports the libraries it would map.
for elf in "$root"/libexec/*; do
  name=$(basename "$elf")
  if ! "$root/lib/ld-musl-x86_64.so.1" --library-path "$root/lib" --list "$elf" >"$work/ldd.txt" 2>&1; then
    fail "$name does not resolve its libraries"
    continue
  fi
  if grep -q 'not found' "$work/ldd.txt"; then
    fail "$name has unresolved libraries: $(tr '\n' ' ' <"$work/ldd.txt")"
    continue
  fi
  # Any mapped path outside the bundle would break on another host. musl
  # reports libc as the loader itself, which is the bundled one.
  outside=$(sed -n 's/^[^=]*=> \([^ ]*\) (0x.*/\1/p' "$work/ldd.txt" \
    | grep -v '^/lib/ld-musl-x86_64\.so\.1$' \
    | grep -v "^$root/lib/" || true)
  if [ -n "$outside" ]; then
    fail "$name resolves libraries outside the bundle: $outside"
    continue
  fi
  pass "closure $name"
done

# Executables must actually start. A loader failure exits 127; every one of
# these tools exits non-zero on a bare invocation for usage reasons at most.
check_runs() {
  name=$1
  shift
  set +e
  output=$("$root/bin/$name" "$@" 2>&1 </dev/null)
  status=$?
  set -e
  case $status in
    127)
      fail "$name did not start: $output"
      return
      ;;
  esac
  case $output in
    *'error while loading shared libraries'*|*'cannot open shared object'*)
      fail "$name has a loader error: $output"
      return
      ;;
  esac
  pass "runs $name (status $status)"
}

check_runs sway --version
check_runs swaymsg --version
check_runs wayvnc --help
check_runs wlr-randr --help
check_runs xkbcomp -version
check_runs grim -h
check_runs dbus-daemon --version
check_runs omarchy-bot-wayland-input
check_runs omarchy-bot-wayland-capture
check_runs omarchy-bot-desktop

# Xwayland only prints its version with a display-independent flag; -version is
# handled before the server starts.
check_runs Xwayland -version

# dbus-send must be able to describe itself without a bus.
set +e
dbus_out=$("$root/bin/dbus-send" --help 2>&1 </dev/null)
dbus_status=$?
set -e
if [ "$dbus_status" -eq 127 ] || printf '%s' "$dbus_out" | grep -q 'cannot open shared object'; then
  fail "dbus-send did not start: $dbus_out"
else
  pass "runs dbus-send (status $dbus_status)"
fi

# The bundle must not depend on the host's own tool copies.
for name in sway grim dbus-daemon Xwayland; do
  host=$(command -v "$name" 2>/dev/null || true)
  if [ -n "$host" ]; then
    fail "self-check host unexpectedly provides $name at $host"
  else
    pass "host has no $name"
  fi
done

if [ "$failures" -ne 0 ]; then
  printf '\n%d bundle check(s) failed\n' "$failures" >&2
  exit 1
fi
printf '\nbundle self-check passed\n'
