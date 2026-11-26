# Other designs

1. **Envelope encryption** — one random data key in the OS keychain; each secret sealed with AES-256-GCM under it into a local SQLite row (unique nonce, key name as AAD). Threat model: theft of the DB or a disk/backup copy that does not include the keychain item. Depends on: any AEAD (Bun `node:crypto`/WebCrypto) plus one keychain read at startup. Bun daemon: yes, directly. Cross-platform: yes; headless Linux only as far as the keychain works there (often it does not). Buys over per-value keychain: one keychain item instead of N, atomic backup/restore, cheap key rotation by re-wrapping the DEK, no per-item prompts. **It does not protect a value while it is unlocked in memory or readable by the same user** — a process running as that user can ask the keychain for the same DEK, so the security is exactly the keychain's, not more.
URL: (no source fetched — design analysis)
[interpretation, high]

2. **systemd-creds / TPM2 sealing** — seals a credential blob; output is "unconditionally encoded in Base64". `--with-key=auto` (default) uses the TPM2 key if a TPM2 device exists and you are not in a container, and the host key "if `/var/lib/systemd/` is on persistent media", so by default "encryption is by default bound to both the TPM2 chip and the OS installation". `--user`/`--uid=` folds "the selected user's numeric UID and username, as well as the system's machine-id" into the key; such credentials "may only be decrypted from the specified user's context, except if privileges can be acquired". TPM2 PCR policy optional (`--tpm2-pcrs`). Threat model: disk/backup theft and lifting the blob to another machine — not a hostile root. Depends on systemd ≥250 (user scoping ≥256) plus a TPM2 or persistent `/var/lib/systemd/`. Bun: only by shelling out to `systemd-creds`; practical at install/provision time. Cross-platform: Linux only; headless is its home turf. Buys: protection while the daemon is *stopped*, no unlocked keyring daemon, secret never in env/plain file — but root (or anything that can acquire privileges, per the quoted caveat) can decrypt.
URL: https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html
[direct, high for quotes; interpretation for the root claim]

3. **age / sops** — age encrypts whole files to X25519/SSH recipients; sops keeps structure readable and encrypts values with per-file data keys wrapped by age/KMS/PGP. Threat model: at-rest protection of config files and safe sharing/version control, not runtime. Depends on an age identity file (or KMS) sitting somewhere. Bun: shell out or a JS implementation. Cross-platform and headless: yes. Buys: reviewable diffs, multi-recipient sharing, no secrets in the repo. Main weakness: the identity file is itself a plaintext key on disk, so the problem is relocated, not removed.
URL: (no source fetched — not in the assigned URL list; see Unverified)
[interpretation, low]

4. **pass** — "each password lives inside of a `gpg` encrypted file whose filename is the title of the website or resource"; a short shell script over `~/.password-store`, with git for history. gpg-agent provides "a nice password input dialog ... (which can be configured to stay authenticated for several minutes)". Threat model: protection of files at rest; the site makes **no** claim about a compromised same-user process, and none protects you there — any same-user process can drive gpg-agent or read `pass show` output. Bun: shell out to `pass show`. Cross-platform: Linux-native, awkward on Windows/headless macOS. Buys: git-auditable history, human-readable/edit-able store, per-entry granularity, user chooses the passphrase lifetime.
URL: https://passwordstore.org/
[direct, high; same-user inference marked as interpretation]

5. **Electron safeStorage** — macOS Keychain keys stored "in a way that prevents other applications from loading them without user override"; Windows DPAPI; Linux a store that "varies depending on your window manager": `kwallet`/`kwallet5`/`kwallet6`/`gnome-libsecret` (async API may use `org.freedesktop.portal.Secret`). Fallback backend is named `basic_text`, and `safeStorage.getSelectedStorageBackend()` returns it as a user-friendly string (`basic_text`, `gnome_libsecret`, `kwallet*`, or `unknown` before `ready`). Documented warning: "If no secret store is available, items stored in using the `safeStorage` API will be unprotected as they are encrypted via hardcoded plaintext password." Threat model: only the backend's; on bare/headless Linux it is effectively zero. Bun: no — it is an Electron main-process API, so a Bun daemon must reimplement it (`secret-tool`) or accept `basic_text`. Buys nothing over a direct keychain call except the documented detection hook.
URL: https://www.electronjs.org/docs/latest/api/safe-storage
[direct, high]

6. **VS Code SecretStorage** — a per-extension key/value store: `keys()`, `get(key)`, `store(key, value)`, `delete(key)`, `onDidChange`. Scoped "independent of the current opened workspace" (i.e. global to that extension, not per-workspace), and "the secrets will not be synced across machines". No security caveat appears in either the API reference or the `vscode.d.ts` doc comment — the guarantee is only "stored encrypted". Bun: no (extension-host API). Buys over a raw keychain: namespacing and an OS-abstraction layer; nothing else.
URL: https://code.visualstudio.com/api/references/vscode-api
[direct, high for the API; the absent caveat is a gap, not a claim]

7. **gh CLI token storage** — stores the token in the system credential store, falling back to "a plain text file" when no credential store is available; the manual only points at `gh auth status` for the location and does not state the path. `GH_TOKEN` is available for PATs. Threat model: credential store quality, degrading to world-of-user-readable plaintext on headless boxes. Bun daemon: shell out to `gh auth token`, or read the file. Buys: nothing new — it is the same keychain pattern plus a documented plaintext escape hatch, which is the honest precedent for "detect and warn".
URL: https://cli.github.com/manual/gh_auth_login
[direct for the fallback; interpretation for path/precedence]

8. **docker credential helpers** — `credsStore` (suffix after `docker-credential-`) in `~/.docker/config.json`; the helper must be on `$PATH`. Protocol: first argv is `store` | `get` | `erase` ("only three possible values"), JSON on stdin/stdout with `ServerURL`/`Username`/`Secret`. Defaults: `osxkeychain` (macOS), `wincred` (Windows), `pass` then `secretservice` (Linux); if none, credentials land in `config.json` **base64-encoded**, described as less secure. `--password-stdin` keeps secrets out of argv/history. Bun: a Bun binary can implement the three verbs easily — this is the best-documented template for a pluggable secret backend. Buys: indirection plus a multi-field, address-keyed protocol; still one backend per host.
URL: https://docs.docker.com/reference/cli/docker/login/
[direct, high]

9. **Tauri keyring / Stronghold** — Stronghold stores "secrets and keys using the IOTA Stronghold secret management engine" as records in a vault, unlocked via `Stronghold.load(vaultPath, vaultPassword)` with a configurable password hash (argon2 shown in examples). The page does not say whether the app or the user supplies the password; its example hardcodes it. A **keyring plugin page could not be verified**: `v2.tauri.app/plugin/keyring/`, `tauri.app/plugin/keyring/` and `github.com/tauri-apps/tauri-plugin-keyring` all 404. Bun: Stronghold is a Rust crate, not callable from Bun. Stronghold's real buy is a *portable encrypted vault* independent of the OS keychain — useful when the keychain is absent, at the cost of owning the password lifecycle.
URL: https://v2.tauri.app/plugin/stronghold/
[direct, medium; keyring claim unverified]

## Unverified

- **age/sops specifics** — no source fetched (URL budget); the description is background knowledge, low confidence, and no version/pricing/API claims should be quoted from it.
- **systemd host key internals** — the man page section naming `/var/lib/systemd/credential.secret` and stating root can read host-key credentials was not in the extracted text. Only the "except if privileges can be acquired" quote is direct evidence.
- **gh token path** (`~/.config/gh/hosts.yml`) and `GH_TOKEN` > keyring precedence — not stated on the fetched page.
- **Tauri keyring plugin** — does not resolve at the three obvious URLs; may be community-maintained or removed.
- **VS Code** — no documented security caveat exists in the official reference or `vscode.d.ts`; whether its Linux path can degrade to a plain file is not documented publicly.
- **docker `list` verb** — the login page documents only `store`/`get`/`erase`; a `list` verb exists in the credential-helper spec but was not confirmed here.
