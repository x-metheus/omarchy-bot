// Cleanup runs during single-Service startup. A thrown commit step rolls back the migration.
// After a hard kill, the next start undoes journaled operations before retrying.
// Skill destinations are allocated case-insensitively, and symlinked legacy Skills are copied in.
// Linked legacy Skill roots and categories are traversed with cycle protection.
// Disposal of staging trees and rolled-back copies handles read-only directories.
// Unmatched dangling aliases may remain. Concurrent writers, repeated interruption, and
// power-loss durability are out of scope. A marked start does nothing.
import { randomUUID } from "node:crypto";
import fs, {
  chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, rmSync, rmdirSync, statSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { isHomeDirectory } from "./paths.ts";

type CleanupStep = "folders" | "skills" | "mcp" | "marker";
export type CleanupResult =
  | { status: "skipped" }
  | { status: "completed"; backupDir?: string; skillsMoved: string[]; mcpServersAdded: string[]; conflicts: string[] };

const legacyFolders = [".pi", ".codex", ".claude"] as const;
const stagingPrefix = "workspace-cleanup-";
const skillRoot = ".agents/skills";
const skillParents = [".agents", skillRoot] as const;
const copyOptions = { recursive: true, verbatimSymlinks: true, preserveTimestamps: true };
const name = z.string().min(1).refine((value) => path.basename(value) === value && !value.includes("\0") && value !== "." && value !== "..");
const operationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("folder"), name: z.enum(legacyFolders) }),
  z.object({ kind: z.literal("skill"), name }),
  z.object({ kind: z.literal("alias"), name }),
  z.object({ kind: z.literal("mcp"), previous: z.boolean() }),
]);
const journalSchema = z.object({
  staging: z.string().regex(/^workspace-cleanup-[\w-]+$/),
  backup: z.string().regex(/^workspace-backup-\d{4}-\d{2}-\d{2}(?:-\d+)?$/).nullable(),
  createdSkillDirs: z.array(z.enum(skillParents)),
  completed: z.array(operationSchema),
  pending: z.object({ operation: operationSchema, partial: z.string().regex(/^\.partial-[a-f0-9-]+$/).optional(), ready: z.boolean().optional() }).optional(),
});
type Operation = z.infer<typeof operationSchema>;
type Journal = z.infer<typeof journalSchema>;

function entry(file: string) {
  return lstatSync(file, { throwIfNoEntry: false });
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function readMcp(file: string, toml = false) {
  const stat = entry(file);
  if (!stat) return { root: {}, servers: {}, mode: undefined };
  if (!stat.isFile()) throw new Error(`${file}: expected a regular MCP configuration file`);
  const text = readFileSync(file, "utf8");
  let root: unknown;
  try {
    root = toml ? Bun.TOML.parse(text) : JSON.parse(text);
  } catch {
    throw new Error(`${file}: invalid ${toml ? "TOML" : "JSON"} in MCP configuration`);
  }
  if (!record(root)) throw new Error(`${file}: expected a configuration object`);
  const key = toml ? "mcp_servers" : "mcpServers";
  const servers = Object.hasOwn(root, key) ? root[key] : {};
  if (!record(servers) || (!toml && !Object.values(servers).every(record))) throw new Error(`${file}: malformed MCP server map`);
  return { root, servers, mode: stat.mode & 0o777 };
}

const nonemptyString = z.string().refine((value) => !!value.trim());
const stringMap = z.custom<Record<string, string>>((value) => record(value)
  && Object.values(value).every((item) => typeof item === "string")).optional();
const codexStdio = z.object({
  type: z.literal("stdio").optional(), command: nonemptyString, args: z.array(z.string()).optional(),
  env: stringMap, enabled: z.boolean().optional(),
}).strict();
const codexHttp = z.object({
  type: z.literal("http").optional(), url: nonemptyString,
  headers: stringMap, http_headers: stringMap, enabled: z.boolean().optional(),
}).strict();

function convertCodex(server: unknown) {
  const stdio = codexStdio.safeParse(server);
  if (stdio.success) {
    const { command, args = [], env, enabled } = stdio.data;
    return { command, args, ...(env && { env }), disabled: enabled === false };
  }
  const http = codexHttp.safeParse(server);
  if (!http.success) return;
  const { url, headers, http_headers, enabled } = http.data;
  const endpoint = URL.parse(url);
  if (!endpoint || !["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password
    || [...endpoint.searchParams.keys()].some((key) => /token|secret|password|api.?key/i.test(key))) return;
  for (const [key, value] of Object.entries(http_headers ?? {})) {
    if (headers && Object.hasOwn(headers, key) && headers[key] !== value) return;
  }
  return { url, ...((headers || http_headers) && { headers: { ...headers, ...http_headers } }), disabled: enabled === false };
}

function scanSkills(
  directory: string, followLinks = false, depth = 0, ancestors: readonly string[] = [],
): { source: string; identity: string }[] {
  const stat = entry(directory);
  const linked = followLinks && stat?.isSymbolicLink();
  if (linked) {
    try { if (!statSync(directory).isDirectory()) return []; }
    catch (error) {
      if (!["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      return [];
    }
  } else if (!stat?.isDirectory()) return [];
  const resolved = followLinks ? realpathSync(directory) : directory;
  if (ancestors.includes(resolved)) return [];
  const file = path.join(directory, "SKILL.md");
  if (entry(file)?.isFile()) {
    const header = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(readFileSync(file, "utf8"));
    const fields: unknown = header && parseYaml(header[1]!, { maxAliasCount: 0 });
    const identity = record(fields) && typeof fields.name === "string" && fields.name.trim();
    return [{ source: directory, identity: identity || path.basename(directory) }];
  }
  if (depth === 5) return [];
  const nextAncestors = [...ancestors, resolved];
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((child) => child.isDirectory() || (followLinks && child.isSymbolicLink())
      ? scanSkills(path.join(directory, child.name), followLinks, depth + 1, nextAncestors) : []);
}

function planSkills(workspace: string, conflicts: Set<string>) {
  const target = path.join(workspace, skillRoot);
  const roots = [".pi", ".claude"].map((folder) => path.join(workspace, folder, "skills"));
  const sources = new Map(roots.filter((root) => entry(path.dirname(root))?.isDirectory())
    .flatMap((root) => scanSkills(root, true)).map(({ source, identity }) => [source, identity]));
  const identities = new Set(scanSkills(target).map(({ identity }) => identity));
  const installs = new Map<string, { destination: string; source: string; alias: boolean }>();
  const children = entry(target) ? readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) : [];
  const existing = new Map(children.map((child) => [child.name, child]));
  const occupied = new Set(children.map((child) => child.name.toLowerCase()));
  const aliases = new Set<string>();
  for (const child of children) {
    if (!child.isSymbolicLink()) continue;
    const source = path.resolve(target, readlinkSync(path.join(target, child.name)));
    if (!roots.some((root) => source === root || source.startsWith(root + path.sep))) continue;
    aliases.add(child.name);
    const identity = sources.get(source);
    const key = child.name.toLowerCase();
    if (!identity || identities.has(identity) || installs.has(key)) continue;
    installs.set(key, { destination: child.name, source, alias: true });
    identities.add(identity);
    sources.delete(source);
  }
  for (const [source, identity] of sources) {
    const basename = path.basename(source);
    const plain = existing.get(basename);
    if (identities.has(identity) || (plain && !plain.isDirectory() && !aliases.has(basename))) {
      conflicts.add(identity);
      continue;
    }
    let destination = basename;
    let key = destination.toLowerCase();
    for (let suffix = 2; installs.has(key) || occupied.has(key) || entry(path.join(target, destination)); suffix++) {
      destination = `${basename}-${suffix}`;
      key = destination.toLowerCase();
    }
    installs.set(key, { destination, source, alias: false });
    identities.add(identity);
  }
  return installs;
}

function planCleanup(workspace: string) {
  const legacy = new Map(legacyFolders.map((name) => [name, entry(path.join(workspace, name))]));
  const folders = legacyFolders.filter((name) => legacy.get(name));
  const sharedFile = path.join(workspace, ".mcp.json");
  const shared = readMcp(sharedFile);
  const pi = legacy.get(".pi")?.isDirectory() ? readMcp(path.join(workspace, ".pi/mcp.json")).servers : {};
  const codex = legacy.get(".codex")?.isDirectory() ? readMcp(path.join(workspace, ".codex/config.toml"), true).servers : {};
  const servers = new Map(Object.entries(shared.servers));
  const conflicts = new Set<string>();
  const mcpServersAdded: string[] = [];
  function add(name: string, server: unknown): void {
    if (!servers.has(name)) {
      servers.set(name, server);
      mcpServersAdded.push(name);
    } else if (!isDeepStrictEqual(servers.get(name), server) && !conflicts.has(name)) {
      console.warn(`Workspace cleanup kept the existing MCP server ${JSON.stringify(name)}`);
      conflicts.add(name);
    }
  }
  for (const [name, server] of Object.entries(pi)) add(name, server);
  for (const [name, server] of Object.entries(codex)) {
    const converted = convertCodex(server);
    if (converted) add(name, converted);
    else console.warn(`Workspace cleanup skipped unrepresentable Codex MCP server ${JSON.stringify(name)}`);
  }
  const createdSkillDirs = skillParents.filter((relative) => {
    const directory = path.join(workspace, relative);
    const stat = entry(directory);
    if (stat && !stat.isDirectory()) throw new Error(`${directory}: expected a workspace directory`);
    return !stat;
  });
  const skills = planSkills(workspace, conflicts);
  const mcp = mcpServersAdded.length ? { ...shared.root, mcpServers: Object.fromEntries(servers) } : undefined;
  return { folders, sharedFile, sharedMode: shared.mode, skills, mcp, createdSkillDirs, conflicts, mcpServersAdded };
}

function remove(file: string): void {
  rmSync(file, { recursive: true, force: true });
}

function makeDirectoriesWritable(directory: string): void {
  const stat = entry(directory);
  if (!stat?.isDirectory()) return;
  if ((stat.mode & 0o700) !== 0o700) chmodSync(directory, stat.mode | 0o700);
  for (const child of readdirSync(directory)) makeDirectoriesWritable(path.join(directory, child));
}

function removeCopy(file: string): void {
  makeDirectoriesWritable(file);
  remove(file);
}

function bestEffortRemove(file: string, dispose = remove): void {
  try { dispose(file); } catch { /* The marker or original error takes precedence. */ }
}

function move(from: string, to: string, {
  recordCopy,
  disposeSource = (file) => rmSync(file, { recursive: true }),
}: { recordCopy?: (partial: string, ready: boolean) => void; disposeSource?: (file: string) => void } = {}): void {
  try { fs.renameSync(from, to); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error; }
  const partial = path.join(path.dirname(to), `.partial-${randomUUID()}`);
  recordCopy?.(path.basename(partial), false);
  try {
    cpSync(from, partial, copyOptions);
    recordCopy?.(path.basename(partial), true);
    fs.renameSync(partial, to);
    disposeSource(from);
  } catch (error) {
    if (!recordCopy) bestEffortRemove(partial, removeCopy);
    throw error;
  }
}

function transaction(workspace: string, dataDir: string, journalFile: string, journal: Journal) {
  const stage = path.join(dataDir, journal.staging);
  const backupPath = () => journal.backup && path.join(dataDir, journal.backup);
  const paths = (operation: Operation): [from: string, to: string] => {
    switch (operation.kind) {
      case "folder": {
        const backup = backupPath();
        if (!backup) throw new Error(`${journalFile}: missing backup for a folder move`);
        return [path.join(workspace, operation.name), path.join(backup, operation.name)];
      }
      case "alias": return [path.join(workspace, skillRoot, operation.name), path.join(stage, "aliases", operation.name)];
      case "skill": return [path.join(stage, "skills", operation.name), path.join(workspace, skillRoot, operation.name)];
      case "mcp": return [path.join(stage, "mcp.json"), path.join(workspace, ".mcp.json")];
    }
  };
  function write(file: string, value: unknown): void {
    const tmp = path.join(stage, "write.tmp");
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  function undo(operation: Operation, sourceRemains = false): void {
    const [from, to] = paths(operation);
    if (operation.kind === "mcp") {
      if (operation.previous) move(path.join(stage, "mcp.previous"), to, { disposeSource: removeCopy });
      else removeCopy(to);
    } else if (sourceRemains) {
      // Undo publication and restore anything the source removal deleted before it stopped.
      if (entry(from)?.isDirectory()) cpSync(to, from, {
        ...copyOptions, force: false, filter: (source, destination) => !entry(destination) || !!entry(source)?.isDirectory(),
      });
      removeCopy(to);
    } else move(to, from, { disposeSource: removeCopy });
  }
  const persist = () => write(journalFile, journal);
  return {
    persist,
    write,
    reserveBackup(date: string): string {
      const base = `workspace-backup-${date}`;
      for (let suffix = 1; ; suffix++) {
        const name = suffix === 1 ? base : `${base}-${suffix}`;
        const directory = path.join(dataDir, name);
        if (entry(directory)) continue;
        journal.backup = name;
        persist();
        try { mkdirSync(directory, { mode: 0o700 }); return directory; }
        catch (error) {
          journal.backup = null;
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          persist();
        }
      }
    },
    commit(operation: Operation): void {
      const pending: NonNullable<Journal["pending"]> = { operation };
      journal.pending = pending;
      persist();
      move(...paths(operation), { recordCopy(partial, ready) {
        Object.assign(pending, { partial, ready });
        persist();
      } });
      journal.completed.push(operation);
      delete journal.pending;
      persist();
    },
    rollback(): void {
      if (journal.pending) {
        const { operation, partial, ready } = journal.pending;
        const [from, to] = paths(operation);
        if (partial) {
          const copy = path.join(path.dirname(to), partial);
          if (entry(copy)) removeCopy(copy);
          else if (ready && entry(to)) undo(operation, !!entry(from));
        } else if (!entry(from) && entry(to)) undo(operation);
      }
      for (const operation of journal.completed.slice().reverse()) undo(operation);
      for (const relative of journal.createdSkillDirs.slice().reverse()) {
        const directory = path.join(workspace, relative);
        if (entry(directory)) rmdirSync(directory);
      }
      const backup = backupPath();
      if (backup && entry(backup)) rmdirSync(backup);
      remove(journalFile);
      removeCopy(stage);
    },
  };
}

export function cleanupWorkspace(options: {
  workspaceDir: string;
  dataDir: string;
  now?: Date;
  hooks?: { beforeStep?: (step: CleanupStep) => void };
}): CleanupResult {
  const dataDir = path.resolve(options.dataDir);
  const marker = path.join(dataDir, "workspace-cleanup.json");
  if (entry(marker)) return { status: "skipped" };
  const workspace = realpathSync(options.workspaceDir);
  const home = process.env[process.platform === "win32" ? "USERPROFILE" : "HOME"] || os.homedir();
  if (isHomeDirectory(workspace, home)) throw new Error(`Workspace cleanup refuses to run in the user's home directory: ${workspace}`);
  const journalFile = path.join(dataDir, "workspace-cleanup.journal.json");
  if (entry(journalFile)) {
    const journal = journalSchema.parse(JSON.parse(readFileSync(journalFile, "utf8")));
    transaction(workspace, dataDir, journalFile, journal).rollback();
  }
  const plan = planCleanup(workspace);
  const completedAt = (options.now ?? new Date()).toISOString();
  const createdDataDir = mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let stage: string | undefined;
  let rollback: (() => void) | undefined;
  try {
    stage = mkdtempSync(path.join(dataDir, stagingPrefix));
    if (plan.skills.size) mkdirSync(path.join(stage, "aliases"));
    const destinations = new Set<string>();
    for (const { destination, source } of plan.skills.values()) {
      const key = path.join(skillRoot, destination).toLowerCase();
      // The unique destination name also identifies the staged copy in the journal.
      const staged = path.join(stage, "skills", destination);
      if (destinations.has(key) || entry(staged)) throw new Error(`${destination}: duplicate Skill destination or staging path`);
      destinations.add(key);
      cpSync(realpathSync(source), staged, copyOptions);
      if (!entry(path.join(staged, "SKILL.md"))?.isFile()) throw new Error(`${staged}: staged Skill is missing SKILL.md`);
    }
    const previous = plan.sharedMode !== undefined;
    if (plan.mcp) {
      const staged = path.join(stage, "mcp.json");
      writeFileSync(staged, `${JSON.stringify(plan.mcp, null, 2)}\n`, { mode: 0o600 });
      if (previous) cpSync(plan.sharedFile, path.join(stage, "mcp.previous"), copyOptions);
      chmodSync(staged, plan.sharedMode ?? 0o600);
      readMcp(staged);
    }
    const journal: Journal = {
      staging: path.basename(stage), backup: null, createdSkillDirs: plan.skills.size ? plan.createdSkillDirs : [], completed: [],
    };
    const { persist, commit, write, reserveBackup, rollback: undo } = transaction(workspace, dataDir, journalFile, journal);
    rollback = undo;
    persist();
    const backupDir = plan.folders.length ? reserveBackup(completedAt.slice(0, 10)) : null;
    options.hooks?.beforeStep?.("folders");
    for (const name of plan.folders) commit({ kind: "folder", name });
    options.hooks?.beforeStep?.("skills");
    for (const relative of journal.createdSkillDirs) mkdirSync(path.join(workspace, relative), { mode: 0o700 });
    for (const { destination: name, alias } of plan.skills.values()) {
      if (alias) commit({ kind: "alias", name });
      commit({ kind: "skill", name });
    }
    options.hooks?.beforeStep?.("mcp");
    if (plan.mcp) commit({ kind: "mcp", previous });
    options.hooks?.beforeStep?.("marker");
    write(marker, { version: 1, completedAt, backup: backupDir });
    bestEffortRemove(journalFile);
    bestEffortRemove(stage, removeCopy);
    return {
      status: "completed", ...(backupDir && { backupDir }),
      skillsMoved: [...plan.skills.values()].map(({ destination }) => destination), mcpServersAdded: plan.mcpServersAdded, conflicts: [...plan.conflicts],
    };
  } catch (error) {
    try {
      if (rollback) rollback();
      else if (stage) removeCopy(stage);
      if (createdDataDir) remove(createdDataDir);
    } catch (rollbackError) {
      console.warn("Workspace cleanup rollback failed", rollbackError);
    }
    throw error;
  }
}
