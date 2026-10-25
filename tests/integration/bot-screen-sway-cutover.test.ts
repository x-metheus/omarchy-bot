import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ComputerSurfaceOwner } from "../../apps/daemon/src/modules/computer/broker.ts";
import { waitScreenReady } from "./helpers/bot-screen-load-observe.ts";
import { api, authedFetch, makeBot, sendToBot, startDaemon, type Harness } from "./helpers/harness.ts";
import { writeFakeSwayIpcMode, writeFakeSwayTree } from "./helpers/fakeSwayIpc.ts";

function ownerOf(bot: { id: string; surfaceId: string }): ComputerSurfaceOwner {
  return { botId: bot.id, surfaceId: bot.surfaceId as ComputerSurfaceOwner["surfaceId"] };
}

const ENV_KEYS = [
  "OMARCHY_BOT_SWAY_BIN",
  "OMARCHY_BOT_SWAYMSG_BIN",
  "OMARCHY_BOT_WAYVNC_BIN",
  "OMARCHY_BOT_WLR_RANDR_BIN",
  "OMARCHY_BOT_XWAYLAND_BIN",
  "OMARCHY_BOT_GRIM_BIN",
  "OMARCHY_BOT_DBUS_DAEMON_BIN",
  "OMARCHY_BOT_INPUT_HELPER_BIN",
  "OMARCHY_BOT_CAPTURE_HELPER_BIN",
  "OMARCHY_BOT_DESKTOP_BIN",
] as const;

const priorEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
let roots: string[] = [];
let harness: Harness | undefined;

afterEach(async () => {
  if (harness !== undefined) {
    await harness.stop().catch(() => {});
    harness = undefined;
  }
  for (const key of ENV_KEYS) {
    const value = priorEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function executable(directory: string, name: string, body: string): string {
  const target = path.join(directory, name);
  writeFileSync(target, body);
  chmodSync(target, 0o700);
  return target;
}

async function installFakeSwayBins(directory: string): Promise<{
  sway: string;
  swaymsg: string;
  wayvnc: string;
  wlrRandr: string;
  xwayland: string;
  grim: string;
  dbusDaemon: string;
  input: string;
  capture: string;
  desktop: string;
}> {
  const controlDir = path.join(directory, "ipc-control");
  mkdirSync(controlDir);
  writeFakeSwayTree(controlDir, {
    id: 1,
    type: "root",
    name: "root",
    nodes: [],
    floating_nodes: [],
  });
  writeFakeSwayIpcMode(controlDir, "ok");
  const helperPath = path.resolve(import.meta.dir, "helpers/fakeSwayIpc.ts");
  const png = path.join(directory, "screen.png");
  const convert = Bun.which("magick") ?? Bun.which("convert");
  if (convert === null) throw new Error("cutover fixture requires ImageMagick convert");
  const painted = Bun.spawn([convert, "-size", "1920x1080", "xc:#102028", png], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  if (await painted.exited !== 0) {
    throw new Error(`could not paint cutover fixture PNG: ${await new Response(painted.stderr).text()}`);
  }
  return {
    sway: executable(directory, "sway", `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import path from "node:path";
import { serveFakeSwayIpc } from ${JSON.stringify(helperPath)};
const runtimeDir = process.env.XDG_RUNTIME_DIR ?? "";
const wayland = path.join(runtimeDir, "wayland-0");
const swaySock = process.env.SWAYSOCK ?? path.join(runtimeDir, "sway-ipc.sock");
writeFileSync(path.join(runtimeDir, "sway-started"), runtimeDir);
Bun.listen({ unix: wayland, socket: { data() {} } });
await serveFakeSwayIpc({
  socketPath: swaySock,
  controlDir: ${JSON.stringify(controlDir)},
});
`),
    swaymsg: executable(directory, "swaymsg", "#!/bin/sh\nexit 0\n"),
    wayvnc: executable(directory, "wayvnc", "#!/bin/sh\nsleep 3600\n"),
    wlrRandr: executable(directory, "wlr-randr", "#!/bin/sh\nexit 0\n"),
    xwayland: executable(directory, "Xwayland", "#!/bin/sh\nexit 0\n"),
    grim: executable(directory, "grim", `#!/bin/sh\ncat ${JSON.stringify(png)}\n`),
    dbusDaemon: executable(directory, "dbus-daemon", `#!/usr/bin/env bun
const address = process.argv.find((argument) => argument.startsWith("--address=")) ?? "";
Bun.listen({ unix: address.slice("--address=".length).replace("unix:path=", ""), socket: { data() {} } });
await new Promise(() => {});
`),
    input: executable(directory, "input", [
      "#!/bin/sh",
      "printf 'READY\\n'",
      "while IFS=' ' read -r command request rest; do",
      "  printf 'OK %s\\n' \"$request\"",
      "done",
      "",
    ].join("\n")),
    capture: executable(directory, "capture", "#!/bin/sh\nprintf 'READY\\n'\nwhile read -r command; do [ \"$command\" = close ] && exit 0; done\n"),
    desktop: executable(directory, "bot-desktop", "#!/bin/sh\nprintf 'READY %s %s\\n' \"$1\" \"$2\"\nwhile :; do sleep 60; done\n"),
  };
}

async function useFakeSwayProductionBins(): Promise<string> {
  const root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-sway-cutover-bins-"));
  roots.push(root);
  const bins = await installFakeSwayBins(root);
  process.env.OMARCHY_BOT_SWAY_BIN = bins.sway;
  process.env.OMARCHY_BOT_SWAYMSG_BIN = bins.swaymsg;
  process.env.OMARCHY_BOT_WAYVNC_BIN = bins.wayvnc;
  process.env.OMARCHY_BOT_WLR_RANDR_BIN = bins.wlrRandr;
  process.env.OMARCHY_BOT_XWAYLAND_BIN = bins.xwayland;
  process.env.OMARCHY_BOT_GRIM_BIN = bins.grim;
  process.env.OMARCHY_BOT_DBUS_DAEMON_BIN = bins.dbusDaemon;
  process.env.OMARCHY_BOT_INPUT_HELPER_BIN = bins.input;
  process.env.OMARCHY_BOT_CAPTURE_HELPER_BIN = bins.capture;
  process.env.OMARCHY_BOT_DESKTOP_BIN = bins.desktop;
  return root;
}

test("production Sway serves a Computer Surface, Agent-only use, and deletion", async () => {
  await useFakeSwayProductionBins();
  harness = await startDaemon(undefined, { useProductionBotScreen: true });

  const botId = await makeBot(harness, "Cutover public");
  const sent = await sendToBot(harness, botId, "agent-only later");
  const owner = ownerOf(await api<{ id: string; surfaceId: string }>(harness, "GET", `/api/bots/${botId}`));

  const preview = await authedFetch(harness,
    `${harness.baseUrl}/api/computer/snapshot?botId=${owner.botId}&surfaceId=${owner.surfaceId}`,
  );
  expect(preview.status).toBe(200);
  await waitScreenReady(harness, owner);
  const agentShot = await harness.svc.screens.act(owner, { name: "screenshot", args: {} });
  const generation = agentShot.desktopSession?.runtimeGeneration;
  expect(generation).toBeNumber();
  expect(existsSync(path.join(harness.home, "r", owner.surfaceId, String(generation), "surface.json"))).toBeTrue();

  const workspaceMarker = path.join(harness.svc.cfg.sharedWorkspaceDir, "cutover-keep.txt");
  mkdirSync(harness.svc.cfg.sharedWorkspaceDir, { recursive: true });
  writeFileSync(workspaceMarker, "keep");
  const deleted = await api<{ status: string }>(harness, "DELETE", `/api/bots/${botId}`, {});
  expect(deleted.status).toBe("deleted");
  expect(existsSync(path.join(harness.home, "r", owner.surfaceId))).toBeFalse();
  expect(readFileSync(workspaceMarker, "utf8")).toBe("keep");
  expect((await authedFetch(harness, `${harness.baseUrl}/api/computer/state?botId=${owner.botId}&surfaceId=${owner.surfaceId}`)).status).toBe(404);
  expect(sent.threadId).toBeString();
}, 20_000);
