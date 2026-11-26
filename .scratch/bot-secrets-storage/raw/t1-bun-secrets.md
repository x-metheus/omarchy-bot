# Bun.secrets

1. **It exists and is real; introduced in Bun v1.2.21 (Aug 2025), not 1.2.0 or 1.2.5.** The v1.2.21 release post has a section "`Bun.secrets` - native secrets manager for CLI tools". The introducing commit is `707fc4c` "Introduce Bun.secrets API (#21973)", committed 2025-08-23; a follow-up "fix `Bun.secrets` bug on linux (#22249)" landed 2025-08-29. Neither the v1.2.0 nor v1.2.5 release posts mention it (verified by substring search of the fetched pages). It is still documented and still receiving commits in the 1.3/1.4 era (e.g. "secrets: add a persist option for Windows Credential Manager entries (#42161)"), so it is present in 1.2.21+, 1.3.x and 1.4.x.
URL: https://bun.com/blog/bun-v1.2.21 [direct, confidence high]

2. **Backends: macOS Keychain Services, Linux libsecret (GNOME Keyring / KWallet), Windows Credential Manager.** Release-post wording: "It uses Keychain Services on macOS, `libsecret` (GNOME Keyring, KWallet) on Linux, and the Windows Credential Manager. All operations (`get`, `set`, and `delete`) are asynchronous and run in Bun's thread pool."
URL: https://bun.com/blog/bun-v1.2.21 [direct, confidence high]

3. **Linux requires a running Secret Service daemon; no daemon means no usable backend.** Docs state: "Requires a secret service daemon such as GNOME Keyring or KWallet", "The secret service must be running", "May prompt for unlock if the keyring is locked", and "Bun stores credentials in the default collection". The docs never use the word D-Bus. Researcher inference (well-established libsecret architecture): libsecret is a client for the freedesktop Secret Service API, which is exposed over D-Bus (`org.freedesktop.secrets`) — hence a headless box/X-less server without gnome-keyring, KWallet or another Secret Service provider has nothing for Bun to talk to. This inference is high confidence but is not stated verbatim by Bun.
URL: https://bun.com/docs/runtime/secrets [direct + interpretation, confidence high]

4. **API surface (no overloads documented).** `Bun.secrets.get({ service, name }) → Promise<string | null>` ("The stored password, or `null` if not found"); `Bun.secrets.set({ service, name, value, persist? })` where `persist` is `"local" | "enterprise"`, Windows-only, defaulting to `"enterprise"`; `Bun.secrets.delete({ service, name }) → Promise<boolean>` ("`true` if a credential was deleted, `false` if not found"). `service` and `name` are required strings; `value` is a required string. All three are async and run on the thread pool.
URL: https://bun.com/docs/runtime/secrets [direct, confidence high]

5. **Documented limits are soft and platform-dependent, not hard caps.** "Maximum password length varies by platform (typically 2048-4096 bytes)"; "Keep `service` and `name` reasonably short (under 256 characters)"; "Some special characters may need escaping depending on the platform". No documented character-set restriction, and **no statement anywhere that `set()` is atomic/replace-semantics** — the docs only say values "Can be updated without restarting the application". Treat overwrite behaviour as undocumented; do not claim atomicity.
URL: https://bun.com/docs/runtime/secrets [direct, confidence high]

6. **Officially labelled experimental.** Verbatim: "This API is new and experimental. It may change in the future."
URL: https://bun.com/docs/runtime/secrets [direct, confidence high]

7. **Error behaviour: missing item is non-throwing; total absence of a credential service is undocumented.** `get` returns `null` and `delete` returns `false` when the item is not found. For "no keychain / no secret service at all", the docs say nothing — they only list "❌ Requires OS credential service". A thrown error (rejected promise) on a backendless Linux box is plausible but unverified.
URL: https://bun.com/docs/runtime/secrets [direct for null/false; interpretation for throw, confidence medium]

8. **It removes the need for `keytar`-style native npm deps, but only for local/CLI use — Bun itself steers you to env vars in production.** Docs position it against "plaintext files like `~/.npmrc`, `~/.aws/credentials`, or `.env`", claiming encrypted at rest, zeroed memory, survives restarts, user-level access control; and explicitly: "❌ Not very useful for deployment secrets (use environment variables in production)" / "❌ Production servers (use proper secret management)". So: yes, it substitutes for a keychain npm package (keytar is never named), no for config/deployment secrets.
URL: https://bun.com/docs/runtime/secrets [direct, confidence high]

9. **Headless/CI/Docker/SSH and `bun build --compile`: entirely undocumented.** No sentence on the docs page mentions containers, CI, SSH, cross-compilation or standalone executables. Combined with finding 3, a compiled binary on a headless Linux host is the highest-risk combination (inference).
URL: https://bun.com/docs/runtime/secrets [direct for absence, confidence high]

## Unverified
- Whether `get()` throws vs resolves `null` when no Secret Service exists at runtime (only "not found" → `null` is documented).
- Whether `set()` is atomic / a transactional replace; whether it prompts for keyring unlock.
- Exact Linux failure modes and whether libsecret is dlopen'd or link-time (docs silent; would need the #21973/#22249 diffs).
- Which specific 1.2.x/1.3.x point releases shipped the `persist` option and the Linux fix (commit dates known: 2025-08-29 and later, version tags not confirmed).
- Behaviour of a `bun build --compile` binary on a machine without the OS credential service.