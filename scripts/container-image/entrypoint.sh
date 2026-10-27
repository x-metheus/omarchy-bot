#!/usr/bin/env bash
set -euo pipefail
umask 077

image_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$HOME" "$OMARCHY_BOT_HOME/runtime" "$OMARCHY_BOT_STATE" \
  "$OMARCHY_BOT_HOME/screens/computer/assets"
ln -sfnT "$image_root/runtime" "$OMARCHY_BOT_HOME/runtime/current"
export OMARCHY_BOT_BROWSER_PACK_DIR=${OMARCHY_BOT_BROWSER_PACK_DIR:-$image_root/browser}
# Chromium's singleton links name the previous container hostname and temporary sockets.
rm -f -- "$OMARCHY_BOT_HOME/screens/computer/config/chromium/Singleton"{Lock,Cookie,Socket}
exec bash "$image_root/runtime/scripts/serve.sh" "$@"
