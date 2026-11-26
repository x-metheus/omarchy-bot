import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { DeleteBotResultDto, ThreadDto } from "../../packages/protocol/src/index.ts";
import {
  api,
  makeBot,
  sendToBot,
  startDaemon,
  waitThreadIdle,
  type Harness,
} from "./helpers/harness.ts";

function sharedWorkspace(h: Harness): string {
  return path.join(h.home, ".omarchy-bot", "workspace");
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
        const conversation = h.svc.db.query("SELECT 1 FROM pi_thread_conversations WHERE thread_id = ?").get(sent.threadId);
        expect(conversation).toBeNull();
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
});
