import { describe, expect, test } from "bun:test";
import type { AgentComputerToolContext, AgentBrowserToolOutput } from "../../packages/agent-contract/src/index.ts";
import { isSurfaceId } from "../../packages/domain/src/ids.ts";
import { createBrowserTool } from "../../workers/pi/src/browser-tool.ts";

const surfaceId = "surf_0123456789abcdef0123456789abcdef";
if (!isSurfaceId(surfaceId)) throw new Error("invalid browser Surface fixture");
const binding = {
  botId: "bot_browser",
  turnId: "turn_browser",
  workerSessionId: "browser-session",
  surfaceId,
};
const desktopSession = { botId: binding.botId, surfaceId: binding.surfaceId, runtimeGeneration: 2 };

describe("Pi SDK Omarchy browser tool", () => {
  test("exposes sequential structural actions with the active turn identity and text result", async () => {
    const calls: Array<{ context: AgentComputerToolContext; action: unknown }> = [];
    const tool = createBrowserTool(() => binding, {
      request: async (context, action) => {
        calls.push({ context, action });
        return { desktopSession, text: 'e1 textbox "Name"', truncated: true };
      },
    });
    const result = await tool.execute("browser-call-1", { action: "snapshot" }, undefined, undefined, undefined as never);

    expect(tool.name).toBe("browser");
    expect(tool.executionMode).toBe("sequential");
    expect(calls).toEqual([{
      context: { ...binding, toolCallId: "browser-call-1" },
      action: { name: "snapshot", args: {} },
    }]);
    expect(result.content).toEqual([{
      type: "text",
      text: `Bot Desktop Session: ${JSON.stringify(desktopSession)}\ne1 textbox "Name"\nBrowser result truncated; some content is omitted.`,
    }]);
    expect(result.details).toEqual({ desktopSession, text: 'e1 textbox "Name"', truncated: true });
  });

  test("holds request_takeover until the bridge returns a fresh snapshot", async () => {
    const started = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<AgentBrowserToolOutput>();
    let settled = false;
    const tool = createBrowserTool(() => binding, {
      request: async (_context, action) => {
        expect(action).toEqual({ name: "request_takeover", args: { reason: "Please complete the login" } });
        started.resolve();
        return resumed.promise;
      },
    });
    const pending = tool.execute(
      "takeover-call",
      { action: "request_takeover", args: { reason: "Please complete the login" } },
      undefined,
      undefined,
      undefined as never,
    ).then((result) => {
      settled = true;
      return result;
    });
    await started.promise;
    expect(settled).toBeFalse();
    resumed.resolve({ desktopSession, text: 'e2 heading "Welcome"' });
    const result = await pending;
    expect(result.content).toEqual([{
      type: "text",
      text: `Bot Desktop Session: ${JSON.stringify(desktopSession)}\ne2 heading "Welcome"`,
    }]);
  });

  test("refuses an unbound or aborted call before bridge dispatch", async () => {
    let active = false;
    let dispatched = false;
    const tool = createBrowserTool(() => active ? binding : undefined, {
      request: async () => {
        dispatched = true;
        return { desktopSession };
      },
    });
    await expect(tool.execute("unbound", { action: "snapshot" }, undefined, undefined, undefined as never))
      .rejects.toThrow("browser tool has no active Omarchy turn binding");
    active = true;
    const controller = new AbortController();
    controller.abort(new Error("cancel browser call"));
    await expect(tool.execute("aborted", { action: "snapshot" }, controller.signal, undefined, undefined as never))
      .rejects.toThrow("cancel browser call");
    expect(dispatched).toBeFalse();
  });

  test("does not expose a result after cancellation while the bridge was running", async () => {
    const controller = new AbortController();
    const tool = createBrowserTool(() => binding, {
      request: async (_context, _action, signal) => {
        expect(signal).toBe(controller.signal);
        controller.abort(new Error("cancelled during browser action"));
        return { desktopSession, text: "obsolete snapshot" };
      },
    });
    await expect(tool.execute("late-abort", { action: "snapshot" }, controller.signal, undefined, undefined as never))
      .rejects.toThrow("cancelled during browser action");
  });
});
