# 06: Retire Service dictation

**What to build:** Service-side Voxtype dictation is removed end to end: the dictation module, routes, configuration, DTOs and events, and `doctor`'s dictation check on the Service; the composer's microphone button, voice settings, and dictation state in the Web UI. User documentation points to each operating system's own dictation (macOS Dictation, Windows Win+H, Voxtype on Omarchy, phone keyboards), which types into the composer.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [ ] No dictation routes, DTOs, events, or configuration remain in the Service or protocol
- [ ] The composer has no microphone button and settings have no voice section
- [ ] Composer drafts no longer carry a dictation anchor
- [ ] The dictation integration test and e2e spec are deleted; remaining suites pass
- [ ] Documentation lists the OS dictation shortcuts
