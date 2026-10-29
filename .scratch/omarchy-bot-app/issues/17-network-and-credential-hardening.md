# 17: Network policy and credential hardening

**What to build:** Four places where the app or tooling trusts more than the spec allows are tightened, so that a token cannot leak and the user cannot be tricked into an unauthenticated install:

1. **Unpaired CSP.** Before pairing, the app's page may connect only to loopback HTTP and HTTPS origins needed for the pairing exchange, not to `http:`/`https:` everywhere. Plain HTTP to a non-loopback host is never allowed by the page, matching what the Rust address validation already refuses.
2. **No silent memory shell in the app.** In the packaged app, a missing or broken native shell is a visible startup error. The Web UI never falls back to the memory shell, so the device token can never land in `localStorage`. The Vite harness and Chromium tests keep using the memory shell explicitly.
3. **Installer authenticity.** When the installer downloads the Omarchy Bot AppImage, it verifies the AppImage's updater signature against the release public key built into the installer, not only a `.sha256` from the same origin. A missing or invalid signature aborts the app install and leaves the Service install intact, with a clear message.
4. **Container-only CA trust.** The Linux app smoke session updates a CA trust store only when it can prove it runs inside the repository's container. Run as root on a host, it refuses (AGENTS.md host safety).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md). Origin: PR #10 code review (Spec (c), Standards judgement call on the CA store).

- [ ] Unpaired CSP permits only what the pairing exchange needs. A test asserts that the generated policy refuses a non-loopback `http:` origin and an arbitrary `https:` origin that was not the pairing target. If arbitrary HTTPS pairing targets make a static policy impossible, record the narrowest workable policy and why
- [ ] The packaged app shows a startup error when the native shell is absent; a test proves the memory shell is only selected explicitly
- [ ] The installer refuses an AppImage with a missing, tampered or wrong-key signature and accepts a correctly signed one (tests with a disposable key)
- [ ] The CA-trust step refuses to run outside the container even as root
- [ ] Review cleanups in the same code: the installer's desktop-entry INI parsing exists once; the revoked-device message avoids the Avoid-listed "This Device" phrasing
