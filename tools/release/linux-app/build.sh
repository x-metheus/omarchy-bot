#!/usr/bin/env bash
set -euo pipefail
bash /src/tools/release/linux-app/prepare-bundler.sh
bun install --cwd tools/release --frozen-lockfile
bun install --cwd apps/metheus --frozen-lockfile
bun tools/release/build-agent-daemon.ts
config=$(bun tools/release/linux-app/build-config.ts)
version=$(bun -e 'console.log(JSON.parse(process.argv[1]).version)' "$config")
cd apps/metheus
product_name=$(bun -e 'console.log((await Bun.file("src-tauri/tauri.conf.json").json()).productName)')
bun run tauri build --config "$config" --bundles appimage -- --locked
name=metheus_${version}_amd64.AppImage
artifact="$CARGO_TARGET_DIR/release/bundle/appimage/${product_name}_${version}_amd64.AppImage"
[[ -f $artifact ]] || { echo "Missing expected AppImage: $artifact" >&2; exit 1; }
if [[ -n ${TAURI_SIGNING_PRIVATE_KEY:-} ]]; then
  [[ -s $artifact.sig ]] || { echo "Missing updater signature: $artifact.sig" >&2; exit 1; }
  bun /src/tools/release/linux-app/check-signature.ts "$artifact.sig" "$version"
  cp "$artifact.sig" "/src/.lane/dist/$name.sig"
else
  rm -f "/src/.lane/dist/$name.sig"
fi
cp "$artifact" "/src/.lane/dist/$name.partial"
mv "/src/.lane/dist/$name.partial" "/src/.lane/dist/$name"
(cd /src/.lane/dist && sha256sum "$name" > "$name.sha256")
