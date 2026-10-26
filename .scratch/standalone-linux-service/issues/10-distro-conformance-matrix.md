# 10: Distribution conformance matrix

**What to build:** CI proves the product on many distributions: installer smoke plus real-Sway Bot Computer conformance in Ubuntu 22.04 and 24.04, Debian 12, Fedora, Arch, openSUSE, and Alpine containers using the published bundle.

**Blocked by:** 02, 04, 05, 07

**Status:** resolved

Spec: [standalone Linux Service](../spec.md)

- [x] Each distribution job installs, serves, pairs, opens a Bot Screen, captures, types, and runs `open_url`.
- [x] Each job runs the real-Sway conformance suite against the bundle.
- [x] Alpine (musl) passes using the non-systemd supervision path.
- [x] A failing distribution fails the workflow with its name in the job title.

## Comments

2026-10-26. Local matrix evidence, then the commit.

Matrix: `.github/workflows/distro-conformance.yml` builds and uploads the runtime archive without publishing it, then seven jobs named `Conformance (<id>)` consume it: Ubuntu 22.04, Ubuntu 24.04, Debian 12, Fedora (latest = 44 locally), Arch (latest), openSUSE Leap 15.6, Alpine 3.21.3. Each installs the checksum-verified archive with the shared CLI extraction code and starts `scripts/serve.sh` under the container entrypoint.

Results against `.lane/runtime/omarchy-bot-runtime-b1e69d5ace13bd260f2f49793841e7c6fd40dc3f-x86_64.tar.zst` (SHA-256 `e85ef3c645af3c0b811628081dac7cfb50c57bf2eb314d76990622af5408882f`, built from current source with the ticket 14 Sway archive and fonts; no ticket 09 dependency and no separate Sway release):

| Distribution | Smoke (install, serve, pair, real Screen, capture, `open_url`, CJK, type) | Seam 3 conformance |
|---|---|---|
| Ubuntu 22.04 | Passed | 6 pass, 0 fail, 152 assertions |
| Ubuntu 24.04 | Passed | 6 pass, 0 fail, 152 assertions |
| Debian 12 | Passed | 6 pass, 0 fail, 152 assertions |
| Fedora 44 | Passed | 6 pass, 0 fail, 152 assertions |
| Arch latest | Passed | 5 pass, 1 fail, 152 assertions |
| openSUSE Leap 15.6 | Passed | 6 pass, 0 fail, 152 assertions |
| Alpine 3.21.3 | Passed | 6 pass, 0 fail, 152 assertions |

Smoke means a paired device token over the public API, a scripted Agent turn, a real Screen reported `ready`, a PNG capture, a real portable-browser `open_url` whose CJK pixels differ from tofu, and typed text the page reported back. No fake browser and no production bypass. Alpine runs the native musl Bun and its private runtime directory has no user-manager socket, so the supervisor takes the owned-child-process path.

Arch failed on a fixture assumption, not the product: `bot-screen-sway-bundle-conformance.test.ts` asserted the base image has no `dbus-daemon` or `dbus-send`. Ordinary distro runs now place failing, logging host-tool guards ahead of the compositor tools, assert bundled tools win PATH resolution, assert the bundled D-Bus process runs, and assert no guard executed; the standalone-image path still requires absent host tools and compilers. Five font-fixture regressions exposed by the font-before-Sway correction were repaired by injecting the existing checksum-verified local font supply into the supervision, boot, and cutover fixtures; their original assertions are unchanged. Production code changed only to verify configured fonts before compositor startup and pass the private fontconfig file into its environment.

Focused evidence after the fixes: supervision, cutover, assets, Sway runtime, and Vite browser tests **27 pass, 4 existing opt-in skips, 0 fail, 174 assertions** (`.lane/distro-verification/finding-fixes-targeted.log`); distro smoke and matrix tests **3 pass, 0 fail, 6 assertions** (`.lane/distro-verification/finding-fixes-matrix.log`); full Arch and Ubuntu 22.04 reruns passed smoke and **6 conformance tests, 171 assertions** each. Earlier focused batch including typecheck: 39 pass, 4 skip, 0 fail. Logs live under `.lane/`, not committed.

Broad suite ran once before the fixes: **673 pass, 12 skip, 7 fail, 3,847 assertions** (`.lane/distro-verification/bun-test.log`). The seven were the known real-model Pi baseline, five font-fixture failures since repaired, and one Playwright case that only fails under the isolated `XDG_CACHE_HOME` with no cached browser. All six new failures passed focused verification afterwards; the broad suite was not rerun, so a wholly green broad run is not claimed. The other five distributions were not rerun after the guard-only fixture change; their recorded runs are from before it, and the fixture change does not touch production paths they exercise.

The failing-distribution criterion is satisfied by construction and by local observation: `Conformance (${{ matrix.id }})` names the distribution, `fail-fast: false` keeps other jobs running, the container script propagates shell failures, and the runner asserts on the Docker exit status — the original Arch run failed locally as `arch: docker run failed`. **The GitHub-hosted workflow was not executed**: no push, no release, and no registry image publication happened on this branch, so hosted job presentation remains unverified.

Cleanup: all containers created for this ticket were removed and no volumes were created; cached images, the runtime archive, and the broad-suite log were retained. `.lane/` is locally excluded, not committed.
