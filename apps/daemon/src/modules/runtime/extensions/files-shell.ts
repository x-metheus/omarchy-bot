import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { awaitWithContext, type Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { err, ExecutionError, FileError, ok, type Result, type WatchTarget } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { isHomeDirectory, type PlatformPaths } from "../../workspace/paths.ts";
import { MODEL_CREDENTIALS_FILENAME } from "../credentials.ts";

// Two minutes lets routine shell work finish while bounding commands that omit a timeout.
export const DEFAULT_BASH_TIMEOUT_SECONDS = 120;
export const MAX_BASH_TIMEOUT_SECONDS = 600;
const BASH_SETTLEMENT_GRACE_MS = 500;

// pi-durable 1.5.2 resolves paths within each method; guarding absolutePath alone does not guard I/O.
export const GUARDED_FILE_METHODS = [
  "absolutePath", "openTextLineReader", "readTextFile", "readTextLines", "readBinaryFile", "openBinaryReader",
  "writeFile", "appendFile", "truncateFile", "flushFile", "renameFile", "fileInfo", "listDir", "openDirReader",
  "canonicalPath", "exists", "createDir", "remove", "watch",
] as const satisfies readonly (keyof NodeExecutionEnv)[];
const guardedMethods = new Set<PropertyKey>(GUARDED_FILE_METHODS);

class FileAccessError extends FileError {
  constructor(code: FileError["code"], message: string, path: string, readonly outside = false) { super(code, message, path); }
}

function resolveInput(cwd: string, input: string): string {
  if (input === "~") return path.resolve(homedir());
  if (input.startsWith("~/") || (process.platform === "win32" && input.startsWith("~\\"))) {
    return path.resolve(path.join(homedir(), input.slice(2)));
  }
  return path.resolve(cwd, input.startsWith("file://") ? fileURLToPath(input) : input);
}

function canonicalPath(absolute: string): string {
  const missing: string[] = [];
  let ancestor = absolute;
  for (;;) {
    try {
      return path.join(realpathSync(ancestor), ...missing.reverse());
    } catch (error) {
      const parent = path.dirname(ancestor);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === ancestor) throw error;
      // A dangling symlink exists but has no real path. Propagate the resolution error.
      if (lstatSync(ancestor, { throwIfNoEntry: false })) throw error;
      missing.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function withinExactPath(root: string, target: string): boolean {
  // Require matching segment spelling for a grant even where path.relative folds case.
  return within(root, target) && path.join(root, path.relative(root, target)) === target;
}

function fileStat(file: string) {
  try { return statSync(file, { bigint: true }); }
  catch { return undefined; }
}

function hasIdentity(candidate: string, expected: ReturnType<typeof fileStat>): boolean {
  if (!expected) return false;
  const stat = fileStat(candidate);
  return stat?.dev === expected.dev && stat.ino === expected.ino;
}

export function hasDirectoryAncestor(root: string, target: string): boolean {
  const rootStat = fileStat(root);
  if (!rootStat?.isDirectory()) return false;
  for (let candidate = path.resolve(target); ; candidate = path.dirname(candidate)) {
    if (hasIdentity(candidate, rootStat)) return true;
    if (path.dirname(candidate) === candidate) return false;
  }
}

function withinProtectedDirectory(root: string, target: string): boolean {
  return within(root, target) || hasDirectoryAncestor(root, target);
}

export function resolveImplicitDownloads(paths: PlatformPaths): string | undefined {
  if (paths.downloadsDir === undefined) return undefined;
  try {
    const resolved = canonicalPath(path.resolve(paths.downloadsDir));
    if (!isHomeDirectory(resolved, paths.homeDir)) return resolved;
  } catch { /* An unresolved Downloads path cannot grant access. */ }
  return undefined;
}

function policy(paths: PlatformPaths, settingsFolders: readonly string[], botId: string | undefined, grants: readonly string[] = []) {
  const protectedPath = (value: string) => {
    const absolute = path.resolve(value);
    const resolved = canonicalPath(absolute);
    return absolute === resolved ? [absolute] : [absolute, resolved];
  };
  const credentialFile = path.join(paths.stateDir, MODEL_CREDENTIALS_FILENAME);
  const credentials = protectedPath(credentialFile);
  const credentialIdentity = fileStat(credentialFile);
  const serviceData = protectedPath(paths.dataDir);
  const serviceState = protectedPath(paths.stateDir);
  const botsRoot = path.join(paths.sharedWorkspaceDir, "bots");
  const bots = protectedPath(botsRoot);
  const botsStat = fileStat(botsRoot);
  const botsIdentity = botsStat?.isDirectory() ? botsStat : undefined;
  const botsSpelling = (name: string) => process.platform === "win32" ? name.toLowerCase() : name;
  const botsSpellings = new Set(bots.map(botsSpelling));
  const ownBot = botId && botId !== "." && botId !== ".." && !/[/\\\0]/.test(botId) ? botId : undefined;
  const crossesPrivateFolder = (name: string) => {
    // Check every bots/ prefix. A nested alias can point back to bots/ through a foreign Bot's folder.
    let child: string | undefined;
    for (let candidate = name; ; candidate = path.dirname(candidate)) {
      const isBotsRoot = botsSpellings.has(botsSpelling(candidate)) || hasIdentity(candidate, botsIdentity);
      if (isBotsRoot && (!ownBot || child !== ownBot)) return true;
      if (path.dirname(candidate) === candidate) return false;
      child = path.basename(candidate);
    }
  };
  const allowed = [paths.sharedWorkspaceDir, ...settingsFolders].flatMap((folder) => {
    try { return [canonicalPath(path.resolve(folder))]; } catch { return []; }
  });
  const downloads = resolveImplicitDownloads(paths);
  if (downloads !== undefined) allowed.push(downloads);
  return (cwd: string, input: string, includesDescendants = false): Result<string, FileAccessError> => {
    let absolute: string;
    let resolved: string;
    try {
      absolute = resolveInput(cwd, input);
      resolved = canonicalPath(absolute);
    } catch {
      return err(new FileAccessError("invalid", `Cannot resolve file path: ${input}`, input));
    }
    const names = absolute === resolved ? [absolute] : [absolute, resolved];
    const denied = (why: string) => err<string, FileAccessError>(new FileAccessError("permission_denied", `Access refused: ${why}: ${input}`, input));
    const containsProtected = (name: string, root: string) => includesDescendants && withinProtectedDirectory(name, root);
    const overlapsProtected = (root: string, name: string) => withinProtectedDirectory(root, name) || containsProtected(name, root);
    if (hasIdentity(resolved, credentialIdentity) ||
      credentials.some((root) => names.some((name) => path.relative(root, name) === "" || containsProtected(name, root)))) return denied("credential store");
    if (serviceData.some((root) => names.some((name) => overlapsProtected(root, name)))) return denied("Service data directory");
    if (serviceState.some((root) => names.some((name) => overlapsProtected(root, name)))) return denied("Service state directory");
    if (names.some((name) => crossesPrivateFolder(name) || bots.some((root) => containsProtected(name, root)))) {
      return denied("another Bot's private folder");
    }
    if (!allowed.some((root) => withinExactPath(root, resolved)) && !grants.includes(resolved)) {
      return err(new FileAccessError("permission_denied", `Access refused: outside the allowed folders: ${input}`, input, true));
    }
    return ok(resolved);
  };
}

export type FileAccess =
  | { kind: "allowed"; path: string }
  | { kind: "outside"; path: string }
  | { kind: "refused"; message: string };

/** Decide a file tool path without touching it: allowed, outside the allowed folders (may be approved), or refused. */
export function classifyFileAccess(
  paths: PlatformPaths,
  settingsFolders: readonly string[],
  botId: string | undefined,
  cwd: string,
  input: string,
): FileAccess {
  let guard: ReturnType<typeof policy>;
  try { guard = policy(paths, settingsFolders, botId); }
  catch { return { kind: "refused", message: "Cannot resolve the protected file locations" }; }
  const checked = guard(cwd, input);
  if (checked.ok) return { kind: "allowed", path: checked.value };
  if (!checked.error.outside) return { kind: "refused", message: checked.error.message };
  return { kind: "outside", path: canonicalPath(resolveInput(cwd, input)) };
}

/** `grants` are canonical file paths an approval allows for one call; refused locations stay refused. */
export function createFilesEnvironment(
  paths: PlatformPaths,
  settingsFolders: readonly string[],
  cwd = paths.sharedWorkspaceDir,
  botId?: string,
  grants: readonly string[] = [],
): NodeExecutionEnv {
  let guard: ReturnType<typeof policy>;
  try {
    guard = policy(paths, settingsFolders, botId, grants);
  } catch {
    guard = (_cwd, input) => err(new FileAccessError("invalid", "Cannot resolve the protected file locations", input));
  }
  const checkedCwd = guard(path.resolve(paths.sharedWorkspaceDir), cwd);
  const cwdError = checkedCwd.ok ? undefined : new FileAccessError(checkedCwd.error.code, `Cannot use conversation cwd. ${checkedCwd.error.message}`, cwd);
  const inner = new NodeExecutionEnv({ cwd: checkedCwd.ok ? checkedCwd.value : path.resolve(paths.sharedWorkspaceDir) });
  return new Proxy(inner, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property);
      if (typeof member !== "function") return member;
      // Shell commands cannot be checked against allowed folders without an OS sandbox. Only cwd is checked.
      if (property === "exec" && cwdError) {
        return async () => err(new ExecutionError("spawn_error", cwdError.message));
      }
      // joinPath is lexical. Internal temp allocations and cleanup are outside file-tool policy.
      if (!guardedMethods.has(property)) return member.bind(target);
      return async (...args: unknown[]) => {
        if (cwdError) return err(cwdError);
        if (property === "watch") {
          const targets: WatchTarget[] = [];
          for (const item of args[0] as readonly WatchTarget[]) {
            const checked = guard(inner.cwd, item.path, true);
            if (!checked.ok) return checked;
            targets.push({ ...item, path: checked.value });
          }
          args[0] = targets;
        } else {
          const pathCount = property === "renameFile" ? 2 : 1;
          const includesDescendants = property === "renameFile" || property === "remove";
          for (let index = 0; index < pathCount; index++) {
            const checked = guard(inner.cwd, args[index] as string, includesDescendants);
            if (!checked.ok) return checked;
            args[index] = checked.value;
          }
        }
        if (property === "canonicalPath") {
          // pi-durable's mutation key walks upward on not_found. The guard already resolved the
          // missing suffix through the existing ancestor, so the queue can use that key directly.
          const [absolute, context] = args as [string, Context];
          const result = await target.canonicalPath(absolute, context);
          return !result.ok && result.error.code === "not_found" ? ok(absolute) : result;
        }
        return Reflect.apply(member, target, args);
      };
    },
  });
}

function withFilePolicy<T extends object>(tool: ToolRegistration<T>) {
  return defineTool({
    ...tool,
    async execute(args, api, context) {
      try {
        return await tool.execute(args, api, context);
      } catch (error) {
        if (!(error instanceof FileAccessError) || context.abortSignal?.aborted) throw error;
        return { isError: true, output: [{ type: "text", text: error.message }] };
      }
    },
  });
}

export function createFilesShellExtension(platform = process.platform) {
  const bash = createBashTool();
  return defineExtension({
    name: "omarchy-files-shell",
    tools: [
      withFilePolicy(createReadTool()),
      withFilePolicy(createWriteTool()),
      withFilePolicy(createEditTool()),
      defineTool({
        ...bash,
        async execute(args, api, context) {
          if (platform === "win32") {
            return { isError: true, output: [{ type: "text", text: "bash is unsupported on Windows." }] };
          }
          const timeout = Math.min(args.timeout ?? DEFAULT_BASH_TIMEOUT_SECONDS, MAX_BASH_TIMEOUT_SECONDS);
          let finished = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const deadline = new Promise<Awaited<ReturnType<typeof bash.execute>>>((resolve) => {
              timer = setTimeout(() => {
                finished = true;
                // A descendant outside the process group can keep pi-durable's pipe readers and spill stream active
                // after settlement by holding the output pipe open. Closing those streams requires an upstream change.
                void api.env?.cleanup(context).catch(() => {});
                resolve({ isError: true, output: [{ type: "text", text: `Command timed out after ${timeout} seconds` }] });
              }, timeout * 1000 + BASH_SETTLEMENT_GRACE_MS);
            });
            const running = bash.execute({ ...args, timeout }, {
              ...api,
              output(...output) { if (!finished && !context.abortSignal?.aborted) api.output(...output); },
              diagnostic(diagnostic) { if (!finished && !context.abortSignal?.aborted) api.diagnostic(diagnostic); },
            }, context);
            return await awaitWithContext(Promise.race([running, deadline]), context);
          } finally {
            finished = true;
            clearTimeout(timer);
          }
        },
      }),
    ],
  });
}
