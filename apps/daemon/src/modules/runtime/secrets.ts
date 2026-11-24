import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

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

const secretNamePattern = /[a-z0-9_-]{1,64}/;
const secretPlaceholderPattern = new RegExp(`\\{\\{secret:(${secretNamePattern.source})\\}\\}`, "g");
const privateMode = 0o600;
const privateDirectoryMode = 0o700;
// One Service process per data directory. This queue serializes operations within that process.
const pending = new Map<string, Promise<unknown>>();
const activeBackends = new Map<string, SecretBackend["kind"]>();

export function fallbackSecretValuesPath(dataDir: string): string {
  return path.join(dataDir, "secrets", "secret-values.json");
}

/** The caller supplies the resolved Service data directory and can inject a keychain backend. */
// The OS backend and its runtime wiring are deferred to the next slice.
export class SecretStore {
  readonly kind: SecretBackend["kind"];
  readonly #backend: SecretBackend;
  readonly #indexFile: string;
  readonly #fallbackDirectory: string;
  readonly #fallbackFile: string;
  readonly #legacyFallbackFile: string;
  readonly #namespace: string;
  #initialized = false;

  constructor(dataDir: string, keychain?: SecretBackend) {
    mkdirSync(dataDir, { recursive: true, mode: privateDirectoryMode });
    const resolvedDataDir = realpathSync(dataDir);
    this.#indexFile = path.join(resolvedDataDir, "secret-index.json");
    this.#fallbackFile = fallbackSecretValuesPath(resolvedDataDir);
    this.#fallbackDirectory = path.dirname(this.#fallbackFile);
    this.#legacyFallbackFile = path.join(resolvedDataDir, "secret-values.json");
    this.#namespace = createHash("sha256").update(resolvedDataDir).digest("hex");
    this.#backend = keychain ?? new FileSecretBackend(this.#fallbackFile, this.#namespace);
    this.kind = this.#backend.kind;
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
    try {
      return await this.#run(async () => {
        const botScope = `bot:${botId}`;
        const known: [string, string][] = [];
        for (const { scope, name } of readIndex(this.#indexFile)) {
          if (scope !== "app" && scope !== botScope) continue;
          const value = await this.#backend.get(this.#accountKey(scope, name));
          if (!value) return "[redacted]";
          known.push([name, value]);
        }
        const containsSecret = (candidate: string) => known.some(([, value]) => candidate.includes(value));
        const redacted = redactSecretValues(text, known, (name) => {
          const placeholder = `{{secret:${name}}}`;
          return containsSecret(placeholder) ? "[redacted]" : placeholder;
        });
        return containsSecret(redacted) ? "[redacted]" : redacted;
      });
    } catch {
      return "[redacted]";
    }
  }

  /** Remove one Bot's indexed secrets and return the number removed. */
  async deleteAll(botId: string): Promise<number> {
    if (!botId) throw new Error("Bot id is required");
    return this.#run(() => this.#deleteSecrets(`bot:${botId}`), "write");
  }

  #forScope(scope: string): SecretScope {
    return {
      save: (name, description, value) => this.#run(async () => {
        const account = this.#accountKey(scope, name);
        if (!value) throw new Error("Secret value is required");
        const entries = readIndex(this.#indexFile);
        const matches = (entry: IndexEntry) => entry.scope === scope && entry.name === name;
        if (name.includes(value) || description.includes(value)
          || entries.some((entry) => matches(entry) && entry.description.includes(value))) {
          throw new Error("Secret metadata must not contain the value");
        }
        // Store the value first. Publish its metadata only after the backend write succeeds.
        try {
          await this.#backend.set(account, value);
        } catch {
          throw new Error("Unable to save secret");
        }
        writePrivateJson(this.#indexFile, [...entries.filter((entry) => !matches(entry)), { scope, name, description }]);
      }, "write"),
      list: () => this.#run(() => readIndex(this.#indexFile)
        .filter((entry) => entry.scope === scope)
        .map(({ name, description }) => ({ name, description }))),
      delete: (name) => this.#run(async () => { await this.#deleteSecrets(scope, name); }, "write"),
    };
  }

  async #deleteSecrets(scope: string, name?: string): Promise<number> {
    const entries = readIndex(this.#indexFile);
    const matches = (entry: IndexEntry) => entry.scope === scope && (name === undefined || entry.name === name);
    const matching = entries.filter(matches);
    const accounts = new Map(name === undefined
      ? matching.map((entry) => [entry.name, this.#accountKey(scope, entry.name)])
      : [[name, this.#accountKey(scope, name)]]);
    const deleted = new Set<string>();
    for (const [secretName, account] of accounts) {
      try {
        await this.#backend.delete(account);
        deleted.add(secretName);
      } catch {
        // Continue deleting the other accounts.
      }
    }
    if (matching.some((entry) => deleted.has(entry.name))) {
      writePrivateJson(this.#indexFile, entries.filter((entry) => !matches(entry) || !deleted.has(entry.name)));
    }
    if (deleted.size !== accounts.size) throw new Error("Unable to delete secret");
    return matching.length;
  }

  #getForRuntime(scope: string, name: string): Promise<string | undefined> {
    return this.#run(async () => {
      const account = this.#accountKey(scope, name);
      const indexed = readIndex(this.#indexFile).some((entry) => entry.scope === scope && entry.name === name);
      if (!indexed) return undefined;
      try {
        return await this.#backend.get(account);
      } catch {
        throw new Error("Unable to read secret");
      }
    });
  }

  #accountKey(scope: string, name: string): string {
    const account = tupleAccountKey(scope, name);
    return this.kind === "keychain" ? `${this.#namespace}:${account}` : account;
  }

  async #initialize(): Promise<void> {
    if (this.kind === "file" || lstatSync(this.#fallbackDirectory, { throwIfNoEntry: false })) {
      preparePrivateDirectory(this.#fallbackDirectory);
    }
    try {
      await this.#migrateFallback();
    } catch {
      throw new Error("Unable to migrate secrets");
    }
    activeBackends.set(this.#indexFile, this.kind);
    this.#initialized = true;
  }

  async #migrateFallback(): Promise<void> {
    const legacy = readFileValues(this.#legacyFallbackFile);
    if (this.kind === "file" && !legacy) return;
    const fallback = readFileValues(this.#fallbackFile);
    if (!legacy && !fallback) return;

    const entries = readIndex(this.#indexFile);
    const secrets = entries.map((entry) => {
      const account = tupleAccountKey(entry.scope, entry.name);
      const olderValue = legacy?.get(account);
      const currentValue = readFallbackValue(fallback, account, this.#namespace);
      const value = this.kind === "keychain" ? currentValue ?? olderValue : olderValue ?? currentValue;
      if (value === undefined) throw new Error("Missing fallback secret");
      return { entry, value };
    });
    const metadata: IndexEntry[] = [];
    for (const { entry, value } of secrets) {
      if (entry.name.includes(value)) continue;
      const description = entry.description.replaceAll(value, "[redacted]");
      if (description.includes(value)) continue;
      const account = this.#accountKey(entry.scope, entry.name);
      await this.#backend.set(account, value);
      if (await this.#backend.get(account) !== value) throw new Error("Secret migration verification failed");
      metadata.push(description === entry.description ? entry : { ...entry, description });
    }
    if (entries.some((entry, index) => entry !== metadata[index])) writePrivateJson(this.#indexFile, metadata);
    if (legacy) rmSync(this.#legacyFallbackFile);
    if (fallback && this.kind === "keychain") rmSync(this.#fallbackFile);
  }

  #run<T>(operation: () => T | Promise<T>, mode: "read" | "write" = "read"): Promise<T> {
    const previous = pending.get(this.#indexFile) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      if (this.kind === "file" && activeBackends.get(this.#indexFile) === "keychain") {
        if (mode === "write") throw new Error("Secret storage has moved to the keychain");
      } else if (!this.#initialized) {
        await this.#initialize();
      }
      return operation();
    });
    pending.set(this.#indexFile, current);
    return current.finally(() => {
      if (pending.get(this.#indexFile) === current) pending.delete(this.#indexFile);
    });
  }
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

function writePrivateJson(file: string, data: object): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", privateMode);
  try {
    try {
      fchmodSync(fd, privateMode);
      requirePrivateFile(fd);
      writeFileSync(fd, JSON.stringify(data));
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}
