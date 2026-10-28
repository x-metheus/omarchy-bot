import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SwayBotScreenRuntimeAdapter } from "../../apps/daemon/src/modules/computer/swayBotScreenRuntime.ts";
import { CdpPipe } from "../../apps/daemon/src/modules/computer/cdpPipe.ts";
import type { BrowserAction } from "../../packages/domain/src/browser.ts";
import type { SurfaceId } from "../../packages/domain/src/ids.ts";
import { api, makeBot, startDaemon, type Harness } from "./helpers/harness.ts";
import { ProjectionClient } from "./helpers/projection-client.ts";
import { until } from "./helpers/bot-screen-load-observe.ts";

const realTest = process.env.OMARCHY_BOT_REAL_PORTABLE_BROWSER === "1" ? test : test.skip;

function browserProcesses(browserPid: number): number[] {
  const processes = readdirSync("/proc").filter(entry => /^\d+$/.test(entry));
  const roots = [browserPid];
  const owned = new Set(roots);
  for (;;) {
    const before = owned.size;
    for (const entry of processes) {
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        if (owned.has(parent)) owned.add(Number(entry));
      } catch { /* Processes can exit while their ancestry is sampled. */ }
    }
    if (owned.size === before) return [...owned];
  }
}

function listeningSocketsOwnedBy(pids: number[]): string[] {
  const owned = new Set<string>();
  for (const pid of pids) {
    try {
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        try {
          const inode = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`))?.[1];
          if (inode !== undefined) owned.add(inode);
        } catch { /* A descriptor may close during sampling. */ }
      }
    } catch { /* A browser subprocess may exit during sampling. */ }
  }
  return ["tcp", "tcp6"].flatMap(table => readFileSync(`/proc/net/${table}`, "utf8").trim().split("\n").slice(1)
    .filter(line => { const fields = line.trim().split(/\s+/); return fields[3] === "0A" && owned.has(fields[9]!); }));
}

function refFor(snapshot: string, label: string): string {
  const role = label === "Name" ? "textbox" : label === "Color" ? "combobox" : "button";
  const line = snapshot.split("\n").find(line => line.includes(`${role} ${JSON.stringify(label)}`));
  const ref = line?.match(/\[(e[^\]]+)\]/)?.[1];
  if (ref === undefined) throw new Error(`No ref for ${label}: ${snapshot}`);
  return ref;
}

realTest("real portable browser completes a form through Broker input and holds human takeover", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "omarchy-browser-real-"));
  const originalEnvironment = { ...process.env };
  const commands: { method: string; params: Record<string, unknown> }[] = [];
  let pipeBrowserPid: number | undefined;
  const request = CdpPipe.prototype.request;
  CdpPipe.prototype.request = function<T>(...args: Parameters<typeof request>): Promise<T> {
    const params = args[1];
    commands.push({ method: args[0], params: typeof params === "object" && params !== null ? { ...params } : {} });
    const response = request.apply(this, args) as Promise<T>;
    if (args[0] === "SystemInfo.getProcessInfo") void response.then(result => {
      if (typeof result !== "object" || result === null || !("processInfo" in result) || !Array.isArray(result.processInfo)) throw new Error("Missing browser process info");
      const browser = result.processInfo.find((process: unknown) => typeof process === "object" && process !== null && "type" in process && process.type === "browser");
      if (typeof browser !== "object" || browser === null || !("id" in browser) || typeof browser.id !== "number") throw new Error("Missing browser process id");
      pipeBrowserPid = browser.id;
    });
    return response;
  };
  const profileRoot = path.join(root, "profiles");
  const applicationCwd = path.join(root, "workspace");
  mkdirSync(applicationCwd);
  let h: Harness | undefined;
  let ownedBrowserPids: number[] = [];
  let viewer: ProjectionClient | undefined;
  const coordinates: { zoom: number; clientX: number; clientY: number; expectedX: number; expectedY: number; gutter: number }[] = [];
  let selectedTabReported = false;
  let pageZoom = 1;
  let receipt: { name: string; color: string } | undefined;
  let webdriver: unknown = "unreported";
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/probe") {
        webdriver = (await request.json() as { webdriver: unknown }).webdriver;
        return new Response("ok");
      }
      if (url.pathname === "/receipt") {
        receipt = { name: url.searchParams.get("name") ?? "", color: url.searchParams.get("color") ?? "" };
        return new Response(`<h1>Receipt: ${receipt.name}, ${receipt.color}</h1>`, { headers: { "content-type": "text/html" } });
      }
      if (url.pathname === "/coordinate") {
        coordinates.push(await request.json() as typeof coordinates[number]);
        return new Response("ok");
      }
      if (url.pathname === "/selected") { selectedTabReported = true; return new Response("ok"); }
      if (url.pathname === "/zoom") { pageZoom = Number(url.searchParams.get("value")); return new Response("ok"); }
      if (url.pathname === "/scrollbar") return new Response(`<!doctype html><title>Scrollbar geometry</title>
        <style>html {overflow:scroll} ::-webkit-scrollbar {width:20px;height:20px} body {margin:0;min-width:2400px;min-height:2400px} button {position:fixed;left:400px;top:100px;width:12px;height:12px;padding:0}</style>
        <button aria-label="Coordinate" onclick="const r=this.getBoundingClientRect(); fetch('/coordinate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({zoom:devicePixelRatio,clientX:event.clientX,clientY:event.clientY,expectedX:r.x+r.width/2,expectedY:r.y+r.height/2,gutter:innerWidth-document.documentElement.clientWidth})}); this.textContent='Hit'">+</button><script>addEventListener('resize',()=>fetch('/zoom?value='+devicePixelRatio));</script>` , { headers: { "content-type": "text/html" } });
      if (url.pathname === "/long") return new Response(`<title>Long text</title><p>${"x".repeat(9000)}</p><p>Ready after cap</p>`, { headers: { "content-type": "text/html" } });
      if (url.pathname.startsWith("/duplicate")) return new Response(`<title>Identical title</title><h1>${url.pathname === "/duplicate-one" ? "Original tab" : "Human selected tab"}</h1><button>Keep ref</button>${url.pathname === "/duplicate-two" ? "<script>document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')fetch('/selected')})</script>" : ""}`, { headers: { "content-type": "text/html" } });
      return new Response(`<!doctype html><title>Browser form ${url.pathname}</title>
        <form action="/receipt"><label>Name<input name="name"></label>
        <label>Color<select name="color"><option value="red">Red</option><option value="blue">Blue</option></select></label>
        <button>Submit</button></form><script>
        fetch('/probe', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({webdriver:navigator.webdriver})});
        </script>`, { headers: { "content-type": "text/html" } });
    },
  });
  try {
    const bundle = process.env.OMARCHY_BOT_SWAY_BUNDLE_DIR;
    const binary = (env: string, name: string): string => {
      const value = process.env[env] ?? (bundle === undefined ? undefined : path.join(bundle, "bin", name));
      if (value === undefined) throw new Error(`Set ${env} or OMARCHY_BOT_SWAY_BUNDLE_DIR`);
      return value;
    };
    const adapter = new SwayBotScreenRuntimeAdapter({
      runtimeRoot: path.join(root, "runtime"), profileRoot, applicationCwd, capacity: 2,
      swayBin: binary("OMARCHY_BOT_SWAY_BIN", "sway"),
      swaymsgBin: binary("OMARCHY_BOT_SWAYMSG_BIN", "swaymsg"),
      wlrRandrBin: binary("OMARCHY_BOT_WLR_RANDR_BIN", "wlr-randr"),
      wayvncBin: binary("OMARCHY_BOT_WAYVNC_BIN", "wayvnc"),
      grimBin: binary("OMARCHY_BOT_GRIM_BIN", "grim"),
      dbusDaemonBin: binary("OMARCHY_BOT_DBUS_DAEMON_BIN", "dbus-daemon"),
      inputHelperBin: binary("OMARCHY_BOT_INPUT_HELPER_BIN", "omarchy-bot-wayland-input"),
      captureHelperBin: binary("OMARCHY_BOT_CAPTURE_HELPER_BIN", "omarchy-bot-wayland-capture"),
      botDesktopBin: binary("OMARCHY_BOT_DESKTOP_BIN", "omarchy-bot-desktop"),
      ...(process.env.OMARCHY_BOT_FONT_DIR === undefined ? {} : { fontDir: process.env.OMARCHY_BOT_FONT_DIR }),
      ...(process.env.OMARCHY_BOT_BROWSER_PACK_DIR === undefined ? {} : { browserPackDir: process.env.OMARCHY_BOT_BROWSER_PACK_DIR }),
    });
    h = await startDaemon(path.join(root, "home"), { botScreenAdapter: adapter, botScreenCapacity: 2 });
    const botId = await makeBot(h, "Real browser form");
    const { surfaceId } = await api<{ surfaceId: SurfaceId }>(h, "GET", `/api/bots/${botId}`);
    const owner = { botId, surfaceId };
    let call = 0;
    const act = (action: BrowserAction, target = owner) => h!.svc.computer.agentBrowserAct(target, "real-browser-turn", `browser-${++call}`, action, AbortSignal.timeout(60_000));
    const url = `http://127.0.0.1:${server.port}/form`;
    await act({ name: "navigate", args: { url } });
    const firstSnapshot = (await act({ name: "snapshot", args: {} })).text!;
    const expiredRef = refFor(firstSnapshot, "Name");
    const snapshot = (await act({ name: "snapshot", args: {} })).text!;
    await expect(act({ name: "click", args: { ref: expiredRef } })).rejects.toThrow(/snapshot/i);
    const nameRef = refFor(snapshot, "Name");
    await act({ name: "type", args: { ref: nameRef, text: "Ada" } });
    await act({ name: "select", args: { ref: refFor(snapshot, "Color"), value: "blue" } });
    await act({ name: "click", args: { ref: refFor(snapshot, "Submit") } });
    await act({ name: "wait_for", args: { text: "Receipt: Ada, blue", timeoutMs: 10_000 } });
    expect((await act({ name: "read_text", args: {} })).text).toContain("Receipt: Ada, blue");
    expect(receipt).toEqual({ name: "Ada", color: "blue" });
    await expect(act({ name: "type", args: { ref: nameRef, text: "stale" } })).rejects.toThrow(/snapshot/i);
    const windows = await h.svc.screens.act(owner, { name: "list_windows", args: {} }, undefined);
    const windowList: unknown[] = Array.isArray(windows.windowList) ? windows.windowList : [];
    const browserWindow = windowList.find((window): window is { appId: string; pid: number } =>
      typeof window === "object" && window !== null && "appId" in window && typeof window.appId === "string"
      && /chrome|chromium/i.test(window.appId) && "pid" in window && typeof window.pid === "number");
    const browserPid = browserWindow?.pid;
    expect(browserPid).toBeDefined();
    expect(pipeBrowserPid).toBe(browserPid);
    const pids = browserProcesses(browserPid!);
    ownedBrowserPids = pids;
    expect(pids.length).toBeGreaterThan(0);
    expect(listeningSocketsOwnedBy(pids)).toEqual([]);
    const otherId = await makeBot(h, "Other real browser Screen");
    const other = await api<{ surfaceId: SurfaceId }>(h, "GET", `/api/bots/${otherId}`);
    await act({ name: "navigate", args: { url: `http://127.0.0.1:${server.port}/other-screen` } }, { botId: otherId, surfaceId: other.surfaceId });
    const ownTabs = (await act({ name: "tabs", args: { operation: "list" } })).text!;
    expect(ownTabs).toContain("/receipt");
    expect(ownTabs).not.toContain("other-screen");
    const otherOwner = { botId: otherId, surfaceId: other.surfaceId };
    const otherTabs = (await act({ name: "tabs", args: { operation: "list" } }, otherOwner)).text!;
    expect(otherTabs).toContain("other-screen");
    expect(otherTabs).not.toContain("/receipt");
    const otherTabId = otherTabs.split("\n").find(line => line.includes("other-screen"))?.trim().replace(/^\*\s*/, "").split(" ")[0];
    expect(otherTabId).toBeDefined();
    await expect(act({ name: "tabs", args: { operation: "switch", tabId: otherTabId } })).rejects.toThrow(/Screen/i);
    await h.svc.computer.agentToolAct(owner, "real-browser-turn", `computer-${++call}`, {
      name: "open_url", args: { url: `http://127.0.0.1:${server.port}/same-screen-window` },
    }, AbortSignal.timeout(60_000));
    const multipleWindows = (await act({ name: "tabs", args: { operation: "list" } })).text!;
    expect(multipleWindows).toContain("/receipt");
    expect(multipleWindows).toContain("same-screen-window");
    expect(multipleWindows).not.toContain("other-screen");
    const receiptTabId = multipleWindows.split("\n").find(line => line.includes("/receipt"))?.trim().replace(/^\*\s*/, "").split(" ")[0];
    expect(receiptTabId).toBeDefined();
    await act({ name: "tabs", args: { operation: "switch", tabId: receiptTabId } });
    let settled = false;
    const pending = act({ name: "request_takeover", args: { reason: "Complete login manually" } }).finally(() => { settled = true; });
    const deadline = Date.now() + 10_000;
    while (h.svc.computer.state(owner).takeoverReason === undefined) {
      if (Date.now() > deadline) throw new Error("Takeover request did not become visible");
      // Real browser and lease progress crosses process boundaries; fake time cannot drive it.
      await Bun.sleep(20);
    }
    expect(settled).toBe(false);
    expect(h.svc.computer.state(owner).takeoverReason).toBe("Complete login manually");
    expect((await h.svc.computer.takeOver(owner)).ok).toBe(true);
    await h.svc.computer.imDone(owner);
    expect((await pending).text).toContain("Receipt");
    expect(h.svc.computer.state(owner).takeoverReason).toBeUndefined();
    await act({ name: "navigate", args: { url: `http://127.0.0.1:${server.port}/long` } });
    await act({ name: "wait_for", args: { text: "Ready after cap", timeoutMs: 10_000 } });
    const long = await act({ name: "read_text", args: {} });
    expect(long.truncated).toBe(true);
    expect(long.text).not.toContain("Ready after cap");
    await act({ name: "navigate", args: { url: `http://127.0.0.1:${server.port}/scrollbar` } });
    await act({ name: "wait_for", args: { text: "+", timeoutMs: 10_000 } });
    for (const zoomed of [false, true]) {
      if (zoomed) {
        viewer = await ProjectionClient.connect(h.baseUrl, owner, "Browser zoom", h.token);
        await viewer.setMode("expanded");
        for (const code of ["ControlLeft", "Equal"]) viewer.sendInput("key", { code, state: "pressed", modifiers: { control: true, alt: false, shift: false, meta: false } });
        for (const code of ["Equal", "ControlLeft"]) viewer.sendInput("key", { code, state: "released", modifiers: { control: code !== "ControlLeft", alt: false, shift: false, meta: false } });
        await until(async () => pageZoom > 1 ? true : undefined, 10_000, "browser keyboard zoom did not resize the page");
        await viewer.close();
        viewer = undefined;
      }
      const tree = (await act({ name: "snapshot", args: {} })).text!;
      await act({ name: "click", args: { ref: refFor(tree, "Coordinate") } });
      const sample = await until(async () => coordinates.length === (zoomed ? 2 : 1) ? coordinates.at(-1) : undefined, 10_000, "coordinate button was missed");
      expect(sample.gutter).toBeGreaterThan(0);
      expect(Math.abs(sample.clientX - sample.expectedX)).toBeLessThanOrEqual(1);
      expect(Math.abs(sample.clientY - sample.expectedY)).toBeLessThanOrEqual(1);
    }
    expect(coordinates[1]!.zoom).toBeGreaterThan(coordinates[0]!.zoom);
    await act({ name: "navigate", args: { url: `http://127.0.0.1:${server.port}/duplicate-one` } });
    await act({ name: "wait_for", args: { text: "Original tab", timeoutMs: 10_000 } });
    await act({ name: "tabs", args: { operation: "open", url: `http://127.0.0.1:${server.port}/duplicate-two` } });
    await act({ name: "wait_for", args: { text: "Human selected tab", timeoutMs: 10_000 } });
    const duplicateTabs = (await act({ name: "tabs", args: {} })).text!;
    const originalTab = duplicateTabs.split("\n").find(line => line.includes("/duplicate-one"))!.trim().replace(/^\*\s*/, "").split(" ")[0];
    await act({ name: "tabs", args: { operation: "switch", tabId: originalTab } });
    const oldRef = refFor((await act({ name: "snapshot", args: {} })).text!, "Keep ref");
    viewer = await ProjectionClient.connect(h.baseUrl, owner, "Human browser tab switch", h.token);
    const held = act({ name: "request_takeover", args: { reason: "Select the second tab" } });
    await until(async () => h!.svc.computer.state(owner).takeoverReason ? true : undefined, 10_000, "tab switch takeover missing");
    await viewer.setMode("expanded");
    selectedTabReported = false;
    for (const code of ["ControlLeft", "Tab"]) viewer.sendInput("key", { code, state: "pressed", modifiers: { control: true, alt: false, shift: false, meta: false } });
    for (const code of ["Tab", "ControlLeft"]) viewer.sendInput("key", { code, state: "released", modifiers: { control: code !== "ControlLeft", alt: false, shift: false, meta: false } });
    await until(async () => selectedTabReported ? true : undefined, 10_000, "human tab selection did not reach the page");
    await h.svc.computer.imDone(owner);
    expect((await held).text).toContain("Human selected tab");
    await viewer.close();
    viewer = undefined;
    await expect(act({ name: "click", args: { ref: oldRef } })).rejects.toThrow(/snapshot/i);
    expect(commands.some(command => command.method === "Runtime.enable")).toBe(false);
    const evaluations = commands.filter(command => command.method === "Runtime.evaluate");
    expect(evaluations.length).toBeGreaterThan(0);
    expect(evaluations.every(command => typeof command.params.contextId === "number")).toBe(true);
    const resolutions = commands.filter(command => command.method === "DOM.resolveNode");
    expect(resolutions.length).toBeGreaterThan(0);
    expect(resolutions.every(command => typeof command.params.executionContextId === "number")).toBe(true);
    // Chromium enables its automation-controlled feature for --remote-debugging-pipe,
    // and the Service deliberately leaves that honest signal alone (Computer ADR 0012).
    expect(webdriver).toBe(true);
  } finally {
    await viewer?.close();
    await h?.stop();
    CdpPipe.prototype.request = request;
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    expect(ownedBrowserPids.filter(pid => existsSync(`/proc/${pid}`))).toEqual([]);
  }
}, 180_000);
