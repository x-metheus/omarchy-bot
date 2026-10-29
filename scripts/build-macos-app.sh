#!/usr/bin/env bash
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
mode=${1:---unsigned}
[[ $# -le 1 && ( $mode == --unsigned || $mode == --signed ) ]] || { echo 'Usage: bash scripts/build-macos-app.sh [--unsigned|--signed]' >&2; exit 1; }
# Empty GitHub secrets must not enable Tauri signing or notarization accidentally.
for variable in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD; do
  [[ -n ${!variable:-} ]] || unset "$variable"
done
if [[ $mode == --signed ]]; then
  for variable in APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
    [[ -n ${!variable:-} ]] || { echo "Signed build requires $variable" >&2; exit 1; }
  done
  [[ $APPLE_SIGNING_IDENTITY == 'Developer ID Application: '* ]] || { echo 'Distribution requires a Developer ID Application identity' >&2; exit 1; }
  if [[ ${CI:-} == true ]]; then
    [[ -n ${APPLE_CERTIFICATE:-} && -n ${APPLE_CERTIFICATE_PASSWORD:-} ]] || { echo 'Signed CI requires APPLE_CERTIFICATE and APPLE_CERTIFICATE_PASSWORD' >&2; exit 1; }
  fi
  if [[ -n ${TAURI_SIGNING_PRIVATE_KEY:-} ]]; then
    [[ -n ${TAURI_SIGNING_PUBLIC_KEY:-} ]] || { echo 'Updater artifacts require TAURI_SIGNING_PUBLIC_KEY' >&2; exit 1; }
  fi
else
  for variable in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD; do
    [[ -z ${!variable:-} ]] || { echo 'Signing credentials require explicit --signed mode' >&2; exit 1; }
  done
  [[ -z ${APPLE_SIGNING_IDENTITY:-} ]] || { echo 'Signing identity requires explicit --signed mode' >&2; exit 1; }
  export APPLE_SIGNING_IDENTITY=-
fi
[[ $(uname -s) == Darwin ]] || { echo 'macOS packaging requires a native Mac runner' >&2; exit 1; }
case $(uname -m) in
  arm64) architecture=aarch64; triple=aarch64-apple-darwin ;;
  x86_64) architecture=x64; triple=x86_64-apple-darwin ;;
  *) echo 'Only arm64 and x64 macOS are supported' >&2; exit 1 ;;
esac
export CARGO_TARGET_DIR="$root/.lane/macos-app/target"
export CARGO_HOME="$root/.lane/macos-app/cargo"
export BUN_INSTALL_CACHE_DIR="$root/.lane/macos-app/bun-cache"
mkdir -p "$root/.lane/dist" "$root/.lane/macos-app/evidence"
[[ -d node_modules ]] || bun install --frozen-lockfile
bun run --filter=@omarchy-bot/web build
bun scripts/build-sidecar.ts
binary="$root/apps/omarchy-bot/src-tauri/binaries/omarchy-bot-sidecar-$triple"
OMARCHY_BOT_TEST_SIDECAR_BINARY="$binary" bun test tests/integration/local-sidecar-process.test.ts
arguments=(--bundles app,dmg --target "$triple")
if [[ -n ${TAURI_SIGNING_PRIVATE_KEY:-} ]]; then
  updater_config=$(bun -e 'console.log(JSON.stringify({bundle:{createUpdaterArtifacts:true},plugins:{updater:{pubkey:process.env.TAURI_SIGNING_PUBLIC_KEY}}}))')
  arguments+=(--config "$updater_config")
fi
(cd apps/omarchy-bot && cargo tauri build "${arguments[@]}" -- --locked)
bundle="$CARGO_TARGET_DIR/$triple/release/bundle"
app="$bundle/macos/omarchy-bot.app"
dmgs=("$bundle"/dmg/*.dmg)
[[ ${#dmgs[@]} -eq 1 && -f ${dmgs[0]} && -d $app ]] || { echo 'Expected one dmg and application bundle' >&2; exit 1; }
version=$(bun -e 'console.log(JSON.parse(await Bun.file("apps/omarchy-bot/src-tauri/tauri.conf.json").text()).version)')
artifact="$root/.lane/dist/omarchy-bot_${version}_${architecture}.dmg"
OMARCHY_BOT_TEST_SIDECAR_BINARY="$app/Contents/MacOS/omarchy-bot-sidecar" bun test tests/integration/local-sidecar-process.test.ts
if [[ $mode == --signed ]]; then
  codesign --verify --deep --strict --verbose=2 "$app"
  codesign --verify --strict --verbose=2 "$app/Contents/MacOS/omarchy-bot-sidecar"
  spctl --assess --type execute --verbose=2 "$app"
  xcrun stapler validate "$app"
  # Tauri notarizes the app; notarize and staple the outer download as well.
  xcrun notarytool submit "${dmgs[0]}" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
  xcrun stapler staple "${dmgs[0]}"
  xcrun stapler validate "${dmgs[0]}"
  spctl --assess --type open --context context:primary-signature --verbose=2 "${dmgs[0]}"
fi
cp "${dmgs[0]}" "$artifact"
(cd "$root/.lane/dist" && shasum -a 256 "$(basename "$artifact")") | tee "$artifact.sha256"
if [[ -n ${TAURI_SIGNING_PRIVATE_KEY:-} ]]; then
  updater="$bundle/macos/omarchy-bot.app.tar.gz"
  [[ -s $updater && -s $updater.sig ]] || { echo 'Missing signed updater archive' >&2; exit 1; }
  cp "$updater" "$root/.lane/dist/omarchy-bot_${version}_${architecture}.app.tar.gz"
  cp "$updater.sig" "$root/.lane/dist/omarchy-bot_${version}_${architecture}.app.tar.gz.sig"
fi
printf 'mode=%s\narchitecture=%s\nversion=%s\nWKWebView=not-run\n' "$mode" "$architecture" "$version" | tee "$root/.lane/macos-app/evidence/build-$architecture.txt"
