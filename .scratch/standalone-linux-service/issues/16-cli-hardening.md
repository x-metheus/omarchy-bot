# 16: CLI hardening: doctor, TLS, pairing, and a real command

**What to build:** Close the shipped CLI gaps recorded in ticket 12's Comments so the Service CLI matches spec user story 13 and works with TLS-bound Services.

**Blocked by:** None (can start immediately)

**Status:** resolved

Spec: [standalone Linux Service](../spec.md)

- [x] `doctor` checks, besides prerequisites: installed runtime and its checksum marker, Sway bundle ready marker, fonts, unit/launcher state, `GET /api/health` reachability, and pairing state; each failed check prints one actionable line, and the exit status is non-zero when any required check fails. It never changes the host.
- [x] `pair`, `devices`, `revoke`, `status`, and the `install`/`update` health wait work against a TLS-bound Service (HTTPS to the configured host/port; loopback self-signed certificates accepted only for the local Service Host connection, using the host secret as today).
- [x] `install` and `update` carry `OMARCHY_BOT_TLS_CERT`, `OMARCHY_BOT_TLS_KEY`, and `OMARCHY_BOT_TRUSTED_PROXY` (from flags or the installing environment) into the unit environment, and an explicit reconfigure path changes them on an existing install without hand-editing a drop-in.
- [x] A fresh container started with TLS can be paired: the container prints a single-use pairing URL to stdout on first start with no Paired Device, and `docker exec … pair` works over HTTPS.
- [x] `install` puts an `omarchy-bot` launcher on the user's PATH (`~/.local/bin`, no root), `uninstall` removes it, and `omarchy-bot --help` / `<command> --help` print usage with exit 0.
- [x] README and ticket 12's limitations are updated to match.

## Comments

### 2026-10-27 — docs pass (interim)

Interim record: the review-remediation and final-evidence comment below supersedes it where they differ.

Documentation updated to shipped branch behavior; no criteria are checked and status stays `open` pending full validation and review.

Changed: `README.md` — Service CLI intro/table/environment (launcher at `~/.local/bin/omarchy-bot`, no `PATH` edit, `--help`/`-h`/`help` exiting 0, new `reconfigure` row, TLS flag/environment fallback rules, empty-value disable/clear, validation before mutation, `doctor`'s full check list plus advisory linger hint and `All required checks passed.`, HTTPS/loopback-only self-signed trust and redirect refusal, `<dataDir>/service.json`), Remote access TLS binding (reconfigure flow replacing the drop-in recipe), generic install paragraph (unit environment now carrying TLS/proxy, launcher, pairing URL origin scheme), container HTTPS paragraph (first-start single-use pairing URL, loopback-only self-signed tolerance for `docker exec` commands, documented manual `pair` fallback), plugin diagnostics summary, and ticket 12's superseded limitation notes.

Implementation names checked against source, not assumed: `apps/cli/src/main.ts` (`commands`, `tlsUsage`, `usage`, flag parsing, `--tls-cert`/`--tls-key` pairing check with "must both be set (or both empty to disable TLS)", `resolve` plus unreadable-file and `isIP` proxy rejection, `Service reconfigured.`, help early return), `apps/cli/src/lifecycle.ts` (`renderUnit` environment keys, `saveConfiguration` writing `service.json` 0600 without the host secret, `reconfigureUnit` requiring unit and runtime, `installLauncher`/`ownsLauncher`/`checkLauncher` marker and refusal, `doctorText` check lines and repair text, `uninstall`), `apps/cli/src/layout.ts` (`serviceOrigin` scheme, `localhost`/`127.0.0.0/8`/`::1`/mapped-IPv4 loopback test, `redirect: "error"`, saved-then-environment merge), and `scripts/container-image/entrypoint.sh` (TLS-only background pair job, health wait, active-device suppression, failure line).

Documented limits that follow from that source: the launcher is written but shell startup files and `PATH` are untouched; `reconfigure` accepts no `--host`/`--port` flags, so a listener change goes through `OMARCHY_BOT_HOST`/`OMARCHY_BOT_PORT` in the environment (recorded in the rewritten unit); the CLI tolerates self-signed certificates only for loopback origins, so a non-loopback `OMARCHY_BOT_HOST` with a self-signed certificate fails CLI certificate verification even on the Service Host, and the `reconfigure` health wait hits the same limit; `doctor` validates the `.archive-sha256` format only and does not rehash fonts or the Sway bundle; inside a container `doctor` reports the absent unit, launcher, and installer-written archive marker by design.

Targeted proof already recorded by the implementation handoff, not re-run here: `bun test tests/unit/cli-commands.test.ts tests/unit/cli-lifecycle.test.ts tests/integration/service-install.test.ts tests/integration/container-launcher.test.ts` — **30 pass / 0 fail / 335 assertions**, with red runs for each criterion before the change. The container TLS acceptance path (`OMARCHY_BOT_CONTAINER_IMAGE=… bun test tests/integration/container-image.test.ts`) still needs a fresh build of this branch's runtime and image.

Pending before any box is checked: full `bun test` with the documented baseline exception, typecheck, lint/boundaries, fresh container image build and acceptance, and independent review of the wording above against the final code.

Superseded below: the "30 pass / 0 fail / 335 assertions" handoff figure, the claim that CLI certificate verification fails for a self-signed certificate on a non-loopback listener, and the open container-TLS acceptance item. The final implementation binds interface requests to a loopback source, so only the destination certificate must verify.

### 2026-10-27 — review remediation and final exercised evidence

Independent review of the remediation found one P1 regression, which is fixed. This evidence record preceded the final security re-review and resolution recorded below.

Review-fix dispositions, all established from source and covered by focused red/green fixture tests:

- **Interface-bound TLS authorization — resolved.** `apps/cli/src/layout.ts:serviceFetch` detects a configured address that is a local interface, sends the request from a loopback source address, and keeps normal destination certificate validation. The daemon's gate is unchanged: the host secret is accepted only from a loopback peer. A real-router regression shows direct interface host-secret requests still return 401 while `pair`, `devices`, doctor's pairing check, and `revoke` succeed, and an untrusted certificate still fails.
- **Reconfiguration validation and rollback — resolved.** `install`/`update`/`reconfigure` validate through shared `listenerConfig` and open an ephemeral Bun listener before mutation; restart or health failure restores the previous unit and `service.json` and restarts the previous Service. A failed restoration is reported, not hidden.
- **Legacy TLS drop-ins — resolved with a manual migration.** `checkConfigurationOverrides` walks the unit's `.d` directory and the runtime user-manager drop-in directory; a conflicting `OMARCHY_BOT_*` assignment, a bare `Environment=` reset, or `EnvironmentFile=` aborts before mutation with an error naming the file. **Current limitation:** nothing migrates those files — the operator must remove the conflicting assignments while keeping unrelated settings, then retry. Drop-ins that set only unrelated settings are preserved.
- **Bun availability — resolved.** The generated unit prepends `dirname(process.execPath)` to `PATH`, and the launcher execs that Bun by absolute path, so a reconfigure with Bun absent from the caller's `PATH` works.
- **Default listener persistence — resolved (the P1).** `layoutFromEnv` normalizes merged empty or missing host and port to `127.0.0.1:7321` before preflight, and `saveConfiguration` writes the effective `layout.host`/`layout.port`. Five regressions cover an installation without host/port followed by reuse, update, and reconfigure, each command against already-saved legacy empty defaults, and saved-value versus environment precedence.
- **Security-report findings:** invalid `127.0.0.256` is rejected; `127.0.1.0` is loopback, while `::ffff:7fff:ffff` is outside `127/8` and is not loopback. The shared IP-aware helper accepts real loopback ranges only. systemd `Environment=` performs no shell substitution; doctor's reported success bug does not exist (required failures make `doctor` exit 1, including alongside the advisory linger hint) and now has executable coverage. The genuine apostrophe-quoting defect in unit values was fixed.

README wording was checked against these sources and already matches: interface bind to a loopback source with the destination certificate verified, wildcard binds through loopback, self-signed tolerance only for a loopback destination, preflight before mutation, rollback to the prior unit and `service.json`, the drop-in conflict error, the Bun directory in `PATH`, and `<dataDir>/service.json` persistence and precedence.

Exercised evidence recorded by the validator on the final source:

| Check | Result |
| :--- | :--- |
| Full repository suite (`bun test tests packages apps workers`, excluding `tests/e2e/**` and `tests/conformance/pi.test.ts`) | 690 pass, 14 fail, 14 skip |
| Latest affected CLI/install/pairing/container/plugin suites | 71 pass, 0 fail, 674 assertions |
| `bun run typecheck` | pass |
| `bun run lint:boundaries` | pass (2/0, 3 assertions) |
| Fresh packaged runtime | SHA-256 `30d9572695b57bfb5ceda5d9813de9cca1a7db7148a4b47f6e2067371d045904` |
| Freshly built image | `sha256:76af6386710ce857149eb18e35a923b97f050e24a17c58c4cda9695c3198c7ef` |
| `OMARCHY_BOT_CONTAINER_IMAGE=omarchy-bot:linux16 bun test tests/integration/container-image.test.ts` | 2 pass, 0 fail, 44 assertions |

The 14 full-run failures were plugin fixture archives missing the newly shared `apps/daemon/src/bootstrap/listenerConfig.ts` (twelve module-resolution failures, two lifetime readiness timeouts). Both archive fixtures were corrected, along with one stale Bun-`PATH` expectation, and every failure was rechecked through the affected runs above; the full suite was **not** rerun after those corrections, so this ticket claims the affected recheck, not an all-green repository.

Remaining known defect and limits:

- Real-model Pi passed steps 1–7 (including text and image attachments) and then failed at `pi.test.ts:355`, where the expected capability-key list omits the `plugins` key the same test and worker require — the known ticket 11 test defect, not a CLI regression. There was no full clean Pi rerun.
- No dedicated real-model container or Alpine harness exists; the container and distro acceptance paths use scripted workers. No new real-model container or Alpine proof was produced.
- Container and volume cleanup after the acceptance run was confirmed by empty listings matching `ob-container`.

At this evidence handoff, security re-review and the final status decision were pending; both are completed below. No push, release, publication, image push, host package change, real user-manager action, or graphical-session change was made.

### 2026-10-27 — final review disposition and resolution

All six acceptance criteria are satisfied. The general review's five original findings are resolved; its subsequent P1 default-listener persistence finding is fixed by normalizing empty saved settings before preflight and persisting the effective listener. The focused production fixture regression passed **5 tests, 0 failures, 18 assertions**, and the validator subsequently packaged the final source and exercised the fresh image. Final security re-review reports **no remaining security findings**. README and ticket 12 match the effective defaults, TLS trust boundary, rollback, launcher, and container behavior.

Acceptance evidence: doctor's required checks and exit codes, TLS CLI operations and health waits, TLS/proxy persistence and reconfiguration, and launcher/help lifecycle are covered by the final affected suites (**71/0/674**); fresh container TLS URL pairing and HTTPS exec are covered by image acceptance (**2/0/44**). Typecheck and boundaries passed. The table above retains artifact identities and the exact observed repository-run result; no additional full-suite run or new real-model container/Alpine proof is claimed. Existing conflicting TLS drop-ins require the documented manual migration. The known Pi capability-key assertion defect remains outside this ticket.

## Answer

Resolved: the Service CLI now provides actionable read-only diagnostics, configured HTTPS operations, persisted TLS/proxy settings with validated reconfiguration and rollback, fresh-container TLS pairing, and a user-local launcher with command help. All six criteria are checked against the final validation and review evidence above. No feature map exists in this effort directory to update.
