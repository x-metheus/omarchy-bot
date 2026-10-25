import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { DeleteBotResultDto, ThreadDto } from "../../packages/protocol/src/index.ts";
import {
  api,
  authedFetch,
  makeBot,
  sendToBot,
  sendToThread,
  startDaemon,
  waitThreadIdle,
  type Harness,
} from "./helpers/harness.ts";

interface FakeWorkerObservation {
  type: "session.open" | "session.resume" | "message.send";
  botId?: string;
  threadId?: string;
  nativeSessionId?: string;
  options?: { cwd?: string; instructions?: string; model?: string };
}

function workerObservations(h: Harness): FakeWorkerObservation[] {
  const log = path.join(h.home, "fake-agent-observations.ndjson");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as FakeWorkerObservation);
}

async function waitForWorkerObservation(
  h: Harness,
  predicate: (observation: FakeWorkerObservation) => boolean,
  timeoutMs = 5_000,
): Promise<FakeWorkerObservation> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const observation = workerObservations(h).find(predicate);
    if (observation !== undefined) return observation;
    if (Date.now() > deadline) throw new Error("fake Agent never observed the expected command");
    await Bun.sleep(25);
  }
}

function sharedWorkspace(h: Harness): string {
  return path.join(h.home, ".omarchy-bot", "workspace");
}

function sessionForThread(
  h: Harness,
  type: "session.open" | "session.resume",
  botId: string,
  threadId: string,
): FakeWorkerObservation {
  const observation = workerObservations(h).find(
    (entry) => entry.type === type && entry.botId === botId && entry.threadId === threadId,
  );
  if (observation === undefined) {
    throw new Error(`fake Agent never observed ${type} for ${threadId}`);
  }
  return observation;
}

describe("Shared Workspace default cwd", () => {
  let h: Harness | undefined;
  let previousCwd: string | undefined;

  afterEach(async () => {
    await h?.stop();
    h = undefined;
    if (previousCwd !== undefined) {
      process.chdir(previousCwd);
      previousCwd = undefined;
    }
  });

  test("a Bot without an explicit Thread cwd works in the home-local Shared Workspace", async () => {
    h = await startDaemon();
    const workspace = sharedWorkspace(h);
    const botId = await makeBot(h, "Workspace Bot");
    const sent = await sendToBot(h, botId, "say: hello from shared workspace");
    await waitThreadIdle(h, sent.threadId);

    const opened = sessionForThread(h, "session.open", botId, sent.threadId);
    expect(opened.options?.cwd).toBe(workspace);
    expect(opened.options?.cwd).not.toBe(process.cwd());
    expect(opened.options?.cwd).not.toBe(h.home);
    expect(statSync(workspace).isDirectory()).toBeTrue();
  });

  test("prepares the Shared Workspace once and reuses existing files without Git", async () => {
    // The daemon prepares the Shared Workspace while booting, so this fixture
    // starts from a workspace that already holds user files.
    const home = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-reuse-"));
    const workspace = path.join(home, ".omarchy-bot", "workspace");
    mkdirSync(workspace, { recursive: true });
    const sentinel = path.join(workspace, "keep-me.txt");
    writeFileSync(sentinel, "prior work");

    h = await startDaemon(home);
    expect(sharedWorkspace(h)).toBe(workspace);
    expect(statSync(workspace).isDirectory()).toBeTrue();
    expect(readFileSync(sentinel, "utf8")).toBe("prior work");
    expect(existsSync(path.join(workspace, ".git"))).toBeFalse();

    const botId = await makeBot(h, "Reuse Bot");
    const first = await sendToBot(h, botId, "say: first file turn");
    await waitThreadIdle(h, first.threadId);
    expect(sessionForThread(h, "session.open", botId, first.threadId).options?.cwd).toBe(workspace);
    expect(readFileSync(sentinel, "utf8")).toBe("prior work");
    expect(existsSync(path.join(workspace, ".git"))).toBeFalse();

    const continued = await sendToThread(h, first.threadId, "say: continue in the same files");
    await waitThreadIdle(h, continued.threadId);

    const resumed = sessionForThread(h, "session.resume", botId, first.threadId);
    expect(resumed.options?.cwd).toBe(workspace);
    expect(readFileSync(sentinel, "utf8")).toBe("prior work");
    expect(existsSync(path.join(workspace, ".git"))).toBeFalse();
  });

  test("two Bots on the same Agent share the default cwd and keep distinct Native Sessions", async () => {
    h = await startDaemon();
    const workspace = sharedWorkspace(h);
    const firstBotId = await makeBot(h, "Shared files A");
    const secondBotId = await makeBot(h, "Shared files B");
    const first = await sendToBot(h, firstBotId, "say: bot a");
    const second = await sendToBot(h, secondBotId, "say: bot b");
    await waitThreadIdle(h, first.threadId);
    await waitThreadIdle(h, second.threadId);

    const firstOpen = sessionForThread(h, "session.open", firstBotId, first.threadId);
    const secondOpen = sessionForThread(h, "session.open", secondBotId, second.threadId);
    expect(firstOpen.options?.cwd).toBe(workspace);
    expect(secondOpen.options?.cwd).toBe(workspace);
    expect(firstOpen.nativeSessionId).not.toBe(secondOpen.nativeSessionId);
  });

  test("a new Thread inherits the Shared Workspace without creating another work-file directory", async () => {
    h = await startDaemon();
    const workspace = sharedWorkspace(h);
    const botId = await makeBot(h, "Multi-thread Bot");
    const first = await sendToBot(h, botId, "say: first conversation");
    const second = await sendToBot(h, botId, "say: second conversation");
    await waitThreadIdle(h, first.threadId);
    await waitThreadIdle(h, second.threadId);

    expect(sessionForThread(h, "session.open", botId, first.threadId).options?.cwd).toBe(workspace);
    expect(sessionForThread(h, "session.open", botId, second.threadId).options?.cwd).toBe(workspace);
    expect(first.threadId).not.toBe(second.threadId);
    expect(statSync(workspace).isDirectory()).toBeTrue();
    expect(existsSync(`${workspace}-thread-${first.threadId}`)).toBeFalse();
    expect(existsSync(`${workspace}-thread-${second.threadId}`)).toBeFalse();
  });

  test("an explicit Thread cwd is preserved even when it equals a plugin directory", async () => {
    h = await startDaemon();
    const pluginCwd = path.resolve(import.meta.dir, "../../workers/pi");
    const botId = await makeBot(h, "Explicit cwd Bot");
    const thread = h.svc.threads.createThread(botId, {
      title: "Plugin project",
      cwd: pluginCwd,
    });
    const sent = await sendToThread(h, thread.id, "say: stay in the plugin checkout");
    await waitThreadIdle(h, sent.threadId);

    expect(sessionForThread(h, "session.open", botId, thread.id).options?.cwd).toBe(pluginCwd);
    expect(pluginCwd).not.toBe(sharedWorkspace(h));
  });

  test("launching and restarting from other directories does not change the default cwd", async () => {
    previousCwd = process.cwd();
    const launchDir = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-launch-"));
    const restartDir = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-relaunch-"));
    const sourceSentinel = path.join(launchDir, "plugin-source-sentinel.txt");
    writeFileSync(sourceSentinel, "plugin source");
    try {
      process.chdir(launchDir);
      h = await startDaemon();
      const workspace = sharedWorkspace(h);
      const botId = await makeBot(h, "Launch-stable Bot");
      const first = await sendToBot(h, botId, "say: from first launch dir");
      await waitThreadIdle(h, first.threadId);
      const firstOpen = sessionForThread(h, "session.open", botId, first.threadId);
      expect(firstOpen.options?.cwd).toBe(workspace);
      expect(firstOpen.options?.cwd).not.toBe(launchDir);
      expect(firstOpen.options?.cwd).not.toBe(h.home);
      expect(readFileSync(sourceSentinel, "utf8")).toBe("plugin source");

      const home = h.home;
      await h.disconnectForRestart();
      process.chdir(restartDir);
      h = await startDaemon(home);
      const continued = await sendToThread(h, first.threadId, "say: after restart from another dir");
      await waitThreadIdle(h, continued.threadId);
      const resumed = sessionForThread(h, "session.resume", botId, first.threadId);
      expect(resumed.options?.cwd).toBe(workspace);
      expect(resumed.options?.cwd).not.toBe(restartDir);
      expect(readFileSync(sourceSentinel, "utf8")).toBe("plugin source");
    } finally {
      rmSync(launchDir, { recursive: true, force: true });
      rmSync(restartDir, { recursive: true, force: true });
    }
  });

  test("workspace access failure is honest and never falls back to source or install", async () => {
    previousCwd = process.cwd();
    const sourceDir = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-source-"));
    writeFileSync(path.join(sourceDir, "install-sentinel.txt"), "keep");
    try {
      process.chdir(sourceDir);
      h = await startDaemon();
      const workspace = sharedWorkspace(h);
      const sentinel = path.join(workspace, "keep-me.txt");
      writeFileSync(sentinel, "prior work");
      const retained = `${workspace}-retained`;
      renameSync(workspace, retained);
      writeFileSync(workspace, "blocked");
      try {
        const botId = await makeBot(h, "Blocked workspace Bot");
        const sent = await sendToBot(h, botId, "say: must not use the source tree");
        await waitThreadIdle(h, sent.threadId);

        const thread = await api<ThreadDto>(h, "GET", `/api/threads/${sent.threadId}`);
        expect(thread.latestTurn?.status).toBe("failed");
        expect(thread.latestTurn?.reason).toContain("Shared Workspace is unavailable");
        expect(
          workerObservations(h).filter(
            (observation) => observation.threadId === sent.threadId && observation.type === "session.open",
          ),
        ).toEqual([]);
        expect(readFileSync(path.join(sourceDir, "install-sentinel.txt"), "utf8")).toBe("keep");
        expect(readFileSync(path.join(retained, "keep-me.txt"), "utf8")).toBe("prior work");
        expect(existsSync(path.join(h.home, "db.sqlite"))).toBeTrue();
      } finally {
        rmSync(workspace);
        renameSync(retained, workspace);
      }
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  test("deleting a Bot preserves Shared Workspace sentinels and product data", async () => {
    h = await startDaemon();
    const workspace = sharedWorkspace(h);
    const botId = await makeBot(h, "Delete-safe Bot");
    const sent = await sendToBot(h, botId, "say: create shared files");
    await waitThreadIdle(h, sent.threadId);
    const sentinel = path.join(workspace, "survive-deletion.txt");
    writeFileSync(sentinel, "shared work");

    const deleted = await api<DeleteBotResultDto>(h, "DELETE", `/api/bots/${botId}`, {});
    expect(deleted.status).toBe("deleted");
    expect(readFileSync(sentinel, "utf8")).toBe("shared work");
    expect(existsSync(path.join(h.home, "db.sqlite"))).toBeTrue();
    expect(existsSync(path.join(h.home, ".omarchy-bot", "memory"))).toBeFalse();
  });

  test("daemon recovery and Bot deletion preserve shared files, explicit cwd, and Native Sessions", async () => {
    h = await startDaemon();
    const workspace = sharedWorkspace(h);
    const explicitCwd = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-explicit-cwd-"));
    const sharedSentinel = path.join(workspace, "survive-recovery.txt");
    const explicitSentinel = path.join(explicitCwd, "project-sentinel.txt");
    const legacyProfile = path.join(h.home, ".omarchy-bot", "legacy-profiles", "keep-me.txt");
    try {
      const botId = await makeBot(h, "Recovery-safe Bot");
      const siblingId = await makeBot(h, "Recovery sibling");
      const first = await sendToBot(h, botId, "say: shared work");
      await waitThreadIdle(h, first.threadId);
      writeFileSync(sharedSentinel, "shared work");
      mkdirSync(path.dirname(legacyProfile), { recursive: true });
      writeFileSync(legacyProfile, "old profile residue");

      const explicitThread = h.svc.threads.createThread(botId, {
        title: "Explicit project",
        cwd: explicitCwd,
      });
      writeFileSync(explicitSentinel, "explicit project");
      const explicitTurn = await sendToThread(h, explicitThread.id, "say: stay in the project");
      await waitThreadIdle(h, explicitTurn.threadId);
      const nativeSessionId = h.svc.threads.getNativeSession(first.threadId);
      if (nativeSessionId === undefined) throw new Error("fake Agent did not create a Native Session");
      expect(sessionForThread(h, "session.open", botId, explicitThread.id).options?.cwd).toBe(explicitCwd);

      const home = h.home;
      await h.disconnectForRestart();
      h = await startDaemon(home);

      expect(readFileSync(sharedSentinel, "utf8")).toBe("shared work");
      expect(readFileSync(explicitSentinel, "utf8")).toBe("explicit project");
      expect(readFileSync(legacyProfile, "utf8")).toBe("old profile residue");
      const continued = await sendToThread(h, first.threadId, "say: after recover");
      await waitThreadIdle(h, continued.threadId);
      const resumed = sessionForThread(h, "session.resume", botId, first.threadId);
      expect(resumed.nativeSessionId).toBe(nativeSessionId);
      expect(resumed.options?.cwd).toBe(workspace);

      const deleted = await api<DeleteBotResultDto>(h, "DELETE", `/api/bots/${botId}`, {});
      expect(deleted.status).toBe("deleted");
      expect(readFileSync(sharedSentinel, "utf8")).toBe("shared work");
      expect(readFileSync(explicitSentinel, "utf8")).toBe("explicit project");
      expect(readFileSync(legacyProfile, "utf8")).toBe("old profile residue");
      expect(existsSync(path.join(h.home, "db.sqlite"))).toBeTrue();
      expect(existsSync(path.join(h.home, ".omarchy-bot", "memory"))).toBeFalse();

      const worker = await h.svc.supervisor.agentWorker("pi");
      const resumedNative: unknown = await worker.request({
        type: "session.resume",
        botId: "bot_native_session_recovery_probe",
        threadId: "thread_native_session_recovery_probe",
        nativeSessionId,
        options: { cwd: workspace, instructions: "" },
      }, 30_000);
      if (resumedNative === null || typeof resumedNative !== "object" || !("nativeSessionId" in resumedNative)) {
        throw new Error("fake Agent returned an invalid Session resume result");
      }
      expect(resumedNative.nativeSessionId).toBe(nativeSessionId);

      const siblingTurn = await sendToBot(h, siblingId, "say: sibling still works");
      await waitThreadIdle(h, siblingTurn.threadId);
      expect(sessionForThread(h, "session.open", siblingId, siblingTurn.threadId).options?.cwd).toBe(workspace);
    } finally {
      rmSync(explicitCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("an avatar recipe session uses the Shared Workspace instead of the launch directory", async () => {
    h = await startDaemon();
    const workspace = sharedWorkspace(h);
    const botId = await makeBot(h, "Avatar recipe Bot");
    const recipe = authedFetch(h, `${h.baseUrl}/api/bots/${botId}/avatar/recipe`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-command-id": crypto.randomUUID() },
      body: JSON.stringify({ prompt: "calm blue teammate" }),
    });
    const opened = await waitForWorkerObservation(
      h,
      (observation) =>
        observation.type === "session.open"
        && observation.botId === botId
        && typeof observation.threadId === "string"
        && observation.threadId.startsWith("avatar_profile_"),
    );
    expect(opened.options?.cwd).toBe(workspace);
    expect(opened.options?.cwd).not.toBe(process.cwd());
    await recipe;
  });
});
