# 18: Every native path goes through the shell interface

**What to build:** The Web UI reaches native behaviour only through the single `shell` interface that ADR 0015 and the spec define. Attachment saving, the document-wide click interception, and the replaced `window.fetch` currently live outside it, in the injected native script and an extra Rust command. Each one either becomes an explicit `shell` capability, with a memory-shell implementation for the harness and tests, or is removed if the app does not need it. A future phone shell then needs to implement only `shell` to get the same behaviour. The user still sees the same thing: clicking a managed attachment saves it to Downloads and shows the path, and external links open in the system browser.

**Blocked by:** None (can start immediately)

**Status:** resolved

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md). Origin: PR #10 code review (Spec (b), Standards judgement call on `shell.js`).

- [x] The injected native script installs the `shell` adapter and nothing else: no global `fetch` replacement and no document-wide click handler
- [x] Attachment download is a `shell` capability. If the spec and ADR 0015 list the capabilities, they are updated to say so; otherwise it is removed and attachments use a path the spec already allows
- [x] Native tests prove that attachments save to Downloads with an authenticated download, keep the filename with a collision prefix, and never send the token to the external browser; memory-shell tests cover the harness path
- [x] Review cleanups in the same code: literals duplicated between the native script and the Web UI's shell module exist once; the update check is shared by check-update and install-update; the repeated memory-shell test type exists once

## Answer

The injected native script now installs only the `shell` adapter. Attachment saving and external-link opening are explicit `shell.attachments`/`shell.openExternal` capabilities, implemented by both the Tauri adapter and the memory shell; the global `fetch` replacement and document-wide click handler are gone. Spec and ADR 0015 list the capabilities. Duplicated literals exist once, `check-update` and `install-update` share one update check, and the repeated memory-shell test type exists once.

## Comments

- Native tests cover authenticated attachment download into Downloads with collision-prefixed filenames and no token sent to the external browser; memory-shell tests cover the harness path. Native startup, TLS and external-browser behaviour are exercised through the packaged WebKit smoke run.
- Merged linux-service `a587545` (ticket 16) as `efc3396`, preserving the host-identity gate and the shared WebSocket URL conversion; no further merge was needed.
- Final checks: `bun test` 855 pass, 31 skip, 0 fail (5,486 assertions, 886 tests, 128 files, 512.64s); `bun run typecheck` passed; boundary checks passed; 30 focused native-host/supervision/memory tests passed (194 assertions); merged Chromium spec 44 pass (56s, OAuth enabled) and the corrected startup spec passed three repeated runs (6.6s); locked Cargo release test passed; packaged AppImage smoke passed 29/29 WebKit checks (49.06s), including host identity, Downloads/collision/token isolation, TLS and startup. Eleven real Pi 0.84.4/DeepSeek conformance steps passed with private configuration removed afterwards.
- Limitation: a supplementary pre-merge broad Chromium run had 116 pass and 4 fail, two missing a Pi option and two blank initial-page/readiness cases; this is not a claim that the entire broad suite passed. Required gates above were green.
