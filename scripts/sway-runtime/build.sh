#!/bin/sh
# Build the self-contained Sway runtime bundle.
#
# Runs inside the pinned Alpine build image (scripts/sway-runtime/Dockerfile):
#   docker build -f scripts/sway-runtime/Dockerfile -t omarchy-bot-sway-runtime-build .
#   docker run --rm -v "$PWD:/src:ro" -v "$PWD/.lane/dist:/out" omarchy-bot-sway-runtime-build
#
# Compiles the core runtime tools from pinned upstream sources, adds the
# remaining runtime tools, collects the full non-libc library closure plus
# runtime data, writes relocatable launchers, and emits a reproducible
# .tar.gz + .sha256 sidecar.
set -eu

repo=${REPO_DIR:-/src}
out_dir=${OUT_DIR:-/out}
work=${WORK_DIR:-/tmp/bundle}
jobs=${BUILD_JOBS:-4}

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$here/sources.lock"

export SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-1700000000}
umask 022

log() { printf '==> %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

root=$work/root
rm -rf "$work"
mkdir -p "$work/src" "$work/build" "$root/bin" "$root/libexec" "$root/lib" "$root/share" "$root/licenses"
mkdir -p "$out_dir"

# ---------------------------------------------------------------------------
# 1. Fetch and verify pinned sources
# ---------------------------------------------------------------------------
printf '%s\n' "$SOURCES" | while IFS='|' read -r name version url sha; do
  [ -n "$name" ] || continue
  log "fetch $name $version"
  case $url in
    *.xz) ext=xz ;;
    *) ext=gz ;;
  esac
  file=$work/src/$name.tar.$ext
  # A verified cache keeps re-runs cheap; the hash is re-checked either way.
  if [ -n "${SRC_CACHE:-}" ] && [ -f "$SRC_CACHE/$name.tar.$ext" ] \
     && [ "$(sha256sum "$SRC_CACHE/$name.tar.$ext" | cut -d' ' -f1)" = "$sha" ]; then
    cp "$SRC_CACHE/$name.tar.$ext" "$file"
  else
    curl -fsSL --retry 3 --connect-timeout 20 --max-time 300 -o "$file" "$url"
    actual=$(sha256sum "$file" | cut -d' ' -f1)
    [ "$actual" = "$sha" ] || die "checksum mismatch for $name: expected $sha, got $actual"
    if [ -n "${SRC_CACHE:-}" ]; then
      mkdir -p "$SRC_CACHE"
      cp "$file" "$SRC_CACHE/$name.tar.$ext"
    fi
  fi
  mkdir -p "$work/src/$name"
  tar -xf "$file" -C "$work/src/$name" --strip-components=1
done

# ---------------------------------------------------------------------------
# 2. Compile pinned upstream sources (installed to /usr for pkg-config)
# ---------------------------------------------------------------------------
build_meson() {
  name=$1
  shift
  log "build $name"
  meson setup "$work/build/$name" "$work/src/$name" \
    --prefix=/usr --libdir=lib --buildtype=release -Db_lto=false "$@" >&2
  meson compile -C "$work/build/$name" -j "$jobs" >&2
  meson install -C "$work/build/$name" --no-rebuild >&2
}

build_meson aml
build_meson neatvnc -Dgbm=disabled

log "patch xwayland xkbcomp resolution"
patch -d "$work/src/xwayland" -p1 <"$here/xwayland-xkbcomp-path.patch" >&2

build_meson xwayland \
  -Dxvfb=false -Dxdmcp=false -Dxcsecurity=true -Ddri3=false -Dglamor=false -Dglx=false \
  -Dsha1=libmd -Dxkb_dir=/usr/share/X11/xkb -Dxkb_output_dir=/var/lib/xkb \
  -Dxkb_bin_dir=/usr/bin

# Headless/Wayland backends, pixman and the SHM allocator are always built;
# empty lists disable the optional GPU and physical-device implementations.
build_meson wlroots \
  -Dexamples=false -Dxwayland=enabled -Dbackends=[] \
  -Drenderers=[] -Dallocators=[] -Dsession=disabled \
  -Dcolor-management=disabled -Dlibliftoff=disabled -Dxcb-errors=disabled

build_meson sway -Dsd-bus-provider=basu -Ddefault-wallpaper=false \
  -Dzsh-completions=false -Dbash-completions=false -Dfish-completions=false \
  -Dman-pages=disabled -Dtray=disabled -Dgdk-pixbuf=disabled

build_meson wayvnc -Dman-pages=disabled -Dscreencopy-dmabuf=disabled
build_meson grim -Dman-pages=disabled
build_meson wlr-randr

log "build dbus"
mkdir -p "$work/build/dbus"
(
  cd "$work/build/dbus"
  "$work/src/dbus/configure" \
    --prefix=/usr --libdir=/usr/lib --localstatedir=/var --sysconfdir=/etc \
    --disable-asserts --without-x --disable-systemd --disable-launchd \
    --disable-selinux --disable-libaudit --disable-apparmor \
    --disable-doxygen-docs --disable-xml-docs >&2
  make -j "$jobs" >&2
  make install >&2
)

# ---------------------------------------------------------------------------
# 3. Native helpers from this repository
# ---------------------------------------------------------------------------
log "build native helpers"
native=$work/native
mkdir -p "$native"
build_helper() {
  helper=$1
  out=$2
  shift 2
  src=$repo/apps/daemon/native/$helper
  flags=""
  for xml in "$@"; do
    base=${xml%.xml}
    wayland-scanner client-header "$src/$xml" "$native/$base-client-protocol.h"
    wayland-scanner private-code "$src/$xml" "$native/$base-protocol.c"
    flags="$flags $native/$base-protocol.c"
  done
  # shellcheck disable=SC2086
  cc -std=c11 -O2 -Wall -Wextra -Werror -I"$native" "$src/main.c" $flags \
    $(pkg-config --cflags --libs wayland-client xkbcommon) -lm -o "$root/libexec/$out"
}

build_helper pointer-helper omarchy-bot-wayland-input \
  wlr-virtual-pointer-unstable-v1.xml virtual-keyboard-unstable-v1.xml
build_helper capture-helper omarchy-bot-wayland-capture \
  wlr-screencopy-unstable-v1.xml

xdg=$(pkg-config --variable=pkgdatadir wayland-protocols)/stable/xdg-shell/xdg-shell.xml
wayland-scanner client-header "$xdg" "$native/xdg-shell-client-protocol.h"
wayland-scanner private-code "$xdg" "$native/xdg-shell-protocol.c"
cc -std=c11 -O2 -Wall -Wextra -Werror -I"$native" \
  "$repo/apps/daemon/native/bot-desktop/main.c" "$native/xdg-shell-protocol.c" \
  $(pkg-config --cflags --libs wayland-client) -o "$root/libexec/omarchy-bot-desktop"

# ---------------------------------------------------------------------------
# 4. Runtime binaries, libraries and data
# ---------------------------------------------------------------------------
log "collect binaries"
for name in sway swaymsg wayvnc grim wlr-randr Xwayland dbus-daemon dbus-send xkbcomp; do
  [ -x "/usr/bin/$name" ] || die "$name was not installed by the source build"
  install -m 0755 "/usr/bin/$name" "$root/libexec/$name"
done

log "record runtime package versions"
# The Dockerfile installs these; verify rather than fetch again so the build
# stays offline-reproducible once the image exists.
for pkg in $APK_PACKAGES; do
  apk info -e "$pkg" >/dev/null 2>&1 || die "runtime package $pkg is missing from the build image"
done
# shellcheck disable=SC2086
apk list --installed $APK_PACKAGES 2>/dev/null | cut -d' ' -f1 | sort >"$work/apk-packages.txt"
[ -s "$work/apk-packages.txt" ] || die "runtime package versions could not be recorded"
# Full installed set (toolchain included) so a rebuilt image is provably the
# same environment.
apk list --installed 2>/dev/null | cut -d' ' -f1 | sort >"$out_dir/packages.lock"

log "collect library closure"
cp -L /lib/ld-musl-x86_64.so.1 "$root/lib/ld-musl-x86_64.so.1"

needed() {
  readelf -d "$1" 2>/dev/null | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p'
}

collect() {
  for elf in "$root"/libexec/* "$root"/lib/*.so*; do
    [ -f "$elf" ] || continue
    needed "$elf"
  done | sort -u
}

# Iterate until no new libraries appear: the closure of the closure is the
# closure. A missing library is fatal, not skipped.
pass=0
while :; do
  pass=$((pass + 1))
  collect >"$work/needed.txt"
  added=0
  while read -r lib; do
    [ -n "$lib" ] || continue
    [ -e "$root/lib/$lib" ] && continue
    path=$(find /usr/lib /lib -maxdepth 2 -name "$lib" 2>/dev/null | head -n 1)
    [ -n "$path" ] || die "missing library $lib"
    cp -L "$path" "$root/lib/$lib"
    added=$((added + 1))
  done <"$work/needed.txt"
  [ "$added" -eq 0 ] && break
  [ "$pass" -lt 10 ] || die "library closure did not converge"
done
log "library closure resolved in $pass pass(es)"

log "collect runtime data"
mkdir -p "$root/share/X11" "$root/share/dbus-1"
cp -a /usr/share/X11/xkb "$root/share/X11/xkb"

# A private session config: no host includes, no service activation, and no
# host executables referenced. Bot Computer applications talk to the private
# bus directly.
cat >"$root/share/dbus-1/session.conf" <<'EOF'
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=/tmp</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
EOF
chmod 0644 "$root/share/dbus-1/session.conf"

log "collect licenses"
cp -a /usr/share/licenses/. "$root/licenses/" 2>/dev/null || true
for pkg in sway wlroots wayvnc neatvnc aml grim wlr-randr xwayland dbus; do
  for f in LICENSE LICENSE.md COPYING COPYING.md; do
    if [ -f "$work/src/$pkg/$f" ]; then
      install -m 0644 "$work/src/$pkg/$f" "$root/licenses/$pkg-$f"
      break
    fi
  done
done

# ---------------------------------------------------------------------------
# 5. Relocatable launchers
# ---------------------------------------------------------------------------
log "write launchers"
for name in sway swaymsg wayvnc wlr-randr grim dbus-send xkbcomp \
            omarchy-bot-wayland-input omarchy-bot-wayland-capture omarchy-bot-desktop; do
  cat >"$root/bin/$name" <<EOF
#!/bin/sh
# Relocates from its own path; the bundled loader keeps this library path out
# of host applications.
root=\$(CDPATH= cd -- "\$(dirname -- "\$0")/.." && pwd)
exec "\$root/lib/ld-musl-x86_64.so.1" --library-path "\$root/lib" "\$root/libexec/$name" "\$@"
EOF
  chmod 0755 "$root/bin/$name"
done

# Xwayland resolves XKB rules from the bundle and runs xkbcomp by name, so the
# launcher puts the bundled xkbcomp first on PATH (child processes inherit it,
# and xkbcomp itself is a bundle launcher).
cat >"$root/bin/Xwayland" <<'EOF'
#!/bin/sh
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# The patched Xwayland resolves xkbcomp through XKB_BIN_DIRECTORY (falling back
# to PATH); both point into the bundle so the host's xkbcomp never runs.
XKB_BIN_DIRECTORY=$root/bin
PATH=$root/bin:$PATH
export XKB_BIN_DIRECTORY PATH
exec "$root/lib/ld-musl-x86_64.so.1" --library-path "$root/lib" \
  "$root/libexec/Xwayland" -xkbdir "$root/share/X11/xkb" "$@"
EOF
chmod 0755 "$root/bin/Xwayland"

# dbus-daemon would otherwise read the host's session.conf. `--session` and
# `--config-file` are mutually exclusive, so --session is replaced.
cat >"$root/bin/dbus-daemon" <<'EOF'
#!/bin/sh
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# Drop --session (mutually exclusive with --config-file) while keeping the rest.
n=$#
i=0
has_config=0
while [ "$i" -lt "$n" ]; do
  arg=$1
  shift
  i=$((i + 1))
  case $arg in
    --config-file|--config-file=*) has_config=1 ;;
  esac
  [ "$arg" = "--session" ] && continue
  set -- "$@" "$arg"
done
if [ "$has_config" -eq 0 ]; then
  set -- --config-file="$root/share/dbus-1/session.conf" "$@"
fi
exec "$root/lib/ld-musl-x86_64.so.1" --library-path "$root/lib" \
  "$root/libexec/dbus-daemon" "$@"
EOF
chmod 0755 "$root/bin/dbus-daemon"

# ---------------------------------------------------------------------------
# 6. Manifest, reproducible archive, sidecar
# ---------------------------------------------------------------------------
log "write manifest"
{
  printf '{\n  "release": "%s",\n  "arch": "x86_64",\n  "libc": "musl",\n' "$SWAY_RUNTIME_RELEASE"
  printf '  "baseImage": "alpine:3.21.3@sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c",\n'
  printf '  "sources": [\n'
  first=1
  printf '%s\n' "$SOURCES" | while IFS='|' read -r name version url sha; do
    [ -n "$name" ] || continue
    [ "$first" = 1 ] || printf ',\n'
    first=0
    printf '    { "name": "%s", "version": "%s", "url": "%s", "sha256": "%s" }' "$name" "$version" "$url" "$sha"
  done
  printf '\n  ],\n  "packages": [\n'
  sed -e 's/^/    "/' -e 's/$/",/' "$work/apk-packages.txt" | sed -e '$ s/,$//'
  printf '  ]\n}\n'
} >"$root/manifest.json"

asset=omarchy-bot-sway-runtime-$SWAY_RUNTIME_RELEASE-x86_64.tar.gz
log "archive $asset"
# Fixed timestamps and ownership, sorted entries, gzip without name/timestamp:
# two builds of the same inputs must produce the same SHA-256.
find "$root" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$SOURCE_DATE_EPOCH" \
    --format=gnu -C "$root" -cf - . | gzip -n -9 >"$out_dir/$asset"
(cd "$out_dir" && sha256sum -- "$asset" >"$asset.sha256")
printf '%s\n' "$out_dir/$asset"
