#!/usr/bin/env bash
# Build and verify the self-contained Sway runtime bundle.
#
#   scripts/build-sway-runtime.sh [out-dir]
#
# Everything compiles inside the pinned Alpine build image; the host needs only
# Docker. Output: <out-dir>/omarchy-bot-sway-runtime-<release>-x86_64.tar.gz,
# its .sha256 sidecar, and the checksum-prepared development directory <out-dir>/sway.
# The default out-dir is .lane/dist.
set -euo pipefail

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
out_dir=${1:-$root/.lane/dist}
image=omarchy-bot-sway-runtime-build
base=alpine:3.21.3@sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c

mkdir -p "$out_dir"
out_dir=$(CDPATH= cd -- "$out_dir" && pwd)

echo "Building $image from scripts/sway-runtime/Dockerfile" >&2
DOCKER_BUILDKIT=1 docker build -f "$root/scripts/sway-runtime/Dockerfile" -t "$image" "$root/scripts/sway-runtime" >&2

echo "Compiling the bundle" >&2
mkdir -p "$root/.lane/source-cache"
docker run --rm --name "linux04-bundle-build-$$" \
  -v "$root:/src:ro" \
  -v "$out_dir:/out" \
  -v "$root/.lane/source-cache:/cache" \
  -e SRC_CACHE=/cache \
  -e BUILD_JOBS="${BUILD_JOBS:-4}" \
  "$image" /src/scripts/sway-runtime/build.sh

# The archive name follows the pinned release in sources.lock, not the newest
# file in the output directory.
release=$(. "$root/scripts/sway-runtime/sources.lock" && printf '%s' "$SWAY_RUNTIME_RELEASE")
archive=$out_dir/omarchy-bot-sway-runtime-$release-x86_64.tar.gz
[ -f "$archive" ] || { echo "expected archive $archive was not produced" >&2; exit 1; }
[ -f "$archive.sha256" ] || { echo "missing checksum sidecar for $archive" >&2; exit 1; }

echo "Verifying $(basename "$archive") in a clean container" >&2
docker run --rm -v "$out_dir:/out:ro" -v "$root/scripts/sway-runtime:/scripts:ro" "$base" \
  sh /scripts/selfcheck.sh "/out/$(basename "$archive")"

bash "$root/scripts/sway-runtime/prepare.sh" "$archive"

echo "Artifact: $archive"
cat "$archive.sha256"
