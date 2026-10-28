# 02: Web UI runs behind the `shell` seam

**What to build:** Every native capability the Web UI needs is reached through one `shell` interface: Service base URL and device token (read, store, clear), pairing intake, opening the system browser, updates, Local Sidecar status/identity/approvals, and platform key-mapping preference. An in-memory implementation backs tests and the browser development harness. `ApiClient`, Screen Projection, RFB, and attachment URLs use the shell's base URL instead of the page location, and the Local Sidecar device identity comes from the shell instead of a page global, keeping the ADR 0011 tagging contract. A developer can run the Vite dev server against a local Service and use the full UI. The existing Chromium e2e suite moves from the Service-served UI to the Vite-served bundle with the in-memory shell and passes.

**Blocked by:** 01 (Service accepts cross-origin requests from the app)

**Status:** ready-for-agent

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [ ] No Web UI code reads `window.location` to derive a Service address
- [ ] The device token and base URL are read only through the shell
- [ ] `message.send` carries the `dev_` tag exactly when the shell reports a running Local Sidecar, and never otherwise
- [ ] The Vite dev harness connects to a local Service cross-origin and the UI works end to end
- [ ] The full existing e2e suite passes against the Vite-served bundle and harness Service, not the Service-served UI
- [ ] The shell interface contains only the capabilities listed in the spec
