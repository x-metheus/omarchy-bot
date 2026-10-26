# 13: Ship the Sway bundle inside the runtime archive

**What to build:** The Service runtime archive carries the pinned Sway runtime bundle under `sway/`, as the spec's Solution section already states ("The archive carries a self-contained Bot Computer runtime"). The Service resolves the Bot Computer binaries from the installed runtime instead of downloading the bundle from a GitHub release, which removes the separate release as a dependency of install, tests, and the container image (09). Host binaries remain a development override only.

**Blocked by:** None (can start immediately)

**Status:** resolved

Spec: [standalone Linux Service](../spec.md)

- [x] The runtime packager (`scripts/package-plugin-runtime.sh`) takes a built Sway bundle archive (built by `scripts/build-sway-runtime.sh`, or a supplied path), refuses one whose SHA-256 does not match the pin in `swayRuntimeSupply.ts`, and places it extracted under `sway/` in the runtime archive with its ready marker.
- [x] The runtime supply resolves the bundle from the installed runtime (`<runtime>/sway/`) and fails with a clear message naming the missing path when it is absent; the network download path, HTTPS fetch, and download timeout are removed.
- [x] Explicit host binaries remain a development override; development checkouts without a packaged runtime can point at a locally built bundle through one documented override (environment variable or config), still checksum-verified.
- [x] `.github/workflows/sway-runtime.yml` verifies the reproducible build against the pin and runs the bundle conformance, but no longer publishes a release; the runtime packaging workflow consumes the built bundle.
- [x] `service-supervision` and the Sway runtime supply tests pass on this host using a locally built bundle, without network access to a release.
- [x] Computer ADR 0011 and ticket 04's notes record that the bundle ships inside the runtime archive.

## Comments

Origin: the release URL pinned in `swayRuntimeSupply.ts` (`sway-runtime-fc4b7ec8…`) returns 404 because the publishing workflow only runs on `main`; six `service-supervision` tests fail on that. Bundling in-archive was chosen on 2026-10-26 over publishing a separate release.

The runtime packager verifies the supplied Sway archive against the pin before extracting it into `sway/` and writing `.omarchy-bot-runtime`. The Service resolves `<dataDir>/runtime/current/sway` without downloading a release. For development, `OMARCHY_BOT_SWAY_BUNDLE_DIR` points at the directory prepared by `scripts/sway-runtime/prepare.sh`; `scripts/build-sway-runtime.sh` calls that script, which checksum-verifies the archive against the pin before writing the marker. Explicit host binary overrides remain available. The Sway workflow verifies the build and runs conformance without publishing a release; the plugin runtime workflow builds the bundle and passes it to the packager. ADR 0011 and ticket 04 record in-archive shipping.

Local Docker build evidence: `.lane/dist/omarchy-bot-sway-runtime-sway-1.10.1-wayvnc-0.8.0-wlroots-0.18.1-v1-x86_64.tar.gz` has SHA-256 `fc4b7ec887c6b5ccad7f62706b4e5a186e63eaeb3e8f70636e641af241a52f94`, matching the pin. The build took 5m30s and its self-check passed.

`bun test` of supply, service-supervision, and plugin-runtime-package: 21 pass, 0 fail. A throwaway `ensure()` call on the extracted local bundle, with the marker written only in that temporary directory, returned all ten binaries and made zero fetch calls; the throwaway check was not committed. Running `scripts/sway-runtime/prepare.sh` on the local archive wrote `.lane/dist/sway/.omarchy-bot-runtime`, and the archive sidecar still passed `sha256sum --check`. Prepare tests: 3 pass. `bun run typecheck` passed.

Full `bun test`: 665 pass, 13 skip, 5 fail. The failures are outside this change: `tests/conformance/pi.test.ts` has a capability-key assertion that omits `plugins` although the preceding assertion requires `plugins: true` (also present on baseline `45548a7`); two application-launch tests and two service-supervision tests failed the existing Noto Sans font download with `ECONNRESET` (`ensureFonts` predates this branch). No failure attempted the old Sway GitHub release download.

The real `package-plugin-runtime.sh` run with the Docker bundle was not performed because `apps/web/dist` and the three native helpers are not built in this worktree. The packager test covers checksum mismatch refusal and extraction under `sway/` using a fixture archive.
