# 22: Omarchy Bot ships the Rust Sidecar and the TypeScript Sidecar is removed

**What to build:** The app bundles and launches the Rust Local Sidecar on Linux, macOS and Windows. The TypeScript Sidecar, its `bun build --compile` step and its per-target Bun binaries are deleted. Users see no behaviour change, and the installers shrink. Approval prompts, Always/Never persistence, the `dev_` identity, quit/unpair teardown and failed pending jobs all behave as before.

**Blocked by:** 21 (Rust Local Sidecar passes the existing Sidecar suites on every OS), 16 (Sidecar decides "same machine" by host identity)

**Status:** needs-info

Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [x] Linux AppImage smoke runs one approved `local.run` end to end with the Rust Sidecar
- [ ] macOS dmg and Windows NSIS CI jobs build and bundle the Rust Sidecar; the Windows install check passes
- [x] No TypeScript Sidecar source, build script or bundled Bun Sidecar binary remains; the package-boundary tests are updated
- [ ] Installer sizes before and after are recorded per platform in Comments
- [x] Review cleanups in the same code: the Sidecar decision is a typed value, not a string; approvals are typed, not `serde_json::Value`; the restart exit code has a descriptive name; `approvalId` and `jobId` naming is consistent

## Comments

2026-10-29 Rust Sidecar cutover implemented and locally verified; native macOS/Windows CI and their installer sizes deferred to the user's push:

The app now builds and bundles the Rust Local Sidecar, and the TypeScript Sidecar is gone: `apps/sidecar/` source, its `package.json`, the `bun build --compile` step in `scripts/build-sidecar.ts` and its per-target Bun binary build output are deleted, and `bun.lock` no longer carries that package. The release build and the Linux, macOS and Windows workflows package `apps/sidecar-rust`; the integration fixture launches the actual Rust binary behind a recording proxy rather than an executor mock; Tauri's approval/decision wire is typed (`Decision`, `Approval`) instead of `serde_json::Value`; the restart exit code is `RESTART_EXIT_CODE`; `approvalId` and `jobId` naming is consistent; and the docs are current.

Verification in the supported container with private Pi configuration, on the final tree: full `bun test` **878 passed, 25 skipped, 0 failed**, 5,645 assertions, 903 tests in 127 files (477.65 s); `bun run typecheck` passed (6.44 s); `cargo test --locked` for `apps/sidecar-rust` **10 passed, 0 failed**; the actual Tauri app's `cargo test --locked` **3 passed, 0 failed**; `bash scripts/build-linux-app.sh` passed in 236.72 s; the packaged AppImage WebKitGTK smoke passed **32/32** checks in 50.54 s, including one approved `local.run`, the `dev_` identity, Always/Never persistence across restart, pending-approval dismissal and quit/unpair teardown.

Linux installer: **149,699,064 B** before (SHA256 `a91ded07f0c9a9376850720e41fbc906453b2be297c2b625a16a97ec854182bd`) and **105,323,000 B** after (SHA256 `fcd1cbd26581b45198cde1d924362457fb027473964d8033263e0aa8a876ba41`), a reduction of **44,376,064 B / 29.6435%**. The Linux Rust release is 7,827,896 B against the former Bun Sidecar's 109,594,800 B (92.8574% smaller). The macOS dmg and Windows NSIS installer sizes are not measured, and no historical Sidecar size is substituted for them.

An earlier full-suite attempt reported real-browser conformance receiving two of at least five tool calls. Diagnosis: the prepared browser pack's ELF requested its Docker installation interpreter `/src/.lane/browser/libs/ld-linux-x86-64.so.2`, which does not exist on the host, so Chromium exited 127; both native browser calls returned the closed CDP pipe and the model reported the browser unavailable. Installing the same checksum-verified pinned archive at a separate host path made the unchanged conformance pass (1 passed, 41 assertions), and the final full suite above is green. No permanent source fix was required. Future host conformance must install that archive at a stable host path; `.lane/browser` was restored to the container-prepared `/src/...` pack.

Review: the independent review's sole P2 was lost Windows test coverage from deleting the TypeScript suite. The repair preserves all seven status cases, all eleven named-block cases, `$completion` file-content preservation and all four launch-survival forms through the actual Rust process seam (binary selection, authenticated device WebSocket, `local.job` dispatch, stdin approval or persisted rule, Rust executor, returned `local.result`); the re-review found no remaining defect or weakened assertion. The affected suite ran **5 passed, 9 platform skips, 0 failed**, 50 assertions, and typecheck passed afterwards.

All temporary instrumentation, disposable runners, the temporary wire harness, the diagnostic browser pack and the private Pi auth/models/settings (mode 0700 directory, 0600 files) were removed, with absence verified. No host changes were made.

Acceptance ticked here is the Linux smoke, the TypeScript Sidecar removal with updated package-boundary tests, and the review cleanups. The macOS dmg/Windows NSIS CI criterion and the all-platform installer-size criterion remain unticked because no native installer build and no macOS/Windows installer measurement were observed on this host. The user will push and report CI. Status is needs-info, not resolved.
