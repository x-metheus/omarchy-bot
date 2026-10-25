#!/usr/bin/env bash
# Launcher-neutral Service entry: systemd units, container entrypoints and the
# Omarchy plugin call only this script. It starts an installed runtime; it never
# installs or downloads anything and never inspects the distribution.
set -euo pipefail

preload=
while (($# > 0)); do
  case $1 in
    --preload)
      preload=${2:?--preload requires a file}
      shift 2
      ;;
    *)
      printf 'Omarchy Bot serve: unknown argument %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

runtime_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
main=$runtime_root/apps/daemon/src/bootstrap/main.ts

kernel=$(uname -s)
machine=$(uname -m)
if [[ $kernel != Linux || $machine != x86_64 ]]; then
  printf 'Omarchy Bot supports Linux on x86_64 only (found %s %s)\n' "$kernel" "$machine" >&2
  exit 1
fi

bun_bin=${OMARCHY_BOT_BUN:-$(command -v bun || true)}
bun_version=$([[ -n $bun_bin ]] && "$bun_bin" --version 2>/dev/null || true)
if [[ ! $bun_version =~ ^([0-9]+)\.([0-9]+) ]] \
  || (( BASH_REMATCH[1] < 1 )) \
  || (( BASH_REMATCH[1] == 1 && BASH_REMATCH[2] < 4 )); then
  printf 'Omarchy Bot requires Bun 1.4 or newer in PATH (found %s)\n' "${bun_version:-unknown}" >&2
  exit 1
fi

if [[ ! -f $main ]]; then
  printf 'Omarchy Bot runtime is incomplete: missing %s\n' "$main" >&2
  exit 1
fi

# A directory only we can use. Create first (best effort), then open that
# path with O_NOFOLLOW and fchmod the fd. Checks that re-walk the name can be
# swapped under sticky /tmp; the fd cannot.
private_dir() {
  local dir=$1
  if [[ ! -d $dir || -L $dir ]]; then
    (umask 077 && mkdir -p -- "$dir" 2>/dev/null) || true
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
' -- "$dir"; then
    printf 'Omarchy Bot requires an owned, non-symlink directory: %s\n' "$dir" >&2
    exit 1
  fi
}

# One Service per OS user. The path depends only on the uid and never on what
# the host provides, so a Service started before /run/user exists cannot end up
# locked under a different path than one started after it appears. flock (not a
# pid file) releases it when the Service dies, including a killed one.
uid=$(id -u)
if ! command -v flock >/dev/null; then
  printf 'Omarchy Bot requires flock (util-linux)\n' >&2
  exit 1
fi
# /tmp is sticky, so an entry with our uid cannot be replaced by another user;
# private_dir still verifies ownership and enforces 0700.
lock_root=/tmp/omarchy-bot-$uid
private_dir "$lock_root"

# The same private root serves as the runtime fallback. The daemon appends
# omarchy-bot/screens/<id>/<generation>/… sockets, and a unix socket path cannot
# exceed 107 bytes. "ob" keeps the longest real path (the 37-byte surface id plus
# wayvnc.sock) at 102 bytes even for a 10-digit uid; the descriptive lock name
# above is too long for this, so only the fallback root is shortened.
if [[ -z ${XDG_RUNTIME_DIR:-} ]]; then
  XDG_RUNTIME_DIR=/tmp/ob-$uid
  private_dir "$XDG_RUNTIME_DIR"
  export XDG_RUNTIME_DIR
fi

lock_file=$lock_root/service.lock
# The directory is 0700 before this, so nobody else can replace the name. A
# symlink planted while it was still writable must not be followed.
if [[ -L $lock_file ]]; then
  printf 'Omarchy Bot refuses to follow a symlinked lock: %s\n' "$lock_file" >&2
  exit 1
fi
# Descriptor 9 is the launcher convention: launch.sh holds the same lock file
# there so runtime preparation and the Service never overlap. Adopting it keeps
# preparation, the Service and its cleanup one critical section; a plain re-open
# would deadlock because the inherited open file description still holds it.
if { true >&9; } 2>/dev/null && [[ /proc/$$/fd/9 -ef $lock_file ]] && flock -n 9; then
  lock_fd=9
else
  exec {lock_fd}>>"$lock_file"
  if ! flock -n "$lock_fd"; then
    running_pid=
    # The winner records its pid just after locking; give it a moment to land and
    # ignore a leftover pid from a run that is gone.
    for _ in {1..50}; do
      candidate=
      read -r candidate <"$lock_file" 2>/dev/null || true
      if [[ -n $candidate ]] && kill -0 "$candidate" 2>/dev/null; then
        running_pid=$candidate
        break
      fi
      sleep 0.01
    done
    printf 'Omarchy Bot Service already running for this user%s (lock %s)\n' \
      "${running_pid:+ (pid $running_pid)}" "$lock_file" >&2
    exit 1
  fi
fi
# exec below keeps this pid and this descriptor, so the Service itself holds the
# lock until its cleanup finishes. Truncate first: a previous run left its pid
# behind and readers must not mistake it for the live one.
: >"$lock_file"
printf '%s\n' "$$" >"$lock_file"

cd -- "$runtime_root"
args=()
if [[ -n $preload ]]; then
  args+=(--preload "$preload")
fi
exec "$bun_bin" "${args[@]}" "$main"
