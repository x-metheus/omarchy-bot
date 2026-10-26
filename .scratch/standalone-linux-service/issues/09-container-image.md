# 09: Container image

**What to build:** A single `docker run` with one state volume gives a working, pairing-required Service on a cloud VM with no desktop, including Bot Screens.

**Blocked by:** 02, 04, 05, 06

**Status:** resolved

Spec: [standalone Linux Service](../spec.md)

- [x] The image runs `serve` as an unprivileged user and stores all state on one volume.
- [x] The health route works for container health checks.
- [x] Logs go to stdout.
- [x] A paired client can create a Bot, run a Turn, open a Bot Screen, and `open_url` inside the container.
- [x] Restarting the container with the same volume preserves Bots, Threads, Paired Devices, and the Bot Computer profile.

## Answer

Added an archive-based container image and build helper, with checksum-pinned build inputs and a browser installed at build time. The existing `serve` entry runs as UID/GID 1000 with one state volume, mandatory pairing, stdout/stderr logs, and a Docker health check. SIGINT selects full Service shutdown; the shared Bot Computer closes application windows through its private Sway socket and allows a bounded profile-flush grace period before existing hard cleanup. Startup removes only Chromium's three stale singleton entries. README documents build/run, pairing, remote access, one active container per volume, sandbox requirements, and real Pi readiness provisioning.

## Comments

### Accepted build and runtime evidence — 2026-10-26

- Fresh current-source runtime packaged with `OMARCHY_BOT_PLUGIN_REVISION=linux09-acceptance bash scripts/package-plugin-runtime.sh`, using the pinned local Sway bundle and fonts, freshly built Web/native helpers, and frozen production dependencies. Archive: `.lane/runtime-acceptance/omarchy-bot-runtime-linux09-acceptance-x86_64.tar.zst`; SHA-256: `10048f30acdc0b92f6cd52a7d0d2e5015526d9ed3a89d1391c92f2d782a2ecdd`.
- `bash scripts/build-container-image.sh .lane/runtime-acceptance/omarchy-bot-runtime-linux09-acceptance-x86_64.tar.zst omarchy-bot:linux09 "$PWD/.lane/container-assets"` succeeded. Docker build used cached pinned inputs with no build network. Build-time browser execution reported `Google Chrome for Testing 156.0.8078.47`.
- Accepted image `omarchy-bot:linux09`: Docker image ID/manifest-list digest `sha256:40306cbe333a7268432278f01ee4b4cdc461a86138cd60d9ea426ddf78193e8f`; image config digest `sha256:e8c8f31712842bfd189537c18ffa69545e8c1c92d78cdddbfb5fe7d55534b4b8`; `USER 1000:1000`, `STOPSIGNAL SIGINT`, size `1640362800` bytes.
- `OMARCHY_BOT_CONTAINER_IMAGE=omarchy-bot:linux09 bun test tests/integration/container-image.test.ts`: **1 pass, 0 fail, 36 assertions**, 20.41 seconds. The actual container used `--pull=never --network=none`, no host desktop, one named state volume, and a separately mounted scripted Pi worker. PID 1 ran as UID 1000; unauthenticated Bot access returned 401; pairing exchange succeeded; the paired client created a Bot/Thread, completed Turns, opened a real Sway Bot Screen, and used `open_url` with the baked Chrome executable. Snapshot was a real 1280×720 PNG. Docker HEALTHCHECK became healthy and stdout contained the listening log.
- Container recreation and subsequent restart retained the same Bot, complete Thread messages, Paired Device/token, and persisted home marker. Browser localStorage visits progressed **1 → 2 → 3**, proving application-profile persistence through both lifecycle operations. Normal stop logged `omarchy-bot daemon stopped` and exited zero.
- Additional actual offline TLS smoke bound `127.0.0.2` with a self-signed certificate for `service.example.test`: `TLS_HEALTH healthy HOST127.0.0.2 SELF_SIGNED_DNS_CERT true`; HTTPS listening log observed. Local health is unauthenticated liveness, not certificate identity validation; README states this explicitly. Launcher checks cover configured IPv4, IPv6, bracketed IPv6, and wildcard health URLs.

### Tests and review

- Launcher contract initially failed with missing entrypoint (`ENOENT`), then passed after implementation. Final focused launcher/archive/assets command, `bun test tests/integration/container-launcher.test.ts tests/unit/runtime-archive.test.ts tests/integration/bot-computer-assets.test.ts`: **22 pass, 0 fail, 153 assertions**.
- `bun run typecheck && bun run lint:boundaries` passed after runtime changes and again after the final lifecycle timeout adjustment.
- One complete isolated `bun test` run: **606 pass, 13 skip, 74 fail**, 3513 assertions across 109 files; log `.lane/container-full-suite.log`. This was not a clean full-suite pass. Of the failures, 72 were caused by the verification environment's long `TMPDIR` exceeding Unix-socket path limits or its private cache hiding installed Playwright; one was the known real-model Pi conformance baseline; one was a lifecycle timeout after the intentional application-shutdown grace period.
- Rechecked all nine affected suites with `TMPDIR=/tmp` and `PLAYWRIGHT_BROWSERS_PATH=/home/colin/.cache/ms-playwright`, retaining isolated HOME/XDG state: **116 pass, 4 skip, 1 fail**, 793 assertions; `.lane/container-suite-recheck.log`. The remaining failure was the 5-second lifecycle timeout. Increased that existing test's timeout to 10 seconds to accommodate shutdown grace; final lifecycle + launcher rerun: **40 pass, 0 fail, 411 assertions**, `.lane/container-lifecycle-recheck.log`.
- User-provided baseline: **676 pass, 13 skip, 1 fail**, the real-model Pi conformance test. No claim that the final entire suite was rerun cleanly; affected failures were resolved through the targeted reruns above.
- Final ContainerReview: **no actionable findings**, correctness correct (confidence 0.97), including follow-up review of the timeout adjustment. Final ContainerSecurity: **no remaining concrete security findings**. Preparation now reuses `extractRuntimeArchive`; review confirmed singleton removal unlinks only the three entries and withdrew the TLS liveness-only finding. Reviewers were read-only and did not independently execute acceptance.

### Cleanup and limits

- Acceptance asserted its container and volume were absent after cleanup. TLS smoke reported `TLS_CLEANUP true true`; its container/volume and temporary certificate directory were removed. Isolated suite cleanup reported `ISOLATED_SUITE_REMAINING_PROCESSES []` and `ISOLATED_SUITE_CLEANUP true`. Build image/cache/archive and local evidence logs remain intentionally available. Host OS, graphical session, real user-manager units, and Omarchy configuration were untouched.
- **Not verified:** real provider authentication or real-model Pi conformance inside the image. The production image contains the real worker; the scripted fixture establishes container behavior only. Production use requires provider credentials and an authentic passing conformance record for the exact Pi version, as documented. No push, release, or registry publication performed.
