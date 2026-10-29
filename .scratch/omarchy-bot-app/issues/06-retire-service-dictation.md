# 06: Retire Service dictation

**What to build:** Service-side Voxtype dictation is removed end to end: the dictation module, routes, configuration, DTOs and events, and `doctor`'s dictation check on the Service; the composer's microphone button, voice settings, and dictation state in the Web UI. User documentation points to each operating system's own dictation (macOS Dictation, Windows Win+H, Voxtype on Omarchy, phone keyboards), which types into the composer.

**Blocked by:** None (can start immediately)

**Status:** resolved

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [x] No dictation routes, DTOs, events, or configuration remain in the Service or protocol
- [x] The composer has no microphone button and settings have no voice section
- [x] Composer drafts no longer carry a dictation anchor
- [x] The dictation integration test and e2e spec are deleted; remaining suites pass
- [x] Documentation lists the OS dictation shortcuts

## Comments

Service dictation is removed end to end: the dictation module, its four HTTP routes (now covered by 404 tests), configuration keys, protocol DTOs and events, and the API client methods are gone; `doctor` had no dictation check to remove. The Web UI loses the composer microphone button, voice settings section, and dictation state while Notifications and text drafts (now without a dictation anchor) still work. Documentation and README point to each OS's own dictation. The dictation integration test, fake Voxtype fixture, and e2e spec are deleted; five visual snapshots were regenerated for the changed Chrome. Review clean. Final `bun test`: 779 pass, 16 skip, 0 fail (795 tests, 4649 assertions); `bun run typecheck` and `lint:boundaries` passed; 39 relevant e2e specs passed.
