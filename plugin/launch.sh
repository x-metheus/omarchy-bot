#!/usr/bin/env bash
set -euo pipefail

state_home=${XDG_STATE_HOME:-${HOME:?Omarchy Bot requires HOME}/.local/state}
mkdir -p "$state_home/omarchy-bot"
exec >>"$state_home/omarchy-bot/plugin-launch.log" 2>&1

launcher_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
plugin_root=${OMARCHY_BOT_PLUGIN_ROOT:-$launcher_dir/..}
os_release=${OMARCHY_BOT_PLUGIN_OS_RELEASE:-/etc/os-release}
if [[ ! -r $os_release ]]; then
  printf 'Omarchy Bot requires a readable Omarchy release file: %s\n' "$os_release" >&2
  exit 1
fi

distribution_id=
while IFS='=' read -r key value; do
  if [[ $key == ID ]]; then
    distribution_id=${value%\"}
    distribution_id=${distribution_id#\"}
    distribution_id=${distribution_id%\'}
    distribution_id=${distribution_id#\'}
    break
  fi
done < "$os_release"
# The plugin package is Omarchy-only; the generic serve entry is not.
if [[ $distribution_id != omarchy || $(uname -m) != x86_64 ]]; then
  printf 'Omarchy Bot supports Omarchy on x86_64 only\n' >&2
  exit 1
fi

data_home=${XDG_DATA_HOME:-${HOME:?Omarchy Bot requires HOME}/.local/share}
omarchy_home=${OMARCHY_BOT_HOME:-$data_home/omarchy-bot}
apps_root="$omarchy_home/app"
mkdir -p "$omarchy_home" "$apps_root"
chmod 700 "$omarchy_home" "$apps_root"

BUN_PIN_VERSION=1.4.2
BUN_PIN_SHA256=${OMARCHY_BOT_PLUGIN_BUN_SHA256:-36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913}
BUN_PIN_URL=${OMARCHY_BOT_PLUGIN_BUN_URL:-https://github.com/oven-sh/bun/releases/download/bun-v${BUN_PIN_VERSION}/bun-linux-x64.zip}
RUNTIME_REPO=${OMARCHY_BOT_PLUGIN_RUNTIME_REPO:-XMethues/omarchy-bot}

curl_bin=${OMARCHY_BOT_PLUGIN_CURL:-$(command -v curl || true)}

require_https() {
  if [[ $1 != https://* ]]; then
    printf 'Omarchy Bot %s must use HTTPS\n' "$2" >&2
    exit 1
  fi
}

sha256_file() {
  sha256sum -- "$1" | awk '{print $1}'
}

download() {
  local url=$1 dest=$2
  if [[ -z $curl_bin ]]; then
    return 1
  fi
  "$curl_bin" -fsSL --proto '=https' --tlsv1.2 --max-time 300 -o "$dest" "$url"
}

download_http_status=
download_with_http_status() {
  local url=$1 dest=$2
  if [[ -z $curl_bin ]]; then
    download_http_status=000
    return 127
  fi
  local http_status status
  if http_status=$("$curl_bin" -fsSL --proto '=https' --tlsv1.2 --max-time 300 --write-out '%{http_code}' -o "$dest" "$url"); then
    download_http_status=$http_status
    return 0
  else
    status=$?
    download_http_status=${http_status:-000}
    return "$status"
  fi
}

download_verified() {
  local url=$1 dest=$2 expected=$3 name=$4
  require_https "$url" "$name"
  if ! download "$url" "$dest"; then
    printf 'Omarchy Bot could not download %s\n' "$name" >&2
    exit 1
  fi
  local actual
  actual=$(sha256_file "$dest")
  if [[ ${actual,,} != "${expected,,}" ]]; then
    rm -f "$dest"
    printf 'Omarchy Bot %s failed SHA-256 verification (expected %s, received %s)\n' "$name" "$expected" "$actual" >&2
    exit 1
  fi
}

extract_zip() {
  if command -v unzip >/dev/null; then
    unzip -o -q "$1" -d "$2"
  else
    python3 - "$1" "$2" <<'PY'
import sys
import zipfile
zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])
PY
  fi
}

resolve_bun() {
  if [[ -n ${OMARCHY_BOT_PLUGIN_BUN:-} ]]; then
    bun_bin=$OMARCHY_BOT_PLUGIN_BUN
    return
  fi
  bun_bin=$(command -v bun || true)
  if [[ -z $bun_bin ]] && command -v mise >/dev/null; then
    bun_bin=$(mise which bun 2>/dev/null || true)
  fi
  local pinned=$omarchy_home/runtime/bun/$BUN_PIN_VERSION/bin/bun
  if [[ -z $bun_bin && -x $pinned ]]; then
    bun_bin=$pinned
  fi
  if [[ -z $bun_bin ]]; then
    if [[ -z $curl_bin ]]; then
      printf 'Omarchy Bot requires Bun 1.4 or newer in PATH\n' >&2
      exit 1
    fi
    local staging=$omarchy_home/runtime/bun/.stage-$BUN_PIN_VERSION-$$
    rm -rf "$staging"
    mkdir -p "$staging"
    download_verified "$BUN_PIN_URL" "$staging/bun.zip" "$BUN_PIN_SHA256" "pinned Bun $BUN_PIN_VERSION"
    extract_zip "$staging/bun.zip" "$staging"
    local extracted=$staging/bun-linux-x64/bun
    if [[ ! -f $extracted ]]; then
      rm -rf "$staging"
      printf 'Omarchy Bot pinned Bun archive did not contain bun-linux-x64/bun\n' >&2
      exit 1
    fi
    chmod 700 "$extracted"
    mkdir -p "$(dirname -- "$pinned")"
    mv "$extracted" "$pinned"
    rm -rf "$staging"
    bun_bin=$pinned
  fi
}

# Serialize pinned-Bun installation. The Service lock is taken after Bun exists
# because claiming the shared /tmp directory needs it.
mkdir -p "$omarchy_home/runtime"
exec {bun_lock_fd}>>"$omarchy_home/runtime/bun.lock"
flock "$bun_lock_fd"
bun_bin=
resolve_bun
bun_version=$("$bun_bin" --version 2>/dev/null || true)
if [[ ! $bun_version =~ ^([0-9]+)\.([0-9]+) ]] \
  || (( BASH_REMATCH[1] < 1 )) \
  || (( BASH_REMATCH[1] == 1 && BASH_REMATCH[2] < 4 )); then
  printf 'Omarchy Bot requires Bun 1.4 or newer (found %s)\n' "${bun_version:-unknown}" >&2
  exit 1
fi
flock -u "$bun_lock_fd"

# Preparation replaces app_root, so it must not run while a Service started from
# it is alive. Same per-user lock as serve.sh. Descriptor 9 carries it through
# the supervisor into serve, which adopts it.
uid=$(id -u)
service_lock_dir=/tmp/omarchy-bot-$uid
if [[ ! -d $service_lock_dir || -L $service_lock_dir ]]; then
  (umask 077 && mkdir -p -- "$service_lock_dir" 2>/dev/null) || true
fi
if ! "$bun_bin" -e '
const fs = require("fs");
let fd;
try {
  fd = fs.openSync(process.argv[1], fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
} catch {
  process.exit(1);
}
if (fs.fstatSync(fd).uid !== process.getuid()) process.exit(1);
fs.fchmodSync(fd, 0o700);
' -- "$service_lock_dir"; then
  printf 'Omarchy Bot requires an owned, non-symlink directory: %s\n' "$service_lock_dir" >&2
  exit 1
fi
if [[ -L $service_lock_dir/service.lock ]]; then
  printf 'Omarchy Bot refuses to follow a symlinked lock: %s\n' "$service_lock_dir/service.lock" >&2
  exit 1
fi
exec 9>>"$service_lock_dir/service.lock"
flock 9

revision=${OMARCHY_BOT_PLUGIN_REVISION:-$(git -C "$plugin_root" rev-parse HEAD)}
app_root="$apps_root/$revision"
ready="$app_root/.omarchy-bot-plugin-ready"

try_runtime() {
  local staging=$1
  local asset=omarchy-bot-runtime-${revision}-x86_64.tar.zst
  local default_base=https://github.com/${RUNTIME_REPO}/releases/download/runtime-${revision}
  local base=${OMARCHY_BOT_PLUGIN_RUNTIME_BASE:-$default_base}
  local url=${OMARCHY_BOT_PLUGIN_RUNTIME_URL:-$base/$asset}
  local expected=${OMARCHY_BOT_PLUGIN_RUNTIME_SHA256:-}
  require_https "$url" "plugin runtime"
  local work=$omarchy_home/runtime/.fetch-$revision-$$
  rm -rf "$work"
  mkdir -p "$work"
  if [[ -z $expected ]]; then
    if ! download_with_http_status "${url}.sha256" "$work/sha256"; then
      local http_status=$download_http_status
      rm -rf "$work"
      if [[ $http_status == 404 ]]; then
        return 1
      fi
      printf 'Omarchy Bot could not download the plugin runtime checksum (HTTP %s)\n' "$http_status" >&2
      exit 1
    fi
    expected=$(awk '{print $1}' "$work/sha256")
    if [[ ! $expected =~ ^[0-9a-fA-F]{64}$ ]]; then
      rm -rf "$work"
      printf 'Omarchy Bot plugin runtime checksum is malformed\n' >&2
      exit 1
    fi
  fi
  if ! download "$url" "$work/$asset"; then
    rm -rf "$work"
    printf 'Omarchy Bot could not download the plugin runtime\n' >&2
    exit 1
  fi
  local actual
  actual=$(sha256_file "$work/$asset")
  if [[ ${actual,,} != "${expected,,}" ]]; then
    rm -rf "$work"
    printf 'Omarchy Bot plugin runtime failed SHA-256 verification (expected %s, received %s)\n' "$expected" "$actual" >&2
    exit 1
  fi
  if ! tar --zstd -xf "$work/$asset" -C "$staging"; then
    rm -rf "$work"
    printf 'Omarchy Bot could not extract the plugin runtime\n' >&2
    exit 1
  fi
  rm -rf "$work"
  if [[ ! -f $staging/package.json || ! -d $staging/apps/web/dist ]]; then
    printf 'Omarchy Bot plugin runtime is missing the web client or package manifest\n' >&2
    exit 1
  fi
  if [[ ! -f $staging/scripts/serve.sh ]]; then
    printf 'Omarchy Bot plugin runtime is missing the serve entry\n' >&2
    exit 1
  fi
  local helper
  for helper in \
    apps/daemon/dist/native-pointer/omarchy-bot-wayland-input \
    apps/daemon/dist/native-capture/omarchy-bot-wayland-capture \
    apps/daemon/dist/native-bot-desktop/omarchy-bot-desktop
  do
    if [[ ! -x $staging/$helper ]]; then
      printf 'Omarchy Bot plugin runtime is missing helper %s\n' "$helper" >&2
      exit 1
    fi
  done
}

source_build() {
  local staging=$1
  git -C "$plugin_root" archive --format=tar "$revision" | tar -xf - -C "$staging"
  cd "$staging"
  "$bun_bin" install --frozen-lockfile
  "$bun_bin" run --filter=@omarchy-bot/web build
  "$bun_bin" apps/daemon/native/pointer-helper/build.ts
  "$bun_bin" apps/daemon/native/capture-helper/build.ts
  "$bun_bin" apps/daemon/native/bot-desktop/build.ts
}

if [[ ! -f $ready || $(<"$ready") != "$revision" || ! -f $app_root/scripts/serve.sh ]]; then
  staging="$apps_root/.stage-$revision-$$"
  rm -rf "$staging" "$app_root"
  mkdir -p "$staging"
  trap 'rm -rf "$staging"' EXIT
  if ! try_runtime "$staging"; then
    source_build "$staging"
  fi
  printf '%s\n' "$revision" > "$staging/.omarchy-bot-plugin-ready"
  mv "$staging" "$app_root"
  trap - EXIT
fi

for candidate in "$apps_root"/.stage-* "$apps_root"/*; do
  if [[ -d $candidate && $candidate != "$app_root" ]]; then
    rm -rf "$candidate"
  fi
done

export PATH="$(dirname -- "$bun_bin"):$PATH"
export OMARCHY_BOT_BUN=$bun_bin
cd "$app_root"
exec "$bun_bin" "$launcher_dir/supervise.ts" "$app_root/scripts/serve.sh"
