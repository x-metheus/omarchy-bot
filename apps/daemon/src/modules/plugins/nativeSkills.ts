import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const Registry = z.object({ version: z.literal(1), entries: z.array(Entry), defaultsInitialized: z.boolean().default(false), aliases: z.record(z.string()).default({}) });
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
    mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    this.#registry = existsSync(this.#file) ? Registry.parse(JSON.parse(readFileSync(this.#file, "utf8"))) : { version: 1, entries: [], defaultsInitialized: false, aliases: {} };
    try { this.#recover(); }
    catch { this.#recoveryError = `Interrupted Skill update requires attention. Current files and recovery copies were retained; inspect ${this.#transactionFile}.`; }
  }

  #persist(): void {
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.#registry, null, 2), { mode: 0o600, flag: "wx" });
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
    for (const [index, item] of transaction.entries.entries()) {
      if (item.stage !== path.join(transaction.root, `stage-${index}`) || item.backup !== path.join(transaction.root, `previous-${index}`)
        || !this.#owned(item.next.directory) || (item.previous && !this.#owned(item.previous.directory))) throw new Error("Invalid Skill recovery destination");
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
    const roots = [this.root, path.join(this.workspace, ".pi", "skills"), path.join(this.workspace, ".claude", "skills"), this.#disabled];
    if (!roots.some((root) => inside(root, directory))) return false;
    if (!existsSync(directory)) return true;
    const real = realpathSync(directory);
    return roots.some((root) => inside(path.resolve(root), real));
  }


  #directories(): string[] {
    const directories: string[] = [];
    const seen = new Set<string>();
    let visited = 0;
    const scan = (directory: string, depth: number): void => {
      if (!existsSync(directory) || depth > 5 || ++visited > 2000) return;
      let canonical: string;
      try { canonical = realpathSync(directory); } catch { return; }
      if (seen.has(canonical)) return;
      seen.add(canonical);
      if (existsSync(path.join(directory, "SKILL.md"))) { directories.push(this.#owned(canonical) ? canonical : directory); return; }
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          const child = path.join(directory, entry.name);
          try { if (lstatSync(realpathSync(child)).isDirectory()) scan(child, depth + 1); } catch { /* A disappearing native entry is reconciled on the next read. */ }
        }
      }
    };
    for (const directory of [path.join(this.workspace, ".pi", "skills"), this.root, path.join(this.workspace, ".claude", "skills"), this.#disabled]) scan(directory, 0);
    return directories;
  }

  #syncAliases(directories: string[]): boolean {
    this.errors = this.#recoveryError ? [this.#recoveryError] : [];
    let changed = false;
    const wanted = new Map<string, string>();
    for (const directory of directories) {
      if (!this.#owned(directory) || inside(this.#disabled, directory)) continue;
      for (const root of [this.root, path.join(this.workspace, ".claude", "skills")]) {
        if (inside(root, directory)) continue;
        const alias = path.join(root, path.basename(directory));
        if (wanted.has(alias) && wanted.get(alias) !== directory) {
          this.errors.push(`${alias}: native Skill names conflict across discovery roots; existing resources were retained`);
        } else wanted.set(alias, directory);
      }
    }
    for (const [alias, target] of Object.entries(this.#registry.aliases)) {
      try {
        if (lstatSync(alias).isSymbolicLink() && path.resolve(path.dirname(alias), readlinkSync(alias)) === target) {
          if (wanted.get(alias) === target) continue;
          rmSync(alias);
        }
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      }
      delete this.#registry.aliases[alias];
      changed = true;
    }
    for (const [alias, target] of wanted) {
      try {
        if (existsSync(alias)) {
          if (realpathSync(alias) !== target) this.errors.push(`${alias}: an existing native Skill prevents cross-client discovery; it was not overwritten`);
          continue;
        }
        mkdirSync(path.dirname(alias), { recursive: true, mode: 0o700 });
        const parent = realpathSync(path.dirname(alias));
        if (!inside(this.workspace, parent)) throw new Error("Native Skill alias parent is outside the shared workspace");
        symlinkSync(path.relative(path.dirname(alias), target), alias, "dir");
        this.#registry.aliases[alias] = target;
        changed = true;
      } catch (error) { this.errors.push(`${alias}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return changed;
  }

  list(): InstalledSkillDto[] {
    const results: InstalledSkillDto[] = [];
    const directories = this.#directories();
    const byPath = new Map(this.#registry.entries.map((entry) => [entry.directory, entry]));
    const retained: Entry[] = [];
    let changed = this.#syncAliases(directories);
    for (const directory of directories) {
      const stored = byPath.get(directory);
      const enabled = !inside(this.#disabled, directory);
      const readOnly = !this.#owned(directory);
      const now = new Date().toISOString();
      const fallbackName = path.basename(directory);
      let metadata = { name: fallbackName, description: "" };
      let digest = stored?.baseline ?? "";
      let error: string | undefined;
      try {
        metadata = skillFrontmatter(readFileSync(path.join(directory, "SKILL.md"), "utf8"));
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
        if (!stored || stored.name !== metadata.name || stored.description !== metadata.description || stored.enabled !== enabled) changed = true;
      }
    }
    if (retained.length !== this.#registry.entries.length) changed = true;
    if (changed) { this.#registry.entries = retained; this.#persist(); }
    return results;
  }

  #entry(id: string): Entry {
    this.list();
    const entry = this.#registry.entries.find((item) => item.id === id);
    if (!entry) throw new HttpError(404, "Shared Skill not found or its source is read-only");
    if (!this.#owned(entry.directory) || !this.#owned(entry.activeDirectory)) throw new HttpError(409, "Skill source is outside the managed workspace");
    return entry;
  }

  install(catalog: CatalogSkillDto, materialized: { directory: string; revision: string }, options: InstallOptions = {}): InstalledSkillDto {
    return this.installBundle([{ catalog, materialized, options }])[0]!;
  }

  installBundle(installations: readonly Installation[]): InstalledSkillDto[] {
    if (!installations.length) return [];
    this.#recover();
    this.list();
    const root = path.join(this.privateDir, `.skill-transaction-${randomUUID()}`);
    mkdirSync(root, { mode: 0o700 });
    const prepared: z.infer<typeof Transaction>["entries"] = [];
    const ids = new Set<string>(), destinations = new Set<string>();
    let journalWritten = false;
    try {
      for (const [index, { catalog, materialized, options = {} }] of installations.entries()) {
        const metadata = skillFrontmatter(readFileSync(path.join(materialized.directory, "SKILL.md"), "utf8"));
        if (!metadata.name || metadata.name.length > 120 || /[/\\\0]/.test(metadata.name) || metadata.name === "." || metadata.name === ".." || metadata.name.startsWith(".")) throw new HttpError(400, "Skill name cannot be used as a native directory");
        const previous = this.#registry.entries.find((entry) => entry.id === catalog.id);
        const retained = previous?.directory === materialized.directory ? previous : undefined;
        if (previous && !retained && (!previous.baselineVerified || this.#fingerprint.digest(previous.directory) !== previous.baseline)) {
          previous.availableRevision = materialized.revision;
          previous.lastCheckedAt = new Date().toISOString();
          this.#persist();
          throw new HttpError(409, "Local or unverified migrated Skill content is preserved. Review it before explicitly reinstalling.");
        }
        const activeDirectory = previous?.activeDirectory ?? path.join(this.root, metadata.name);
        const enabled = options.enabled ?? previous?.enabled ?? true;
        const directory = enabled ? activeDirectory : path.join(this.#disabled, createHash("sha256").update(catalog.id).digest("hex"));
        if (!this.#owned(activeDirectory) || !this.#owned(directory)) throw new HttpError(409, "Skill destination is outside the managed workspace");
        if (ids.has(catalog.id) || destinations.has(directory)) throw new HttpError(409, "The bundle contains conflicting Skill destinations");
        ids.add(catalog.id); destinations.add(directory);
        if (existsSync(directory) && (!previous || previous.directory !== directory)) throw new HttpError(409, "A native Skill already occupies this destination; it was not overwritten");
        const stage = path.join(root, `stage-${index}`);
        const backup = path.join(root, `previous-${index}`);
        cpSync(materialized.directory, stage, { recursive: true, dereference: false, errorOnExist: true });
        if (catalog.id === "official:openai:skill-creator") {
          const dependencies = path.resolve(import.meta.dir, "../../../../../workers/pi/resources/python");
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
      this.#registry.entries = [...this.#registry.entries.filter((entry) => !ids.has(entry.id)), ...prepared.map((item) => item.next)];
      this.#persist();
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
    if (existsSync(target)) throw new HttpError(409, "Another Skill occupies the destination; nothing was overwritten");
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
    if (!entry) return;
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
