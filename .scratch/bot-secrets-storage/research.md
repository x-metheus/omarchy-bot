# Saving sensitive data: backend choice for the secret store

Implement a `Bun.secrets` adapter now, with the existing private file as the fallback when the capability probe
on first asynchronous use fails for a never-promoted data directory; this adds no package dependency and
matches the platform stores named by the spec
([Bun secrets](https://bun.com/docs/runtime/secrets)) (direct, high).
The keychain does not stop the Bot's own shell: access depends on service policy, item policy, unlock state,
and the caller's OS context; the shell runs as the same OS user and can reach the same credential service
under the ordinary configurations considered here ([Secret Service
specification](https://specifications.freedesktop.org/secret-service-spec/latest-single/);
[CredReadW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw))
(interpretation, high on Linux where no extra ACLs are configured; medium-high on Windows).
The keychain primarily improves protection of stored values against offline copies and casual disclosure,
subject to platform and backup configuration ([Bun secrets](https://bun.com/docs/runtime/secrets))
(interpretation, medium).
Exact-value redaction reduces direct disclosure in supported tool results, but is not a general guarantee
against transformed values, network exfiltration, or a shell reading a store directly (project source map,
`.scratch/bot-secrets-storage/raw/scout-store.md`; interpretation).
Bun labels the API experimental, and only the Linux path has been exercised in the supplied first-hand probe;
macOS and Windows remain unverified ([Bun secrets](https://bun.com/docs/runtime/secrets);
`.scratch/bot-secrets-storage/raw/probe-bun-secrets.md`) (direct, high).

## What Task 22 already has

The following describes the supplied branch map, not a fresh checkout:
`.scratch/bot-secrets-storage/raw/scout-store.md` (direct, high).

- `SecretBackend` has `get`, `set`, and `delete`; values are strings, absence is `undefined`, and deleting an absent account succeeds.
- `runtime.ts` supplies no keychain backend, so the production selection is always the private file.
- App and Bot scopes are separate; the account is a hash of scope and name, and keychain accounts also carry a data-directory namespace.
- A metadata index supplies enumeration; backends need no list operation.
- Migration reads values back before deleting the old file; a truncated or altered value fails verification.
- Opening a keychain store makes an already-live fallback store for that data directory read-only for writes.
- Promotion deletes the fallback file, so a backend must actually replace the file, not mirror it.
- The backend is selected from `dataDir`; initialization is lazy in the current store shape.
- Backend kind is a closed `keychain | file` union consumed by the status API and Settings.
- Selecting an external library is an ask-first dependency decision in Task 22; real Linux keychain coverage remains manual.
- Shell inheritance is the six-variable allowlist `PATH, HOME, LANG, TMPDIR, USER, SHELL`; `DBUS_SESSION_BUS_ADDRESS` is not inherited.
- On this branch placeholder filling and exact-value output redaction are wired for `bash`; the map says `web_fetch` and MCP integration live on separate branches.

## Comparison table

Protection cells are ordered **disk theft/backups; other OS users; same-user shell; memory dump**.
✅ means protection under the stated conditions, ❌ means no reliable protection, and partial means it depends
on key custody, configuration, or exposure timing.
The table assumes a normal unlocked session and no additional application-specific access policy; the prose
gives the evidence and exceptions.
An encrypted credential copied together with usable key material is not protected merely because it is
encrypted ([Bun secrets](https://bun.com/docs/runtime/secrets); [Secret Service
specification](https://specifications.freedesktop.org/secret-service-spec/latest-single/)) (interpretation,
high).

| Option | Protects against | Dependencies | Platform coverage | Headless Linux | Failure modes | Bun support |
|---|---|---|---|---|---|---|
| Bun.secrets | partial; ✅; ❌; ❌ | Bun, OS service | Linux/macOS/Windows | Needs service | Experimental; locked/unavailable | Built in |
| secret-tool/libsecret CLI | partial; ✅; ❌; ❌ | CLI, Secret Service | Linux | Needs bus/service | Missing tool, lock, bus | Subprocess |
| macOS `security` CLI | partial; ✅; ❌; ❌ | macOS CLI | macOS | N/A | Prompt, argv, ACL | Subprocess |
| PowerShell PasswordVault | partial; ✅; ❌; ❌ | PowerShell, WinRT | Windows | N/A | Runtime/session access | Subprocess |
| @napi-rs/keyring | partial; ✅; ❌; ❌ | Native package | Multiple | Service or volatile keyutils | Native packaging; volatile fallback | N-API, unverified package |
| keytar (archived) | partial; ✅; ❌; ❌ | Native package, libsecret | Linux/macOS/Windows | Needs service | Archived; native builds | N-API, unverified package |
| 0600 file | ❌; ✅ on POSIX, unverified on Windows; ❌; ❌ | Private filesystem | Project targets | Yes | Plaintext; permissions | Built in |
| Envelope encryption | partial; ✅; ❌; ❌ | AEAD, key custody | Cross-platform | Needs key source | Key loss; nonce errors | Crypto available |
| systemd-creds/TPM2 | partial; ✅; ❌; ❌ | systemd, host key/TPM | Linux | Yes | Host binding, provisioning | External command |
| Electron safeStorage | partial; ✅; partial; ❌ | Electron main process | Linux/macOS/Windows | `basic_text` risk | Backend fallback | Not in daemon |
| Tauri Stronghold | partial; partial; partial; ❌ | Tauri/Rust, vault password | Tauri-supported | Password needed | Password custody/loss | No direct API |
| age / sops | partial; partial; partial; ❌ | Identity, KMS, or passphrase | Cross-platform | Key needed | Key custody | External integration |
| pass | partial; partial; partial; ❌ | GPG, agent or passphrase | Primarily Unix | Key needed | Agent/key custody | Subprocess |
| VS Code SecretStorage | partial; partial; unverified; ❌ | Extension host, platform storage | VS Code platforms | Backend dependent | Backend custody | Extension API |
| GitHub CLI token storage | partial; partial; ❌; ❌ | Credential store or file | Cross-platform | File fallback | Plaintext fallback | Subprocess |
| Docker credential helpers | partial; partial; partial with a helper, ❌ with config-file fallback; ❌ | Helper or config file | Cross-platform | Backend dependent | Base64 fallback | Subprocess |

For Electron and Tauri, same-user protection depends on application integration and key custody; it is not
demonstrated for this daemon ([Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage);
[Tauri Stronghold](https://v2.tauri.app/plugin/stronghold/)) (interpretation, medium).

## Option by option

### Bun.secrets

Bun exposes asynchronous `get`, `set`, and `delete` backed by Linux Secret Service, macOS Keychain, and
Windows Credential Manager ([Bun secrets](https://bun.com/docs/runtime/secrets); [Bun
release](https://bun.com/blog/bun-v1.2.21)) (direct, high).
`get` returns `null` for a missing item and `delete` returns a boolean; the API is explicitly experimental
([Bun secrets](https://bun.com/docs/runtime/secrets)) (direct, high).
A local Linux probe saw exact read-back, replacement, deletion, and an 8192-byte round trip (measured locally
on Linux with Bun 1.4.5, 2026-11-25; `.scratch/bot-secrets-storage/raw/probe-bun-secrets.md`) (direct).
No macOS, Windows, locked-keyring, or compiled-executable test is included in that probe.
**Verdict:** the best fit for the existing seam, subject to the experimental API and cross-platform
verification.

### secret-tool / libsecret CLI

`secret-tool` addresses items by attribute pairs, writes a password from stdin, and returns a lookup value on
stdout ([secret-tool manual](https://man.archlinux.org/man/secret-tool.1.en)) (direct, high).
It needs a reachable Secret Service and adds a process invocation for each operation
([libsecret](https://gnome.pages.gitlab.gnome.org/libsecret/); [secret-tool
manual](https://man.archlinux.org/man/secret-tool.1.en)) (interpretation, high).
A locked collection can require interaction; precise headless failures were not verified in the source notes
([Secret Service specification](https://specifications.freedesktop.org/secret-service-spec/latest-single/))
(interpretation, medium).
**Verdict:** workable for Linux provisioning, unnecessary as the primary Bun backend.

### macOS `security` CLI

The system command supports generic-password creation, lookup, and deletion; `find-generic-password -w`
displays the password ([security manual](https://keith.github.io/xcode-man-pages/security.1.html)) (direct,
high).
Supplying the value as a command argument can expose it through process arguments; the manual documents
interactive prompting when `-w` is the last argument, but piped input behavior remains unverified ([security
manual](https://keith.github.io/xcode-man-pages/security.1.html)) (interpretation, medium).
Its default trusted-creator behavior makes the CLI binary itself relevant to item access ([security
manual](https://keith.github.io/xcode-man-pages/security.1.html)) (direct, high).
**Verdict:** avoid as the daemon's hot-path backend.

### Windows PowerShell PasswordVault

`PasswordVault` represents a user-specific Credential Locker, with add, find, retrieve, and remove operations;
desktop apps outside an AppContainer can access the user's lockers
([PasswordVault](https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.passwordvault))
(direct, high).
Calling it from PowerShell requires a WinRT projection and process management; exact session requirements were
not established in the source notes
([PasswordVault](https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.passwordvault))
(interpretation, medium).
Embedding values in command text creates avoidable exposure; no latency benchmark was supplied.
**Verdict:** unnecessary subprocess and integration complexity for this daemon.

### @napi-rs/keyring

The package provides synchronous and asynchronous entries with prebuilt native targets
([package](https://www.npmjs.com/package/@napi-rs/keyring);
[registry](https://registry.npmjs.org/@napi-rs/keyring/latest)) (direct, high).
Its Linux binaries statically link vendored `libdbus`, licensed `AFL-2.1 OR GPL-2.0-or-later`, despite the
package's MIT license ([package](https://www.npmjs.com/package/@napi-rs/keyring);
[registry](https://registry.npmjs.org/@napi-rs/keyring/latest)) (direct, high).
The documented Linux default can fall back to nonpersistent kernel keyutils; pinning Secret Service avoids
silently treating volatile storage as durable ([repository](https://github.com/Brooooooklyn/keyring-node))
(direct, high).
Bun supports most Node-API extensions, but this specific package was not tested here ([Bun
Node-API](https://bun.com/docs/runtime/node-api)) (direct, high).
**Verdict:** an extra dependency and license review without a demonstrated security advantage.

### keytar (archived)

The upstream repository is archived; the package has native installation/build requirements, including Linux
libsecret development headers for source builds ([repository
metadata](https://api.github.com/repos/atom/node-keytar); [package](https://www.npmjs.com/package/keytar))
(direct, high).
Archival is a maintenance signal, not proof of an npm deprecation notice
([package](https://www.npmjs.com/package/keytar)) (direct, high).
Bun's general Node-API compatibility does not establish that this particular addon works in the target build
([Bun Node-API](https://bun.com/docs/runtime/node-api)) (interpretation, high).
**Verdict:** do not introduce an archived native dependency.

### 0600 file

Task 22's fallback keeps values in a JSON file with enforced POSIX 0600 file and 0700 directory modes;
other-user protection is unverified on Windows because no Windows ACL implementation is evidenced. The shell
policy guards its path and identity (branch map: `.scratch/bot-secrets-storage/raw/scout-store.md`) (direct,
high).
The file is plaintext, so a copied backup exposes values even when filesystem permissions were restrictive
(interpretation, high).
The same-user shell is outside the file-policy security boundary and can read as that OS user (project threat
model, `.scratch/bot-secrets-storage/raw/t4-threat-model.md`) (interpretation, high).
**Verdict:** appropriate explicit fallback, with a clear Settings warning.

### Envelope encryption

A random data-encryption key (DEK) can reside in a keychain while authenticated ciphertext and unique nonces
reside in SQLite; associated data can bind a ciphertext to its name (design inference;
`.scratch/bot-secrets-storage/raw/t5-other-designs.md`) (interpretation, high).
This can protect a database-only backup and reduce keychain calls, but loses that protection if the usable DEK
is copied or retrieved by the same-user shell.
Rewrapping can help future key rotation, while introducing nonce, key-loss, migration, and recovery
responsibilities.
**Verdict:** defer until value size, export, or measured round-trip costs justify it.

### systemd-creds / TPM2

`systemd-creds` supports encrypted credentials bound to a host key and/or TPM2, with optional user-scoped
credentials and TPM policy ([systemd-creds
manual](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html)) (direct, high).
It is suited to headless Linux but requires provisioning and cannot establish a general running-process
boundary against a same-user shell without additional isolation (interpretation, medium).
TPM availability and policy determine what offline copying or machine changes prevent ([systemd-creds
manual](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html)) (interpretation, high).
**Verdict:** future server-specific improvement, not the cross-platform default.

### Electron safeStorage

`safeStorage` is an Electron main-process API using platform facilities; on Linux
`getSelectedStorageBackend()` can report `basic_text` ([Electron
safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)) (direct, high).
For the synchronous Linux API, Electron warns that the `basic_text` fallback uses a hardcoded plaintext
password and is unprotected; its async Linux API describes a separate fallback provider ([Electron
safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)) (direct, high).
Its macOS documentation describes protection against other applications without user override, but does not
establish the details for this daemon ([Electron
safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)) (direct, high).
**Verdict:** not a Bun daemon API, and fallback detection remains necessary.

### Tauri Stronghold

The Tauri plugin offers an encrypted vault loaded with a vault path and password; its example shows password
hashing ([Tauri Stronghold](https://v2.tauri.app/plugin/stronghold/)) (direct, medium).
The password must come from somewhere and its lifecycle determines whether the vault protects a headless host
or a same-user process (interpretation, high).
The supplied research did not verify a Tauri keyring plugin or a direct Bun API ([Tauri
Stronghold](https://v2.tauri.app/plugin/stronghold/)) (direct, medium).
**Verdict:** a different password-managed product design, not a drop-in backend.

### age / sops

These designs encrypt files to identities or other key providers; decryption authority lives with the
identity, KMS, or a human-supplied passphrase. A same-user process that can reach an unlocked identity can
also use it (design inference). This description is background design knowledge, not fetched primary
documentation, and the supplied notes mark its specifics unverified (`.scratch/bot-secrets-storage/raw/t5-other-designs.md`).
**Verdict:** useful for sharing encrypted files, but key custody remains the problem.

### pass

`pass` stores GPG-encrypted files, with decryption authority held by the GPG key and agent or a human
passphrase ([password store](https://passwordstore.org/)) (direct, high).
A same-user process able to use the unlocked agent can request decryption (interpretation, medium).
**Verdict:** useful for human-managed secrets, with agent and passphrase custody to manage.

### VS Code SecretStorage

The extension API provides encrypted, extension-scoped storage ([VS Code API](https://code.visualstudio.com/api/references/vscode-api))
(direct, high). Decryption authority resides in VS Code and its platform storage integration; the supplied
reference does not establish a same-user boundary (interpretation, medium).
**Verdict:** an extension-host abstraction, not a Bun daemon backend.

### GitHub CLI token storage

`gh` uses a system credential store or falls back to a plaintext file ([gh auth login](https://cli.github.com/manual/gh_auth_login))
(direct, high). Decryption authority resides with the credential store and its user context, or file access
controls on fallback; a same-user process with access can retrieve the token (interpretation, medium).
**Verdict:** a precedent for an explicit plaintext fallback.

### Docker credential helpers

Docker delegates credential storage to a configured helper, or falls back to base64 in its config file
([Docker login](https://docs.docker.com/reference/cli/docker/login/)) (direct, high). Decryption authority
lives with the helper's underlying store, agent, or passphrase; same-user access depends on that store's policy.
**Verdict:** useful backend indirection, but not an independent same-user boundary.

## The threat model, honestly

### Disk theft, backups, file sync

**Keychains:** Bun documents encryption at rest for its credential-store API, so keychain storage can protect
against a copied application data directory that does not include usable keychain material ([Bun
secrets](https://bun.com/docs/runtime/secrets)) (direct plus interpretation, high).
On Windows Bun defaults to enterprise persistence, which can expose credentials to other sessions of the
same user and allow roaming; the adapter should use local persistence instead ([Bun secrets](https://bun.com/docs/runtime/secrets))
(direct plus recommendation). Whether a full backup, synced profile, stolen unlocked device, or restored keychain exposes an item depends on
the platform and item configuration; do not treat a copied application directory and a complete machine image
as equivalent ([Apple
accessibility](https://developer.apple.com/documentation/security/restricting-keychain-item-accessibility);
[DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)) (direct plus
interpretation, high).
Apple's accessibility attribute governs device lock state and restore eligibility; it does not itself prove
per-process isolation ([Apple
accessibility](https://developer.apple.com/documentation/security/restricting-keychain-item-accessibility))
(direct, high).

**Plain file:** mode 0600 does not encrypt bytes in a copied file; disk encryption or backup controls are
separate protections (interpretation, high).
**Envelope:** a ciphertext-only database copy is protected only while its DEK remains unavailable to the
recipient (design inference, high).
**systemd credentials:** host/TPM binding can protect an offline copy subject to the configured host key and
policy ([systemd-creds](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html))
(interpretation, high).

### Other OS users

Under normal OS permission and login separation, each option can protect against an unrelated unprivileged OS
user; this assumes private files and a properly configured credential service, not shared credentials or
privileged access (interpretation, high).
On Linux the fallback uses 0600 files in a 0700 directory; the user's session bus and credential service
supply the corresponding separation for Secret Service (branch map,
`.scratch/bot-secrets-storage/raw/scout-store.md`; [Secret Service
specification](https://specifications.freedesktop.org/secret-service-spec/latest-single/)) (interpretation,
medium).
On macOS user keychains and item access controls provide the relevant separation ([Apple
TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)) (interpretation,
medium).
On Windows `CredReadW` uses the credential set associated with the current token's logon session; DPAPI
typically ties decryption to matching user logon credentials
([CredReadW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw);
[DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)) (direct, high).
Stronghold and envelope encryption only hold when vault passwords or DEKs are kept from the other user; a
password in a world-readable file would defeat the premise (interpretation, high).

### A Bot's shell running as the same user

**The keychain does not stop the Bot's own shell.** Access depends on service policy, item policy, unlock
state, and the caller's OS context. The workspace is not a sandbox, so store-level Bot scopes
and guarded paths cannot impose an OS-user boundary on arbitrary shell code (project specification,
`docs/specs/bot-runtime.md`; branch map, `.scratch/bot-secrets-storage/raw/scout-store.md`) (interpretation,
high).
A Bot can use a normal program or runtime to ask an available credential service for an item, subject to the
actual service policy and unlock state.

**Linux:** the Secret Service specification identifies itself as a 0.2 DRAFT and is a moving reference.
It does not mandate client-application authentication or
per-application ACLs; it explicitly leaves access control to implementations ([Secret Service
specification](https://specifications.freedesktop.org/secret-service-spec/latest-single/)) (direct, high).
It binds an opened session to a D-Bus connection, not to a particular binary identity; it permits an
implementation to unlock for one client or for all clients ([Secret Service
specification](https://specifications.freedesktop.org/secret-service-spec/latest-single/)) (direct, high).
Thus a reachable unlocked service without extra application policy can be queried by a same-user client
through `secret-tool lookup` or raw D-Bus, regardless of which client originally stored the value ([Secret
Service specification](https://specifications.freedesktop.org/secret-service-spec/latest-single/);
[secret-tool manual](https://man.archlinux.org/man/secret-tool.1.en)) (interpretation, high for that
configuration).
The supplied research did not verify whether specific GNOME Keyring or KWallet versions add effective
restrictions; no universal bypass claim follows from an optional-access-control specification.

**Windows:** `CredReadW` selects credentials by the current token's logon session, and its documentation does
not specify a per-credential application DACL
([CredReadW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw);
[CREDENTIALW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw)) (direct for
scope; interpretation, medium-high for lack of per-app isolation).
A same-session process knowing the target is expected to read a generic credential through the API or a short
script; this is an inference, not an independently measured Windows result ([CredReadW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw);
[CREDENTIALW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw))
(interpretation, medium). `bash` is unsupported on Windows on this branch: the exposure is another
same-session process today, and a future Windows shell (branch map, `.scratch/bot-secrets-storage/raw/scout-store.md`).
PasswordVault's documented desktop-app access similarly does not establish a boundary between ordinary
same-user desktop processes
([PasswordVault](https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.passwordvault))
(interpretation, medium).

**macOS:** file-based keychains use per-item ACLs naming trusted applications, while data-protection keychains
use access groups and optionally access control objects ([Apple
TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains); [security
manual](https://keith.github.io/xcode-man-pages/security.1.html)) (direct, high).
The `security` manual says the application creating an item is trusted by default; it documents `-T` for
trusted application paths and `-w` for displaying a found password ([security
manual](https://keith.github.io/xcode-man-pages/security.1.html)) (direct, high).
It is therefore plausible that a same-user process re-invoking the trusted `security` binary can retrieve an
item created through that CLI, but this specific no-prompt bypass was **not measured** and must not be
presented as established fact ([security manual](https://keith.github.io/xcode-man-pages/security.1.html))
(interpretation, medium).
For items created by a different binary, prompt or denial behavior is also unverified; Bun's actual macOS
identity and item configuration need a test.
A signed app-bundled binary with the appropriate data-protection keychain access group can provide a stronger
application gate;
Apple says the `security` tool is primarily focused on the file-based keychain and access-group entitlements
are standard for apps rather than command-line tools ([Apple
TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)) (direct plus
interpretation, medium).
The evidence does not establish that *every* CLI or every signed helper categorically lacks or gains an
entitlement.

**Decision:** reaching the keychain through a CLI versus a native library changes no demonstrated same-user
boundary on Linux or Windows. On macOS, for a file-based keychain item, the trusted creator identity affects
prompting. A genuine application boundary needs the data-protection keychain plus access groups, requiring a
signed, entitled, app-bundled binary and a provisioning profile. Neither `Bun.secrets` nor a small keychain
library establishes that gate by itself for this daemon ([Secret Service
specification](https://specifications.freedesktop.org/secret-service-spec/latest-single/);
[CredReadW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw); [Apple
TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)) (interpretation,
medium-high).
`secret-tool lookup`, a raw D-Bus client, `security find-generic-password -w`, or a short Windows script are
representative routes where their respective access conditions permit; they are not proven to defeat every
possible keychain configuration.
No backend choice here should be justified as reliable same-user resistance.

### Memory dumps

All options fail to protect a value once an attacker can read the daemon heap while that value is present; a
keychain can reduce persistent plaintext copies and the time a value needs to be retained, not eliminate
runtime plaintext (interpretation, high).
Linux Yama scope 0 permits same-UID attach to a dumpable process; scope 1 normally restricts attach to a
predefined relationship, and stricter modes restrict it further
([Yama](https://www.kernel.org/doc/html/latest/admin-guide/LSM/Yama.html)) (direct, high).
The source does not establish the default scope on any distribution, and parent/descendant relationships
matter ([Yama](https://www.kernel.org/doc/html/latest/admin-guide/LSM/Yama.html)) (direct plus interpretation,
high).
Yama describes dumpability as a condition on attach; its application to this daemon has not been verified
([Yama](https://www.kernel.org/doc/html/latest/admin-guide/LSM/Yama.html)) (direct plus interpretation, high).
Bun says its API “avoids exposing secrets in process memory dumps” via zeroing, but `get()` returns a plain
string to the caller and nothing documents that an in-use value is excluded from a dump ([Bun secrets](https://bun.com/docs/runtime/secrets))
(direct plus interpretation, high). The live-heap caveat therefore stands.

### Root or malware

Root or malware with equivalent control defeats all these options, including by accessing plaintext during use
(threat-model inference, `.scratch/bot-secrets-storage/raw/t4-threat-model.md`) (interpretation, high).

### What that means for the spec's claim

The current success criterion at `docs/specs/bot-runtime.md:44` reads:

> No secret value is kept in a plain file that a Bot's shell can read where an OS keychain is available, or is sent to a model by the app.

The store bullet at `docs/specs/bot-runtime.md:207` reads:

> **Store:** the OS keychain: Secret Service on Linux, Keychain on macOS, and Credential Manager on Windows. Where no keychain is available, such as a server without Secret Service, the Service falls back to a file in its data directory readable only by your user, and Settings warns that a Bot's shell could read it. Keychain access uses one small library or the platform's command-line tool; which one is an ask-first dependency decision.

The no-plain-file clause is literally true for successfully migrated values when the keychain is used and old
plaintext copies are removed; it does not say the shell cannot retrieve the value from the keychain
(interpretation based on branch map).
Read as a security promise, however, it is misleading: the Bot's shell can obtain the value from the
keychain under the access conditions described above.
The no-model-disclosure goal is materially supported for exact occurrences in the implemented redaction paths,
but a blanket guarantee is not established: the branch map only verifies `bash`, and transformations or
shell-driven exfiltration are outside exact-match redaction (branch map,
`.scratch/bot-secrets-storage/raw/scout-store.md`) (interpretation, high).

Recommended replacement:

> When an OS keychain is available, the Service stores secret values there instead of in its plaintext fallback file. If the keychain is unavailable, a never-promoted data directory uses a user-readable private file and warns in Settings; a promoted directory reports an availability error instead. Tool results replace exact occurrences of values used in that call before the app stores the results or sends them to the model. A Bot's same-user shell is not isolated from the user's keychain or fallback file, and redaction does not prevent transformed or out-of-band disclosure.

The surviving claims are keychain rather than plaintext fallback storage, subject to successful migration, and
exact-value redaction in each actually integrated tool path; neither is a promise that an adversarial shell
cannot obtain a value.

## Shell hardening: would it help?

Removing `secret-tool`, `security`, `dbus-send`, or `gdbus` from `PATH`, or removing a bus address from the
environment, does not create a security boundary against a Bot controlling shell arguments (interpretation,
high).
A Bot controlling argv can call an available binary, interpreter, or socket by absolute path; ordinary tools
can supply code execution or communication paths, though their presence on a specific installation is not
established (interpretation, high).
Removing selected `PATH` entries is a denylist against an actor who controls argv, not application isolation
(interpretation, high).

Task 22 already sets `inheritEnv = false` and inherits only `PATH, HOME, LANG, TMPDIR, USER, SHELL`;
`DBUS_SESSION_BUS_ADDRESS` is not in that list (branch map, `.scratch/bot-secrets-storage/raw/scout-store.md`)
(direct, high).
That is real mitigation for accidental environment-variable leakage, though the tool's per-call environment
can add variables; it does not stop a determined same-user Bot from using another available route
(interpretation, high).
Hiding commands or a single environment variable as a claimed same-user barrier is theatre; an OS-enforced
isolation boundary would be a different product design.

## Recommendation

Implement `BunSecretsBackend implements SecretBackend` now and inject it into the existing store after a
capability decision; retain the file backend when no usable keychain is detected for a never-promoted data directory ([Bun
secrets](https://bun.com/docs/runtime/secrets); branch map, `.scratch/bot-secrets-storage/raw/scout-store.md`)
(interpretation, high).
The three asynchronous methods map directly to the seam, require no added dependency, and cover the three
platforms named by the spec ([Bun secrets](https://bun.com/docs/runtime/secrets)) (direct, high).
This avoids Task 22's ask-first **external dependency** decision; acceptance of Bun's experimental API remains
an explicit product decision.

### Integration shape

Use a fixed application-specific `service` string and the account passed by `SecretStore` as Bun's `name`.
The existing keychain account already includes `sha256(realpathSync(dataDir))` followed by the hashed
scope/name, so rehashing the data directory into `service` would duplicate existing isolation (branch map,
`.scratch/bot-secrets-storage/raw/scout-store.md`) (direct plus interpretation, high).
The adapter can be constructed from `dataDir` through the existing store wiring and needs no separate external
configuration.

- Set the backend's `kind` to `keychain`.
- On Windows pass `persist: "local"` to `set`, avoiding the default `"enterprise"` persistence, which can be available across same-user sessions and roam.
- Convert `get()` returning `null` to `undefined`.
- Treat `delete()` returning `false` as successful absence.
- Propagate operation errors to the store's existing value-free error handling; a thrown probe error means keychain unavailable **for selection**, not that an already selected keychain can safely be downgraded.
- Retain read-back verification, fallback-file removal after verified migration, and the live-fallback read-only promotion rule.

Bun documents missing `get` as `null` and missing `delete` as `false` ([Bun secrets](https://bun.com/docs/runtime/secrets))
(direct, high). The `kind`, `null` to `undefined` mapping, and successful deletion of an absent item come
from the project `SecretBackend` contract (`.scratch/bot-secrets-storage/raw/scout-store.md`) (direct, high).
Avoid falling back on a later read or write error: an inaccessible existing keychain must not silently create
a divergent file store (design inference, high).

### Probe and migration

Keep `SecretStore(dataDir)` construction synchronous and `forApp()`/`forBot()` callable before async
initialization. Select the backend lazily, for example with the existing `keychain?` parameter and an async
`#ensureBackend()` inside the already-async `#run`; the first async operation resolves and memoises selection,
and `kind` reports that memoised result. The constructor does not currently probe. `/api/secrets/status` and
the Settings banner must render a “checking” state or be read after first use, a small change to the existing
`kind` union usage (branch map, `.scratch/bot-secrets-storage/raw/scout-store.md`) (design recommendation).

Probe a reserved unique throwaway account whose name cannot collide with real accounts: (1) `get` a sentinel
that should be absent and require `null`, (2) `set` a random value then `get` and compare exactly, and
(3) `delete` it and confirm deletion. Bound all three steps with a short timeout, e.g. 5 seconds; Bun says a
locked collection “may prompt for unlock”. Any rejection, timeout, or mismatch means keychain unavailable
for selection. A *successful* probe writes and deletes one throwaway item; after a failed or timed-out write or
read-back, attempt a bounded cleanup of that unique account so a stuck item is not left behind. Even so, the
probe does not establish durability or other item access, nor macOS or Windows behavior on an unpromoted host
([Bun secrets](https://bun.com/docs/runtime/secrets)) (direct plus recommendation).

The supplied Linux probe unset `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR`; it did not stop the bus or
remove the runtime directory. It rejected after trying `dbus-launch --autolaunch`; with the bus available,
the absent sentinel returned `null` (measured locally on Linux with Bun 1.4.5, 2026-11-25;
`.scratch/bot-secrets-storage/raw/probe-bun-secrets.md`) (direct).

Persist a small promotion marker in the data directory recording that it has been promoted to the keychain.
If the marker is present and the probe fails, do not create or write a fallback store; return a value-free
availability error such as the existing “Unable to read secret”. Automatic fallback is allowed only without a
marker, for a new or never-promoted directory. A non-empty `secret-values.json` without a marker counts as not
promoted, so an existing fallback installation can still be promoted later; retain verified migration and the
live-store write guard (design recommendation).

Two ordering rules matter more than the marker itself, because a crash between steps otherwise leaves either
both copies or neither:

1. **The marker must be durable before the fallback file is unlinked.** If the process dies between writing the
   marker and removing `secret-values.json`, a restart sees both. Keep fallback writes disabled in that state,
   verify the staged values against the actual keychain items, and then retry the removal. If verification
   fails, keep the file for recovery and return a value-free error rather than deleting data the keychain does
   not hold. The same rule covers a data-directory restore that brings back a marker and file whose keychain
   items no longer exist.
2. **A fresh directory must be marked before its first keychain-backed save.** A new data directory has no
   fallback file to migrate, so “write the marker after verified migration” never fires. Write the marker
   before accepting the first keychain write, so a later probe failure cannot silently select the plaintext
   fallback for a directory that does hold keychain values.

Tests to add: promote with a non-empty file, restart with the probe forced to fail, and assert no fallback file
is created and reads fail with a value-free error; a fresh directory that saves one keychain secret, then
restarts with a failed probe, and likewise stays off the file; and a simulated crash after the marker is
durable but before the file is unlinked, asserting recovery verifies against the keychain before removing the
file.

### Size and platform status

Bun documents a platform-dependent maximum typically in the 2048–4096 byte range; it is guidance, not a
demonstrated universal hard ceiling ([Bun secrets](https://bun.com/docs/runtime/secrets)) (direct, high).
An 8192-byte value round-tripped in the supplied local probe (measured locally on Linux with Bun 1.4.5,
2026-11-25; `.scratch/bot-secrets-storage/raw/probe-bun-secrets.md`) (direct).
Do not add chunking now, but do not promise unbounded blobs; surface a clear value-free failure if a platform
rejects a value and preserve the old data during failed migration (recommendation).
Linux has a hand-verified basic path only; macOS and Windows behavior rests on Bun's documentation and is
unverified here ([Bun secrets](https://bun.com/docs/runtime/secrets); local probe) (direct, high).
Test the actual shipping runtime and platform before claiming platform coverage beyond documented support.

### Should the spec or design change?

1. Replace the dependency sentence with: “Keychain access uses Bun's built-in secrets API; adding an external
library remains an ask-first dependency decision.” ([Bun secrets](https://bun.com/docs/runtime/secrets))
   (direct plus recommendation). The rest of that quoted bullet must change with it, because its fallback
   sentence still promises a file whenever the keychain is unavailable and calls that file “readable only by
   your user” on every platform. Replace it with: fallback only for a never-promoted data directory; a
   value-free error for a promoted directory whose keychain is unreachable; POSIX `0700`/`0600` enforcement
   stated as such; and Windows file privacy marked unverified until the ACL path exists.
2. Replace the success criterion at line 44 with the exact wording proposed in **What that means for the
spec's claim**, and implement/test each named tool's redaction before claiming it.
3. Optionally place this note beside “the workspace is not a sandbox”: “The keychain is not a sandbox for a
Bot's same-user shell either.” The macOS access-group exception is a possible future design, not a guarantee
of the proposed adapter.

The spec's separate “never stored elsewhere” language also needs careful review: runtime use necessarily puts
plaintext in process memory, while the intended scope of product-visible persistent memory must be stated
explicitly (interpretation, high).

### What NOT to do

**Do not add `@napi-rs/keyring` now.** It adds a dependency, its Linux artifacts include statically linked
`libdbus` under `AFL-2.1 OR GPL-2.0-or-later`, and its documented Secret Service path does not establish a
same-user threat-model gain ([package](https://www.npmjs.com/package/@napi-rs/keyring); [registry](https://registry.npmjs.org/@napi-rs/keyring/latest); [Secret Service
specification](https://specifications.freedesktop.org/secret-service-spec/latest-single/)) (direct plus
interpretation, high).
If reconsidered, explicitly pin persistent Secret Service rather than accepting the documented volatile
keyutils fallback ([repository](https://github.com/Brooooooklyn/keyring-node)) (direct, high).

**Do not shell out to `secret-tool` or `security` for each operation.** Command arguments can expose values,
each operation adds a process and depends on an available executable, and a macOS CLI-created item may trust the
CLI identity ([secret-tool manual](https://man.archlinux.org/man/secret-tool.1.en); [security
manual](https://keith.github.io/xcode-man-pages/security.1.html)) (direct plus interpretation, medium).
`secret-tool` supports stdin, so argv exposure is a risk of particular invocation designs, not an unavoidable
property of every CLI. Both Linux paths depend on a session bus: the Bun probe also shows this fragility
(`.scratch/bot-secrets-storage/raw/probe-bun-secrets.md`) (direct plus interpretation).

**Do not build envelope encryption now.** It can improve database-only backups, export design, and keychain
round-trip count, but it does not solve the same-user threat when the DEK is available to that user (design
inference, high).
Revisit if supported value sizes or measured keychain call volume become a real limitation.

## Headless Linux with no Secret Service

A headless host may have neither a session bus nor a usable Secret Service; in the supplied probe, unsetting
`DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR` (without stopping the bus or removing the runtime directory) caused Bun to try `dbus-launch --autolaunch` and reject (measured
locally on Linux with Bun 1.4.5, 2026-11-25; `.scratch/bot-secrets-storage/raw/probe-bun-secrets.md`)
(direct).
This is one measured configuration, not proof that every headless host fails identically; a host can run a
user bus and Secret Service without a graphical desktop ([Secret Service
specification](https://specifications.freedesktop.org/secret-service-spec/latest-single/)) (interpretation,
medium).
The fallback file is appropriate when the probe fails only for a never-promoted directory; the honest statement is that stored secret values
are plaintext in a 0600 file and a Bot's same-user shell can read them (branch map,
`.scratch/bot-secrets-storage/raw/scout-store.md`) (interpretation, high).

For this host, systemd credentials with host/TPM binding are a plausible offline improvement without a desktop
keyring, at the cost of platform-specific provisioning; they primarily improve protection while the service is
stopped and do not isolate plaintext in a running daemon
([systemd-creds](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html)) (direct plus
interpretation, medium).
This is not the only conceivable improvement: a separately managed passphrase, remote secret manager, or
isolation boundary could change the threat model, but each adds a new operational dependency (design
inference).
Settings should say: “No OS keychain is available. Secrets are stored in a private plaintext file readable by
your user, including commands run by a Bot. Protection from other OS users is enforced on POSIX; it is unverified on Windows.”
When the keychain is active, Settings should still explain that same-user Bot commands may be able to access
it (recommendation).

## Open questions for you

1. **Experimental API:** accept `Bun.secrets` now, or keep the file-only backend for one release? Default:
accept it, pin the supported Bun runtime, and verify upgrades ([Bun
secrets](https://bun.com/docs/runtime/secrets)) (direct plus recommendation).
2. **macOS stronger gate:** is a signed app-bundled helper using data-protection keychain access groups worth
exploring later? Default: defer until there is a concrete same-user isolation requirement and a macOS
prototype ([Apple TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains))
(direct plus recommendation).
3. **Fallback format:** should fallback use the same envelope-encrypted format so a later keychain move is a
DEK rewrap? Default: no; without a separately protected fallback key it adds migration and recovery complexity
without making the host meaningfully safer (design inference).
4. **Settings warning:** how prominent should the headless plaintext warning be? Default: persistent, visible
in Settings, and shown when secrets are first saved; explain the same-user shell risk (recommendation).
5. **CLI fallback:** do we need `security` or `secret-tool` on a platform where Bun fails but a CLI works,
enough to justify a second backend? Default: no; collect a reproducible compatibility case first, including
how values avoid argv exposure (recommendation).

## Sources

**Local project evidence**

- `.scratch/bot-secrets-storage/raw/scout-store.md` — branch map, interface, promotion, shell environment, and current integration; supplied read-only research, not a URL.
- `.scratch/bot-secrets-storage/raw/probe-bun-secrets.md` — first-hand measurement, not a URL: measured locally on Linux with Bun 1.4.5, 2026-11-25; no macOS, Windows, locked-keyring, or compiled-executable evidence.
- `.scratch/bot-secrets-storage/raw/t4-threat-model.md` and `.scratch/bot-secrets-storage/raw/t5-other-designs.md` — supplied threat and design analysis, not independent platform measurements.
- `docs/specs/bot-runtime.md` — project success criterion and store bullet; project specification, not a URL.

**Runtime and packages**

- [Bun secrets](https://bun.com/docs/runtime/secrets) — API contract, experimental status, backend coverage, documented size guidance, and limitations.
- [Bun 1.2.21 release](https://bun.com/blog/bun-v1.2.21) — introduction of the API and platform backend descriptions.
- [Bun Node-API](https://bun.com/docs/runtime/node-api) — general N-API support, not verification of a particular addon.
- [@napi-rs/keyring package](https://www.npmjs.com/package/@napi-rs/keyring) — API and Linux vendored libdbus license.
- [@napi-rs/keyring registry](https://registry.npmjs.org/@napi-rs/keyring/latest) — package metadata and native target dependencies.
- [keyring-node repository](https://github.com/Brooooooklyn/keyring-node) — Secret Service and volatile keyutils selection.
- [keytar repository metadata](https://api.github.com/repos/atom/node-keytar) — archived status.
- [keytar package](https://www.npmjs.com/package/keytar) — native installation and Linux build dependencies.

**OS mechanisms and threat boundaries**

- [Secret Service specification](https://specifications.freedesktop.org/secret-service-spec/latest-single/) — sessions, optional access control, and unlock policies; it identifies itself as a 0.2 DRAFT and is a moving reference.
- [libsecret](https://gnome.pages.gitlab.gnome.org/libsecret/) — Secret Service D-Bus client library.
- [secret-tool manual](https://man.archlinux.org/man/secret-tool.1.en) — CLI attributes, stdin storage, and lookup.
- [macOS security manual](https://keith.github.io/xcode-man-pages/security.1.html) — third-party mirror of the Xcode man page; the primary artifact is `man security` on the target macOS version.
- [Apple TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains) — file-based and data-protection keychain distinctions.
- [Apple keychain accessibility](https://developer.apple.com/documentation/security/restricting-keychain-item-accessibility) — device-lock and restore conditions.
- [Windows CredReadW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw) — logon-session credential selection.
- [Windows CREDENTIALW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw) — credential structure.
- [Windows PasswordVault](https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.passwordvault) — user lockers and desktop app access.
- [Windows DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata) — user and machine protection scopes.
- [Linux Yama](https://www.kernel.org/doc/html/latest/admin-guide/LSM/Yama.html) — ptrace scope semantics and dumpability.
- [systemd-creds](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html) — host/TPM binding and user credential scope.

**Application integrations**

- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) — platform backends and unprotected `basic_text` fallback.
- [Tauri Stronghold](https://v2.tauri.app/plugin/stronghold/) — password-unlocked encrypted vault integration.
