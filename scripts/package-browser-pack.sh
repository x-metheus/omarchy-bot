#!/usr/bin/env bash
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "${OMARCHY_BOT_BUN:-bun}" "$root/scripts/package-browser-pack.ts" "$@"
