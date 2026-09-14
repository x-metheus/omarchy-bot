import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DeviceLocalJobFrame } from "../../../packages/protocol/src/index.ts";

const SECRET_DIR_NAMES = new Set([".ssh", ".gnupg", ".aws", ".config"]);
const SEARCH_HIT_LIMIT = 32;
const SNIPPET_MAX = 160;

export function confinedSidecarPath(relative: string, root: string): string {
  const resolved = path.resolve(root, relative);
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error("Local Sidecar path escapes the sandbox");
  }
  return resolved;
}

export function ruleKey(job: DeviceLocalJobFrame): string {
  return `${job.action}:${job.command ?? job.path ?? job.query ?? ""}`;
}

export async function executeLocalJob(
  job: DeviceLocalJobFrame,
  root: string,
): Promise<{ ok: true; text: string; exitCode?: number } | { ok: false; error: string }> {
  try {
    if (/\bscreenshot\b|\bpointer\b|SWAYSOCK|WAYLAND_DISPLAY/i.test(`${job.command ?? ""} ${job.path ?? ""}`)) {
      return { ok: false, error: "Local Sidecar rejects screenshot, pointer, and Host compositor actions" };
    }
    if (job.action === "run") {
      if (job.command === undefined) return { ok: false, error: "local.run requires a command" };
      const proc = Bun.spawn(["/bin/sh", "-c", job.command], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { ok: true, text: `${stdout}${stderr}`.slice(0, 8_192), exitCode };
    }
    if (job.action === "search") {
      if (job.query === undefined) return { ok: false, error: "local.search requires a query" };
      return { ok: true, text: searchSandbox(job.query, root, job.path) };
    }
    if (job.action === "read") {
      if (job.path === undefined) return { ok: false, error: "local.read requires an explicit path" };
      return { ok: true, text: readFileSync(confinedSidecarPath(job.path, root), "utf8").slice(0, 8_192) };
    }
    if (job.action === "write") {
      if (job.path === undefined) return { ok: false, error: "local.write requires an explicit path" };
      const target = confinedSidecarPath(job.path, root);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, job.contents ?? "");
      return { ok: true, text: `wrote ${job.path}` };
    }
    if (job.action === "transfer") {
      if (job.direction === "from-workspace") {
        if (job.destination === undefined) {
          return { ok: false, error: "transfer onto a Sidecar requires an explicit destination path" };
        }
        const target = confinedSidecarPath(job.destination, root);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, job.contents ?? "");
        return { ok: true, text: `copied to ${job.destination}` };
      }
      if (job.path === undefined) {
        return { ok: false, error: "transfer into Shared Workspace requires a Sidecar source path" };
      }
      return { ok: true, text: readFileSync(confinedSidecarPath(job.path, root), "utf8") };
    }
    return { ok: false, error: `unsupported local action ${job.action}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function searchSandbox(query: string, root: string, explicitRoot?: string): string {
  if (explicitRoot === "/" || query === "/") {
    throw new Error("Local Sidecar search cannot scan /");
  }
  const start = confinedSidecarPath(explicitRoot ?? ".", root);
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
      if (SECRET_DIR_NAMES.has(name)) continue;
      const full = path.join(dir, name);
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
