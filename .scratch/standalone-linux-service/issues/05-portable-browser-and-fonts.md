# 05: Portable browser and fonts

**What to build:** `open_url` works on a host with no browser, and pages render Latin and CJK text correctly on hosts without fonts. A natively installed host browser is still preferred; snap-confined browsers are never launched. The shared Bot Computer browser profile is unchanged.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

Spec: [standalone Linux Service](../spec.md)

- [ ] On a fixture host with no browser, `open_url` opens the portable browser on the requesting Screen (Seam 3).
- [ ] On a fixture host where the only browser is a snap, the snap is skipped and the portable browser is used.
- [ ] A page containing CJK text renders glyphs, not empty boxes, in a Screen capture.
- [ ] Repeated `open_url` calls reuse the shared browser profile across Screens.
- [ ] The portable browser and fonts are fetched checksum-verified into the Bot Computer profile, not the host.
