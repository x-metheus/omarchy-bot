import type { Server } from "bun";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os, { type NetworkInterfaceInfo } from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { SurfaceId } from "../../../packages/domain/src/ids.ts";
import type { BrowserFrameMetric } from "./bot-screen-capacity-report.ts";

interface BrowserOwner {
  botId: string;
  surfaceId: SurfaceId;
}

interface InstrumentFrame {
  sequence: number;
  signature: number;
  capturedAtEpochMs: number | null;
  receivedAtMs: number;
  decodedAtMs?: number;
  displayedAtMs?: number;
  captureToBrowserMs?: number;
}


interface InstrumentState {
  received: InstrumentFrame[];
  decoded: InstrumentFrame[];
  displayed: InstrumentFrame[];
  inputAuthorityMessages: Array<{ active: boolean; controllerEpoch: number; receivedAtMs: number }>;
  inputAuthorityActive: boolean;
  sentInputMessages: Array<{ type: string | null; state?: string; reason?: string; sentAtMs: number }>;
  pendingInput?: {
    baselineSequence: number;
    baselineSignature: number;
    sentAtMs?: number;
    visibleAtMs?: number;
  };
  armInput(): void;
}

declare global {
  interface Window {
    __botScreenLoad: InstrumentState;
  }
}

export interface BrowserWindowMetric extends BrowserFrameMetric {
  durationMs: number;
  renderingSequences: number[];
  decodeDrops: number;
  paintDrops: number;
  captureToBrowserMs: number[];
}

export function selectNonLoopbackLanAddress(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
  requestedInterface?: string,
): { interfaceName: string; address: string } {
  if (requestedInterface !== undefined && interfaces[requestedInterface] === undefined) {
    throw new Error(`OMARCHY_BOT_LOAD_LAN_INTERFACE ${requestedInterface} does not exist`);
  }
  const virtualInterface = /^(?:br-|docker|podman|tailscale|veth|virbr|vmnet|wg)/;
  const candidates = Object.entries(interfaces)
    .filter(([name]) => requestedInterface === undefined || name === requestedInterface)
    .flatMap(([interfaceName, entries]) => (entries ?? []).map((entry) => ({ interfaceName, entry })))
    .filter(({ interfaceName, entry }) =>
      !virtualInterface.test(interfaceName)
      && entry.family === "IPv4"
      && !entry.internal
      && !entry.address.startsWith("127.")
    )
    .sort((left, right) =>
      left.interfaceName.localeCompare(right.interfaceName) || left.entry.address.localeCompare(right.entry.address)
    );
  const selected = candidates[0];
  if (selected === undefined) {
    throw new Error("the browser load harness requires a non-loopback IPv4 LAN interface");
  }
  return { interfaceName: selected.interfaceName, address: selected.entry.address };
}

export async function buildFinalWebClient(projectRoot: string): Promise<void> {
  const build = Bun.spawn(["bun", "run", "--filter=@omarchy-bot/web", "build"], {
    cwd: projectRoot,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await build.exited;
  const index = path.join(projectRoot, "apps/web/dist/index.html");
  if (status !== 0 || !existsSync(index)) {
    throw new Error(`final web client build failed with status ${status}`);
  }
}

function installBrowserInstrumentation(): void {
  const received: InstrumentFrame[] = [];
  const decoded: InstrumentFrame[] = [];
  const displayed: InstrumentFrame[] = [];
  const awaitingBlob: InstrumentFrame[] = [];
  const frameByUrl = new Map<string, InstrumentFrame>();
  const processedUrls = new Set<string>();
  const observedViews = new WeakSet<HTMLElement>();
  let viewSequence = 0;
  let pendingHeader: { sequence: number; byteLength: number; capturedAt?: string } | undefined;

  const instrument: InstrumentState = {
    received,
    decoded,
    displayed,
    inputAuthorityMessages: [],
    inputAuthorityActive: false,
    sentInputMessages: [],
    armInput() {
      const baseline = displayed.at(-1);
      if (baseline === undefined) throw new Error("cannot arm input before a browser-painted frame");
      instrument.pendingInput = {
        baselineSequence: baseline.sequence,
        baselineSignature: baseline.signature,
      };
    },
  };
  Object.defineProperty(window, "__botScreenLoad", { value: instrument });

  const nativeCreateObjectUrl = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (blob: Blob): string => {
    const url = nativeCreateObjectUrl(blob);
    const frame = awaitingBlob.shift();
    if (frame !== undefined) frameByUrl.set(url, frame);
    return url;
  };

  const NativeWebSocket = window.WebSocket;
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(Target, args: ConstructorParameters<typeof WebSocket>) {
      const socket = new Target(...args);
      const url = new URL(typeof args[0] === "string" ? args[0] : args[0].href, location.href);
      if (url.pathname.endsWith("/api/computer/projection/control")) {
        socket.addEventListener("message", (event: MessageEvent<unknown>) => {
          if (typeof event.data === "string") {
            try {
              const message = JSON.parse(event.data) as {
                type?: string;
                active?: boolean;
                controllerEpoch?: number;
                sequence?: number;
                byteLength?: number;
                capturedAt?: string;
              };
              if (
                message.type === "input-authority"
                && typeof message.active === "boolean"
                && typeof message.controllerEpoch === "number"
              ) {
                instrument.inputAuthorityActive = message.active;
                instrument.inputAuthorityMessages.push({
                  active: message.active,
                  controllerEpoch: message.controllerEpoch,
                  receivedAtMs: performance.now(),
                });
              }
              pendingHeader = message.type === "preview-frame"
                && typeof message.sequence === "number"
                && typeof message.byteLength === "number"
                ? {
                    sequence: message.sequence,
                    byteLength: message.byteLength,
                    ...(message.capturedAt === undefined ? {} : { capturedAt: message.capturedAt }),
                  }
                : pendingHeader;
            } catch {
              // Production client owns validation; instrumentation records valid messages only.
            }
            return;
          }
          if (pendingHeader === undefined || !(event.data instanceof ArrayBuffer)) return;
          if (event.data.byteLength !== pendingHeader.byteLength) {
            pendingHeader = undefined;
            return;
          }
          const capturedAtEpochMs = pendingHeader.capturedAt === undefined ? null : Date.parse(pendingHeader.capturedAt);
          const frame: InstrumentFrame = {
            sequence: pendingHeader.sequence,
            signature: 0,
            capturedAtEpochMs: Number.isFinite(capturedAtEpochMs) ? capturedAtEpochMs : null,
            receivedAtMs: performance.now(),
          };
          received.push(frame);
          awaitingBlob.push(frame);
          pendingHeader = undefined;
        });
        const nativeSend = socket.send.bind(socket);
        socket.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView): void => {
          const pendingInput = instrument.pendingInput;
          if (typeof data === "string") {
            try {
              const message = JSON.parse(data) as { type?: string; state?: string; reason?: string };
              instrument.sentInputMessages.push({
                type: message.type ?? null,
                ...(message.state === undefined ? {} : { state: message.state }),
                ...(message.reason === undefined ? {} : { reason: message.reason }),
                sentAtMs: performance.now(),
              });
              if (
                message.type === "key"
                && message.state === "pressed"
                && pendingInput !== undefined
                && pendingInput.sentAtMs === undefined
              ) pendingInput.sentAtMs = performance.now();
            } catch {
              // Production client owns validation; instrumentation timestamps parseable sends.
            }
          }
          nativeSend(data);
        };
      }
      return socket;
    },
  });

  const observeImage = async (image: HTMLImageElement): Promise<void> => {
    const url = image.src;
    const frame = frameByUrl.get(url) ?? received.findLast((candidate) => candidate.decodedAtMs === undefined);
    if (frame === undefined || processedUrls.has(url)) return;
    try {
      await image.decode();
      if (image.src !== url) return;
      processedUrls.add(url);
      frame.decodedAtMs = performance.now();
      decoded.push(frame);
      await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      if (image.src !== url) return;
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context === null) return;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let signature = 2166136261;
      for (let index = 0; index < pixels.length; index += 16) {
        signature ^= pixels[index]!;
        signature = Math.imul(signature, 16777619);
      }
      frame.signature = signature >>> 0;
      frame.displayedAtMs = performance.now();
      if (frame.capturedAtEpochMs !== null) frame.captureToBrowserMs = Date.now() - frame.capturedAtEpochMs;
      displayed.push(frame);
      const input = instrument.pendingInput;
      if (
        input?.sentAtMs !== undefined
        && input.visibleAtMs === undefined
        && frame.sequence > input.baselineSequence
        && frame.signature !== input.baselineSignature
      ) input.visibleAtMs = frame.displayedAtMs;
    } catch {
      // A newer frame may revoke this Blob URL before decode/paint.
    }
  };

  const observeExpandedView = (host: HTMLElement): void => {
    if (observedViews.has(host)) return;
    observedViews.add(host);
    const scratch = document.createElement("canvas");
    scratch.width = 320;
    scratch.height = 180;
    const context = scratch.getContext("2d", { willReadFrequently: true });
    if (context === null) return;
    let lastSignature: number | undefined;
    const paint = (): void => {
      if (!host.isConnected) return;
      const source = host.querySelector("canvas");
      if (source !== null) {
        const decodedAtMs = performance.now();
        context.drawImage(source, 0, 0, scratch.width, scratch.height);
        const pixels = context.getImageData(0, 0, scratch.width, scratch.height).data;
        let signature = 2166136261;
        for (let index = 0; index < pixels.length; index += 16) {
          signature ^= pixels[index]!;
          signature = Math.imul(signature, 16777619);
        }
        signature >>>= 0;
        if (signature !== lastSignature) {
          lastSignature = signature;
          const displayedAtMs = performance.now();
          const frame: InstrumentFrame = {
            sequence: ++viewSequence,
            signature,
            capturedAtEpochMs: null,
            receivedAtMs: decodedAtMs,
            decodedAtMs,
            displayedAtMs,
          };
          received.push(frame);
          decoded.push(frame);
          displayed.push(frame);
          const input = instrument.pendingInput;
          if (
            input?.sentAtMs !== undefined
            && input.visibleAtMs === undefined
            && frame.sequence > input.baselineSequence
            && frame.signature !== input.baselineSignature
          ) input.visibleAtMs = displayedAtMs;
        }
      }
      requestAnimationFrame(paint);
    };
    requestAnimationFrame(paint);
  };

  const scan = (): void => {
    const view = document.querySelector<HTMLElement>('[data-testid="computer-expanded-view"]');
    const preview = document.querySelector<HTMLImageElement>('img[data-testid="computer-preview"]');
    if (view !== null) observeExpandedView(view);
    else if (preview !== null) void observeImage(preview);
  };
  addEventListener("DOMContentLoaded", () => {
    new MutationObserver(scan).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["src"],
      childList: true,
      subtree: true,
    });
    document.addEventListener("load", (event) => {
      if (event.target instanceof HTMLImageElement) void observeImage(event.target);
    }, true);
    scan();
  }, { once: true });
}

type ProjectionFailureLookup = (
  owner: BrowserOwner,
  sessionId: string,
) => unknown;

export class BrowserSurfaceSession {
  #windowStartedAtMs?: number;

  private constructor(
    readonly owner: BrowserOwner,
    readonly lanEndpoint: string,
    readonly projectionSessionId: string,
    private readonly videoWidth: number,
    private readonly videoHeight: number,
    private readonly page: Page,
    private readonly context: BrowserContext,
    private readonly failureLookup?: ProjectionFailureLookup,
  ) {}

  static async open(
    browser: Browser,
    lanEndpoint: string,
    owner: BrowserOwner,
    failureLookup?: ProjectionFailureLookup,
    token?: string,
  ): Promise<BrowserSurfaceSession> {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
    });
    // Keep the memory shell on the LAN HTTPS proxy for HTTP and WebSocket traffic.
    await context.addInitScript(({ serviceUrl, token }) => {
      localStorage.setItem("omarchy-bot.service-url", serviceUrl);
      if (token) localStorage.setItem("omarchy-bot.device-token", token);
    }, { serviceUrl: lanEndpoint, token });
    const page = await context.newPage();
    await page.addInitScript(installBrowserInstrumentation);
    await page.goto(`${lanEndpoint}/?bot=${encodeURIComponent(owner.botId)}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("header-computer").waitFor({ state: "visible", timeout: 15_000 });
    try {
      await page.waitForFunction(() =>
        document.querySelector('[data-testid="header-computer"]')?.getAttribute("aria-disabled") !== "true"
      );
    } catch {
      const diagnostics = await page.evaluate(async () => {
        const response = await fetch("/api/bots");
        return {
          status: response.status,
          body: await response.text(),
          page: document.body.innerText.slice(0, 1_000),
        };
      });
      throw new Error(`final web client did not select the Bot: ${JSON.stringify(diagnostics)}`);
    }
    const projectionResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/computer/projection"
        && response.request().method() === "POST"
        && response.status() === 201;
    });
    await page.getByTestId("header-computer").click();
    const answer = await (await projectionResponse).json() as {
      sessionId?: unknown;
      videoWidth?: unknown;
      videoHeight?: unknown;
    };
    if (
      typeof answer.sessionId !== "string"
      || typeof answer.videoWidth !== "number"
      || typeof answer.videoHeight !== "number"
    ) throw new Error("final web client projection answer lacked its media contract");
    const preview = page.getByTestId("computer-preview");
    await preview.waitFor({ state: "visible", timeout: 15_000 });
    try {
      await page.waitForFunction(() => window.__botScreenLoad.displayed.length > 0, undefined, { timeout: 15_000 });
    } catch {
      const pageDiagnostics = await page.evaluate(async ({ botId, surfaceId, sessionId }) => {
        const image = document.querySelector<HTMLImageElement>('img[data-testid="computer-preview"]');
        const response = await fetch(
          `/api/computer/projection?botId=${encodeURIComponent(botId)}&surfaceId=${encodeURIComponent(surfaceId)}&sessionId=${encodeURIComponent(sessionId)}`,
        );
        return {
          instrumentation: {
            received: window.__botScreenLoad.received.length,
            decoded: window.__botScreenLoad.decoded.length,
            displayed: window.__botScreenLoad.displayed.length,
          },
          image: image === null
            ? null
            : {
                srcScheme: (image.currentSrc || image.src).split(":", 1)[0] ?? "",
                srcLength: (image.currentSrc || image.src).length,
                complete: image.complete,
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
              },
          projection: {
            status: response.status,
            body: await response.text(),
          },
        };
      }, { botId: owner.botId, surfaceId: owner.surfaceId, sessionId: answer.sessionId });
      const diagnostics = {
        ...pageDiagnostics,
        internalFailure: failureLookup?.(owner, answer.sessionId) ?? null,
      };
      throw new Error(`final web client did not paint Computer Preview: ${JSON.stringify(diagnostics)}`);
    }
    return new BrowserSurfaceSession(
      owner,
      lanEndpoint,
      answer.sessionId,
      answer.videoWidth,
      answer.videoHeight,
      page,
      context,
      failureLookup,
    );
  }

  async expand(): Promise<void> {
    await this.page.getByTestId("computer-preview-expand").click();
    await this.page.getByTestId("expanded-web-control").waitFor({ state: "visible", timeout: 10_000 });
    await this.page.waitForFunction(
      () => {
        const view = document.querySelector('[data-testid="computer-expanded-view"]');
        return view !== null && window.__botScreenLoad.inputAuthorityActive;
      },
      undefined,
      { timeout: 10_000 },
    );
  }

  async measureInputToVisible(afterWebInputSent?: () => Promise<void>): Promise<number> {
    await this.page.evaluate(() => {
      window.__botScreenLoad.armInput();
    });
    const control = this.page.getByTestId("expanded-web-control");
    await control.focus();
    let sent = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await this.page.keyboard.press(attempt % 2 === 0 ? "A" : "B");
      sent = await this.page.evaluate(() =>
        window.__botScreenLoad.pendingInput?.sentAtMs !== undefined
      );
      if (sent) break;
      await this.page.waitForTimeout(50);
    }
    if (!sent) {
      const pageDiagnostics = await this.page.evaluate(async ({ botId, surfaceId, sessionId }) => {
        const response = await fetch(
          `/api/computer/projection?botId=${encodeURIComponent(botId)}&surfaceId=${encodeURIComponent(surfaceId)}&sessionId=${encodeURIComponent(sessionId)}`,
        );
        return {
          inputAuthority: {
            active: window.__botScreenLoad.inputAuthorityActive,
            messages: window.__botScreenLoad.inputAuthorityMessages,
          },
          sentInputMessages: window.__botScreenLoad.sentInputMessages,
          projection: {
            status: response.status,
            body: await response.text(),
          },
        };
      }, {
        botId: this.owner.botId,
        surfaceId: this.owner.surfaceId,
        sessionId: this.projectionSessionId,
      });
      const diagnostics = {
        ...pageDiagnostics,
        internalFailure: this.failureLookup?.(this.owner, this.projectionSessionId) ?? null,
      };
      throw new Error(`Web Control did not send browser input: ${JSON.stringify(diagnostics)}`);
    }
    await afterWebInputSent?.();
    try {
      await this.page.waitForFunction(() => {
        const input = window.__botScreenLoad.pendingInput;
        return input?.sentAtMs !== undefined && input.visibleAtMs !== undefined;
      }, undefined, { timeout: 5_000 });
    } catch {
      const pageDiagnostics = await this.page.evaluate(async ({ botId, surfaceId, sessionId }) => {
        const response = await fetch(
          `/api/computer/projection?botId=${encodeURIComponent(botId)}&surfaceId=${encodeURIComponent(surfaceId)}&sessionId=${encodeURIComponent(sessionId)}`,
        );
        return {
          input: window.__botScreenLoad.pendingInput,
          inputAuthority: {
            active: window.__botScreenLoad.inputAuthorityActive,
            messages: window.__botScreenLoad.inputAuthorityMessages,
          },
          sentInputMessages: window.__botScreenLoad.sentInputMessages,
          received: window.__botScreenLoad.received.slice(-5),
          decoded: window.__botScreenLoad.decoded.slice(-5),
          displayed: window.__botScreenLoad.displayed.slice(-5),
          projection: {
            status: response.status,
            body: await response.text(),
          },
        };
      }, {
        botId: this.owner.botId,
        surfaceId: this.owner.surfaceId,
        sessionId: this.projectionSessionId,
      });
      const diagnostics = {
        ...pageDiagnostics,
        internalFailure: this.failureLookup?.(this.owner, this.projectionSessionId) ?? null,
      };
      throw new Error(`browser input did not produce painted feedback: ${JSON.stringify(diagnostics)}`);
    }
    return this.page.evaluate(() => {
      const input = window.__botScreenLoad.pendingInput;
      if (input?.sentAtMs === undefined || input.visibleAtMs === undefined) throw new Error("input was not browser-visible");
      return input.visibleAtMs - input.sentAtMs;
    });
  }

  async startWindow(): Promise<void> {
    this.#windowStartedAtMs = await this.page.evaluate(() => performance.now());
  }

  async movePointer(step: number): Promise<void> {
    const control = this.page.getByTestId("expanded-web-control");
    const box = await control.boundingBox();
    if (box === null) return;
    await this.page.mouse.move(
      box.x + 20 + (step * 37) % Math.max(1, box.width - 40),
      box.y + 20 + (step * 19) % Math.max(1, box.height - 40),
    );
    if (step % 4 === 0) await this.page.mouse.wheel(0, step % 8 === 0 ? 240 : -240);
  }

  async finishWindow(window?: { durationMs: number }): Promise<BrowserWindowMetric> {
    const startedAtMs = this.#windowStartedAtMs;
    if (startedAtMs === undefined) throw new Error("browser measurement window was not started");
    if (window !== undefined) {
      await this.page.evaluate(() => new Promise<void>((resolve) =>
        requestAnimationFrame(() => setTimeout(resolve, 0))
      ));
    }
    const surfaceId: string = this.owner.surfaceId;
    const lanEndpoint = this.lanEndpoint;
    return this.page.evaluate(({ start, surfaceId, lanEndpoint, window }) => {
      const state = globalThis.window.__botScreenLoad;
      const endedAtMs = performance.now();
      const durationMs = window?.durationMs ?? endedAtMs - start;
      const received = state.received.filter((frame) =>
        frame.receivedAtMs >= start && frame.receivedAtMs <= endedAtMs
      );
      const decoded = state.decoded.filter((frame) =>
        (frame.decodedAtMs ?? -1) >= start && (frame.decodedAtMs ?? Infinity) <= endedAtMs
      );
      const displayed = state.displayed.filter((frame) =>
        (frame.displayedAtMs ?? -1) >= start && (frame.displayedAtMs ?? Infinity) <= endedAtMs
      );
      const receivedFrames = received.length;
      const decodedFrames = decoded.length;
      const displayedFrames = displayed.length;
      const renderingSequences = [...new Set(displayed.map((frame) => frame.sequence))]
        .sort((left, right) => left - right);
      const seconds = durationMs / 1_000;
      return {
        surfaceId,
        lanEndpoint,
        finalWebClient: true as const,
        durationMs: Number(durationMs.toFixed(2)),
        renderingSequences,
        receivedFrames,
        decodedFrames,
        displayedFrames,
        decodeDrops: receivedFrames - decodedFrames,
        paintDrops: decodedFrames - displayedFrames,
        receivedFps: Number((receivedFrames / seconds).toFixed(2)),
        decodedFps: Number((decodedFrames / seconds).toFixed(2)),
        displayedFps: Number((displayedFrames / seconds).toFixed(2)),
        captureToBrowserMs: displayed.flatMap((frame) =>
          frame.captureToBrowserMs === undefined ? [] : [Number(frame.captureToBrowserMs.toFixed(2))]
        ),
      };
    }, { start: startedAtMs, surfaceId, lanEndpoint, window });
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

interface ProjectionProxyData {
  target: string;
  upstream: WebSocket | undefined;
  pending: Array<string | Uint8Array>;
  pendingBytes: number;
  closed: boolean;
}

/** The browser harness must relay WebSocket upgrades as well as HTTP assets. */
export function startProjectionProxy(
  upstreamBaseUrl: string,
  hostname: string,
  tls?: { key: import("bun").BunFile; cert: import("bun").BunFile },
): Server<ProjectionProxyData> {
  const upstream = new URL(upstreamBaseUrl);
  const maxBufferedBytes = 8 * 1024 * 1024;
  const byteLength = (data: string | Uint8Array | ArrayBuffer): number =>
    typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
  return Bun.serve<ProjectionProxyData>({
    hostname,
    port: 0,
    ...(tls === undefined ? {} : { tls }),
    fetch(request, server) {
      const incoming = new URL(request.url);
      const target = new URL(`${incoming.pathname}${incoming.search}`, upstream);
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
        if (server.upgrade(request, { data: { target: target.href, upstream: undefined, pending: [], pendingBytes: 0, closed: false } })) return;
        return new Response("WebSocket upgrade required", { status: 426 });
      }
      return fetch(new Request(target, request));
    },
    websocket: {
      open(client) {
        const data = client.data;
        const remote = new WebSocket(data.target);
        data.upstream = remote;
        remote.binaryType = "arraybuffer";
        remote.addEventListener("open", () => {
          if (data.closed) { remote.close(); return; }
          for (const message of data.pending) remote.send(message);
          data.pending = [];
          data.pendingBytes = 0;
        });
        remote.addEventListener("message", (event) => {
          if (data.closed) return;
          const message = typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer);
          if (client.getBufferedAmount() + byteLength(message) > maxBufferedBytes || client.send(message) === 0) {
            client.close(1013, "proxy backpressure");
            remote.close();
          }
        });
        remote.addEventListener("error", () => client.close(1011, "upstream connection failed"));
        remote.addEventListener("close", (event) => {
          if (!data.closed) client.close(event.code === 1000 ? 1000 : 1011, "upstream closed");
        });
      },
      message(client, raw) {
        const data = client.data;
        const remote = data.upstream;
        if (data.closed) return;
        const size = byteLength(raw);
        if (size + data.pendingBytes + (remote?.bufferedAmount ?? 0) > maxBufferedBytes) {
          client.close(1013, "proxy backpressure");
          remote?.close();
          return;
        }
        if (remote?.readyState === WebSocket.OPEN) remote.send(raw);
        else { data.pending.push(typeof raw === "string" ? raw : raw.slice()); data.pendingBytes += size; }
      },
      close(client) {
        client.data.closed = true;
        client.data.pending = [];
        client.data.pendingBytes = 0;
        client.data.upstream?.close();
      },
    },
  });
}

export class FinalWebBrowserHarness {
  readonly lanEndpoint: string;
  readonly lanInterface: string;
  readonly browserName: string;
  readonly #browser: Browser;
  readonly #proxy: Server<ProjectionProxyData>;
  readonly #tlsRoot: string;

  private constructor(
    browser: Browser,
    proxy: Server<ProjectionProxyData>,
    lanEndpoint: string,
    lanInterface: string,
    browserName: string,
    tlsRoot: string,
    private readonly failureLookup?: ProjectionFailureLookup,
    private readonly token?: string,
  ) {
    this.#browser = browser;
    this.#proxy = proxy;
    this.lanEndpoint = lanEndpoint;
    this.lanInterface = lanInterface;
    this.browserName = browserName;
    this.#tlsRoot = tlsRoot;
  }

  static async start(
    upstreamBaseUrl: string,
    failureLookup?: ProjectionFailureLookup,
    token?: string,
  ): Promise<FinalWebBrowserHarness> {
    const selected = selectNonLoopbackLanAddress(os.networkInterfaces(), process.env.OMARCHY_BOT_LOAD_LAN_INTERFACE);
    const tlsRoot = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-screen-load-tls-"));
    const keyPath = path.join(tlsRoot, "key.pem");
    const certificatePath = path.join(tlsRoot, "certificate.pem");
    const openssl = Bun.which("openssl");
    if (openssl === null) {
      rmSync(tlsRoot, { recursive: true, force: true });
      throw new Error("the browser load harness requires openssl for its LAN HTTPS endpoint");
    }
    const certificate = Bun.spawn([
      openssl,
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      "-days",
      "1",
      "-subj",
      `/CN=${selected.address}`,
      "-addext",
      `subjectAltName=IP:${selected.address}`,
    ], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    if (await certificate.exited !== 0) {
      rmSync(tlsRoot, { recursive: true, force: true });
      throw new Error("could not create the browser load harness LAN certificate");
    }
    const proxy = startProjectionProxy(upstreamBaseUrl, selected.address, {
      key: Bun.file(keyPath), cert: Bun.file(certificatePath),
    });
    const executablePath = process.env.OMARCHY_BOT_LOAD_BROWSER_BIN
      ?? Bun.which("brave")
      ?? Bun.which("chromium")
      ?? Bun.which("chromium-browser");
    if (executablePath === null || executablePath === undefined) {
      proxy.stop(true);
      rmSync(tlsRoot, { recursive: true, force: true });
      throw new Error("the real load harness requires Brave or Chromium");
    }
    try {
      const browser = await chromium.launch({
        executablePath,
        headless: true,
        args: [
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
        ],
      });
      return new FinalWebBrowserHarness(
        browser,
        proxy,
        `https://${selected.address}:${proxy.port}`,
        selected.interfaceName,
        path.basename(executablePath),
        tlsRoot,
        failureLookup,
        token,
      );
    } catch (error) {
      proxy.stop(true);
      rmSync(tlsRoot, { recursive: true, force: true });
      throw error;
    }
  }

  open(owner: BrowserOwner): Promise<BrowserSurfaceSession> {
    return BrowserSurfaceSession.open(this.#browser, this.lanEndpoint, owner, this.failureLookup, this.token);
  }

  async close(): Promise<void> {
    await this.#browser.close();
    await this.#proxy.stop(true);
    rmSync(this.#tlsRoot, { recursive: true, force: true });
  }
}
