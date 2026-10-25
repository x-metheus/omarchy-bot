import { randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import {
  anchoredSessionCommand,
  sessionAnchor,
  settleOwnedSession,
  terminateOwnedSession,
  type OwnedSession,
} from "../../supervision/ownedProcesses.ts";
import {
  BotScreenInputRejectedError,
  type BotScreenCaptureStream,
  type BotScreenCaptureFrame,
  type BotScreenInputEvent,
  type BotScreenProvision,
} from "./botScreenManager.ts";

export type DetachedProcess = Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
type PointerProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;
type CaptureProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

const INPUT_RPC_TIMEOUT_MS = 1_000;
const CAPTURE_RPC_TIMEOUT_MS = 5_000;

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function executable(name: string | undefined, fallback: string): string | undefined {
  const candidate = name ?? fallback;
  if (candidate.includes("/")) return existsSync(candidate) ? candidate : undefined;
  return Bun.which(candidate) ?? undefined;
}

export async function command(argv: string[], env: Record<string, string>): Promise<CommandResult> {
  const child = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

async function terminateCapture(child: CaptureProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(1_000).then(() => false),
  ]);
  if (stopped) return;
  child.kill("SIGKILL");
  await child.exited;
}

export class WaylandVirtualInput {
  readonly exited: Promise<Error>;
  #responses: ProcessLineReader;
  #requestSequence = 0;
  #operations: Promise<void> = Promise.resolve();
  #stopped = false;
  #context: string;
  #terminalError: Error | undefined;

  private constructor(
    private readonly process: PointerProcess,
    generation: number,
    provision: BotScreenProvision,
  ) {
    this.#responses = new ProcessLineReader(
      process.stdout,
      "Bot Screen input helper closed its protocol stream",
    );
    this.#context = `${provision.surfaceId} ${generation} ${provision.geometryGeneration}`;
    this.exited = process.exited.then((status) => new Error(`Bot Screen input helper exited with status ${status}`));
  }

  get running(): boolean {
    return !this.#stopped && this.process.exitCode === null && this.#terminalError === undefined;
  }

  static async start(
    binary: string,
    outputName: string,
    launcherEnvironment: Record<string, string>,
    generation: number,
    provision: BotScreenProvision,
    commandPrefix: string[],
  ): Promise<WaylandVirtualInput> {
    const process = Bun.spawn([
      ...commandPrefix,
      binary,
      outputName,
      provision.surfaceId,
      String(generation),
      String(provision.geometryGeneration),
      String(provision.logicalWidth),
      String(provision.logicalHeight),
    ], {
      env: launcherEnvironment,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const input = new WaylandVirtualInput(process, generation, provision);
    const ready = await Promise.race([
      input.#responses.next(),
      process.exited.then(async (status) => {
        const stderr = await new Response(process.stderr).text();
        throw new Error(
          `Bot Screen input helper exited with status ${status}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`,
        );
      }),
      Bun.sleep(5_000).then(() => {
        throw new Error("Bot Screen input helper did not become ready");
      }),
    ]);
    if (ready !== "READY") {
      process.kill("SIGTERM");
      throw new Error("Bot Screen input helper returned an invalid readiness response");
    }
    return input;
  }

  setInputAuthority(controllerEpoch: number): Promise<void> {
    const requestSequence = ++this.#requestSequence;
    return this.#command(
      `authority ${requestSequence} ${this.#context} ${controllerEpoch}`,
      requestSequence,
    );
  }

  input(event: BotScreenInputEvent): Promise<void> {
    const requestSequence = ++this.#requestSequence;
    const envelope = `${event.surfaceId} ${event.runtimeGeneration} ${event.geometryGeneration} ${event.controllerEpoch} ${event.sequence}`;
    if (event.type === "motion") {
      return this.#command(`motion ${requestSequence} ${envelope} ${event.x} ${event.y}`, requestSequence);
    }
    if (event.type === "button") {
      const button = event.button === "left" ? 272 : event.button === "right" ? 273 : 274;
      return this.#command(
        `button ${requestSequence} ${envelope} ${event.x} ${event.y} ${button} ${
          event.state === "pressed" ? 1 : 0
        }`,
        requestSequence,
      );
    }
    if (event.type === "scroll") {
      return this.#command(
        `scroll ${requestSequence} ${envelope} ${event.x} ${event.y} ${event.deltaX} ${event.deltaY}`,
        requestSequence,
      );
    }
    if (event.type === "key") {
      return this.#command(
        `key ${requestSequence} ${envelope} ${event.keyCode} ${event.state === "pressed" ? 1 : 0}`,
        requestSequence,
      );
    }
    return this.#command(
      `paste ${requestSequence} ${envelope} ${Buffer.from(event.text, "utf8").toString("base64")}`,
      requestSequence,
    );
  }

  release(controllerEpoch?: number): Promise<void> {
    const requestSequence = ++this.#requestSequence;
    return this.#command(
      `release ${requestSequence} ${this.#context} ${controllerEpoch ?? 0}`,
      requestSequence,
    );
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    if (this.#terminalError === undefined) await this.release().catch(() => {});
    this.#stopped = true;
    this.process.stdin.end();
    const exited = await Promise.race([
      this.process.exited.then(() => true),
      Bun.sleep(1_000).then(() => false),
    ]);
    if (exited) return;
    this.process.kill("SIGTERM");
    const terminated = await Promise.race([
      this.process.exited.then(() => true),
      Bun.sleep(1_000).then(() => false),
    ]);
    if (terminated) return;
    this.process.kill("SIGKILL");
    await this.process.exited;
  }

  #command(line: string, requestSequence: number): Promise<void> {
    const operation = this.#operations.then(async () => {
      if (this.#terminalError !== undefined) throw this.#terminalError;
      if (this.#stopped || this.process.exitCode !== null) throw new Error("Bot Screen input helper is not running");
      let timeout: Timer | undefined;
      let response: string;
      try {
        const exchange = (async () => {
          this.process.stdin.write(`${line}\n`);
          await this.process.stdin.flush();
          return this.#responses.next();
        })();
        response = await Promise.race([
          exchange,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              const error = new Error("Bot Screen input helper RPC timed out");
              this.#terminalError = error;
              this.process.kill("SIGTERM");
              reject(error);
            }, INPUT_RPC_TIMEOUT_MS);
            timeout.unref?.();
          }),
        ]);
      } catch (cause) {
        const error = this.#terminalError
          ?? (cause instanceof Error ? cause : new Error(String(cause)));
        this.#terminalError = error;
        this.process.kill("SIGTERM");
        throw error;
      } finally {
        clearTimeout(timeout);
      }
      if (response === `OK ${requestSequence}`) return;
      const rejectionPrefix = `ERR ${requestSequence} `;
      if (response.startsWith(rejectionPrefix)) {
        throw new BotScreenInputRejectedError(response.slice(rejectionPrefix.length));
      }
      const error = new Error("Bot Screen input helper returned an invalid protocol response");
      this.#terminalError = error;
      this.process.kill("SIGTERM");
      throw error;
    });
    this.#operations = operation.catch(() => {});
    return operation;
  }
}

class CaptureProtocolReader {
  #chunks: Uint8Array[] = [];
  #decoder = new TextDecoder();
  #offset = 0;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async readLine(): Promise<string> {
    const bytes: number[] = [];
    for (;;) {
      const byte = await this.#readByte();
      if (byte === 0x0a) return this.#decoder.decode(Uint8Array.from(bytes));
      bytes.push(byte);
      if (bytes.length > 128) throw new Error("Bot Screen capture helper returned an oversized frame header");
    }
  }

  async readBytes(length: number): Promise<Uint8Array> {
    const bytes = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      await this.#ensureChunk();
      const chunk = this.#chunks[0]!;
      const available = chunk.byteLength - this.#offset;
      const count = Math.min(available, length - written);
      bytes.set(chunk.subarray(this.#offset, this.#offset + count), written);
      written += count;
      this.#offset += count;
      if (this.#offset === chunk.byteLength) {
        this.#chunks.shift();
        this.#offset = 0;
      }
    }
    return bytes;
  }

  async #readByte(): Promise<number> {
    await this.#ensureChunk();
    const chunk = this.#chunks[0]!;
    const byte = chunk[this.#offset]!;
    this.#offset += 1;
    if (this.#offset === chunk.byteLength) {
      this.#chunks.shift();
      this.#offset = 0;
    }
    return byte;
  }

  async #ensureChunk(): Promise<void> {
    while (this.#chunks.length === 0) {
      const chunk = await this.reader.read();
      if (chunk.done) throw new Error("Bot Screen capture helper closed its protocol stream");
      if (chunk.value.byteLength > 0) this.#chunks.push(chunk.value);
    }
  }
}

export class WaylandCaptureStream implements BotScreenCaptureStream {
  #captureInFlight = false;
  #stopped = false;
  #terminalError: Error | undefined;

  private constructor(
    private readonly process: CaptureProcess,
    private readonly protocol: CaptureProtocolReader,
    private readonly stderrOutput: Promise<string>,
    private readonly expectedWidth: number,
    private readonly expectedHeight: number,
  ) {}

  static async start(
    binary: string,
    outputName: string,
    environment: Record<string, string>,
    expectedWidth: number,
    expectedHeight: number,
    commandPrefix: readonly string[] = [],
  ): Promise<WaylandCaptureStream> {
    const process = Bun.spawn([...commandPrefix, binary, outputName], {
      env: environment,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const protocol = new CaptureProtocolReader(process.stdout.getReader());
    const stderrOutput = new Response(process.stderr).text();
    let ready: string;
    try {
      ready = await Promise.race([
        protocol.readLine(),
        process.exited.then(async (status) => {
          const stderr = await stderrOutput;
          throw new Error(
            `Bot Screen capture helper exited with status ${status}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`,
          );
        }),
        Bun.sleep(5_000).then(() => {
          throw new Error("Bot Screen capture helper did not become ready");
        }),
      ]);
    } catch (error) {
      await terminateCapture(process);
      throw error;
    }
    if (ready !== "READY") {
      await terminateCapture(process);
      throw new Error("Bot Screen capture helper returned an invalid readiness response");
    }
    return new WaylandCaptureStream(process, protocol, stderrOutput, expectedWidth, expectedHeight);
  }

  async next(): Promise<BotScreenCaptureFrame> {
    if (this.#terminalError !== undefined) throw this.#terminalError;
    if (this.#stopped || this.process.exitCode !== null) throw new Error("Bot Screen capture stream is closed");
    if (this.#captureInFlight) throw new Error("Bot Screen capture stream already has a pending frame");
    this.#captureInFlight = true;
    let timeout: Timer | undefined;
    try {
      const capture = (async () => {
        this.process.stdin.write("capture\n");
        await this.process.stdin.flush();
        const header = (await this.protocol.readLine()).split(" ");
        if (header.length !== 4 || header[0] !== "FRAME") {
          throw new Error("Bot Screen capture helper returned an invalid frame header");
        }
        const width = Number(header[1]);
        const height = Number(header[2]);
        const byteLength = Number(header[3]);
        if (
          width !== this.expectedWidth
          || height !== this.expectedHeight
          || !Number.isSafeInteger(byteLength)
          || byteLength !== width * height * 4
        ) {
          throw new Error("Bot Screen capture helper returned unexpected frame geometry");
        }
        const capturedAt = new Date();
        const raw = await this.protocol.readBytes(byteLength);
        return {
          pixelFormat: "rgba" as const,
          width,
          height,
          bytes: raw,
          capturedAt,
        };
      })();
      return await Promise.race([
        capture,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Bot Screen capture helper RPC timed out")), CAPTURE_RPC_TIMEOUT_MS);
          timeout.unref?.();
        }),
      ]);
    } catch (cause) {
      this.process.kill("SIGTERM");
      const stderr = await Promise.race([
        this.stderrOutput,
        Bun.sleep(100).then(() => ""),
      ]);
      const message = cause instanceof Error ? cause.message : String(cause);
      const error = new Error(`${message}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`);
      this.#terminalError = error;
      throw error;
    } finally {
      clearTimeout(timeout);
      this.#captureInFlight = false;
    }
  }

  async close(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.process.exitCode !== null) return;
    if (this.#terminalError === undefined) {
      try {
        this.process.stdin.write("close\n");
        await this.process.stdin.flush();
      } catch {
        // The capture helper may have exited while teardown was writing its final request.
      }
    }
    this.process.stdin.end();
    const exited = await Promise.race([
      this.process.exited.then(() => true),
      Bun.sleep(1_000).then(() => false),
    ]);
    if (exited) return;
    this.process.kill("SIGTERM");
    const terminated = await Promise.race([
      this.process.exited.then(() => true),
      Bun.sleep(1_000).then(() => false),
    ]);
    if (terminated) return;
    this.process.kill("SIGKILL");
    await this.process.exited;
  }
}

export function explicitEnvironment(input: {
  runtimeDir: string;
  waylandDisplay: string;
  homeDir?: string;
  configHome: string;
  dataHome?: string;
  stateHome: string;
  cacheHome: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    HOME: input.homeDir ?? process.env.HOME ?? path.dirname(input.configHome),
    LANG: process.env.LANG ?? "C.UTF-8",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "",
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    USER: process.env.USER ?? "",
    XDG_CACHE_HOME: input.cacheHome,
    XDG_CONFIG_HOME: input.configHome,
    ...(input.dataHome === undefined ? {} : { XDG_DATA_HOME: input.dataHome }),
    XDG_RUNTIME_DIR: input.runtimeDir,
    XDG_SESSION_TYPE: "wayland",
    XDG_STATE_HOME: input.stateHome,
    WAYLAND_DISPLAY: input.waylandDisplay,
    GDK_BACKEND: "wayland",
    MOZ_ENABLE_WAYLAND: "1",
    QT_QPA_PLATFORM: "wayland",
  };
  for (const key of ["OMARCHY_COMPUTER_BIN", "OMARCHY_BOT_COMPUTER_BIN"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Desktop-entry lookup must see the same data directories the Service does.
  if (process.env.XDG_DATA_DIRS !== undefined) env.XDG_DATA_DIRS = process.env.XDG_DATA_DIRS;
  return env;
}

export function isSocket(candidate: string): boolean {
  try {
    return lstatSync(candidate).isSocket();
  } catch {
    return false;
  }
}

export class ProcessLineReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #decoder = new TextDecoder();
  #buffer = "";

  constructor(
    stream: ReadableStream<Uint8Array>,
    private readonly eofMessage = "Bot Desktop closed its readiness stream",
  ) {
    this.#reader = stream.getReader();
  }

  async next(): Promise<string> {
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline >= 0) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        return line;
      }
      const chunk = await this.#reader.read();
      if (chunk.done) throw new Error(this.eofMessage);
      this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
    }
  }
}

/** Waits until a child binds its private socket, failing fast if it exits first. */
export async function waitForSocket(
  socketPath: string,
  child: DetachedProcess,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (isSocket(socketPath)) return;
    if (child.exitCode !== null) {
      throw new Error(`${label} exited before binding its private socket with status ${child.exitCode}`);
    }
    await Bun.sleep(20);
  }
  throw new Error(`${label} did not create its private socket`);
}

/** One detached child plus, when the Service owns it, the session that proves its descendants. */
export interface OwnedChild {
  process: DetachedProcess;
  session?: OwnedSession;
}

/**
 * Spawns one detached child. Without a user manager (`owned`) it leads an
 * anchored session, so teardown still finds its descendants after its leader
 * exits and even when they scrubbed their environment. With a transient unit the
 * unit's cgroup owns the group, so the spawn stays exactly as before.
 */
export function spawnDetachedChild(input: {
  argv: readonly string[];
  env: Record<string, string>;
  cwd?: string;
  output: "pipe" | "ignore";
  owned: boolean;
}): OwnedChild {
  const token = randomUUID();
  const process = Bun.spawn(
    input.owned ? anchoredSessionCommand(input.argv, token) : [...input.argv],
    {
      env: input.env,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      stdin: "ignore",
      stdout: input.output,
      stderr: input.output,
      detached: true,
    },
  );
  return {
    process,
    ...(input.owned ? { session: { sessionId: process.pid, anchor: sessionAnchor(token) } } : {}),
  };
}

/** Stops an owned child's whole session, including TERM-resistant descendants. */
export async function terminateOwnedChild(child: OwnedChild | undefined): Promise<void> {
  if (child === undefined) return;
  if (child.session === undefined) {
    // A transient unit owns the group through its cgroup; stop the leader and
    // let the unit's KillMode=control-group clean the rest.
    if (child.process.exitCode !== null || child.process.signalCode !== null) return;
    try {
      child.process.kill("SIGTERM");
    } catch {
      return;
    }
    const stopped = await Promise.race([
      child.process.exited.then(() => true),
      Bun.sleep(3_000).then(() => false),
    ]);
    if (stopped) return;
    child.process.kill("SIGKILL");
    await child.process.exited;
    return;
  }
  await terminateOwnedSession(child.session);
  // A session whose marker is missing cannot be proven and was not signalled;
  // stop the process group the detached leader still leads.
  if (child.process.exitCode === null && child.process.signalCode === null) {
    await terminateLeaderGroup(child.process.pid, child.process.exited);
  }
  await child.process.exited;
}

async function terminateLeaderGroup(pid: number, exited: Promise<number>): Promise<void> {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  const stopped = await Promise.race([
    exited.then(() => true),
    Bun.sleep(3_000).then(() => false),
  ]);
  if (stopped) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** Releases a session anchor once the leader and every descendant have exited. */
export function settleOwnedChild(child: OwnedChild | undefined): boolean {
  return child === undefined || child.session === undefined || settleOwnedSession(child.session);
}
