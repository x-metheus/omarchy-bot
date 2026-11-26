import { createHash, randomUUID } from "node:crypto";
import { constants, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ResourceFingerprint } from "./resourceFingerprint.ts";
import type { CatalogSkillDto, InstalledSkillDto } from "@omarchy-bot/protocol";
import { confinedPath } from "@omarchy-bot/domain";
import { HttpError } from "../bots/bots.ts";
import { skillFrontmatter } from "./skillInstaller.ts";

const Entry = z.object({
  id: z.string(), name: z.string(), description: z.string(), source: z.string(),
  sourceType: z.enum(["github", "well-known", "local"]), installUrl: z.string(), installs: z.number().optional(),
  revision: z.string(), installedAt: z.string(), updatedAt: z.string(), lastCheckedAt: z.string().optional(),
  skillPath: z.string().optional(),
  directory: z.string(), activeDirectory: z.string(), baseline: z.string(), enabled: z.boolean(),
  baselineVerified: z.boolean().default(true),
  origin: z.enum(["installed", "local", "default", "service"]), serviceId: z.string().optional(),
  error: z.string().optional(), availableRevision: z.string().optional(),
});
type Entry = z.infer<typeof Entry>;
// Zod strips the retired aliases map when reading older registries or transactions.
const Registry = z.object({ version: z.literal(1), entries: z.array(Entry), defaultsInitialized: z.boolean().default(false) });
type InstallOptions = { origin?: Entry["origin"]; serviceId?: string; enabled?: boolean; installedAt?: string; baselineVerified?: boolean };
type Installation = { catalog: CatalogSkillDto; materialized: { directory: string; revision: string }; options?: InstallOptions };
const Transaction = z.object({
  root: z.string(), committed: z.boolean(), before: Registry,
  entries: z.array(z.object({ next: Entry, previous: Entry.optional(), stage: z.string(), backup: z.string(), contentDigest: z.string(), previousDigest: z.string().optional() })),
});

function inside(root: string, target: string): boolean {
  try {
    return confinedPath(target, root) !== path.resolve(root);
  } catch {
    return false;
  }
}

function insideSkillRoot(root: string, target: string): boolean {
  return inside(root, target) && target.split(path.sep).every((part) => part !== ".pi" && part !== ".claude");
}

function legacySkillRoots(workspace: string): string[] {
  return [".pi", ".claude"].map((client) => path.join(workspace, client, "skills"));
}

export function assertUnlinkedDestination(directory: string): string {
  const absolute = path.resolve(directory);
  // Validate each parent before resolving its children, including the configured data directory.
  let current = path.parse(absolute).root;
  let canonicalParent = realpathSync(current);
  for (const component of path.relative(current, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new HttpError(409, `Skill destination cannot use a symlink: ${current}`);
    if (!stat.isDirectory() && current !== absolute) throw new HttpError(409, `Skill destination parent must be a directory: ${current}`);
    const canonical = realpathSync(current);
    if (path.dirname(canonical) !== canonicalParent) throw new HttpError(409, `Skill destination escaped its parent directory: ${current}`);
    canonicalParent = canonical;
  }
  return absolute;
}

/** Native files are authoritative; this registry retains origin and update baselines only. */
export class NativeSkills {
  readonly root: string;
  readonly #disabled: string;
  readonly #file: string;
  #registry: z.infer<typeof Registry>;
  #fingerprint = new ResourceFingerprint({ kind: "Skill", maxEntries: 2000, maxBytes: 100 * 1024 * 1024 });
  readonly #transactionFile: string;
  #recoveryError: string | undefined;
  errors: string[] = [];

  constructor(readonly workspace: string, readonly privateDir: string) {
    this.root = path.join(workspace, ".agents", "skills");
    this.#disabled = path.join(privateDir, "disabled-skills");
    this.#file = path.join(privateDir, "native-skills.json");
    this.#transactionFile = path.join(privateDir, "native-skills-transaction.json");
    mkdirSync(assertUnlinkedDestination(privateDir), { recursive: true, mode: 0o700 });
    this.#registry = existsSync(this.#file) ? Registry.parse(JSON.parse(readFileSync(this.#file, "utf8"))) : { version: 1, entries: [], defaultsInitialized: false };
    try { this.#recover(); }
    catch { this.#recoveryError = `Interrupted Skill update requires attention. Current files and recovery copies were retained; inspect ${this.#transactionFile}.`; }
  }

  #persist(registry = this.#registry): void {
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(registry, null, 2), { mode: 0o600, flag: "wx" });
    renameSync(temporary, this.#file);
  }

  #writeTransaction(transaction: z.infer<typeof Transaction>): void {
    const temporary = `${this.#transactionFile}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(transaction), { mode: 0o600, flag: "wx" });
    renameSync(temporary, this.#transactionFile);
  }

  #recover(): void {
    if (!existsSync(this.#transactionFile)) return;
    const transaction = Transaction.parse(JSON.parse(readFileSync(this.#transactionFile, "utf8")));
    if (path.dirname(transaction.root) !== this.privateDir || !/^\.skill-transaction-[0-9a-f-]{36}$/.test(path.basename(transaction.root))) throw new Error("Invalid Skill recovery location");
    assertUnlinkedDestination(transaction.root);
    for (const [index, item] of transaction.entries.entries()) {
      if (item.stage !== path.join(transaction.root, `stage-${index}`) || item.backup !== path.join(transaction.root, `previous-${index}`)) throw new Error("Invalid Skill recovery location");
      this.#assertDestination(item.next.directory);
      if (item.previous) this.#assertDestination(item.previous.directory);
      if (transaction.committed) {
        if (item.previous && existsSync(item.backup) && this.#fingerprint.digest(item.backup) !== item.previousDigest) throw new Error("Previous Skill was edited during update; recovery copies were retained");
      } else if (!existsSync(item.stage)) {
        if (!existsSync(item.next.directory) || this.#fingerprint.digest(item.next.directory) !== item.contentDigest) throw new Error("Skill was edited after interruption; current and previous copies were retained");
      } else if (existsSync(item.backup) && existsSync(item.next.directory)) {
        throw new Error("A new native Skill occupies the recovery destination");
      }
    }
    if (!transaction.committed) {
      for (const item of [...transaction.entries].reverse()) {
        if (!existsSync(item.stage)) rmSync(item.next.directory, { recursive: true });
        if (item.previous && existsSync(item.backup)) {
          if (existsSync(item.previous.directory)) throw new Error("Skill recovery would overwrite a native resource");
          renameSync(item.backup, item.previous.directory);
        }
      }
      this.#registry = transaction.before;
      this.#persist();
    }
    rmSync(transaction.root, { recursive: true, force: true });
    rmSync(this.#transactionFile);
    this.#recoveryError = undefined;
  }

  #owned(directory: string): boolean {
    const roots = [this.root, this.#disabled];
    if (!roots.some((root) => inside(root, directory))) return false;
    if (!existsSync(directory)) return true;
    const real = realpathSync(directory);
    return roots.some((root) => inside(path.resolve(root), real));
  }

  #assertDestination(directory: string): void {
    const absolute = path.resolve(directory);
    if (!inside(this.root, absolute) && !inside(this.#disabled, absolute)) throw new HttpError(409, "Skill destination is outside the managed workspace");
    assertUnlinkedDestination(absolute);
  }

  #directories(): { directory: string; root: string }[] {
    const directories: { directory: string; root: string }[] = [];
    const seen = new Set<string>();
    let visited = 0;
    const scan = (directory: string, root: string, depth: number): void => {
      if (depth > 5 || visited >= 2000) return;
      let canonical: string;
      try {
        canonical = realpathSync(directory);
        if (canonical !== root && !insideSkillRoot(root, canonical)) return;
        if (!lstatSync(canonical).isDirectory()) return;
      } catch { return; }
      visited++;
      if (seen.has(canonical)) return;
      seen.add(canonical);
      const skillFile = path.join(canonical, "SKILL.md");
      const document = lstatSync(skillFile, { throwIfNoEntry: false });
      if (document) {
        directories.push({ directory: this.#owned(canonical) ? canonical : directory, root });
        if (!document.isSymbolicLink() || existsSync(skillFile)) return;
      }
      for (const entry of readdirSync(canonical, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          try { scan(path.join(directory, entry.name), root, depth + 1); } catch { /* A disappearing native entry is reconciled on the next read. */ }
        }
      }
    };
    for (const [base, directory] of [[this.workspace, this.root], [this.privateDir, this.#disabled]] as const) {
      let canonicalBase: string;
      try { canonicalBase = realpathSync(base); } catch { continue; }
      const root = path.join(canonicalBase, path.relative(base, directory));
      if (insideSkillRoot(canonicalBase, root)) scan(directory, root, 0);
    }
    return directories;
  }

  #reconcileLegacyDestinations(): Map<Entry, Entry> {
    const reconciled = new Map<Entry, Entry>();
    const legacyRoots = legacySkillRoots(this.workspace);
    const pending = this.#registry.entries.filter((entry) => !entry.enabled && inside(this.#disabled, entry.directory)
      && legacyRoots.some((root) => inside(root, entry.activeDirectory)));
    if (!pending.length) return reconciled;

    const occupied = new Set(this.#registry.entries.map((entry) => path.resolve(entry.activeDirectory).toLowerCase()));
    try {
      for (const directory of [path.dirname(this.root), this.root]) {
        const stat = lstatSync(directory, { throwIfNoEntry: false });
        if (stat && !stat.isDirectory()) throw new Error(`${directory} must be a real directory`);
      }
      if (existsSync(this.root)) {
        for (const name of readdirSync(this.root)) occupied.add(path.resolve(this.root, name).toLowerCase());
      }
    } catch (error) {
      this.errors.push(`Cannot reconcile disabled legacy Skills: ${error instanceof Error ? error.message : String(error)}`);
      return reconciled;
    }

    for (const entry of pending) {
      const name = path.basename(path.resolve(entry.activeDirectory));
      let destination = path.resolve(this.root, name);
      try {
        for (let suffix = 2; occupied.has(destination.toLowerCase()) || lstatSync(destination, { throwIfNoEntry: false }); suffix++) {
          destination = path.resolve(this.root, `${name}-${suffix}`);
        }
      } catch (error) {
        this.errors.push(`Cannot reconcile disabled Skill ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      occupied.add(destination.toLowerCase());
      const updated = { ...entry, activeDirectory: destination };
      if (entry.origin === "local") {
        if (entry.source === entry.activeDirectory) updated.source = destination;
        if (entry.installUrl === entry.activeDirectory) updated.installUrl = destination;
      }
      reconciled.set(entry, updated);
    }
    return reconciled;
  }

  #scan() {
    const results: InstalledSkillDto[] = [];
    const directories = this.#directories();
    this.errors = this.#recoveryError ? [this.#recoveryError] : [];
    const reconciled = this.#reconcileLegacyDestinations();
    let changed = false;
    const byPath = new Map(this.#registry.entries.map((entry) => [entry.directory, entry]));
    const retained: Entry[] = [];
    for (const { directory, root } of directories) {
      const original = byPath.get(directory);
      let document: string | undefined;
      try { document = realpathSync(path.join(directory, "SKILL.md")); } catch { /* An unresolvable document is omitted. */ }
      if (!document || !insideSkillRoot(root, document)) {
        if (original) retained.push(original);
        continue;
      }
      const stored = original && (reconciled.get(original) ?? original);
      const enabled = !inside(this.#disabled, directory);
      const readOnly = !this.#owned(directory);
      const now = new Date().toISOString();
      const fallbackName = path.basename(directory);
      let metadata = { name: fallbackName, description: "" };
      let digest = stored?.baseline ?? "";
      let error: string | undefined;
      try {
        metadata = skillFrontmatter(readFileSync(document, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW }));
        digest = this.#fingerprint.digest(directory);
      } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
      const entry: Entry = stored ?? {
        id: `local_${createHash("sha256").update(path.relative(this.workspace, directory)).digest("hex").slice(0, 24)}`,
        ...metadata, source: directory, sourceType: "local", installUrl: directory, revision: digest,
        installedAt: now, updatedAt: now, directory, activeDirectory: directory,
        baseline: digest, baselineVerified: true, enabled, origin: "local",
      };
      const modified = entry.origin !== "local" && (!entry.baselineVerified || digest !== entry.baseline);
      const effectiveError = error ?? (!entry.baselineVerified ? "Migrated content has no verified upstream baseline. Review and preserve local work before explicitly reinstalling." : entry.error);
      results.push({
        id: entry.id, ...metadata, source: entry.source, sourceType: entry.sourceType, installUrl: entry.installUrl,
        enabled: enabled && !error, revision: entry.sourceType === "local" ? digest : entry.revision,
        installedAt: entry.installedAt, updatedAt: entry.updatedAt, origin: entry.origin,
        path: path.join(directory, "SKILL.md"), readOnly, modified,
        updateStatus: modified ? "modified" : effectiveError ? "failed" : entry.availableRevision ? "available" : "current",
        ...(entry.installs === undefined ? {} : { installs: entry.installs }),
        ...(entry.skillPath === undefined ? {} : { skillPath: entry.skillPath }),
        ...(entry.lastCheckedAt === undefined ? {} : { lastCheckedAt: entry.lastCheckedAt }),
        ...(entry.serviceId === undefined ? {} : { serviceId: entry.serviceId }),
        ...(entry.availableRevision === undefined ? {} : { availableRevision: entry.availableRevision }),
        ...(effectiveError === undefined ? {} : { error: effectiveError }),
      });
      if (!readOnly) {
        const updated = { ...entry, ...metadata, enabled };
        retained.push(updated);
        if (!stored || stored !== original || stored.name !== metadata.name || stored.description !== metadata.description || stored.enabled !== enabled) changed = true;
      }
    }
    if (retained.length !== this.#registry.entries.length) changed = true;
    return { results, registry: changed ? { ...this.#registry, entries: retained } : this.#registry };
  }

  list(): InstalledSkillDto[] {
    const { results, registry } = this.#scan();
    if (registry !== this.#registry) {
      this.#persist(registry);
      this.#registry = registry;
    }
    return results;
  }

  #entry(id: string): Entry {
    const listed = this.list().some((item) => item.id === id && !item.readOnly);
    const entry = listed && this.#registry.entries.find((item) => item.id === id);
    if (!entry) throw new HttpError(404, "Shared Skill not found or its source is read-only");
    if (!this.#owned(entry.directory) || !this.#owned(entry.activeDirectory)) throw new HttpError(409, "Skill source is outside the managed workspace");
    return entry;
  }

  install(catalog: CatalogSkillDto, materialized: { directory: string; revision: string }, options: InstallOptions = {}): InstalledSkillDto {
    return this.installBundle([{ catalog, materialized, options }])[0]!;
  }

  installBundle(installations: readonly Installation[]): InstalledSkillDto[] {
    if (!installations.length) return [];
    const root = path.join(this.privateDir, `.skill-transaction-${randomUUID()}`);
    assertUnlinkedDestination(root);
    assertUnlinkedDestination(this.root);
    this.#recover();
    const { results, registry } = this.#scan();
    const ids = new Set<string>(), destinations = new Set<string>();
    // Validate the complete bundle before writing staging files or persisting the scan.
    const plans = installations.map(({ catalog, materialized, options = {} }) => {
      const previous = registry.entries.find((entry) => entry.id === catalog.id);
      if (previous && !results.some((entry) => entry.id === previous.id && !entry.readOnly)) throw new HttpError(409, "Installed Skill document is unavailable; its registry entry was preserved");
      const metadata = skillFrontmatter(readFileSync(path.join(materialized.directory, "SKILL.md"), "utf8"));
      if (!metadata.name || metadata.name.length > 120 || /[/\\\0]/.test(metadata.name) || metadata.name === "." || metadata.name === ".." || metadata.name.startsWith(".")) throw new HttpError(400, "Skill name cannot be used as a native directory");
      const activeDirectory = previous?.activeDirectory ?? path.join(this.root, metadata.name);
      const enabled = options.enabled ?? previous?.enabled ?? true;
      const directory = enabled ? activeDirectory : path.join(this.#disabled, createHash("sha256").update(catalog.id).digest("hex"));
      this.#assertDestination(activeDirectory);
      if (directory !== activeDirectory) this.#assertDestination(directory);
      if (previous && previous.directory !== directory) this.#assertDestination(previous.directory);
      if (ids.has(catalog.id) || destinations.has(directory)) throw new HttpError(409, "The bundle contains conflicting Skill destinations");
      ids.add(catalog.id); destinations.add(directory);
      if (existsSync(directory) && (!previous || previous.directory !== directory)) throw new HttpError(409, "A native Skill already occupies this destination; it was not overwritten");
      return { catalog, materialized, options, previous, metadata, activeDirectory, enabled, directory };
    });
    for (const { previous, materialized } of plans) {
      if (previous && previous.directory !== materialized.directory && (!previous.baselineVerified || this.#fingerprint.digest(previous.directory) !== previous.baseline)) {
        previous.availableRevision = materialized.revision;
        previous.lastCheckedAt = new Date().toISOString();
        this.#persist(registry);
        this.#registry = registry;
        throw new HttpError(409, "Local or unverified migrated Skill content is preserved. Review it before explicitly reinstalling.");
      }
    }
    const prepared: z.infer<typeof Transaction>["entries"] = [];
    let journalWritten = false;
    mkdirSync(root, { mode: 0o700 });
    try {
      for (const [index, { catalog, materialized, options, previous, metadata, activeDirectory, enabled, directory }] of plans.entries()) {
        const retained = previous?.directory === materialized.directory ? previous : undefined;
        const stage = path.join(root, `stage-${index}`);
        const backup = path.join(root, `previous-${index}`);
        cpSync(materialized.directory, stage, { recursive: true, dereference: false, errorOnExist: true });
        if (catalog.id === "official:openai:skill-creator") {
          const dependencies = path.resolve(import.meta.dir, "../../../resources/python");
          const manifest = z.object({ files: z.record(z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) })) }).parse(JSON.parse(readFileSync(path.join(dependencies, "pyyaml-source.json"), "utf8")));
          for (const [relative, file] of Object.entries(manifest.files)) {
            const source = path.resolve(dependencies, relative);
            if (!inside(dependencies, source) || createHash("sha256").update(readFileSync(source)).digest("hex") !== file.sha256) throw new Error("The bundled creator Python dependency failed its integrity check");
          }
          cpSync(path.join(dependencies, "yaml"), path.join(stage, "scripts", "yaml"), { recursive: true });
          cpSync(path.join(dependencies, "LICENSE-PyYAML"), path.join(stage, "scripts", "LICENSE-PyYAML"));
        }
        const contentDigest = this.#fingerprint.digest(stage);
        const now = new Date().toISOString();
        const next: Entry = {
          ...catalog, ...metadata, directory, activeDirectory, enabled, baseline: retained?.baseline ?? contentDigest,
          baselineVerified: options.baselineVerified ?? retained?.baselineVerified ?? true,
          revision: retained?.revision ?? materialized.revision, installedAt: previous?.installedAt ?? options.installedAt ?? now,
          updatedAt: retained ? retained.updatedAt : previous?.revision === materialized.revision ? previous.updatedAt : now,
          lastCheckedAt: now, origin: options.origin ?? previous?.origin ?? "installed",
          ...(options.serviceId ?? previous?.serviceId ? { serviceId: options.serviceId ?? previous?.serviceId } : {}),
          ...(retained?.error ? { error: retained.error } : {}),
          ...(retained?.availableRevision ? { availableRevision: retained.availableRevision } : {}),
        };
        prepared.push({ next, ...(previous ? { previous, previousDigest: retained ? contentDigest : previous.baseline } : {}), stage, backup, contentDigest });
      }
      // Check the complete bundle again after staging, before replacing any member.
      for (const item of prepared) {
        this.#assertDestination(item.next.directory);
        if (item.previous) this.#assertDestination(item.previous.directory);
        if (item.previous && this.#fingerprint.digest(item.previous.directory) !== item.previousDigest) throw new HttpError(409, "Skill changed during update; local changes were retained");
        if (existsSync(item.next.directory) && item.previous?.directory !== item.next.directory) throw new HttpError(409, "A native Skill appeared during installation; it was retained");
      }
      const transaction: z.infer<typeof Transaction> = { root, committed: false, before: structuredClone(this.#registry), entries: prepared };
      this.#writeTransaction(transaction);
      journalWritten = true;
      for (const item of prepared) {
        mkdirSync(path.dirname(item.next.directory), { recursive: true, mode: 0o700 });
        if (item.previous) renameSync(item.previous.directory, item.backup);
        renameSync(item.stage, item.next.directory);
        if (item.previous && this.#fingerprint.digest(item.backup) !== item.previousDigest) throw new HttpError(409, "Skill changed at replacement; local changes were retained");
      }
      const installedRegistry = { ...registry, entries: [...registry.entries.filter((entry) => !ids.has(entry.id)), ...prepared.map((item) => item.next)] };
      this.#persist(installedRegistry);
      this.#registry = installedRegistry;
      transaction.committed = true;
      this.#writeTransaction(transaction);
      try { this.#recover(); }
      catch { this.#recoveryError = `Updated Skill bundle retained recovery copies requiring attention at ${this.#transactionFile}.`; }
    } catch (error) {
      if (journalWritten) {
        try { this.#recover(); }
        catch { this.#recoveryError = `Interrupted Skill update requires attention. Current files and recovery copies were retained at ${this.#transactionFile}.`; }
      }
      throw error;
    } finally {
      if (!journalWritten) rmSync(root, { recursive: true, force: true });
    }
    return this.list().filter((entry) => ids.has(entry.id));
  }

  enable(id: string, enabled: boolean, service = false): void {
    const entry = this.#entry(id);
    if (entry.origin === "service" && !service) throw new HttpError(409, "Manage this Skill through its owning Service");
    if (entry.enabled === enabled) return;
    const target = enabled ? entry.activeDirectory : path.join(this.#disabled, createHash("sha256").update(id).digest("hex"));
    if (lstatSync(target, { throwIfNoEntry: false })) throw new HttpError(409, "Another Skill occupies the destination; nothing was overwritten");
    this.#assertDestination(target);
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    renameSync(entry.directory, target);
    entry.directory = target;
    entry.enabled = enabled;
    this.#persist();
  }

  remove(id: string, service = false): void {
    const entry = this.#entry(id);
    if (entry.origin === "service" && !service) throw new HttpError(409, "Manage this Skill through its owning Service");
    rmSync(entry.directory, { recursive: true });
    this.#registry.entries = this.#registry.entries.filter((item) => item.id !== id);
    this.#persist();
  }

  markError(id: string, error: string): void {
    const entry = this.#registry.entries.find((item) => item.id === id);
    if (!entry || !this.#scan().results.some((item) => item.id === id && !item.readOnly)) return;
    entry.error = error;
    entry.lastCheckedAt = new Date().toISOString();
    this.#persist();
  }

  provisionDefault(resourcesDirectory: string): void {
    const id = "official:openai:skill-creator";
    const previous = this.list().find((entry) => entry.id === id);
    if (this.#registry.defaultsInitialized && !previous) return;
    const provenance = z.object({
      repository: z.literal("https://github.com/openai/skills"),
      sourceDirectory: z.literal("skills/.system/skill-creator"),
      commit: z.string().regex(/^[0-9a-f]{40}$/),
      files: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
    }).parse(JSON.parse(readFileSync(path.join(resourcesDirectory, "skill-creator-source.json"), "utf8")));
    const directory = path.join(resourcesDirectory, "skill-creator");
    const revision = `git:${provenance.commit}:${provenance.sourceDirectory}`;
    if (previous?.revision === revision && previous.path && existsSync(path.join(path.dirname(previous.path), "scripts", "yaml", "__init__.py"))) return;
    for (const file of provenance.files) {
      const target = path.resolve(directory, file.path);
      if (!inside(directory, target) || createHash("sha256").update(readFileSync(target)).digest("hex") !== file.sha256) {
        throw new Error("Bundled official Skill Creator failed its resource integrity check");
      }
    }
    const metadata = skillFrontmatter(readFileSync(path.join(directory, "SKILL.md"), "utf8"));
    this.install({
      id, ...metadata, sourceType: "github", source: "openai/skills",
      installUrl: `${provenance.repository}/tree/main/${provenance.sourceDirectory}`,
    }, { directory, revision }, { origin: "default" });
    this.#registry.defaultsInitialized = true;
    this.#persist();
  }
}
