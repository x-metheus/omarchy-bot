# 10: Windows executor for the Sidecar

**What to build:** On Windows the Local Sidecar runs commands with Windows PowerShell 5.1, each job assigned to a Job Object closed with kill-on-close on cancel or timeout, and refuses Windows credential and key stores in AppData. It registers as `windows` / `powershell-5.1`. The Local Sidecar integration suite runs on a Windows CI runner.

**Blocked by:** 08 (Sidecar connects by URL and reports its OS and shell)

**Status:** needs-info

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [ ] `local.run` executes PowerShell 5.1 syntax and returns output and exit code
- [ ] Cancel and timeout terminate the command and every descendant
- [ ] Windows credential and key stores are refused
- [ ] Registration reports `windows` and `powershell-5.1`
- [ ] The Sidecar suite, including Windows-only cases, passes on a Windows CI runner

## Comments

Implemented the Windows executor and its cross-platform policy: `windows` LocalExecutor running Windows PowerShell 5.1 in text output mode, assigning each job to a Job Object with kill-on-close before the command is released through stdin, so cancel, timeout, and shutdown terminate the command and every descendant. Registration now accepts `win32` and reports `windows` / `powershell-5.1`; the Windows credential and key-store denylist is case-insensitive, expands real NTFS long paths (blocking short-alias bypass, including missing write destinations), and is enforced for every file action; the shared Linux credential file-action policy leak is fixed. PowerShell failures surface as explicit text errors. Docs, workflow, and tests updated; a `sidecar-conformance` workflow runs Linux/macOS/Windows jobs plus a native compiled binary suite.

Review: standards and spec final reviews both clean, no remaining actionable issues.

Local verification (Linux x64): focused Sidecar/source process smoke 15 pass, 7 Windows-only skip, 0 fail (142 assertions); files/policy/transfer/dispatch integration 16 pass, 0 fail (125 assertions); `bun run typecheck` pass; `bun run lint:boundaries:2` pass; native `bun build --compile` and the process suite against that binary 4 pass, 0 fail (48 assertions); real Service registration/cancellation 2 pass, 0 fail (9 assertions). Temporary native artifacts were removed.

Full `bun test` is not green: 810 pass, 22 skip, 1 fail (833 tests / 124 files, 5,139 assertions, 436.27s), the failure being Pi conformance without prepared `.lane/dist/sway`. One prerequisite retry using the existing prepared Sway/fonts/browser assets passed opening but returned an empty model response where `CONFORM-STREAM-OK` step 2 was expected (2 pass, 1 fail outer); artifacts: full run at `artifact://16`, retry at `artifact://19`. This failure is unrelated to this ticket and was not re-run.

Blocked on a prerequisite: all Windows acceptance criteria are implemented but remain unverified at runtime, since no Windows host or CI runner is available here and the Windows-only executor regressions are skipped locally. The remaining acceptance criteria stay unchecked until the `sidecar-conformance` workflow (or equivalent) is pushed and observed green on `windows-latest`, where a real Windows runner would confirm PowerShell 5.1 execution and exit codes, descendant teardown, credential-store refusal including NTFS aliases, and the `windows` / `powershell-5.1` registration. Pushing is not authorized in this environment.
