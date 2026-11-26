# Gap findings

1. **OWASP LLM01 (Prompt Injection) does not contain a credential-exfiltration-via-shell narrative.** It describes exfiltration only in a narrow scenario: *"A user employs an LLM to summarize a webpage containing hidden instructions that cause the LLM to insert an image linking to a URL, leading to exfiltration of the the private conversation."* Impact categories include *"Providing unauthorized access to functions available to the LLM"* and *"Executing arbitrary commands in connected systems"*, plus mitigation *"Provide the application with its own API tokens for extensible functionality, and handle these functions in code rather than providing them to the model."* Agency is framed as context-dependent: *"The severity and nature of the impact ... are largely dependent on both the business context the model operates in, and the agency with which the model is architected."* Mitigations named: *"Require human approval for high-risk actions"* and *"Implement human-in-the-loop controls for privileged operations to prevent unauthorized actions."* **No mention** of credentials, secret stores, environment variables, shell access, or reading local files. So: LLM01 supports "tool-use exfiltration + excessive agency" generally, but cannot be cited for "agent with shell reads keychain/secret store."

URL: https://genai.owasp.org/llmrisk/llm01-prompt-injection/
[direct, high]

2. **Electron `safeStorage` Linux fallback is documented as effectively unencrypted.** Exact warning: *"Note that not all Linux setups have an available secret store. If no secret store is available, items stored in using the `safeStorage` API will be unprotected as they are encrypted via hardcoded plaintext password. You can detect when this happens when `safeStorage.getSelectedStorageBackend()` returns `basic_text`."* Backend strings returned: `basic_text` (DE not recognised or `--password-store="basic"`), `gnome_libsecret`, `kwallet` (kde4), `kwallet5` (kde5), `kwallet6` (kde6), and `unknown` (*"When the function is called before app has emitted the `ready` event."*). Mechanisms: macOS → Keychain Access, stored *"in a way that prevents other applications from loading them without user override"*; Windows → DPAPI; Linux → kwallet*/gnome-libsecret, async API via `org.freedesktop.portal.Secret` or Secret Service, with *"A fallback provider ... for environments without a secret service available."*

URL: https://www.electronjs.org/docs/latest/api/safe-storage
[direct, high]

3. **Yama ptrace_scope wording (verbatim from the kernel LSM doc).** 0 classic: *"a process can `PTRACE_ATTACH` to any other process running under the same uid, as long as it is dumpable (i.e. did not transition uids, start privileged, or have called `prctl(PR_SET_DUMPABLE...)` already)."* 1 restricted: *"a process must have a predefined relationship with the inferior it wants to call `PTRACE_ATTACH` on. By default, this relationship is that of only its descendants ... To change the relationship, an inferior can call `prctl(PR_SET_PTRACER, debugger, ...)`."* 2 admin-only: *"only processes with `CAP_SYS_PTRACE` may use ptrace."* 3 no attach: *"no processes may use ptrace with `PTRACE_ATTACH` nor via `PTRACE_TRACEME`. Once set, this sysctl value cannot be changed."* The page does **not** state which value any distro ships as default.

URL: https://www.kernel.org/doc/html/latest/admin-guide/LSM/Yama.html
[direct, high]

4. **Windows DPAPI `CryptProtectData` is scoped to the user's logon credentials, not to the calling process.** Verbatim: *"Typically, only a user with logon credentials that match those of the user who encrypted the data can decrypt the data."* And: *"In addition, decryption usually can only be done on the computer where the data was encrypted. However, a user with a roaming profile can decrypt the data from another computer on the network."* On machine scope: *"If the CRYPTPROTECT_LOCAL_MACHINE flag is set when the data was encrypted, any user on the computer where the encryption was done can decrypt the data."* The page does **not** explicitly address whether a different same-user process can call `CryptUnprotectData` on data it did not create — **inference:** the stated scope is the logon credential set, not the creating process, so any process running as that user (with the same logon session crypto material) is expected to decrypt; treat as inference, not a quoted guarantee.

URL: https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata
[direct for quotes; interpretation for the cross-process conclusion, medium]

## Could not verify

- **OWASP LLM06:2025 Excessive Agency** — the fetch returned a degenerate/empty extraction with no usable text; no content could be attributed to that page. Only one attempt allowed within budget, so nothing from LLM06 is asserted here.
- **Apple `com.apple.security.get-task-allow`** — the documentation URL returned an Apple "page you're looking for can't be found" error page. Nothing about the entitlement, debugging, hardened runtime, or cross-process task reads could be sourced. This gap is open; the claim that a hardened-runtime app without `get-task-allow` cannot be attached/read by another process is **unsourced** and must not be asserted yet.
- **Default ptrace_scope on distros** (e.g. Ubuntu = 1) — not stated on the kernel page; would need a distro-specific source.
- **Electron macOS Keychain "user override"** — page says other apps cannot load keys "without user override" but does not specify the prompt mechanism or whether a same-user CLI process can force it.
