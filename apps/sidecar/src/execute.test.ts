import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { dlopen, ptr } from "bun:ffi";
import { LOCAL_RESULT_TEXT_MAX, type DeviceLocalJobFrame } from "@omarchy-bot/protocol";
import { executeLocalJob } from "./execute.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function transferJob(file: string): DeviceLocalJobFrame {
  return {
    type: "local.job" as const,
    jobId: "job-1",
    action: "transfer" as const,
    hostname: "laptop",
    botId: "bot",
    turnId: "turn",
    path: file,
    destination: "inbox/big.txt",
    direction: "to-workspace" as const,
  };
}

describe("executeLocalJob transfer frame bound", () => {
  test("refuses a to-workspace file that exceeds the result frame", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-transfer-"));
    roots.push(root);
    writeFileSync(path.join(root, "big.txt"), "x".repeat(LOCAL_RESULT_TEXT_MAX + 1));
    const result = await executeLocalJob(transferJob("big.txt"), root);
    expect(result).toEqual({
      ok: false,
      error: `transfer exceeds the ${LOCAL_RESULT_TEXT_MAX} character result frame`,
    });
  });

  test("returns a to-workspace file that fits the result frame", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-transfer-"));
    roots.push(root);
    const text = "y".repeat(LOCAL_RESULT_TEXT_MAX);
    writeFileSync(path.join(root, "fit.txt"), text);
    const result = await executeLocalJob(transferJob("fit.txt"), root);
    expect(result).toEqual({ ok: true, text });
  });

  test("an aborted run kills the child and does not succeed", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-abort-"));
    roots.push(root);
    const controller = new AbortController();
    const pending = executeLocalJob({
      type: "local.job",
      jobId: "job-abort",
      action: "run",
      hostname: "laptop",
      botId: "bot",
      turnId: "turn",
      command: "sleep 30",
    }, root, controller.signal);
    controller.abort();
    const result = await pending;
    expect(result.ok).toBeFalse();
  });
});

describe("Windows credential stores", () => {
  test("refuses a credential read while retaining the Linux policy", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-windows-policy-"));
    roots.push(root);
    const file = "AppData/Roaming/Microsoft/Credentials/secret.txt";
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), "secret");
    const job: DeviceLocalJobFrame = { ...transferJob(file), action: "read" };
    expect(await executeLocalJob(job, root, undefined, { os: "windows" })).toEqual({
      ok: false, error: "Local Sidecar refuses credential directories",
    });
    expect(await executeLocalJob(job, root, undefined, { os: "linux" })).toEqual({ ok: true, text: "secret" });
  });

  test("blocks case-insensitive key stores for every file action and excludes them from search", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-windows-policy-"));
    roots.push(root);
    const stores = [
      "AppData/Local/Microsoft/Credentials", "AppData/Roaming/Microsoft/Credentials",
      "AppData/Local/Microsoft/Protect", "AppData/Roaming/Microsoft/Protect",
      "AppData/Local/Microsoft/Vault", "AppData/Roaming/Microsoft/Vault",
      "AppData/Local/Microsoft/Crypto", "AppData/Roaming/Microsoft/Crypto",
      "appdata/roaming/microsoft/credentials",
    ];
    for (const store of stores) {
      const file = `${store}/secret.txt`;
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), "needle-secret");
      for (const action of ["read", "write", "search", "transfer"] as const) {
        const job = { ...transferJob(file), action, query: "needle", contents: "overwrite" };
        expect(await executeLocalJob(job, root, undefined, { os: "windows" })).toEqual({
          ok: false, error: "Local Sidecar refuses credential directories",
        });
      }
      expect(await executeLocalJob({ ...transferJob("ordinary.txt"), direction: "from-workspace", destination: file, contents: "overwrite" }, root, undefined, { os: "windows" })).toEqual({
        ok: false, error: "Local Sidecar refuses credential directories",
      });
      expect(readFileSync(path.join(root, file), "utf8")).toBe("needle-secret");
    }
    const safe = "AppData/Roaming/notes/entry.txt";
    mkdirSync(path.dirname(path.join(root, safe)), { recursive: true });
    writeFileSync(path.join(root, safe), "needle-safe");
    expect(await executeLocalJob({ ...transferJob(safe), action: "read" }, root, undefined, { os: "windows" })).toEqual({ ok: true, text: "needle-safe" });
    const result = await executeLocalJob({ ...transferJob("."), action: "search", query: "needle" }, root, undefined, { os: "windows" });
    expect(result).toEqual({ ok: true, text: `${path.normalize(safe)}: needle-safe` });
  });

  test.skipIf(process.platform !== "win32")("refuses a witnessed NTFS short alias for existing files and missing write descendants", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-short-path-"));
    roots.push(root);
    const store = "AppData/Roaming/Microsoft/Credentials";
    mkdirSync(path.join(root, store), { recursive: true });
    writeFileSync(path.join(root, store, "secret.txt"), "needle-secret");
    const api = dlopen("kernel32.dll", { GetShortPathNameW: { args: ["ptr", "ptr", "u32"], returns: "u32" } });
    let alias: string;
    let ancestorAlias: string;
    try {
      const input = Buffer.from(`${path.join(root, store)}\0`, "utf16le");
      const output = Buffer.alloc(65_536);
      const length = api.symbols.GetShortPathNameW(ptr(input), ptr(output), output.length / 2);
      expect(length).toBeGreaterThan(0);
      expect(length).toBeLessThan(output.length / 2);
      alias = path.basename(output.toString("utf16le", 0, length * 2));
      // A lexical spelling such as CREDEN~1 is not evidence that NTFS created an alias.
      expect(alias.toLowerCase()).not.toBe("credentials");
      expect(readFileSync(path.join(root, "AppData/Roaming/Microsoft", alias, "secret.txt"), "utf8")).toBe("needle-secret");
      const ancestor = Buffer.from(`${path.join(root, "AppData/Roaming/Microsoft")}\0`, "utf16le");
      const ancestorLength = api.symbols.GetShortPathNameW(ptr(ancestor), ptr(output), output.length / 2);
      expect(ancestorLength).toBeGreaterThan(0);
      expect(ancestorLength).toBeLessThan(output.length / 2);
      ancestorAlias = path.basename(output.toString("utf16le", 0, ancestorLength * 2));
      expect(ancestorAlias.toLowerCase()).not.toBe("microsoft");
      expect(readFileSync(path.join(root, "AppData/Roaming", ancestorAlias, "Credentials/secret.txt"), "utf8")).toBe("needle-secret");
    } finally {
      api.close();
    }
    const aliased = `AppData/Roaming/Microsoft/${alias}`;
    for (const action of ["read", "write", "search", "transfer"] as const) {
      expect(await executeLocalJob({ ...transferJob(`${aliased}/secret.txt`), action, query: "needle", contents: "overwrite" }, root)).toEqual({
        ok: false, error: "Local Sidecar refuses credential directories",
      });
    }
    const missing = `${aliased}/new/nested/secret.txt`;
    expect(await executeLocalJob({ ...transferJob(missing), action: "write", contents: "overwrite" }, root)).toEqual({
      ok: false, error: "Local Sidecar refuses credential directories",
    });
    expect(await executeLocalJob({ ...transferJob("ordinary.txt"), direction: "from-workspace", destination: missing, contents: "overwrite" }, root)).toEqual({
      ok: false, error: "Local Sidecar refuses credential directories",
    });
    expect(readFileSync(path.join(root, store, "secret.txt"), "utf8")).toBe("needle-secret");
    expect(existsSync(path.join(root, store, "new"))).toBeFalse();
    const safe = "AppData/Roaming/Microsoft/notes/entry.txt";
    mkdirSync(path.dirname(path.join(root, safe)), { recursive: true });
    writeFileSync(path.join(root, safe), "needle-safe");
    expect(await executeLocalJob({ ...transferJob(`AppData/Roaming/${ancestorAlias}`), action: "search", query: "needle" }, root)).toEqual({
      ok: true, text: `${path.normalize(safe)}: needle-safe`,
    });
  });
});

/** A background descendant that ignores SIGTERM and only writes once released. */
const DESCENDANT_COMMAND =
  "sh -c 'trap \"\" TERM; echo $$ > descendant.pid; while [ ! -f release ]; do sleep 0.05; done; printf survived > marker.txt' & wait";

/** The same descendant, but the shell exits at once and leaves it behind. */
const SHELL_EXITS_FIRST_COMMAND =
  "sh -c 'trap \"\" HUP TERM; echo $$ > descendant.pid; while [ ! -f release ]; do sleep 0.05; done; printf survived > marker.txt' & echo $$ > shell.pid; exit 0";

function processAlive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] !== "Z" && fields[0] !== "X";
  } catch {
    return false;
  }
}

/** Poll a condition; readiness and exit are witnessed, never slept on. */
async function until(probe: () => boolean, message: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (probe()) return;
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(10);
  }
}

/** Bound a promise so a stuck job fails loudly instead of hanging the suite. */
async function withDeadline<T>(operation: Promise<T>, message: string, timeoutMs = 10_000): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error(message)), timeoutMs);
  try {
    return await Promise.race([operation, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(process.platform !== "linux")("executeLocalJob descendant teardown", () => {
  test("aborting a run stops descendants that ignore SIGTERM", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-descendant-"));
    roots.push(root);
    const controller = new AbortController();
    const pending = executeLocalJob({
      type: "local.job",
      jobId: "job-descendant",
      action: "run",
      hostname: "laptop",
      botId: "bot",
      turnId: "turn",
      command: DESCENDANT_COMMAND,
    }, root, controller.signal);
    let descendantPid: number | undefined;
    try {
      await until(() => existsSync(path.join(root, "descendant.pid")), "descendant never became ready");
      descendantPid = Number(readFileSync(path.join(root, "descendant.pid"), "utf8").trim());
      expect(Number.isSafeInteger(descendantPid)).toBeTrue();
      expect(processAlive(descendantPid)).toBeTrue();

      controller.abort();
      await until(() => !processAlive(descendantPid!), "descendant survived the aborted job");

      const result = await withDeadline(pending, "aborted run never settled");
      expect(result.ok).toBeFalse();

      writeFileSync(path.join(root, "release"), "");
      expect(existsSync(path.join(root, "marker.txt"))).toBeFalse();
    } finally {
      if (descendantPid !== undefined && processAlive(descendantPid)) {
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  }, 30_000);

  test("cancelling still reaches descendants after the shell has exited", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-orphan-"));
    roots.push(root);
    const controller = new AbortController();
    const pending = executeLocalJob({
      type: "local.job",
      jobId: "job-orphan",
      action: "run",
      hostname: "laptop",
      botId: "bot",
      turnId: "turn",
      command: SHELL_EXITS_FIRST_COMMAND,
    }, root, controller.signal);
    let descendantPid: number | undefined;
    try {
      await until(
        () => existsSync(path.join(root, "descendant.pid")) && existsSync(path.join(root, "shell.pid")),
        "the shell and its descendant never started",
      );
      descendantPid = Number(readFileSync(path.join(root, "descendant.pid"), "utf8").trim());
      const shellPid = Number(readFileSync(path.join(root, "shell.pid"), "utf8").trim());
      expect(Number.isSafeInteger(descendantPid)).toBeTrue();
      expect(Number.isSafeInteger(shellPid)).toBeTrue();
      await until(() => !processAlive(shellPid), "the shell never exited");
      expect(processAlive(descendantPid)).toBeTrue();

      controller.abort();
      await until(() => !processAlive(descendantPid!), "descendant outlived the aborted job");

      const result = await withDeadline(pending, "aborted run never settled");
      expect(result.ok).toBeFalse();

      writeFileSync(path.join(root, "release"), "");
      expect(existsSync(path.join(root, "marker.txt"))).toBeFalse();
    } finally {
      if (descendantPid !== undefined && processAlive(descendantPid)) {
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  }, 30_000);
});
