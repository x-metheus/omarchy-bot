# 13: ⌘ key mapping during Takeover

**What to build:** When the shell reports macOS, Takeover sends ⌘ as Ctrl and ⌥ as Super to the Bot Screen by default, with a per-device override (stored by the shell) that sends ⌘ as Super. Other platforms and the paste path are unchanged.

**Blocked by:** 02 (Web UI runs behind the `shell` seam)

**Status:** resolved

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [x] On macOS, ⌘C/⌘V/⌘ shortcuts arrive in the Bot Screen as Ctrl shortcuts
- [x] On macOS, ⌥ arrives as Super
- [x] The override switches ⌘ to Super and persists for this device
- [x] Linux and Windows key handling is unchanged
- [x] Covered by an e2e spec with the in-memory shell reporting macOS

## Comments

Implemented macOS key mapping in Web Control: ⌘ sends Ctrl and ⌥ sends Super by default; Settings → Keyboard adds a “Send ⌘ as Super” switch whose value the shell persists per device independently of pairing. Linux and Windows handling is unchanged. ⌘V stays a local plain-text paste through the existing paste message (not a forwarded remote V), matching the spec’s unchanged-paste rule. macOS repeat keydowns reach the physical-key tracker, so Command-held repeats emit balanced remote press/release pairs and omitted keyups recover client-side, while duplicate modifier presses and held ordinary keys stay deduplicated. Chromium e2e coverage uses the in-memory shell reporting macOS.

Validation after the repeat correction: focused mapping/shell unit tests 12 pass (54 assertions); 4 focused Chromium platform cases pass; full `bun test` 816 pass, 17 skip, 0 fail, 5106 assertions across 123 files, including all eleven real Pi conformance steps; `bun run typecheck` passes. Native WKWebView shortcut delivery and packaged-app preference storage remain release validation in tickets 07 and 14; Chromium coverage alone does not establish macOS support.
