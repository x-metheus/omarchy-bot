import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FakeBotScreenRuntimeAdapter } from "../../apps/daemon/src/modules/computer/fakeBotScreenRuntime.ts";
import type {
  BotScreenInputEvent,
  BotScreenProvision,
  BotScreenRuntime,
} from "../../apps/daemon/src/modules/computer/botScreenManager.ts";
import type { ComputerWindowListItem } from "../../packages/agent-contract/src/computer-protocol.ts";
import type { SurfaceId } from "../../packages/domain/src/ids.ts";
import { createScriptedSwayFixture } from "./helpers/swayBotScreen.ts";

/**
 * Every runtime adapter must satisfy this contract: capture, window routing,
 * launch, and the input-authority handshake look the same above the seam.
 */
interface ContractScreen {
  provision: BotScreenProvision;
  start(): Promise<BotScreenRuntime>;
  /** Windows the Screen routes, in Screen coordinates. */
  windows(): ComputerWindowListItem[];
  /** Application the Screen can launch into its own workspace. */
  application: string;
  /** Input event types the Screen's input helper accepted, in order. */
  acceptedInputs(): string[];
  dispose(): void;
}

const SURFACE_ID = "surf_55555555555555555555555555555555" as SurfaceId;

function provision(): BotScreenProvision {
  return {
    surfaceId: SURFACE_ID,
    geometryGeneration: 7,
    logicalWidth: 1_920,
    logicalHeight: 1_080,
    scale: 1,
    refreshRate: 15,
  };
}

function fakeScreen(): ContractScreen {
  const started = provision();
  const windows: ComputerWindowListItem[] = [
    {
      id: "10",
      title: "Fixture window",
      appId: "fixture",
      pid: 1001,
      focused: true,
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      workspace: `bot-${started.surfaceId}`,
      clientType: "wayland",
    },
  ];
  const adapter = new FakeBotScreenRuntimeAdapter();
  adapter.setWindows(started.surfaceId, windows);
  return {
    provision: started,
    start: () => adapter.start(started),
    windows: () => windows,
    application: "fixture-application",
    acceptedInputs: () => adapter.inputEvents.map((record) => record.event.type),
    dispose: () => {},
  };
}

async function scriptedSwayScreen(): Promise<ContractScreen> {
  const fixture = await createScriptedSwayFixture();
  return {
    provision: provision(),
    start: (): Promise<BotScreenRuntime> => fixture.adapter.start(provision()),
    windows: () => fixture.windowsFor(SURFACE_ID),
    application: fixture.application,
    acceptedInputs: () =>
      fixture.inputCommands()
        .map((line) => line.split(" ")[0]!)
        .filter((command) => command !== "authority" && command !== "release"),
    dispose: () => fixture.dispose(),
  };
}

function contract(name: string, create: () => ContractScreen | Promise<ContractScreen>): void {
  describe(name, () => {
    let screen: ContractScreen;
    let runtime: BotScreenRuntime;

    beforeEach(async () => {
      screen = await create();
      runtime = await screen.start();
    });

    afterEach(async () => {
      await runtime.stop().catch(() => {});
      screen.dispose();
    });

    test("captures its Screen as a PNG", async () => {
      const capture = await runtime.capture();
      expect(capture.mediaType).toBe("image/png");
      expect(capture.bytes.slice(0, 8)).toEqual(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
    });

    test("keeps one capture stream per Screen", async () => {
      const stream = await runtime.openCaptureStream();
      await stream.close();
      await stream.close();
    });

    test("routes the windows of its own workspace in Screen coordinates", async () => {
      expect(await runtime.listWindows()).toEqual(screen.windows());
    });

    test("focuses exactly the window it was asked to focus", async () => {
      const target = screen.windows()[0]!;
      await runtime.focusWindow(target);
      const listed = await runtime.listWindows();
      expect(listed.filter((window) => window.focused).map((window) => window.id)).toEqual([target.id]);
      expect(listed.map((window) => window.id)).toEqual(screen.windows().map((window) => window.id));
    });

    test("launches an application on its own Screen", async () => {
      await expect(runtime.launch({ app: screen.application })).resolves.toMatchObject({
        text: expect.stringContaining(screen.application),
      });
    });

    test("delivers input only under the authority it granted", async () => {
      const envelope = (epoch: number, sequence: number): BotScreenInputEvent => ({
        surfaceId: screen.provision.surfaceId,
        runtimeGeneration: runtime.generation,
        geometryGeneration: screen.provision.geometryGeneration,
        controllerEpoch: epoch,
        sequence,
        type: "motion",
        x: 4,
        y: 5,
      });

      await expect(runtime.input(envelope(1, 1))).rejects.toThrow();
      expect(screen.acceptedInputs()).toEqual([]);
      expect(await runtime.setInputAuthority(1)).toBe(1);
      await runtime.input(envelope(1, 1));
      expect(screen.acceptedInputs()).toEqual(["motion"]);
      await runtime.releaseInput(1);
      await expect(runtime.input(envelope(1, 2))).rejects.toThrow();
    });

    test("stops once and refuses work afterwards", async () => {
      await runtime.stop();
      await runtime.stop();
      await expect(runtime.capture()).rejects.toThrow();
    });
  });
}

contract("Fake Bot Screen runtime contract", fakeScreen);
contract("Scripted Sway Bot Screen runtime contract", scriptedSwayScreen);
