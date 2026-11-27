# Code Context — secret store on `t3/secret-store-clean-shell`

Read-only map, gathered with `git show`/`git diff`/`git grep` against `main...t3/secret-store-clean-shell`. Nothing checked out.

## Files Retrieved
1. `apps/daemon/src/modules/runtime/secrets.ts` — **new, 403 lines**. The whole store: `SecretBackend` interface, `SecretStore`, `SecretScope`, `FileSecretBackend`, placeholder fill/redaction, private-file helpers.
2. `apps/daemon/src/modules/runtime/extensions/secrets.ts` — **new, 71 lines**. The `secrets` model tool (save/list/delete) as a pi-durable extension; per-conversation Bot scope.
3. `apps/daemon/src/modules/runtime/secrets.test.ts` — **new, 563 lines**. Unit tests incl. in-memory `MemoryKeychain implements SecretBackend`, migration, 0600/0700 enforcement, fill/redact.
4. `apps/daemon/src/modules/runtime/extensions/files-shell.ts` — **+137**. `bash` clean env, env arg, `{{secret:}}` filling, redaction of output/diagnostics/errors, spill suppression, fallback file added to the always-refused policy.
5. `apps/daemon/src/modules/runtime/extensions/files-shell.test.ts` — **+304**. Clean-env test, secret-out-of-history test, redaction test, identity/alias refusal tests.
6. `apps/daemon/src/modules/runtime/credentials.ts` — **+168/-44**. `CredentialStore` rewritten on top of `SecretStore.forApp()`; legacy `model-credentials.json` importer/remover.
7. `apps/daemon/src/modules/runtime/credentials.test.ts` — **+166/-**. Fake keychain, migration, retry-on-failure cases.
8. `apps/daemon/src/modules/runtime/runtime.ts` — **+59**. Wires `SecretStore`, `secrets` extension, exposes `credentials`/`secrets` on `BotRuntime`, redacts durable Turn failures.
9. `apps/daemon/src/modules/bots/botDeletion.ts` (+`botDeletion.test.ts`) — `secrets` deletion stage with `deleteAll(botId)` and a `secretsRemoved` count.
10. `apps/daemon/src/api/http.ts`, `bootstrap/main.ts` — `GET /api/secrets/status` → `{ backend: "keychain" | "file" }`; `SecretService` gets `secretsBackend`.
11. `packages/protocol/src/api.ts` (`stage` gains `"secrets"`, `removed.secrets` default 0), `packages/api-client/src/index.ts` (`secretStorageStatus()`).
12. `apps/web/src/components/SettingsDialog.tsx` (+55) — Settings banner quoting the backend from `/api/secrets/status`.
13. **Bot runtime Task 22** recorded the constraints on the backend choice at the time of this review.

## 1. Purpose per file (one paragraph each)

**`secrets.ts` (new).** Defines the storage seam and all storage mechanics. `SecretBackend` is the only abstraction the OS keychain will implement later; `SecretStore` owns a 0600 metadata index (`secret-index.json`) of `{scope, name, description}` and delegates *values* only to the backend. Values never enter the index. Scopes are `"app"` and `bot:<id>`, account keys are `sha256(JSON.stringify([scope,name]))` hex, and for keychain backends additionally prefixed with `sha256(realpath(dataDir))` so two Services on one machine cannot read each other's items. Public surface: `forApp()`, `forBot(id)`, `getAppSecretForRuntime`, `getBotSecretForRuntime`, `redactKnown`, `deleteAll`, plus the pure helpers `secretPlaceholderNames`, `fillSecretPlaceholders`, `redactSecretValues` and `fallbackSecretValuesPath`. Includes one-shot legacy migration (root-level `secret-values.json`, plus path-prefixed keys) and a per-index-file write queue.

**`extensions/secrets.ts` (new).** The model-facing `secrets` tool with `action: save|list|delete`, `name` constrained to `^[a-z0-9_-]{1,64}$`. It resolves `botId` from `api.conversationId` via `BotSecretAccess.botId`, then `access.store.forBot(botId)`; if the conversation is not a Bot conversation it returns `"Secrets are only available to Bot conversations."` `list` returns `{name, description}` only — values are never returned. Custom `prepareArguments` re-throws a value-free error because "the Harness persists validation errors, and the default error includes the supplied arguments."

**`files-shell.ts` (changed).** Adds the clean-shell env, an `env` parameter for `bash`, placeholder filling for command and env values, and a redaction path that keeps secret-using output entirely out of the live stream (no `outputWindow`, no `spill`) and only publishes a bounded, redacted tail. Also extends the always-refused path policy to the fallback secret file.

**`credentials.ts` (changed).** Provider API keys move from `model-credentials.json` into app secrets: secret name is `"provider-" + sha256(id).slice(0,48)`, the value is the API key, and the *description* holds the JSON provider metadata (`isProviderRecord`). `CredentialStore.open(stateDir, secrets)` imports the legacy file per record, verifies read-back, keeps the file if any record fails, and deletes it once complete.

**`runtime.ts` (changed).** `new SecretStore(paths.dataDir)`; `CredentialStore.open(paths.stateDir, secretStore)` with a degraded fallback (`new CredentialStore(secretStore)`) and one warning; installs `createSecretsExtension(secrets)`; passes `secrets` into `createFilesShellExtension`; exposes `credentials` and `secrets` on `BotRuntime`; wraps durable Turn failures and recovered-Turn failure reasons in `secretStore.redactKnown(...)`.

**`botDeletion.ts`, `api/http.ts`, protocol/api-client/SettingsDialog.** Deletion gains a `secrets` stage (`secretStore.deleteAll`) that reports `removed.secrets`; HTTP gains an authenticated `GET /api/secrets/status` returning only the backend kind; the web Settings dialog shows a warning when the backend is `"file"`.

## 2. Backend interface and selection

```ts
// secrets.ts:5-12
export interface SecretBackend {
  readonly kind: "keychain" | "file";
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  /** Deleting an absent account succeeds so a partially completed deletion can be retried. */
  delete(account: string): Promise<void>;
}
```

Scope surface (`secrets.ts:18-20, 113-151`):
```ts
export interface SecretScope {
  save(name: string, description: string, value: string): Promise<void>;
  list(): Promise<SecretMetadata[]>;
  delete(name: string): Promise<void>;
}
```

Selection is **constructor injection only** — there is no runtime detection:
```ts
// secrets.ts:40-41, 53-61
/** The caller supplies the resolved Service data directory and can inject a keychain backend. */
// The OS backend and its runtime wiring are deferred to the next slice.
constructor(dataDir: string, keychain?: SecretBackend) {
  ...
  this.#backend = keychain ?? new FileSecretBackend(this.#fallbackFile, this.#namespace);
  this.kind = this.#backend.kind;
}
```
`runtime.ts:72` passes no backend, so production always gets `FileSecretBackend`; tests inject `MemoryKeychain`. Everything else (credentials, tool, status endpoint, Settings banner) reads `store.kind`.

Failure/absence handling:
- `#getForRuntime` returns `undefined` when the name is not indexed, and throws `"Unable to read secret"` when the backend throws (`secrets.ts:161-172`).
- `save` writes the value first, then publishes metadata; backend failure → `"Unable to save secret"` (`secrets.ts:127-133`).
- `delete` tries every account, skips failures, and throws `"Unable to delete secret"` if any failed, leaving those entries listed for retry (`secrets.ts:137-158`).
- `redactKnown` fails closed: any error yields `"[redacted]"` (`secrets.ts:81-105`).
- `#initialize` migration failure → `"Unable to migrate secrets"`; migration verifies read-back and refuses to delete the legacy file if a value is missing.
- `#run` guards backend downgrade: `if (this.kind === "file" && activeBackends.get(this.#indexFile) === "keychain") { if (mode === "write") throw new Error("Secret storage has moved to the keychain"); }` (`secrets.ts:224-235`) — a live fallback store goes read-only once a keychain store has been opened for the same data dir.
- `CredentialStore.open` failures degrade to an empty in-memory store with one `console.warn` (no crash).

## 3. The 0600 fallback file

- **Path:** `fallbackSecretValuesPath(dataDir) = path.join(dataDir, "secrets", "secret-values.json")` (`secrets.ts:34-36`); legacy root-level `path.join(dataDir, "secret-values.json")` is also read (`#legacyFallbackFile`).
- **Permissions:** directory `0o700` (`preparePrivateDirectory`: `mkdirSync(..., mode: 0o700)`, `openSync(O_RDONLY|O_DIRECTORY|O_NOFOLLOW)`, `fchmodSync(fd, 0o700)`, then reject if `fstatSync(fd).mode & 0o7777 !== 0o700`); file `0o600` (`privateMode = 0o600`) enforced by `requirePrivateFile`: `if (!stat.isFile() || (stat.mode & 0o7777) !== privateMode) throw new Error("Secret storage requires a regular file with 0600 permissions")`. Modes `0o700`/`0o755` on an existing dir are tightened to 0700 at startup; broader *file* modes are rejected, not repaired.
- **Format:** a JSON object mapping account key → value string: `Object.fromEntries(values)` where values is `Map<accountKey, string>`; account keys are the sha256 tuple hex (keychain-prefixed keys are also tolerated for migration via `readFallbackValue`). Index (`secret-index.json`) is `IndexEntry[]` = `{scope, name, description}`.
- **Atomic write:** `writePrivateJson` writes `file.<uuid>.tmp` with `openSync(tmp, "wx", 0o600)`, `fchmodSync(0o600)`, `requirePrivateFile`, `writeFileSync(fd, JSON.stringify(data))`, `closeSync`, then `renameSync(tmp, file)`, and always `rmSync(tmp, { force: true })` in `finally`. Reads use `openSync(file, O_RDONLY|O_NOFOLLOW|O_NONBLOCK)` so symlinks cannot be followed; `ENOENT` → `undefined`; bad JSON → `"Invalid secret storage JSON"`.
- **Out of Bot reach:** the fallback file is added to the always-refused policy alongside model credentials:
```ts
// extensions/files-shell.ts (policy())
const credentialFiles = [path.join(paths.stateDir, MODEL_CREDENTIALS_FILENAME), fallbackSecretValuesPath(paths.dataDir)];
const credentials = credentialFiles.flatMap(protectedPath);
const credentialIdentities = credentialFiles.map(fileStat);
...
if (credentialIdentities.some((identity) => hasIdentity(resolved, identity)) ||
  credentials.some((root) => names.some((name) => path.relative(root, name) === "" || containsProtected(name, root)))) return denied("credential store");
```
i.e. path containment **plus** inode identity (catches hard links and aliases), tested by `"credential and fallback secret identities refuse allowed aliases and hard links"` and `"bash becomes entirely unusable if the secret storage is not prepared"`-adjacent cases. The whole `dataDir` (`serviceData = protectedPath(paths.dataDir)`) is also denied, and `bash` starts in the Shared Workspace so `cwd` is never inside it.

## 4. `{{secret:name}}` filling and redaction

Patterns (`secrets.ts:23-24`):
```ts
const secretNamePattern = /[a-z0-9_-]{1,64}/;
const secretPlaceholderPattern = new RegExp(`\\{\\{secret:(${secretNamePattern.source})\\}\\}`, "g");
```
`fillSecretPlaceholders(text, resolve)` → `{ text, used: ReadonlyMap<name, value> }`; a missing name throws `` `Missing secret: ${placeholder}` ``; resolved values are inserted literally and are **not** rescanned (`"...inserts a value literally without resolving placeholders inside it"`). `redactSecretValues(text, used, placeholderForName?)` builds a single alternation regex from values sorted longest-first, escaped, and returns generated placeholders; if regex compilation throws it raises `"Unable to redact secret values."` rather than leaking the pattern (`"A regex compilation error can include the input pattern, which contains the secret values."`). It replaces against the original text only, so placeholders containing a used value are not re-scanned.

**Call sites actually on this branch: only `bash`.** `web_fetch` does not exist on this branch (`extensions/` holds `files-shell`, `prompt`, `skills`, `secrets`), and `plugins/mcp.ts`/`nativeMcp.ts` are unchanged versus `main` — no `{{secret:}}` handling there. Task 22 text still claims filling in `bash`, `web_fetch`, and `mcp`; the web_fetch/mcp halves live on their own branches (`t3/web-fetch-search-extension`, `t3/mcp-through-pi-mcp`).

bash path (`extensions/files-shell.ts`, bash `execute`):
```ts
const variables = Object.entries(args.env ?? {});
const names = new Set([args.command, ...variables.map(([, value]) => value)].flatMap(secretPlaceholderNames));
...
const value = botId && secrets ? await awaitWithContext(secrets.store.getBotSecretForRuntime(botId, name), context) : undefined;
if (value === undefined) return textResult(`Missing secret: {{secret:${name}}}`);
...
// Command placeholders are literal. The Bot handles shell quoting and should prefer env.
const command = fill(args.command);
const environment = Object.fromEntries(variables.map(([name, value]) => [name, fill(value)]));
```
When any secret is used: `usesSecrets = used.size > 0`; `api.outputWindow` is set to `undefined`, `spill` is dropped (`// A spill file would contain unredacted output from commands that use secrets.`), live output goes to a private `OutputBuffer({ ...window, retain: "tail" })`, `retainedOutput()` returns `{ text: redactSecretValues(snapshot.text, outputValues), truncated }` (values are `sanitizeOutput(value)` first, "The snapshot strips control codes, so redact that same form of each value"), diagnostics are redacted (`redactDiagnostic`), final text/structure output and `fullOutputPath` are redacted, truncation becomes a `{ severity: "warn", code: "truncated", ... }` diagnostic, and thrown errors are rethrown with `redact(...)`. Persisted tool arguments keep the placeholders — filling happens on a copy at execute time.

Service-side redaction: `SecretStore.redactKnown(text, botId)` reads only `app` + `bot:<botId>` indexed values; an unreadable indexed value short-circuits to `"[redacted]"`, and an unsafe placeholder is replaced with `"[redacted]"`. Used by `runtime.ts` for durable Turn failures and recovered turns (skipped for `DurableRunAborted`).

## 5. Clean shell environment

```ts
// extensions/files-shell.ts
const BASH_INHERITED_ENV = ["PATH", "HOME", "LANG", "TMPDIR", "USER", "SHELL"] as const;
...
export function createFilesShellExtension(platform = process.platform, approvals?: FileApprovals, secrets?: BotSecretAccess) {
  const bash = createBashTool({
    prepare(execution) {
      execution.inheritEnv = false;
      for (const key of BASH_INHERITED_ENV) {
        const value = process.env[key];
        if (value !== undefined) execution.env[key] = value;
      }
    },
  });
```
So it is an explicit **allowlist** of six variables with `inheritEnv = false` — not a denylist. Per-call `env` from the tool argument is merged on top through the `shellEnvironment` proxy:
```ts
env: { ...options?.env, ...variables },
```
`cwd` comes from `createFilesEnvironment(paths, settingsFolders, cwd = paths.sharedWorkspaceDir, botId, ...)`: the conversation `cwd` must pass `guard(path.resolve(paths.sharedWorkspaceDir), cwd)`; on failure `cwdError` is set and the inner `NodeExecutionEnv` falls back to `path.resolve(paths.sharedWorkspaceDir)` while `exec` returns a `spawn_error`. `runtime.ts` passes `cwd` from the harness env callback (`env: ({ conversationId, cwd }) => ...`). Windows returns `textResult("bash is unsupported on Windows.")`.

## 6. Per-Bot scoping

- Namespacing: `forBot(botId)` → scope string `` `bot:${botId}` ``; `forApp()` → `"app"`. Account key = `sha256(JSON.stringify([scope, name]))` hex (`tupleAccountKey`), so a Bot's `/{{secret:foo}}/` and the app's `foo` are distinct accounts.
- Keychain backends additionally prefix the data-directory namespace: `return this.kind === "keychain" ? \`${this.#namespace}:${account}\` : account;` with `#namespace = sha256(realpathSync(dataDir))`.
- Isolation is enforced in the store, not the caller: `list` filters `entry.scope === scope`; `get` refuses unindexed names; `delete` matches `entry.scope === scope`; `#getForRuntime(scope, name)` is only reachable from Service code (`getBotSecretForRuntime(botId, name)`), and the model never gets a scope object for another Bot.
- The `secrets` tool derives `botId` from `access.botId(api.conversationId)` (`conversationBots` map in `runtime.ts`), so a Bot cannot name a target scope; non-Bot conversations get an error. `deleteAll(botId)` refuses empty ids.
- Tests: `"Bots cannot get, list, or delete another Bot's secrets"`, `"secrets and bash cannot list, delete, or use another Bot's or the app's secrets"`, `"keychain accounts are isolated by Service data directory"`.

## 7. TODO/FIXME/comments naming the keychain decision or platform tools

No `TODO`/`FIXME`/`HACK`/`XXX` markers exist anywhere under `apps/daemon/src/modules/runtime/` on the branch (`git grep` returns nothing). The decision is recorded in prose instead:

- `secrets.ts:40-41`: `/** The caller supplies the resolved Service data directory and can inject a keychain backend. */` + `// The OS backend and its runtime wiring are deferred to the next slice.`
- The branch’s Task 22 described the pending choice of OS tooling.

> "Keychain access needs a library or each platform's command-line tool: choosing a library is an ask-first dependency decision."
> "...Tests with a fake keychain backend, plus one manual run on Linux Secret Service (still manual, pending the backend decision)."
> Acceptance: "Keychain paths are exercised with the fake backend only; the real OS keychain backend is pending the library/CLI decision."

No code contains `keytar`, `libsecret`, `secret-tool`, or `security find-generic-password`.

## 8. Dependencies

**None added.** `git diff main...t3/secret-store-clean-shell -- '**/package.json'` yields no `+`/`-` lines and `git diff ... -- bun.lock | wc -l` is `0`. The new code uses only `node:crypto`, `node:fs`, `node:path`, and already-present `@earendil-works/chord/output` (`OutputBuffer`, `sanitizeOutput`, `BoundedOutput`) — note `BoundedOutput`/`ToolDiagnostic`/`BashToolInput` imports are new but from existing packages.

## Architecture (flow)

`runtime.openBotRuntime` constructs `SecretStore(paths.dataDir)` → `CredentialStore.open(stateDir, secretStore)` (app scope, migrates `model-credentials.json`, then removes it) → `secrets: BotSecretAccess = { store, botId: (id) => conversationBots.get(id) }` → `createFilesShellExtension(platform, approvals, secrets)` and `registry.install(createSecretsExtension(secrets))`. Tool executions resolve Bot scope → `SecretStore` → `SecretBackend` (`FileSecretBackend` today). `BotRuntime` exposes `credentials` and `secrets`; `Service` passes `runtime.secrets` to `BotDeletion` and `runtime.secrets.kind` to the HTTP layer for `/api/secrets/status`, which the web Settings dialog renders as a fallback warning.

## Constraints that bear on the storage-backend choice

1. The seam is **3 methods, string→string, per-account, no enumeration, no error types**. A keychain library must map "delete absent account succeeds" and must not need list/backends enumeration (the index in `secret-index.json` is the only enumeration source).
2. Accounts are already namespaced by data directory (`<sha256(dataDir)>:<sha256([scope,name])>`) and `kind` is a closed union `"keychain" | "file"` — adding a third kind touches `SecretBackend`, `api.ts` status type, and the Settings banner copy.
3. Values must survive **read-back verification** (`await this.#backend.get(account) !== value` throws during migration) — a backend that transforms or truncates values breaks migration.
4. Promotion to a keychain deletes the fallback file and makes live fallback stores **read-only** for writes; any new backend must be a real replacement, not a mirror.
5. The backend must be constructible from `dataDir` alone inside `openBotRuntime` and must not require async initialization before the first `forApp()/forBot()` call in the current shape (initialization is lazy inside `#run`).
6. Selecting a library is an explicit **ask-first dependency decision** (Task 22); no dependency may be added silently, and Linux Secret Service coverage is manual only today.

## Start Here
`apps/daemon/src/modules/runtime/secrets.ts` — read lines 1-60 (interface, patterns, namespace, backend selection) then 106-235 (`#forScope`, delete, `#run`, migration) and 306-403 (`FileSecretBackend` + private-file helpers). Everything else (tool, bash wiring, credentials, status endpoint) is a thin consumer of that file.