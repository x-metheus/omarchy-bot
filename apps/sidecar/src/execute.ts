import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LOCAL_RESULT_TEXT_MAX, type DeviceLocalJobFrame } from "@omarchy-bot/protocol";
import { confinedPath } from "@omarchy-bot/domain";
import type { LocalDeviceIdentity } from "@omarchy-bot/agent-contract";
import { posixExecutor, type LocalExecutor } from "./posix.ts";

const LINUX_SECRET_PATHS = [".ssh", ".gnupg", ".aws", ".config"];
const MACOS_SECRET_PATHS = [...LINUX_SECRET_PATHS, "Library/Keychains", "Library/Accounts", "Library/Application Support/com.apple.TCC"];
const SEARCH_HIT_LIMIT = 32;
const SNIPPET_MAX = 160;

export function ruleKey(job: Pick<DeviceLocalJobFrame, "action" | "command" | "path" | "query">): string {
  return `${job.action}:${job.command ?? job.path ?? job.query ?? ""}`;
}

export async function executeLocalJob(
  job: DeviceLocalJobFrame,
  root: string,
  signal?: AbortSignal,
  options: { os?: LocalDeviceIdentity["os"] | undefined; executor?: LocalExecutor } = {},
): Promise<{ ok: true; text: string; exitCode?: number } | { ok: false; error: string }> {
  try {
    signal?.throwIfAborted();
    const os = options.os ?? (process.platform === "darwin" ? "macos" : "linux");
    const secretPaths = os === "macos" ? MACOS_SECRET_PATHS : LINUX_SECRET_PATHS;
    const localPaths = job.action === "transfer"
      ? [job.direction === "from-workspace" ? job.destination : job.path]
      : [job.path];
    if (os === "macos" && localPaths.some((target) => target !== undefined && isSecretPath(confinedPath(target, root), root, secretPaths, true))) {
      return { ok: false, error: "Local Sidecar refuses credential directories" };
    }
    if (/\bscreenshot\b|\bpointer\b|SWAYSOCK|WAYLAND_DISPLAY/i.test(`${job.command ?? ""} ${job.path ?? ""}`)) {
      return { ok: false, error: "Local Sidecar rejects screenshot, pointer, and Host compositor actions" };
    }
    if (job.action === "run") {
      if (job.command === undefined) return { ok: false, error: "local.run requires a command" };
      return await (options.executor ?? posixExecutor).run(job.command, root, signal);
    }
    if (job.action === "search") {
      if (job.query === undefined) return { ok: false, error: "local.search requires a query" };
      return { ok: true, text: searchSandbox(job.query, root, secretPaths, os === "macos", job.path) };
    }
    if (job.action === "read") {
      if (job.path === undefined) return { ok: false, error: "local.read requires an explicit path" };
      return { ok: true, text: readFileSync(confinedPath(job.path, root), "utf8").slice(0, 8_192) };
    }
    if (job.action === "write") {
      if (job.path === undefined) return { ok: false, error: "local.write requires an explicit path" };
      signal?.throwIfAborted();
      const target = confinedPath(job.path, root);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, job.contents ?? "");
      return { ok: true, text: `wrote ${job.path}` };
    }
    if (job.action === "transfer") {
      if (job.direction === "from-workspace") {
        if (job.destination === undefined) {
          return { ok: false, error: "transfer onto a Sidecar requires an explicit destination path" };
        }
        signal?.throwIfAborted();
        const target = confinedPath(job.destination, root);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, job.contents ?? "");
        return { ok: true, text: `copied to ${job.destination}` };
      }
      if (job.path === undefined) {
        return { ok: false, error: "transfer into Shared Workspace requires a Sidecar source path" };
      }
      const text = readFileSync(confinedPath(job.path, root), "utf8");
      if (text.length > LOCAL_RESULT_TEXT_MAX) {
        return { ok: false, error: `transfer exceeds the ${LOCAL_RESULT_TEXT_MAX} character result frame` };
      }
      return { ok: true, text };
    }
    return { ok: false, error: `unsupported local action ${job.action}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isSecretPath(target: string, root: string, secretPaths: readonly string[], ignoreCase: boolean): boolean {
  const relative = path.relative(root, target).split(path.sep).join("/");
  const candidate = `/${ignoreCase ? relative.toLowerCase() : relative}/`;
  return secretPaths.some((secret) => candidate.includes(`/${ignoreCase ? secret.toLowerCase() : secret}/`));
}

function searchSandbox(query: string, root: string, secretPaths: readonly string[], ignoreCase: boolean, explicitRoot?: string): string {
  if (explicitRoot === "/" || query === "/") {
    throw new Error("Local Sidecar search cannot scan /");
  }
  const start = confinedPath(explicitRoot ?? ".", root);
  if (isSecretPath(start, root, secretPaths, ignoreCase)) throw new Error("Local Sidecar refuses credential directories");
  const hits: string[] = [];
  const walk = (dir: string): void => {
    if (hits.length >= SEARCH_HIT_LIMIT) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (hits.length >= SEARCH_HIT_LIMIT) return;
      const full = path.join(dir, name);
      if (isSecretPath(full, root, secretPaths, ignoreCase)) continue;
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      let body = "";
      try {
        body = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (!full.includes(query) && !body.includes(query)) continue;
      const relative = path.relative(root, full);
      const line = body.split("\n").find((candidate) => candidate.includes(query)) ?? "";
      hits.push(`${relative}: ${line.slice(0, SNIPPET_MAX)}`);
    }
  };
  walk(start);
  return hits.join("\n").slice(0, 8_192);
}
