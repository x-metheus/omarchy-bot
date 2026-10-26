# 17: Browser pack for hosts without a usable browser

**What to build:** Hosts with no usable non-snap browser (headless VMs, containers, stock Ubuntu with snap Firefox/Chromium) get a working Bot Computer browser without a run-time download. The runtime archive stays browserless; the packager also produces a separate checksum-pinned **browser pack** (Chrome for Testing plus the libraries `botComputerAssets.ts` downloads today). The installer installs the pack when the host has no usable browser (or with `--with-browser`), from a local file or its release URL, verifying the checksum; the Service resolves the browser from the installed pack and never downloads it at run time. Host browsers are still preferred when present.

**Blocked by:** None (can start immediately)

**Status:** open

Spec: [standalone Linux Service](../spec.md)

- [ ] The packager builds `omarchy-bot-browser-<version>-x86_64.tar.zst` with a `.sha256` sidecar from the pinned Chrome for Testing and library inputs, refusing any mismatched input.
- [ ] `install`/`update` install the pack (checksum-verified, from `--browser-pack <file>` or the release URL) when no usable non-snap host browser is found or `--with-browser` is given, and skip it otherwise; `uninstall` removes it.
- [ ] The Service resolves the browser from the installed pack; the run-time download path in `botComputerAssets.ts` is removed. With neither a host browser nor the pack, `open_url` fails with one actionable message naming `--with-browser`.
- [ ] The container image (09) and the distribution matrix (10) use the pack, so their browser steps run with container networking disabled.
- [ ] Portable browser conformance (CJK, shared profile, snap avoidance) passes against the installed pack.
- [ ] README, Computer ADR 0011 and ticket 05/14 notes record the browser pack.

## Comments
