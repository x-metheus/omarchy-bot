#!/usr/bin/env bash
set -euo pipefail
bash /src/scripts/linux-app/prepare-bundler.sh
if [[ ! -d node_modules ]]; then bun install --frozen-lockfile; fi
bun run --filter=@omarchy-bot/web build
config=$(bun scripts/linux-app/build-config.ts)
version=$(bun -e 'console.log(JSON.parse(process.argv[1]).version)' "$config")
cd apps/omarchy-bot
[[ -f src-tauri/Cargo.lock ]] || cargo generate-lockfile --manifest-path src-tauri/Cargo.toml
cargo tauri build --config "$config" --bundles appimage -- --locked
name=omarchy-bot_${version}_amd64.AppImage
artifact=/src/.lane/linux-app/target/release/bundle/appimage/$name
[[ -f $artifact ]] || { echo "Missing expected AppImage: $artifact" >&2; exit 1; }
if [[ -n ${TAURI_SIGNING_PRIVATE_KEY:-} ]]; then
  [[ -s $artifact.sig ]] || { echo "Missing updater signature: $artifact.sig" >&2; exit 1; }
  bun /src/scripts/linux-app/check-signature.ts "$artifact.sig" "$version"
  cp "$artifact.sig" "/src/.lane/dist/$name.sig"
else
  rm -f "/src/.lane/dist/$name.sig"
fi
cp "$artifact" "/src/.lane/dist/$name.partial"
mv "/src/.lane/dist/$name.partial" "/src/.lane/dist/$name"
(cd /src/.lane/dist && sha256sum "$name" > "$name.sha256")
