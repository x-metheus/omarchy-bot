import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { AGENT_LOCAL_TOOL } from "@omarchy-bot/agent-contract";
import { createLocalTool } from "./local-tool.ts";

test("Native Sessions map the shared local tool definition rather than a private dialect", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "omarchy-pi-local-context-"));
  let session: AgentSession | undefined;
  let dispatches = 0;
  try {
    const faux = fauxProvider({ models: [{ id: "local-context-model" }], tokensPerSecond: 10_000 });
    faux.setResponses([fauxAssistantMessage([fauxText("Conversation retained.")])]);
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(cwd, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const loader = new DefaultResourceLoader({ cwd, agentDir: cwd });
    await loader.reload();
    const tool = createLocalTool(() => undefined, {
      request: async () => {
        dispatches += 1;
        throw new Error("Loading conversation context must not dispatch local work");
      },
    });
    ({ session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      model: faux.getModel(),
      modelRuntime,
      resourceLoader: loader,
      sessionManager: SessionManager.create(cwd, path.join(cwd, "sessions")),
      customTools: [tool],
    }));

    expect(tool.name).toBe(AGENT_LOCAL_TOOL.name);
    expect(tool.description).toBe(AGENT_LOCAL_TOOL.description);
    expect(tool.promptSnippet).toBe(AGENT_LOCAL_TOOL.systemPrompt.summary);
    expect(tool.promptGuidelines).toEqual([...AGENT_LOCAL_TOOL.systemPrompt.guidelines]);
    expect(session.systemPrompt).toContain(AGENT_LOCAL_TOOL.systemPrompt.summary);
    for (const guideline of AGENT_LOCAL_TOOL.systemPrompt.guidelines) {
      expect(session.systemPrompt).toContain(guideline);
    }
    expect(dispatches).toBe(0);
  } finally {
    session?.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});
