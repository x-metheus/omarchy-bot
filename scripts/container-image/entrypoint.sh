#!/usr/bin/env bash
set -euo pipefail
umask 077

image_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$HOME" "$OMARCHY_BOT_HOME/runtime" "$OMARCHY_BOT_STATE" \
  "$OMARCHY_BOT_HOME/screens/computer/assets"
ln -sfnT "$image_root/runtime" "$OMARCHY_BOT_HOME/runtime/current"
ln -sfnT "$image_root/browser-profile/assets/browser-bundle" \
  "$OMARCHY_BOT_HOME/screens/computer/assets/browser-bundle"
# Chromium's singleton links name the previous container hostname and temporary sockets.
rm -f -- "$OMARCHY_BOT_HOME/screens/computer/config/chromium/Singleton"{Lock,Cookie,Socket}
if [[ -n ${OMARCHY_BOT_TLS_CERT:-} ]]; then
  bun run - "$image_root/runtime" <<'PAIR' &
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const runtime = process.argv[2];
const { layoutFromEnv, serviceFetch } = await import(pathToFileURL(`${runtime}/apps/cli/src/layout.ts`).href);
const { run } = await import(pathToFileURL(`${runtime}/apps/cli/src/main.ts`).href);
const layout = layoutFromEnv();
const deadline = Date.now() + 30_000;
let healthy = false;
while (Date.now() < deadline) {
  try {
    const response = await serviceFetch(layout, "/api/health");
    if (response.ok && (await response.json()).ok === true) { healthy = true; break; }
  } catch {}
  await Bun.sleep(100);
}
try {
  if (!healthy) throw new Error();
  const secret = readFileSync(layout.hostSecretPath, "utf8").trim();
  const response = await serviceFetch(layout, "/api/devices/paired", { headers: { authorization: `Bearer ${secret}` } });
  if (!response.ok) throw new Error();
  const { devices } = await response.json();
  if (!devices.some(device => !device.revokedAt) && await run(["pair"]) !== 0) throw new Error();
} catch { console.error("Could not issue initial pairing URL; run the Service CLI pair command in the container."); }
PAIR
fi
exec bash "$image_root/runtime/scripts/serve.sh" "$@"
