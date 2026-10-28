#!/usr/bin/env bash
set -euo pipefail
bash /src/scripts/linux-app/prepare-bundler.sh
if [[ ! -d node_modules ]]; then bun install --frozen-lockfile; fi
bun run --filter=@omarchy-bot/web build
cd apps/omarchy-bot
[[ -f src-tauri/Cargo.lock ]] || cargo generate-lockfile --manifest-path src-tauri/Cargo.toml
cargo tauri build --bundles appimage -- --locked
artifact=/src/.lane/linux-app/target/release/bundle/appimage/omarchy-bot_0.1.0_amd64.AppImage
[[ -f $artifact ]] || { echo "Missing expected AppImage: $artifact" >&2; exit 1; }
cp "$artifact" /src/.lane/dist/omarchy-bot_0.1.0_amd64.AppImage.partial
mv /src/.lane/dist/omarchy-bot_0.1.0_amd64.AppImage.partial /src/.lane/dist/omarchy-bot_0.1.0_amd64.AppImage
(cd /src/.lane/dist && sha256sum omarchy-bot_0.1.0_amd64.AppImage > omarchy-bot_0.1.0_amd64.AppImage.sha256)
