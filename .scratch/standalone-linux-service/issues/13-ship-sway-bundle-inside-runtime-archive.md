# 13: Ship the Sway bundle inside the runtime archive

**What to build:** The Service runtime archive carries the pinned Sway runtime bundle under `sway/`, as the spec's Solution section already states ("The archive carries a self-contained Bot Computer runtime"). The Service resolves the Bot Computer binaries from the installed runtime instead of downloading the bundle from a GitHub release, which removes the separate release as a dependency of install, tests, and the container image (09). Host binaries remain a development override only.

**Blocked by:** None (can start immediately)

**Status:** open

Spec: [standalone Linux Service](../spec.md)

- [ ] The runtime packager (`scripts/package-plugin-runtime.sh`) takes a built Sway bundle archive (built by `scripts/build-sway-runtime.sh`, or a supplied path), refuses one whose SHA-256 does not match the pin in `swayRuntimeSupply.ts`, and places it extracted under `sway/` in the runtime archive with its ready marker.
- [ ] The runtime supply resolves the bundle from the installed runtime (`<runtime>/sway/`) and fails with a clear message naming the missing path when it is absent; the network download path, HTTPS fetch, and download timeout are removed.
- [ ] Explicit host binaries remain a development override; development checkouts without a packaged runtime can point at a locally built bundle through one documented override (environment variable or config), still checksum-verified.
- [ ] `.github/workflows/sway-runtime.yml` verifies the reproducible build against the pin and runs the bundle conformance, but no longer publishes a release; the runtime packaging workflow consumes the built bundle.
- [ ] `service-supervision` and the Sway runtime supply tests pass on this host using a locally built bundle, without network access to a release.
- [ ] Computer ADR 0011 and ticket 04's notes record that the bundle ships inside the runtime archive.

## Comments

Origin: the release URL pinned in `swayRuntimeSupply.ts` (`sway-runtime-fc4b7ec8…`) returns 404 because the publishing workflow only runs on `main`; six `service-supervision` tests fail on that. Bundling in-archive was chosen on 2026-10-26 over publishing a separate release.
