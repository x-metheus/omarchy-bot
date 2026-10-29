# 18: Every native path goes through the shell interface

**What to build:** The Web UI reaches native behaviour only through the single `shell` interface that ADR 0015 and the spec define. Attachment saving, the document-wide click interception, and the replaced `window.fetch` currently live outside it, in the injected native script and an extra Rust command. Each one either becomes an explicit `shell` capability, with a memory-shell implementation for the harness and tests, or is removed if the app does not need it. A future phone shell then needs to implement only `shell` to get the same behaviour. The user still sees the same thing: clicking a managed attachment saves it to Downloads and shows the path, and external links open in the system browser.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md). Origin: PR #10 code review (Spec (b), Standards judgement call on `shell.js`).

- [ ] The injected native script installs the `shell` adapter and nothing else: no global `fetch` replacement and no document-wide click handler
- [ ] Attachment download is a `shell` capability. If the spec and ADR 0015 list the capabilities, they are updated to say so; otherwise it is removed and attachments use a path the spec already allows
- [ ] Native tests prove that attachments save to Downloads with an authenticated download, keep the filename with a collision prefix, and never send the token to the external browser; memory-shell tests cover the harness path
- [ ] Review cleanups in the same code: literals duplicated between the native script and the Web UI's shell module exist once; the update check is shared by check-update and install-update; the repeated memory-shell test type exists once
