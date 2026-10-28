# 10: Windows executor for the Sidecar

**What to build:** On Windows the Local Sidecar runs commands with Windows PowerShell 5.1, each job assigned to a Job Object closed with kill-on-close on cancel or timeout, and refuses Windows credential and key stores in AppData. It registers as `windows` / `powershell-5.1`. The Local Sidecar integration suite runs on a Windows CI runner.

**Blocked by:** 08 (Sidecar connects by URL and reports its OS and shell)

**Status:** ready-for-agent

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [ ] `local.run` executes PowerShell 5.1 syntax and returns output and exit code
- [ ] Cancel and timeout terminate the command and every descendant
- [ ] Windows credential and key stores are refused
- [ ] Registration reports `windows` and `powershell-5.1`
- [ ] The Sidecar suite, including Windows-only cases, passes on a Windows CI runner
