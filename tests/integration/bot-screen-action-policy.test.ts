import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FakeBotScreenRuntimeAdapter } from "../../apps/daemon/src/modules/computer/fakeBotScreenRuntime.ts";
import type { BotScreenInputAction } from "../../apps/daemon/src/modules/computer/botScreenManager.ts";
import type { ComputerWindowListItem } from "../../packages/agent-contract/src/computer-protocol.ts";
import type { ComputerAction } from "../../packages/domain/src/computer.ts";
import type { SurfaceId } from "../../packages/domain/src/ids.ts";
import { api, makeBot, startDaemon, type Harness } from "./helpers/harness.ts";

const WINDOWS: ComputerWindowListItem[] = [
  {
    id: "window-1",
    title: "Editor",
    appId: "fixture.editor",
    pid: 1001,
    focused: false,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    workspace: "bot-fixture",
    clientType: "wayland",
  },
  {
    id: "window-2",
    title: "Browser",
    appId: "fixture.browser",
    pid: 1002,
    focused: true,
    bounds: { x: 800, y: 0, width: 800, height: 600 },
    workspace: "bot-fixture",
    clientType: "wayland",
  },
];

/** The action vocabulary, evdev key table, and event shapes every adapter shares. */
describe("Bot Screen action policy above the platform seam", () => {
  let h: Harness;
  let adapter: FakeBotScreenRuntimeAdapter;
  let owner: { botId: string; surfaceId: SurfaceId };

  beforeEach(async () => {
    adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const botId = await makeBot(h, "Action policy");
    const bot = await api<{ surfaceId: SurfaceId }>(h, "GET", `/api/bots/${botId}`);
    owner = { botId, surfaceId: bot.surfaceId };
    adapter.setWindows(owner.surfaceId, WINDOWS);
  });

  afterEach(async () => {
    await h.stop();
  });

  async function act(action: ComputerAction, send?: (event: BotScreenInputAction) => Promise<void>) {
    return h.svc.screens.act(owner, action, send);
  }

  function recorder(): { events: BotScreenInputAction[]; send: (event: BotScreenInputAction) => Promise<void> } {
    const events: BotScreenInputAction[] = [];
    return { events, send: async (event) => { events.push(event); } };
  }

  test("a click becomes motion, press, and release in Screen coordinates", async () => {
    const { events, send } = recorder();
    await expect(act({ name: "click", args: { x: 4, y: 5 } }, send)).resolves.toMatchObject({
      desktopSession: { ...owner, runtimeGeneration: 1 },
    });
    expect(events).toEqual([
      { type: "motion", x: 4, y: 5 },
      { type: "button", x: 4, y: 5, button: "left", state: "pressed" },
      { type: "button", x: 4, y: 5, button: "left", state: "released" },
    ]);

    const right = recorder();
    await act({ name: "click", args: { x: 10, y: 20, button: "right" } }, right.send);
    expect(right.events.filter((event) => event.type === "button")).toEqual([
      { type: "button", x: 10, y: 20, button: "right", state: "pressed" },
      { type: "button", x: 10, y: 20, button: "right", state: "released" },
    ]);
  });

  test("scroll defaults its coordinates and requires both deltas", async () => {
    const { events, send } = recorder();
    await act({ name: "scroll", args: { deltaX: 1, deltaY: -120 } }, send);
    expect(events).toEqual([{ type: "scroll", x: 0, y: 0, deltaX: 1, deltaY: -120 }]);
    await expect(act({ name: "scroll", args: { deltaX: 1 } }, send)).rejects.toThrow(/deltaY must be a number/);
  });

  test("a key chord presses in order and releases in reverse order", async () => {
    const { events, send } = recorder();
    await act({ name: "key", args: { key: "Ctrl+L" } }, send);
    expect(events).toEqual([
      { type: "key", keyCode: 29, state: "pressed" },
      { type: "key", keyCode: 38, state: "pressed" },
      { type: "key", keyCode: 38, state: "released" },
      { type: "key", keyCode: 29, state: "released" },
    ]);
    await expect(act({ name: "key", args: { key: "Firefly" } }, send)).rejects.toThrow(/unknown key/);
  });

  test("type pastes its text and requires one", async () => {
    const { events, send } = recorder();
    await act({ name: "type", args: { text: "你好, world" } }, send);
    expect(events).toEqual([{ type: "paste", text: "你好, world" }]);
    await expect(act({ name: "type", args: {} }, send)).rejects.toThrow(/type requires args\.text/);
  });

  test("input actions without the input lease are refused and coordinates must be numbers", async () => {
    await expect(act({ name: "click", args: { x: 4, y: 5 } })).rejects.toThrow(/input lease/);
    const { events, send } = recorder();
    await expect(act({ name: "click", args: { y: 5 } }, send)).rejects.toThrow(/click x must be a number/);
    expect(events).toEqual([]);
  });

  test("focus_window resolves one window of this Screen and confirms it", async () => {
    await expect(act({ name: "focus_window", args: { id: "window-1" } })).resolves.toMatchObject({
      desktopSession: owner,
    });
    expect(adapter.focusRequests).toEqual(["window-1"]);
    expect(await windowStates()).toEqual([["window-1", true], ["window-2", false]]);

    await act({ name: "focus_window", args: { appId: "fixture.browser" } });
    expect(adapter.focusRequests).toEqual(["window-1", "window-2"]);
    expect(await windowStates()).toEqual([["window-1", false], ["window-2", true]]);
  });

  async function windowStates(): Promise<Array<[string, boolean]>> {
    const listed = await act({ name: "list_windows", args: {} });
    const windows = Array.isArray(listed.windowList) ? listed.windowList as ComputerWindowListItem[] : [];
    return windows.map((window) => [window.id, window.focused]);
  }

  test("focus_window reports a missing, ambiguous, or unspecified match", async () => {
    await expect(act({ name: "focus_window", args: { id: "window-9" } })).rejects.toThrow(/did not match/);
    await expect(act({ name: "focus_window", args: {} })).rejects.toThrow(/requires id, title, or appId/);
    adapter.setWindows(owner.surfaceId, [
      WINDOWS[0]!,
      { ...WINDOWS[1]!, title: "Editor" },
    ]);
    await expect(act({ name: "focus_window", args: { title: "Editor" } })).rejects.toThrow(/matched multiple/);
    expect(adapter.focusRequests).toEqual([]);
  });

  test("launch actions require their target", async () => {
    await expect(act({ name: "open_app", args: { app: "fixture.desktop" } })).resolves.toMatchObject({
      text: "fake-open#1:fixture.desktop",
    });
    await expect(act({ name: "open_url", args: { url: "https://example.com" } })).resolves.toMatchObject({
      text: "fake-open#2:https://example.com",
    });
    await expect(act({ name: "open_app", args: {} })).rejects.toThrow(/open_app requires args\.app/);
    await expect(act({ name: "open_url", args: {} })).rejects.toThrow(/open_url requires args\.url/);
  });
});
