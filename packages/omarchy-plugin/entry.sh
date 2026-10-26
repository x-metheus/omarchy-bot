#!/usr/bin/env bash
set -euo pipefail

entry_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
plugin_root=${OMARCHY_BOT_PLUGIN_ROOT:-$entry_dir/../..}
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
if [[ $distribution_id != omarchy || $(uname -m) != x86_64 ]]; then
  printf 'Omarchy Bot supports Omarchy on x86_64 only\n' >&2
  exit 1
fi

omarchy_home=${OMARCHY_BOT_HOME:-${HOME:?Omarchy Bot requires HOME}/.local/share/omarchy-bot}
# Keep the lock outside runtime: uninstall deletes runtime while waiters still hold this inode.
plugin_state=${OMARCHY_BOT_STATE:-${HOME}/.local/state/omarchy-bot}
mkdir -p "$plugin_state"
exec {plugin_lock_fd}>>"$plugin_state/plugin.lock"
generation_file=$plugin_state/plugin-generation
cli=$omarchy_home/runtime/current/apps/cli/src/main.ts
case ${1:-} in
  enable)
    flock "$plugin_lock_fd"
    printf '%s\n' "$$.$RANDOM" > "$generation_file.tmp"
    mv -- "$generation_file.tmp" "$generation_file"
    mkdir -p "$omarchy_home/runtime"
    cp -- "$0" "$omarchy_home/runtime/plugin-entry.sh.tmp"
    mv -- "$omarchy_home/runtime/plugin-entry.sh.tmp" "$omarchy_home/runtime/plugin-entry.sh"
    ;;
  settle)
    generation=$(cat "$generation_file" 2>/dev/null || true)
    flock "$plugin_lock_fd"
    [[ $generation == "$(cat "$generation_file" 2>/dev/null || true)" && -f $cli ]] || exit 0
    ;;
  disable) flock "$plugin_lock_fd" ;;
esac
curl_bin=${OMARCHY_BOT_PLUGIN_CURL:-$(command -v curl || true)}
download() {
  if [[ $1 != https://* ]]; then
    printf 'Omarchy Bot download must use HTTPS\n' >&2
    exit 1
  fi
  "$curl_bin" -fsSL --proto '=https' --tlsv1.2 --max-time 300 -o "$2" "$1"
}
bun_bin=${OMARCHY_BOT_PLUGIN_BUN:-$(command -v bun || true)}
if [[ -z $bun_bin ]] && command -v mise >/dev/null; then
  bun_bin=$(mise which bun 2>/dev/null || true)
fi
if [[ -z $bun_bin ]]; then
  pinned=$omarchy_home/runtime/bun/1.4.2/bin/bun
  if [[ ! -x $pinned ]]; then
    mkdir -p "$omarchy_home/runtime"
    exec {bun_lock_fd}>>"$omarchy_home/runtime/bun.lock"
    flock "$bun_lock_fd"
    if [[ ! -x $pinned ]]; then
      work=$(mktemp -d "$omarchy_home/runtime/.bun-XXXXXX")
      trap 'rm -rf -- "$work"' EXIT
      download "${OMARCHY_BOT_PLUGIN_BUN_URL:-https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip}" "$work/bun.zip"
      expected=${OMARCHY_BOT_PLUGIN_BUN_SHA256:-36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913}
      printf '%s  %s\n' "$expected" "$work/bun.zip" | sha256sum --check --status
      unzip -q "$work/bun.zip" -d "$work"
      mkdir -p "$(dirname -- "$pinned")"
      chmod 700 "$work/bun-linux-x64/bun"
      mv "$work/bun-linux-x64/bun" "$pinned"
      rm -rf -- "$work"
      trap - EXIT
    fi
    flock -u "$bun_lock_fd"
  fi
  bun_bin=$pinned
fi
export PATH="$(dirname -- "$bun_bin"):$PATH"
plugin_status() {
  "$bun_bin" -e '
try {
  const config=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));
  console.log(config.version===1 && Array.isArray(config.plugins)
    ? (config.plugins.some(entry=>entry?.id===process.argv[2]) ? "enabled" : "disabled") : "unknown");
} catch { console.log("unknown"); }
' "$config" "$plugin_id"
}

case ${1:-} in
  enable)
    archive=missing
    checksum=missing
    if [[ ! -f $omarchy_home/runtime/current/scripts/serve.sh ]]; then
      revision=${OMARCHY_BOT_PLUGIN_REVISION:-$(git -C "$plugin_root" rev-parse HEAD)}
      asset=omarchy-bot-runtime-${revision}-x86_64.tar.zst
      repo=${OMARCHY_BOT_PLUGIN_RUNTIME_REPO:-XMethues/omarchy-bot}
      base=${OMARCHY_BOT_PLUGIN_RUNTIME_BASE:-https://github.com/${repo}/releases/download/runtime-${revision}}
      url=${OMARCHY_BOT_PLUGIN_RUNTIME_URL:-$base/$asset}
      work=$(mktemp -d)
      trap 'rm -rf -- "$work"' EXIT
      archive=$work/$asset
      checksum=$work/sha256
      if [[ -n ${OMARCHY_BOT_PLUGIN_RUNTIME_SHA256:-} ]]; then
        printf '%s\n' "$OMARCHY_BOT_PLUGIN_RUNTIME_SHA256" > "$checksum"
      else
        download "${url}.sha256" "$checksum"
      fi
      download "$url" "$archive"
      mkdir "$work/installer"
      "$bun_bin" -e '
const {createHash}=require("node:crypto"),{readFileSync}=require("node:fs");
const [archive,checksum,destination]=process.argv.slice(1);
const expected=/^([a-f\d]{64})(?:[ \t]+\*?[^\r\n]+)?$/i.exec(readFileSync(checksum,"utf8").trim())?.[1]?.toLowerCase();
const bytes=readFileSync(archive);
if(createHash("sha256").update(bytes).digest("hex")!==expected)throw new Error("runtime archive checksum mismatch");
await new Bun.Archive(Bun.zstdDecompressSync(bytes)).extract(destination);
' "$archive" "$checksum" "$work/installer"
      cli=$work/installer/apps/cli/src/main.ts
    fi
    "$bun_bin" "$cli" install --archive "$archive" --checksum "$checksum"
    ;;
  disable) exec "$bun_bin" "$cli" stop ;;
  settle)
    source_dir=${2:?Plugin source directory is required}
    config=${3:?Omarchy shell config path is required}
    plugin_id=${4:?Plugin id is required}
    stopped=false
    flock -u "$plugin_lock_fd"
    # Destruction precedes persistence; wait for disable, re-enable, or source removal.
    while true; do
      [[ $generation == "$(cat "$generation_file" 2>/dev/null || true)" ]] || exit 0
      status=$(plugin_status)
      if [[ ! -d $source_dir || ( $status == disabled && $stopped == false ) ]]; then
        flock "$plugin_lock_fd"
        [[ $generation == "$(cat "$generation_file" 2>/dev/null || true)" && -f $cli ]] || exit 0
        status=$(plugin_status)
        if [[ ! -d $source_dir ]]; then
          [[ $status != enabled ]] || exit 0
          exec "$bun_bin" "$cli" uninstall
        elif [[ $status == disabled && $stopped == false ]]; then
          "$bun_bin" "$cli" stop
          stopped=true
        fi
        flock -u "$plugin_lock_fd"
      fi
      [[ $stopped == false || $status != enabled ]] || exit 0
      sleep 2
    done
    ;;
  *) printf 'Usage: entry.sh enable|disable|settle <source-dir> <shell-config> <plugin-id>\n' >&2; exit 2 ;;
esac
