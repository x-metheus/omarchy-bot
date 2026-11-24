import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withFakeRuntimeProvider } from "../../apps/daemon/src/modules/runtime/harness-test-support.ts";
import { DEFAULT_MODEL_SETTING } from "../../apps/daemon/src/modules/runtime/models.ts";
import { setSetting } from "../../apps/daemon/src/persistence/settings.ts";
import { ApiClient } from "../../packages/api-client/src/index.ts";
import { fauxAssistantMessage, fauxToolCall, type FakeReply } from "../../packages/testkit/src/fake-provider.ts";
import { apiStatus, makeBot, messages, sendToBot, sendToThread, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";

const settingsPath = "/api/settings/allowed-folders";

async function withDaemon(run: (h: Harness, client: ApiClient, root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "allowed-folders-")));
  try {
    const durableSuite = process.env.OMARCHY_TEST_DURABLE;
    delete process.env.OMARCHY_TEST_DURABLE;
    const h = await startDaemon(path.join(root, "home"), {
      dataDir: path.join(root, "data"),
      stateDir: path.join(root, "state"),
    }).finally(() => {
      if (durableSuite === undefined) delete process.env.OMARCHY_TEST_DURABLE;
      else process.env.OMARCHY_TEST_DURABLE = durableSuite;
    });
    try {
      await run(h, new ApiClient({ baseUrl: h.baseUrl, deviceToken: h.token }), root);
    } finally {
      await h.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("allowed-folder routes require a paired device token", () => withDaemon(async (h) => {
  for (const method of ["GET", "POST", "DELETE"]) {
    expect((await fetch(`${h.baseUrl}${settingsPath}`, { method })).status).toBe(401);
  }
}));

test("the Settings API lists, adds, and removes allowed folders", () => withDaemon(async (h, client, root) => {
  const folder = path.join(root, "extra");
  const { sharedWorkspaceDir, downloadsDir } = h.svc.cfg;
  const alwaysAllowed = downloadsDir === undefined ? [sharedWorkspaceDir] : [sharedWorkspaceDir, downloadsDir];
  const empty = { folders: [], alwaysAllowed };
  expect(await apiStatus(h, "GET", settingsPath)).toEqual({ status: 200, body: empty });
  expect(await client.allowedFolders()).toEqual(empty);

  const added = { folders: [folder], alwaysAllowed };
  expect(await client.addAllowedFolder(folder)).toEqual(added);
  expect(await client.addAllowedFolder(folder)).toEqual(added);
  expect(await client.allowedFolders()).toEqual(added);
  for (const implicitFolder of alwaysAllowed) {
    expect(await client.addAllowedFolder(implicitFolder)).toEqual(added);
    expect(await client.removeAllowedFolder(implicitFolder)).toEqual(added);
  }
  expect(await client.removeAllowedFolder(folder)).toEqual(empty);
  expect(await client.removeAllowedFolder(folder)).toEqual(empty);
  expect(await client.allowedFolders()).toEqual(empty);
}));

test("folder mutations reject invalid paths and bodies", () => withDaemon(async (h) => {
  for (const method of ["POST", "DELETE"]) {
    for (const body of [{ folder: "relative/folder" }, { folder: path.join(h.home, "invalid\0folder") }, { folder: 1 }, {}]) {
      expect((await apiStatus(h, method, settingsPath, body)).status).toBe(400);
    }
  }
}));

const echoToolResult: FakeReply = ({ messages }) => {
  const result = messages.at(-1);
  return fauxAssistantMessage(result?.role === "toolResult"
    ? result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")
    : "Missing tool result");
};

test("adding and removing a folder affects file access on the next Turn", async () => {
  let file: string;
  const read = (id: string): FakeReply => () => fauxAssistantMessage(
    [fauxToolCall("read", { path: file }, { id })], { stopReason: "toolUse" },
  );
  await withFakeRuntimeProvider([
    { segments: [{ type: "text", text: "Ready." }] },
    read("read-allowed"), echoToolResult,
    read("read-removed"), echoToolResult,
  ], { tokensPerSecond: 10000 }, () => withDaemon(async (h, client, root) => {
    await h.svc.credentials.add({
      id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1",
      apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }],
    });
    setSetting(h.svc.db, DEFAULT_MODEL_SETTING, "fake/fake-model");
    setSetting(h.svc.db, "runtime", "durable");
    const folder = path.join(root, "extra");
    file = path.join(folder, "fixture.txt");
    const contents = "Read from the Settings fixture.";
    await mkdir(folder);
    await writeFile(file, contents);

    const botId = await makeBot(h, "Allowed Folders Bot");
    const { threadId, turnId } = await sendToBot(h, botId, "Start the conversation.");
    await waitThreadIdle(h, threadId, 5000);
    expect(h.svc.threads.turnRow(turnId)?.status).toBe("completed");

    await client.addAllowedFolder(folder);
    const allowed = await sendToThread(h, threadId, "Read the file now that its folder is allowed.");
    await waitThreadIdle(h, threadId, 5000);
    expect(h.svc.threads.turnRow(allowed.turnId)?.status).toBe("completed");
    expect(await messages(h, threadId)).toContainEqual(expect.objectContaining({ kind: "response", text: contents }));
    expect(await client.listApprovals(threadId)).toEqual([]);

    await client.removeAllowedFolder(folder);
    const removed = await sendToThread(h, threadId, "Read the same file again.");
    const deadline = Date.now() + 5000;
    let pending = await client.listApprovals(threadId);
    while (pending.length === 0 && Date.now() < deadline && h.svc.threads.turnRow(removed.turnId)?.status === "working") {
      await Bun.sleep(50);
      pending = await client.listApprovals(threadId);
    }
    expect(pending).toEqual([expect.objectContaining({
      threadId, botId, turnId: removed.turnId, tool: "read", path: file, folder, status: "pending",
    })]);
    expect(await client.answerApproval(pending[0]!.id, { answer: "deny" })).toMatchObject({ status: "denied" });
    await waitThreadIdle(h, threadId, 5000);
    expect(h.svc.threads.turnRow(removed.turnId)?.status).toBe("completed");
    expect(await messages(h, threadId)).toContainEqual(expect.objectContaining({ kind: "response", text: `The user denied access to ${file}.` }));
    expect((await client.allowedFolders()).folders).toEqual([]);
  }));
}, 20000);
