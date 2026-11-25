import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withFakeRuntimeProvider } from "../../apps/daemon/src/modules/runtime/harness-test-support.ts";
import { DEFAULT_MODEL_SETTING } from "../../apps/daemon/src/modules/runtime/models.ts";
import { getSetting, setSetting } from "../../apps/daemon/src/persistence/settings.ts";
import type { BotDto } from "../../packages/protocol/src/index.ts";
import { api, messages, sendToBot, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";

const daemonEnv = ["HOME", "OMARCHY_BOT_HOME", "OMARCHY_BOT_STATE", "OMARCHY_BOT_PORT", "OMARCHY_BOT_WORKERS_DIR", "OMARCHY_BOT_DELETION_TERMINAL_TIMEOUT_MS", "OMARCHY_TEST_DURABLE", "PI_CODING_AGENT_DIR"] as const;

test("daemon startup imports Pi credentials and runs an unset Bot on the seeded default only once", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "daemon-pi-import-"));
  const stateDir = path.join(home, "state");
  const agentDir = path.join(home, ".pi", "agent");
  const callerAgentDir = path.join(home, "caller-pi-agent");
  const env = new Map(daemonEnv.map((key) => [key, process.env[key]]));
  const fixtureKey = "test-pi-import-turn-key";
  const reply = "The imported default completed this Turn.";
  let daemon: Harness | undefined;
  try {
    delete process.env.OMARCHY_TEST_DURABLE;
    await mkdir(callerAgentDir, { mode: 0o700 });
    await writeFile(path.join(callerAgentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "test-caller-pi-key" } }), { mode: 0o600 });
    process.env.PI_CODING_AGENT_DIR = callerAgentDir;
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    for (const [file, value] of Object.entries({
      "auth.json": { fake: { type: "api_key", key: fixtureKey } },
      "models.json": { providers: { fake: { name: "Fixture Gateway", baseUrl: "https://example.invalid/v1", api: "openai-completions", models: [{ id: "fake-model" }] } } },
      "settings.json": { defaultProvider: "fake", defaultModel: "fake-model" },
    })) {
      await writeFile(path.join(agentDir, file), JSON.stringify(value), { mode: 0o600 });
    }

    await withFakeRuntimeProvider([{ segments: [{ type: "text", text: reply }] }], { tokensPerSecond: 10000 }, async () => {
      const started = daemon = await startDaemon(home, { stateDir });
      const providers = started.svc.credentials.list();
      expect(process.env.PI_CODING_AGENT_DIR).toBe(agentDir);
      expect(JSON.stringify(providers).includes(fixtureKey)).toBeFalse();
      expect(providers).toEqual([{
        id: "fake", name: "Fixture Gateway", protocol: "openai-compatible", baseUrl: "https://example.invalid/v1", models: [{ id: "fake-model" }], hasKey: true,
      }]);
      expect(started.svc.credentials.getForRuntime("fake")?.apiKey === fixtureKey).toBeTrue();
      expect(getSetting(started.svc.db, DEFAULT_MODEL_SETTING)).toBe("fake/fake-model");
      setSetting(started.svc.db, "runtime", "durable");

      const bot = await api<BotDto>(started, "POST", "/api/bots", { name: "Migration Bot", agentId: "pi" });
      const sent = await sendToBot(started, bot.id, "Use the imported default.");
      await waitThreadIdle(started, sent.threadId);
      expect(started.svc.threads.turnRow(sent.turnId)?.status).toBe("completed");
      const threadMessages = await messages(started, sent.threadId);
      expect(threadMessages.some((message) => message.kind === "response" && message.text === reply)).toBeTrue();
      expect(JSON.stringify([bot, sent, threadMessages]).includes(fixtureKey)).toBeFalse();

      await started.svc.credentials.remove("fake");
      await started.stop();
      daemon = undefined;
      expect(process.env.PI_CODING_AGENT_DIR).toBe(callerAgentDir);
    });

    daemon = await startDaemon(home, { stateDir });
    expect(daemon.svc.credentials.list()).toEqual([]);
    expect(getSetting(daemon.svc.db, DEFAULT_MODEL_SETTING)).toBe("fake/fake-model");
  } finally {
    try { await daemon?.stop(); }
    finally {
      for (const [key, value] of env) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(home, { recursive: true, force: true });
    }
  }
}, 30000);
