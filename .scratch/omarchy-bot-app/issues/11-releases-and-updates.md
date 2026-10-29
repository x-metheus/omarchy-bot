# 11: Releases and auto-update

**What to build:** App builds are published to GitHub Releases with checksums and a signed Tauri updater manifest, versioned independently of the Service runtime. The app's updater (check, download, restart) is exposed through the shell, and the protocol-mismatch screen's update action uses it.

**Blocked by:** 07 (Omarchy Bot app on Linux)

**Status:** resolved

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [x] A release workflow publishes the AppImage, checksums, and a signed updater manifest
- [x] The updater signing key is held as a release secret, never in the repository
- [x] An installed app detects a newer release, downloads, verifies, and restarts into it
- [x] A tampered artifact is refused
- [x] The mismatch screen's "update Omarchy Bot" action triggers the updater

## Comments

Implemented a native Tauri updater (`check` / `download` / `restart` behind the existing shell) and connected the protocol-mismatch "update Omarchy Bot" action to it, plus `.github/workflows/app-release.yml` triggered by `app-vX.Y.Z` tags. The workflow builds a signed AppImage in a pinned container, then publishes the AppImage, its SHA-256 file, Tauri `.sig`, and `latest.json` to an immutable versioned release, and advances the rolling `app-latest` tag only when the version is genuinely newer. The app updater reads the dedicated stable endpoint `.../releases/download/app-latest/latest.json`, whose manifest points at versioned artifacts; app versions remain independent of Service runtime releases and cannot overwrite versioned assets. The signing private key exists only as an `app-release` environment secret (public key as a variable); the workflow checks tag/version/manifest/checksum consistency before publishing and uploads only public evidence.

Verification in this worktree:
- Native signed updater smoke: 6/6 checks in real WebKit against the packaged app — newer release detected; same/older ignored; tampered bytes refused with installed AppImage hash and keychain pairing unchanged; authentic artifact relabeled to another version refused; authentic newer AppImage verified and installed; restart into a new executable with the current version and pairing preserved.
- Packaged Linux app WebKit smoke: 19/19 checks passed.
- Protocol-mismatch suite: 18/18 Chromium checks passed, including the screen's update action driving check → download → restart.
- Workflow YAML parses and shell bodies pass `bash -n`; tag/manifest/checksum logic exercised with exact bodies. `actionlint` is not installed, so it was not run.
- `PI_CODING_AGENT_DIR=.lane/ticket11-agent bun test`: 828 pass, 23 skip, 0 fail, 5288 assertions across 851 tests / 124 files in 523.14s; all 11 real Pi steps reached READY and private HOME cleanup completed.
- `bun run typecheck`: exit 0 in 6.11s.

External limits: real GitHub publication, protection/promotion, an ordinary FUSE-mounted AppImage update, and macOS/Windows behavior were not exercised here; packaged macOS/Windows support belongs to tickets 14/15. The user accepted these as documented external verification for resolving this ticket.

Repeatability: the Pi environment was fixed without host changes by provisioning the browser under the worktree's private `.lane/browser` (the container-pack interpreter path is unusable on the host) and using a private `PI_CODING_AGENT_DIR` with `kimi-k2.7-code`; no host settings were modified.

### Integration follow-up (merge of local `linux-service` 575f5ce1)

Merged the latest local `linux-service` branch into this app-release branch and retained the bundled Sidecar and native platform behavior (Sidecar process ownership/launch, Windows executor/output handling, native shell seams). `app-release.yml` now drives one immutable `app-vX.Y.Z` release covering all four updater platforms — Linux AppImage plus macOS arm64/x64 DMGs and `.app.tar.gz` plus Windows NSIS — under one version, one shared `app-release` signing environment, and four platform map entries from the same signed version. Fixed version propagation from the tag to every job, secret/variable placement, release concurrency, and draft publishing: publish bytes are verified against the draft release assets, the release is completed only after verification, and `app-latest` is promoted only to a strictly newer version. `Cargo.lock` was regenerated in the pinned container (`CARGO_HOME=/src/.lane/linux-app/cargo`); Windows updater schema and Windows icons/config are included.

Local verification after the merge:
- `bun run typecheck`: exit 0 in 6.37s.
- Targeted native-shell, release CLI, Sidecar, shell, and boundaries tests: 17 pass, 2 Windows-only skips, 0 fail, 122 assertions.
- Protocol-mismatch suite: 18 pass in 20.6s.
- Linux container release build: exit 0 in 70.94s with the bundled Sidecar.
- General packaged WebKit smoke: 26 pass in 46.13s.
- Signed updater smoke: 6 pass in 139.83s.
- Checksum-verified portable `actionlint` 1.7.12 over all workflows: exit 0.
- Six build-config guard checks and Bash syntax checks passed.

Independent review returned CLEAN (confidence 0.88) with no source changes required. Real macOS/Windows execution and real GitHub publication remain external, and tickets 14/15 evidence stays pending; their criteria are untouched. The full Bun/Pi suite was not requested or run for this merge. Ticket remains resolved; the historical evidence above is preserved unchanged.
