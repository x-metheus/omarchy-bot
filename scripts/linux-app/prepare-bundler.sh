#!/usr/bin/env bash
set -euo pipefail
cache=$HOME/.cache/tauri
mkdir -p "$cache"
while read -r digest name; do
  target=$cache/$name
  if [[ ! -f $target ]]; then
    case $name in
      AppRun-x86_64) url=https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-x86_64 ;;
      linuxdeploy-07333c6-x86_64.AppImage) url=https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy-07333c6/linuxdeploy-x86_64.AppImage ;;
      linuxdeploy-plugin-appimage.AppImage) url=https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-x86_64.AppImage ;;
      linuxdeploy-plugin-*.sh) url=https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v2.12.4/crates/tauri-bundler/src/bundle/linux/appimage/$name ;;
      *) echo "Unknown pinned bundler tool: $name" >&2; exit 1 ;;
    esac
    curl --fail --location --proto '=https' --output "$target.partial" "$url"
    if [[ $name == linuxdeploy-07333c6-x86_64.AppImage ]]; then
      # Tauri clears AppImage integration magic before invoking linuxdeploy.
      dd if=/dev/zero of="$target.partial" bs=1 count=3 seek=8 conv=notrunc status=none
    fi
    printf '%s  %s\n' "$digest" "$target.partial" | sha256sum --check -
    mv "$target.partial" "$target"
    chmod 755 "$target"
  fi
done < /src/scripts/linux-app/bundler.sha256
(cd "$cache" && sha256sum --check /src/scripts/linux-app/bundler.sha256)
