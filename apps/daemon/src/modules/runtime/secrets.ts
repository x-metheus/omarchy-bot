import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bunSecretsService, type BunSecretsProbeResult } from "./bunSecrets.ts";

export interface SecretBackend {
  readonly kind: "keychain" | "file";
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  /** Deleting an absent account succeeds so a partially completed deletion can be retried. */
  delete(account: string): Promise<void>;
}

export interface SecretMetadata {
  name: string;
  description: string;
}

export interface SecretScope {
  save(name: string, description: string, value: string): Promise<void>;
  list(): Promise<SecretMetadata[]>;
  delete(name: string): Promise<void>;
}

interface IndexEntry extends SecretMetadata {
  scope: string;
}

interface KeychainDescriptor {
  backend: SecretBackend;
  probe: () => Promise<BunSecretsProbeResult>;
  operationTimeoutMs?: number;
}

interface SecretStorageStatus {
  backend: SecretBackend["kind"] | "unavailable";
  reason?: string;
}

interface BackendSelection {
  status: SecretStorageStatus;
  backend?: SecretBackend;
}

const secretNamePattern = /[a-z0-9_-]{1,64}/;
const secretPlaceholderPattern = new RegExp(`\\{\\{secret:(${secretNamePattern.source})\\}\\}`, "g");
const privateMode = 0o600;
const privateDirectoryMode = 0o700;
// One Service process per data directory. This queue serializes operations within that process.
const pending = new Map<string, Promise<unknown>>();
// Bun cannot cancel a mutation. Refuse retries for this directory until it settles.
const pendingKeychainMutations = new Set<string>();
const keychainOperationTimeoutMs = 5_000;
const promotionMarker = { version: 1, service: bunSecretsService };
const noKeychain = "No OS keychain is available.";
const keychainUnavailable = "The OS keychain is unavailable.";
const storageAccessError = "Unable to access secret storage";

class KeychainOperationTimeout extends Error {
  constructor() { super(storageAccessError); }
}

export function fallbackSecretValuesPath(dataDir: string): string {
  return path.join(dataDir, "secrets", "secret-values.json");
}

/** The caller supplies the resolved Service data directory and can inject a keychain backend. */
export class SecretStore {
  readonly #indexFile: string;
  readonly #fallbackDirectory: string;
  readonly #fallbackFile: string;
  readonly #legacyFallbackFile: string;
  readonly #markerFile: string;
  readonly #namespace: string;
  #selected?: BackendSelection;
  #retryKeychainSelection = false;

  constructor(dataDir: string, private readonly keychain?: KeychainDescriptor) {
    mkdirSync(dataDir, { recursive: true, mode: privateDirectoryMode });
    const resolvedDataDir = realpathSync(dataDir);
    this.#indexFile = path.join(resolvedDataDir, "secret-index.json");
    this.#fallbackFile = fallbackSecretValuesPath(resolvedDataDir);
    this.#fallbackDirectory = path.dirname(this.#fallbackFile);
    this.#legacyFallbackFile = path.join(resolvedDataDir, "secret-values.json");
    this.#markerFile = path.join(this.#fallbackDirectory, "keychain.json");
    this.#namespace = createHash("sha256").update(resolvedDataDir).digest("hex");
  }

  get kind(): "checking" | SecretStorageStatus["backend"] {
    if (pendingKeychainMutations.has(this.#indexFile)) return "unavailable";
    return this.#selected?.status.backend ?? "checking";
  }

  async status(): Promise<SecretStorageStatus> {
    return this.#queue(async () => ({ ...(await this.#ensureBackend()).status }));
  }

  forApp(): SecretScope {
    return this.#forScope("app");
  }

  forBot(botId: string): SecretScope {
    return this.#forScope(`bot:${botId}`);
  }

  /** Service-only accessor for provider credentials and connected accounts. */
  getAppSecretForRuntime(name: string): Promise<string | undefined> {
    return this.#getForRuntime("app", name);
  }

  /** Service-only accessor for filling a Bot's secret placeholders. */
  getBotSecretForRuntime(botId: string, name: string): Promise<string | undefined> {
    return this.#getForRuntime(`bot:${botId}`, name);
  }

  /** Service-only redaction of app and owning Bot values in a failure diagnostic. */
  async redactKnown(text: string, botId: string): Promise<string> {
    return this.#run(async (backend) => {
      try {
        const botScope = `bot:${botId}`;
        const known: [string, string][] = [];
        for (const { scope, name } of readIndex(this.#indexFile)) {
          if (scope !== "app" && scope !== botScope) continue;
          const value = await backend.get(this.#accountKey(scope, name, backend));
          if (!value) return "[redacted]";
          known.push([name, value]);
        }
        const containsSecret = (candidate: string) => known.some(([, value]) => candidate.includes(value));
        const redacted = redactSecretValues(text, known, (name) => {
          const placeholder = `{{secret:${name}}}`;
          return containsSecret(placeholder) ? "[redacted]" : placeholder;
        });
        return containsSecret(redacted) ? "[redacted]" : redacted;
      } catch (error) {
        if (error instanceof KeychainOperationTimeout) throw error;
        return "[redacted]";
      }
    });
  }

  /** Remove one Bot's indexed secrets and return the number removed. */
  async deleteAll(botId: string): Promise<number> {
    return this.#run((backend) => {
      if (!botId) throw new Error("Bot id is required");
      return this.#deleteSecrets(backend, `bot:${botId}`);
    });
  }

  #forScope(scope: string): SecretScope {
    return {
      save: (name, description, value) => this.#run(async (backend) => {
        const account = this.#accountKey(scope, name, backend);
        if (!value) throw new Error("Secret value is required");
        const entries = readIndex(this.#indexFile);
        const matches = (entry: IndexEntry) => entry.scope === scope && entry.name === name;
        if (name.includes(value) || description.includes(value)
          || entries.some((entry) => matches(entry) && entry.description.includes(value))) {
          throw new Error("Secret metadata must not contain the value");
        }
        // Store the value first. Publish its metadata only after the backend write succeeds.
        try {
          await backend.set(account, value);
        } catch (error) {
          if (error instanceof KeychainOperationTimeout) throw error;
          throw new Error("Unable to save secret");
        }
        writePrivateJson(this.#indexFile, [...entries.filter((entry) => !matches(entry)), { scope, name, description }]);
      }),
      list: () => this.#run(() => readIndex(this.#indexFile)
        .filter((entry) => entry.scope === scope)
        .map(({ name, description }) => ({ name, description }))),
      delete: (name) => this.#run(async (backend) => { await this.#deleteSecrets(backend, scope, name); }),
    };
  }

  async #deleteSecrets(backend: SecretBackend, scope: string, name?: string): Promise<number> {
    const entries = readIndex(this.#indexFile);
    const matches = (entry: IndexEntry) => entry.scope === scope && (name === undefined || entry.name === name);
    const matching = entries.filter(matches);
    const accounts = new Map(name === undefined
      ? matching.map((entry) => [entry.name, this.#accountKey(scope, entry.name, backend)])
      : [[name, this.#accountKey(scope, name, backend)]]);
    const deleted = new Set<string>();
    let timeout: KeychainOperationTimeout | undefined;
    for (const [secretName, account] of accounts) {
      try {
        await backend.delete(account);
        deleted.add(secretName);
      } catch (error) {
        if (error instanceof KeychainOperationTimeout) {
          timeout = error;
          break;
        }
        // Continue deleting the other accounts after a settled failure.
      }
    }
    if (matching.some((entry) => deleted.has(entry.name))) {
      writePrivateJson(this.#indexFile, entries.filter((entry) => !matches(entry) || !deleted.has(entry.name)));
    }
    if (timeout) throw timeout;
    if (deleted.size !== accounts.size) throw new Error("Unable to delete secret");
    return matching.length;
  }

  #getForRuntime(scope: string, name: string): Promise<string | undefined> {
    return this.#run(async (backend) => {
      const account = this.#accountKey(scope, name, backend);
      const indexed = readIndex(this.#indexFile).some((entry) => entry.scope === scope && entry.name === name);
      if (!indexed) return undefined;
      try {
        return await backend.get(account);
      } catch (error) {
        if (error instanceof KeychainOperationTimeout) throw error;
        throw new Error("Unable to read secret");
      }
    });
  }

  #accountKey(scope: string, name: string, backend: SecretBackend): string {
    const account = tupleAccountKey(scope, name);
    return backend.kind === "keychain" ? this.#keychainAccountKey(account) : account;
  }

  #keychainAccountKey(tuple: string): string {
    return `${this.#namespace}:${tuple}`;
  }

  async #ensureBackend(retryFailedKeychain = false): Promise<BackendSelection> {
    if (pendingKeychainMutations.has(this.#indexFile)) return unavailable(keychainUnavailable);
    // Status reports the observed failure. A subsequent storage operation can retry selection.
    if (!this.#selected || (retryFailedKeychain && this.#retryKeychainSelection)) {
      this.#selected = await this.#selectBackend();
      if (this.#selected.backend) this.#retryKeychainSelection = false;
    }
    let selected = this.#selected;
    if (selected.backend?.kind === "file") {
      // All stores share the queue, so a live fallback sees any marker before another write.
      try {
        if (lstatSync(this.#markerFile, { throwIfNoEntry: false })) {
          selected = this.#selected = unavailable(keychainUnavailable);
        }
      } catch {
        selected = this.#selected = unavailable("Unable to check secret storage.");
      }
    }
    return selected;
  }

  async #selectBackend(): Promise<BackendSelection> {
    let stage = "Unable to check secret storage.";
    try {
      if (lstatSync(this.#fallbackDirectory, { throwIfNoEntry: false })) preparePrivateDirectory(this.#fallbackDirectory);
      const marker = readPrivateJson(this.#markerFile);
      const promoted = marker !== undefined;
      if (promoted && (!isRecord(marker) || marker.version !== promotionMarker.version || marker.service !== promotionMarker.service)) {
        return unavailable("The OS keychain promotion marker is invalid.");
      }
      const keychain = this.keychain;
      const probe = keychain ? await Promise.resolve().then(() => keychain.probe()).catch(() => undefined) : undefined;
      if (keychain && probe?.available) {
        stage = promoted ? "Unable to verify the OS keychain copy." : "Unable to promote secrets to the OS keychain.";
        preparePrivateDirectory(this.#fallbackDirectory);
        const backend: SecretBackend = {
          kind: keychain.backend.kind,
          get: (account) => this.#accessKeychain(keychain, () => keychain.backend.get(account)),
          set: (account, value) => this.#accessKeychain(keychain, () => keychain.backend.set(account, value), true),
          delete: (account) => this.#accessKeychain(keychain, () => keychain.backend.delete(account), true),
        };
        await this.#migrateFallback(backend, promoted);
        return { status: { backend: "keychain" }, backend };
      }
      if (promoted) return unavailable(keychainUnavailable);

      stage = "Unable to prepare file secret storage.";
      preparePrivateDirectory(this.#fallbackDirectory);
      const backend = new FileSecretBackend(this.#fallbackFile, this.#namespace);
      await this.#migrateFallback(backend, false);
      return { status: { backend: "file", reason: noKeychain }, backend };
    } catch {
      return unavailable(stage);
    }
  }

  async #accessKeychain<T>(keychain: KeychainDescriptor, operation: () => Promise<T>, mutates = false): Promise<T> {
    const result = Promise.resolve().then(operation);
    const timeout = Promise.withResolvers<never>();
    const timeoutError = new KeychainOperationTimeout();
    const timer = setTimeout(() => timeout.reject(timeoutError), keychain.operationTimeoutMs ?? keychainOperationTimeoutMs);
    try {
      return await Promise.race([result, timeout.promise]);
    } catch (error) {
      if (this.#selected?.status.backend === "keychain") {
        this.#selected = unavailable(keychainUnavailable);
        this.#retryKeychainSelection = true;
      }
      if (error !== timeoutError) throw new Error(keychainUnavailable);
      if (mutates) {
        pendingKeychainMutations.add(this.#indexFile);
        const release = () => { pendingKeychainMutations.delete(this.#indexFile); };
        void result.then(release, release);
      }
      throw timeoutError;
    } finally {
      clearTimeout(timer);
    }
  }

  async #migrateFallback(backend: SecretBackend, promoted: boolean): Promise<void> {
    const legacy = readFileValues(this.#legacyFallbackFile);
    const toKeychain = backend.kind === "keychain";
    if (!toKeychain && !legacy) return;
    const fallback = readFileValues(this.#fallbackFile);
    if (legacy?.size || fallback?.size) {
      const entries = readIndex(this.#indexFile);
      const accounts = entries.map((entry) => {
        const tuple = tupleAccountKey(entry.scope, entry.name);
        return { entry, tuple, namespaced: this.#keychainAccountKey(tuple) };
      });
      const legacyAccounts = new Set(accounts.map(({ tuple }) => tuple));
      const fallbackAccounts = new Set(accounts.flatMap(({ tuple, namespaced }) => [tuple, namespaced]));
      for (const account of legacy?.keys() ?? []) {
        if (!legacyAccounts.has(account)) throw new Error("Unindexed legacy secret");
      }
      for (const account of fallback?.keys() ?? []) {
        if (!fallbackAccounts.has(account)) throw new Error("Unindexed fallback secret");
      }
      const secrets = accounts.flatMap(({ entry, tuple, namespaced }) => {
        const olderValue = legacy?.get(tuple);
        const fallbackValue = fallback?.get(tuple);
        const namespacedValue = fallback?.get(namespaced);
        const currentValue = fallbackValue ?? namespacedValue;
        const value = toKeychain ? currentValue ?? olderValue : olderValue ?? currentValue;
        if (value === undefined) throw new Error("Missing fallback secret");
        if (toKeychain && [olderValue, fallbackValue, namespacedValue].some((candidate) => candidate !== undefined && candidate !== value)) {
          throw new Error("Conflicting fallback values");
        }
        const description = entry.description.replaceAll(value, "[redacted]");
        if (entry.name.includes(value) || description.includes(value)) {
          if (toKeychain) throw new Error("Unsafe secret metadata");
          return [];
        }
        const metadata = description === entry.description ? entry : { ...entry, description };
        return [{ account: toKeychain ? namespaced : tuple, value, metadata }];
      });
      for (const { account, value } of secrets) {
        if (!promoted) await backend.set(account, value);
        if (await backend.get(account) !== value) throw new Error("Secret migration verification failed");
      }
      const metadata = secrets.map((secret) => secret.metadata);
      if (entries.some((entry, index) => entry !== metadata[index])) writePrivateJson(this.#indexFile, metadata);
    }
    if (toKeychain && (!promoted || legacy || fallback)) {
      if (promoted) syncDirectory(this.#fallbackDirectory);
      else writePrivateJson(this.#markerFile, promotionMarker, true);
      // Persist the secrets/ directory entry too, including after an interrupted promotion.
      syncDirectory(path.dirname(this.#indexFile));
    }
    if (legacy) rmSync(this.#legacyFallbackFile);
    if (fallback && toKeychain) rmSync(this.#fallbackFile);
  }

  #run<T>(operation: (backend: SecretBackend) => T | Promise<T>): Promise<T> {
    return this.#queue(async () => {
      const { backend } = await this.#ensureBackend(true);
      if (!backend) throw new Error(storageAccessError);
      return operation(backend);
    });
  }

  #queue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = pending.get(this.#indexFile) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    pending.set(this.#indexFile, current);
    return current.finally(() => {
      if (pending.get(this.#indexFile) === current) pending.delete(this.#indexFile);
    });
  }
}

function unavailable(reason: string): BackendSelection {
  return { status: { backend: "unavailable", reason } };
}

export function secretPlaceholderNames(text: string): string[] {
  return Array.from(text.matchAll(secretPlaceholderPattern), ([, name]) => name!);
}

/** Fill exact placeholders and collect the values used by this call for redaction. */
export function fillSecretPlaceholders(
  text: string,
  resolve: (name: string) => string | undefined,
): { text: string; used: ReadonlyMap<string, string> } {
  const used = new Map<string, string>();
  const filled = text.replace(secretPlaceholderPattern, (placeholder: string, name: string) => {
    const value = used.get(name) ?? resolve(name);
    if (value === undefined) throw new Error(`Missing secret: ${placeholder}`);
    used.set(name, value);
    return value;
  });
  return { text: filled, used };
}

export function redactSecretValues(
  text: string,
  used: Iterable<readonly [string, string]>,
  placeholderForName: (name: string) => string = (name) => `{{secret:${name}}}`,
): string {
  const placeholders = new Map<string, string>();
  for (const [name, value] of used) {
    if (value && !placeholders.has(value)) placeholders.set(value, placeholderForName(name));
  }
  if (placeholders.size === 0) return text;

  const alternatives = [...placeholders.keys()]
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  let pattern: RegExp;
  try {
    pattern = new RegExp(alternatives.join("|"), "g");
  } catch {
    // A regex compilation error can include the input pattern, which contains the secret values.
    throw new Error("Unable to redact secret values.");
  }
  // Match only the original text, even if a generated placeholder contains a used value.
  return text.replace(pattern, (value) => placeholders.get(value)!);
}

function tupleAccountKey(scope: string, name: string): string {
  if (secretNamePattern.exec(name)?.[0] !== name) {
    throw new Error("Invalid secret name: use 1–64 lowercase letters, digits, dashes, or underscores");
  }
  return createHash("sha256").update(JSON.stringify([scope, name])).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIndexEntry(value: unknown): value is IndexEntry {
  return isRecord(value) && typeof value.scope === "string"
    && typeof value.name === "string" && typeof value.description === "string";
}

function readIndex(file: string): IndexEntry[] {
  const data = readPrivateJson(file);
  if (data === undefined) return [];
  if (!Array.isArray(data) || !data.every(isIndexEntry)) throw new Error("Invalid secret metadata index");
  return data;
}

class FileSecretBackend implements SecretBackend {
  readonly kind = "file";

  constructor(private readonly file: string, private readonly legacyNamespace: string) {}

  async get(account: string): Promise<string | undefined> {
    return readFallbackValue(readFileValues(this.file), account, this.legacyNamespace);
  }

  async set(account: string, value: string): Promise<void> {
    const values = readFileValues(this.file) ?? new Map<string, string>();
    values.delete(`${this.legacyNamespace}:${account}`);
    values.set(account, value);
    writePrivateJson(this.file, Object.fromEntries(values));
  }

  async delete(account: string): Promise<void> {
    const values = readFileValues(this.file);
    if (!values) return;
    const removed = values.delete(account);
    if (values.delete(`${this.legacyNamespace}:${account}`) || removed) {
      writePrivateJson(this.file, Object.fromEntries(values));
    }
  }
}

function readFallbackValue(values: Map<string, string> | undefined, account: string, legacyNamespace: string): string | undefined {
  return values?.get(account) ?? values?.get(`${legacyNamespace}:${account}`);
}

function readFileValues(file: string): Map<string, string> | undefined {
  const data = readPrivateJson(file);
  if (data === undefined) return undefined;
  if (!isRecord(data)) throw new Error("Invalid secret values file");
  const entries = Object.entries(data);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
    throw new Error("Invalid secret values file");
  }
  return new Map(entries);
}

function preparePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: privateDirectoryMode });
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fchmodSync(fd, privateDirectoryMode);
    if ((fstatSync(fd).mode & 0o7777) !== privateDirectoryMode) {
      throw new Error("Secret storage requires a directory with 0700 permissions");
    }
  } finally {
    closeSync(fd);
  }
}

function requirePrivateFile(fd: number): void {
  const stat = fstatSync(fd);
  if (!stat.isFile() || (stat.mode & 0o7777) !== privateMode) {
    throw new Error("Secret storage requires a regular file with 0600 permissions");
  }
}

function readPrivateJson(file: string): unknown {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    requirePrivateFile(fd);
    const contents = readFileSync(fd, "utf8");
    try {
      return JSON.parse(contents);
    } catch {
      throw new Error("Invalid secret storage JSON");
    }
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(directory: string): void {
  // This directory fsync is unavailable on Windows.
  if (process.platform === "win32") return;
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writePrivateJson(file: string, data: object, durable = false): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", privateMode);
  try {
    try {
      fchmodSync(fd, privateMode);
      requirePrivateFile(fd);
      writeFileSync(fd, JSON.stringify(data));
      if (durable) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
    if (durable) syncDirectory(path.dirname(file));
  } finally {
    rmSync(temporary, { force: true });
  }
}
