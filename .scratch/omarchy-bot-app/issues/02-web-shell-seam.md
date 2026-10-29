# 02: Web UI runs behind the `shell` seam

**What to build:** Every native capability the Web UI needs is reached through one `shell` interface: Service base URL and device token (read, store, clear), pairing intake, opening the system browser, updates, Local Sidecar status/identity/approvals, and platform key-mapping preference. An in-memory implementation backs tests and the browser development harness. `ApiClient`, Screen Projection, RFB, and attachment URLs use the shell's base URL instead of the page location, and the Local Sidecar device identity comes from the shell instead of a page global, keeping the ADR 0011 tagging contract. A developer can run the Vite dev server against a local Service and use the full UI. The existing Chromium e2e suite moves from the Service-served UI to the Vite-served bundle with the in-memory shell and passes.

**Blocked by:** 01 (Service accepts cross-origin requests from the app)

**Status:** resolved

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [x] No Web UI code reads `window.location` to derive a Service address
- [x] The device token and base URL are read only through the shell
- [x] `message.send` carries the `dev_` tag exactly when the shell reports a running Local Sidecar, and never otherwise
- [x] The Vite dev harness connects to a local Service cross-origin and the UI works end to end
- [x] The full existing e2e suite passes against the Vite-served bundle and harness Service, not the Service-served UI
- [x] The shell interface contains only the capabilities listed in the spec

## Answer

The six-capability shell and memory adapter now own the Service connection and running Local Sidecar identity. API/events, pairing storage, attachments, avatars, and projection/RFB/snapshot URLs use that connection. Vite serves the Chromium suite on a separate origin; the remaining real-Sway and LAN HTTPS browser fixtures seed the same shell connection. Tauri, Add Service, and OAuth remain in tickets 07, 03, and 05.

## Comments

Independent reviews by ReviewWebShell and FinalShellReview are clean after correcting the two browser integration fixtures. Final `bun test`: 800 pass, 17 skip, 0 fail, 5034 assertions across 122 files (530.18s), including all eleven real Pi conformance steps with private Sway/browser assets and fixture cleanup. `bun run typecheck` passed; `bun run lint:boundaries`: 2 pass, 0 fail. Full Chromium `bun run test:e2e`: 83 passed (3.8m), with Vite at port 7398 and the harness Service at 7399; existing visual snapshots passed unchanged.

The initially missing `.lane/dist/sway` prerequisite was supplied by temporary local links to the existing prepared, checksum-pinned Sway bundle in the ticket 01 worktree and the shared managed fonts/browser pack. A first full run with global asset environment overrides passed Pi conformance but contaminated two installer/container fixtures (798 pass, 17 skip, 2 fail); replacing those overrides with local asset links made the unchanged complete suite pass. No host packages or graphical-session state were changed. The recovered Vite process and private test artifacts were cleaned up; native WebView support is not claimed by Chromium coverage.

