# Platform CLI keychain tools

1. **Linux `secret-tool` invocations.** Set: `printf '%s' "$SECRET" | secret-tool store --label='omarchy-bot' service omarchy-bot account token`; get: `secret-tool lookup service omarchy-bot account token`; delete: `secret-tool clear service omarchy-bot account token`. Attributes are bare `{attribute} {value}` pairs; `--label` is required for `store`. The man page states the password "can also be piped in via stdin … until EOF" and that a tty invocation prompts for one line instead; for `lookup`, "when printing the password to a terminal or tty, an extra newline will be added" — i.e. on a pipe the raw value goes to stdout with no trailing newline.
URL: https://man.archlinux.org/man/secret-tool.1.en [direct, high]

2. **Secret Service is attribute-addressed D-Bus, not per-app sandboxed.** The spec pages describe items, collections, locking and prompts; items are found by attribute sets, and `GetSecret` returns the secret for a matched item. The pages I could reach (index, "Secret" structure, items/collections) contain **no per-application ACL and no statement that the calling client's identity is authenticated**. Operationally: any process on the same session bus that can resolve `org.freedesktop.secrets` can `SearchItems`/`GetSecret` for an unlocked collection. [interpretation, medium — the negative claim is from absent spec text plus known D-Bus semantics, not a quoted statement]
URL: https://specifications.freedesktop.org/secret-service/latest/

3. **libsecret is a client binding to Secret Service over D-Bus** ("Secret Service D-Bus client library"), exposing an error enum and a Service proxy object. The landing page does **not** document what happens when `org.freedesktop.secrets` is absent, so "no service ⇒ D-Bus name-resolution error surfaced as a GError" is inference, not quoted.
URL: https://gnome.pages.gitlab.gnome.org/libsecret/ [direct for the binding, medium; the failure-mode part is unverified]

4. **macOS `security(1)` invocations.** Set: `security add-generic-password -a "$USER" -s omarchy-bot -w "$SECRET" -U`; get: `security find-generic-password -a "$USER" -s omarchy-bot -w`; delete: `security delete-generic-password -a "$USER" -s omarchy-bot`. `-a` account and `-s` service are required; `-w` on add is documented as "Specify password to be added. Put at end of command to be prompted (recommended)". On find, `-w` means "Display the password(only) for the item found".
URL: https://keith.github.io/xcode-man-pages/security.1.html [direct, high]

5. **macOS access control is per-item, by creating app or `-T` list.** `-A` = "Allow any application to access this item without warning (insecure, not recommended!)"; `-T appPath` = "Specify an application which may access this item (multiple -T options are allowed)"; "By default, the application which creates an item is trusted to access its data without warning", and `-T ""` removes that default trust. So an item written by `bash`/`security` is trusted for that binary, and a *different* caller triggers the access prompt.
URL: https://keith.github.io/xcode-man-pages/security.1.html [direct, high]

6. **`-w` prints the secret to stdout** (the page says "Display the password(only)" and does not mention any GUI for that mode). The GUI prompt comes from the *keychain access check* (item created by another app / ACL mismatch), not from `-w` itself — inference from finding 5 plus Apple's documented "always allow / deny" dialog behaviour. Headless/SSH or launchd-agent-without-aqua contexts then fail with interaction-not-allowed style errors rather than prompting.
URL: https://keith.github.io/xcode-man-pages/security.1.html [interpretation, medium]

7. **Windows `PasswordVault` is a per-user Credential Locker** — "Represents a Credential Locker of credentials. Lockers are specific to a user" — with `Add`, `Retrieve`, `RetrieveAll`, `FindAllByResource`, `Remove`. Crucially for a daemon: "Apps not running in an AppContainer (for example, regular Desktop apps) can access all the user's lockers", so a non-packaged process is not blocked by packaging identity.
URL: https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.passwordvault [direct, high]

8. **Windows credential types.** "Generic credentials can be read and written by user processes" (domain credentials' secret is readable only in-process with the LSA, and apps may only *write* those). `CredWrite`/`CredRead` with `CRED_TYPE_GENERIC` is the same store `cmdkey /generic` writes to; scope is the user's credential set (per-user profile), which the overview page does not spell out.
URL: https://learn.microsoft.com/en-us/windows/win32/secauthn/credentials-management [direct for types, medium; per-user scoping and cmdkey specifics unverified]
URL: https://learn.microsoft.com/en-us/windows/win32/secauthn/kinds-of-credentials [direct, high]

9. **argv exposure.** Exposed: `security add-generic-password … -w "$SECRET"` (secret in `ps`/`/proc/<pid>/cmdline`, and it can land in shell history), and any PowerShell `-Command` string that embeds the secret. Not exposed: `printf '%s' "$SECRET" | secret-tool store …` (stdin), and Windows API calls (`CredWrite`, `PasswordVault.Add`) made from code that passes the secret as an argument, not as command text. The argv-free macOS path is `security add-generic-password -a … -s … -w` with `-w` last and the secret fed on stdin — the man page documents prompting, not stdin, so treat "piping works" as unverified.
URL: https://man.archlinux.org/man/secret-tool.1.en [interpretation, high for the exposure mechanics; medium for the macOS stdin workaround]

10. **Cost is one process spawn per call, plus (on Linux) a D-Bus round trip; on macOS IPC to `securityd`; on Windows a WinRT/CredRead call.** No published benchmarks were found in these sources. Mechanically: fork+exec+dynamic-link of `secret-tool`/`security` ≈ single-digit-to-tens of ms; D-Bus method round trip on a local socket ≈ sub-ms; a locked collection that must be unlocked adds a human-latency prompt. PowerShell adds a full .NET runtime start (~hundreds of ms cold, first call worst), which dwarfs every other cost and makes "spawn PowerShell per secret read" the wrong design; a native `CredRead` helper or keeping one PowerShell process alive are the sane options.
URL: https://learn.microsoft.com/en-us/windows/win32/secauthn/credentials-management [interpretation, medium — no numbers published in the fetched sources]

11. **Linux failure modes.** No session bus (headless server, container, `ssh` without forwarding, systemd unit with no user manager) ⇒ there is no `org.freedesktop.secrets` name to resolve, so `secret-tool` fails at connect time rather than returning an empty secret. A systemd *user* unit normally inherits `DBUS_SESSION_BUS_ADDRESS` from `systemd --user`'s environment; if the unit was started before the bus address was imported, import it once with `systemctl --user import-environment DBUS_SESSION_BUS_ADDRESS` (or `dbus-update-activation-environment`) and restart the unit. A locked collection means `GetSecret` either yields a prompt object (needs a prompter/UI that headless daemons lack) or errors — so a daemon must treat "locked" as an error path with a clear operator message, not a block.
URL: https://specifications.freedesktop.org/secret-service/latest/ [interpretation, medium — assembled from spec structure plus Linux/D-Bus behaviour; the exact error strings were not verified]

12. **The honest architecture takeaway.** These CLIs are fine for *provisioning* (set a secret once, interactively, as a human) and poor as a daemon's hot-path store: argv leaks on macOS, per-call process spawn everywhere, and no per-app isolation on Linux. A daemon should read the secret once at startup from an env var/file with 0600, or link a native library (`libsecret`, Security framework, `CredRead`) instead of shelling out.
URL: https://specifications.freedesktop.org/secret-service/latest/ [interpretation, medium]

## Unverified

- Exact Secret Service `OpenSession`/`SearchItems`/`GetSecret` signatures and any explicit statement on client authentication — the fetched spec pages were index/chapter fragments; the D-Bus interface pages were not reached (fetch budget exhausted, Exa search unavailable).
- `secret-tool` behavior when no session bus exists (exact stderr text, exit code).
- Whether `security add-generic-password … -w` reads a piped stdin secret (documented as a prompt only).
- macOS error codes for a headless/SSH access-check failure (`errSecInteractionNotAllowed` / -25308) — not confirmed from a fetched source.
- `cmdkey /generic` semantics (write-only; `/list` shows targets, not secrets) and per-user scoping of `CredWrite` blobs — not in the fetched Microsoft pages.
- Whether `PasswordVault` needs an interactive logon session / STA thread from a plain Win32 process (page is silent; it does require the WinRT projection, e.g. C#/WinRT or a PowerShell type-load, from desktop code).
- Any measured latency numbers for `secret-tool`, `security`, or PowerShell startup.
