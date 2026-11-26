# Threat model

Scope: secret storage for a desktop agent that runs as the user. Designs compared: (A) keychain via CLI tool, (B) keychain via native library, (C) 0600 file, (D) envelope encryption (DEK in keychain, ciphertext in local DB).

## Findings

1. **The Secret Service (Linux) API defines no client-application authentication.** The spec's §10 "What's not included in the API" states: "This specification does not mandate any form of access control. The service may choose to allow certain applications to access a keyring, and others." It defines no app identity, executable path, signature, or peer-credential check anywhere. §6 says "Open a unique session for the caller application" and "Once established, a session is bound to calling application's connection to the D-Bus session bus" — i.e. bound to a bus *connection*, not to a binary. Access control is entirely a per-implementation option.
URL: https://specifications.freedesktop.org/secret-service-spec/latest-single/ [direct, high]

2. **There are no per-application ACLs on items or collections in the Secret Service spec.** The closest statement, §8: "A service may choose to unlock items or collections just for a single client application. Alternatively the service may choose to allow any client application to access items or collections unlocked by another client application." Both behaviours are permitted, so a client cannot rely on being isolated from other clients of the same user.
URL: https://specifications.freedesktop.org/secret-service-spec/latest-single/ [direct, high]

3. **Consequence for Linux (inference): any same-user process that can reach the session bus can OpenSession → SearchItems → GetSecret on an unlocked collection.** The spec never states this verbatim, but it explicitly permits exactly this behaviour and mandates nothing that would prevent it. Confidence is high for spec-compliant services that do not add their own ACLs; implementations may deviate, and I did not verify gnome-keyring/KWallet internals.
URL: https://specifications.freedesktop.org/secret-service-spec/latest-single/ [interpretation, high]

4. **macOS `kSecAttrAccessible` does not gate other same-user processes — it gates device-lock state and restore eligibility.** Apple: "The `kSecAttrAccessible` attribute enables you to control item availability relative to the lock state of the device. It also lets you specify eligibility for restoration to a new device." Values: *When Unlocked* — "only accessible when the device is unlocked… the default"; *After First Unlock* — true once unlocked after a restart, "remains true until the device restarts"; *Always* — "always accessible, regardless of the locked state… not recommended"; *When Passcode Set* — "only access items with this setting if the device is unlocked", deleted if passcode removed. No cross-process restriction is claimed.
URL: https://developer.apple.com/documentation/security/restricting-keychain-item-accessibility [direct, high]

5. **macOS file-based keychain does have per-item ACLs, but they name *applications* (binaries), not users.** Technote TN3137: "The file-based keychain uses access control lists (`SecAccess`)" whereas "The data protection keychain uses keychain access groups, supplemented by an optional access control object (`SecAccessControl`)", and "the access control model of the file-based keychain is completely different than that of the data protection keychain". The man page defines `-T appPath` = "Specify an application which may access this item (multiple `-T` options are allowed)" and `-A` = "Allow any application to access this item without warning (insecure, not recommended!)".
URL: https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains [direct, high]
URL: https://keith.github.io/xcode-man-pages/security.1.html [direct, high]

6. **An item created by a CLI tool trusts that CLI tool by default — so `security find-generic-password -w` from any other process is running the trusted binary.** Man page: "By default, the application which creates an item is trusted to access its data without warning. You can remove this default access by explicitly specifying an empty app pathname: `-T \"\"`." `-w` is only documented as "Display the password(only) for the item found". Inference: because a macOS ACL entry is a *binary path*, a secret written via the `security` CLI is readable, without any prompt, by any same-user process that simply invokes the same `security` binary. The man page does **not** state what happens when an untrusted binary calls `-w` (prompt vs. denial).
URL: https://keith.github.io/xcode-man-pages/security.1.html [interpretation, medium — the "trusted by default" sentence is direct; the bypass-by-reinvocation step is inference]

7. **macOS CLI tools cannot hold keychain access groups, so the *data protection* keychain is materially harder for a same-user shell to reach than the login keychain.** TN3137: "The keychain support in the `security` command-line tool is primarily focused on the file-based keychain", and access-group entitlements are "standard for app and app extensions but not for command-line tools". This is the one real CLI-vs-library asymmetry I found, and it comes from code signing and entitlements — not from CLI-vs-library itself.
URL: https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains [direct, high]

8. **Windows Credential Manager scopes access to the logon session, with no documented per-credential DACL.** `CredReadW` docs: "The credential set used is the one associated with the logon session of the current token. The token must not have the user's SID disabled." No parameter or remark restricts which *application* may read a credential. Inference: any same-user process in the same logon session can read any of that user's generic credentials by target name.
URL: https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw [interpretation, medium-high — session scoping is direct; absence of an app-level DACL is "not documented", which is weaker than "proven absent"]

9. **ptrace is the only real barrier to cross-process memory reading on Linux, and it is off by default only under Yama scope ≥1.** scope 0: "a process can `PTRACE_ATTACH` to any other process running under the same uid, as long as it is dumpable". scope 1: the attacher "must have a predefined relationship with the inferior… By default, this relationship is that of only its descendants". scope 2: "only processes with `CAP_SYS_PTRACE`". scope 3: "no processes may use ptrace". Inference: scope 1 stops an unrelated same-user shell from attaching, but **not** an agent that spawned the secret-holding process (descendant relationship), and not a dumpable process under scope 0.
URL: https://www.kernel.org/doc/html/latest/admin-guide/LSM/Yama.html [direct, high for the quotes; interpretation for the agent-as-parent case, high]

10. **Per-threat matrix.** (i) *Disk theft/backups/sync*: (C) fails — a 0600 file is plaintext to anyone who obtains the bytes; only volume encryption or file-sync ACLs help. (D) holds — the DEK is not in the DB, so a DB/backup copy is useless; `…ThisDeviceOnly`-style attributes also limit restore to a new device (finding 4). (A)/(B) hold to the extent the platform keychain is encrypted at rest. (ii) *Other OS users*: all four hold — file mode 0600, per-user session bus, per-user logon session, keychain DACLs. (iii) *Same-user shell*: all four fail; see finding 11. (iv) *Memory dump*: all four fail once the secret is in the process; keychain designs merely narrow the window. (v) *Root/malware*: all four fail; root reads any keychain, file, or memory.
URL: https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw [interpretation, high]

11. **The decision-relevant answer: no — on Linux and Windows, reaching the keychain through a CLI tool versus a native library changes nothing for threat (iii).** The Secret Service spec mandates no client authentication and no per-app ACLs, and binds sessions to D-Bus connections rather than binaries (findings 1-2), so `secret-tool lookup`, a raw D-Bus call, and a libsecret call are indistinguishable to the service: same uid, same session bus, same unlock state. Windows likewise scopes only to the logon session (finding 8). On macOS the distinction is not "CLI vs library" but "which binary the ACL names" (findings 5-7): a library-linked app is trusted under its own signature, while a CLI-created item is trusted under the CLI's path and is therefore reachable by re-invoking that CLI. Choosing a native library buys nothing against a same-user shell; only the data protection keychain plus access groups (which requires a signed, app-bundled helper) does, and only on macOS.
URL: https://specifications.freedesktop.org/secret-service-spec/latest-single/ [interpretation, high]

12. **Practical corollary (inference): the CLI path is weakly *worse*, not better.** A CLI tool adds exposure vectors a linked library does not: argv is visible in `ps`/`/proc/*/cmdline` to same-user processes, environment variables (`DEBUG`, `SSLKEYLOGFILE`-style) and wrapper scripts/shell history leak, and the tool's own path becomes the trusted identity in any ACL model. None of these is a defence improvement.
URL: https://keith.github.io/xcode-man-pages/security.1.html [interpretation, medium]

## Unverified

- Electron `safeStorage` limits and same-user threat language: both the security tutorial and the `safeStorage` discussion returned no substantive text, so nothing is claimed. Do not cite Electron for this.
- OWASP LLM Top 10 / LLM01 prompt-injection framing on exfiltration via tool use, and whether any entry covers an agent with shell access reading local credentials: not fetched (budget exhausted). No claim made.
- Whether macOS prompts or silently denies when an *untrusted* binary calls `security find-generic-password -w`. The man page is silent; I did not find the answer in TN3137 either. This matters for (A) on macOS and should be tested empirically.
- Whether gnome-keyring or KWallet add de-facto per-application ACLs beyond the spec. The spec permits either behaviour (finding 2), so this is implementation-specific and untested here.
- `kSecAttrAccess`/`SecAccess` reference page contained no text on trusted applications or prompt behaviour; the TN3137 and man-page quotes are the basis for findings 5-6.

## Sources

- Kept: Secret Service API spec (https://specifications.freedesktop.org/secret-service-spec/latest-single/) — the only authoritative statement that access control is optional and sessions bind to bus connections.
- Kept: Apple TN3137 on Mac keychains (https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains) — distinguishes file-based ACLs from data-protection access groups; CLI tools lack access groups.
- Kept: Apple "Restricting keychain item accessibility" (https://developer.apple.com/documentation/security/restricting-keychain-item-accessibility) — proves `kSecAttrAccessible` is about lock state/restore, not peer processes.
- Kept: `security(1)` man page (https://keith.github.io/xcode-man-pages/security.1.html) — `-T`, `-A`, and "creator is trusted by default".
- Kept: `CredReadW` docs (https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw) — logon-session scoping.
- Kept: Yama LSM docs (https://www.kernel.org/doc/html/latest/admin-guide/LSM/Yama.html) — ptrace_scope semantics.
- Rejected: `https://specifications.freedesktop.org/secret-service/latest/` — title page only, no substantive text.
- Rejected: `https://developer.apple.com/documentation/security/ksecattraccessible` and `.../ksecattraccess` — key stubs pointing elsewhere.
- Rejected: `https://www.electronjs.org/docs/latest/tutorial/security` — no extractable text on same-user threats or `safeStorage`.

## Next steps

1. Empirically test on macOS: create an item with `security add-generic-password`, then read it from an unrelated binary via `security find-generic-password -w` — confirm no prompt.
2. Test on Linux whether the target keyring implementation isolates clients (spec permits either).
3. Read `safeStorage` docs and OWASP LLM01 separately if Electron or prompt-injection framing is needed.
