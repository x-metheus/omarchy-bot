import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ownedProcessIdentity,
  ownedProcessRunning,
  privateRuntimeProcesses,
  terminateOwnedProcess,
  watchOwnedProcess,
} from "./ownedProcesses.ts";

test.skipIf(process.platform !== "linux")("owned processes leave the runtime inventory after termination and natural exit", async () => {
  const runtimeDir = path.join(tmpdir(), `owned-process-${crypto.randomUUID()}`);
  const spawnChild = () => Bun.spawn([process.execPath, "-e", "await new Response(Bun.stdin.stream()).text()"], {
    env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir },
    stdin: "pipe",
  });

  const stopped = spawnChild();
  const exited = spawnChild();
  try {
    const stoppedIdentity = ownedProcessIdentity(stopped.pid, runtimeDir);
    const exitedIdentity = ownedProcessIdentity(exited.pid, runtimeDir);
    expect(ownedProcessRunning(stoppedIdentity)).toBeTrue();
    expect(ownedProcessRunning(exitedIdentity)).toBeTrue();

    await terminateOwnedProcess(stoppedIdentity);
    await stopped.exited;
    expect(privateRuntimeProcesses(runtimeDir).map((identity) => identity.pid)).toEqual([exited.pid]);

    const exit = watchOwnedProcess(exitedIdentity);
    exited.stdin.end();
    expect(await exited.exited).toBe(0);
    await exit;
    expect(privateRuntimeProcesses(runtimeDir)).toEqual([]);
  } finally {
    stopped.kill();
    exited.kill();
    await Promise.all([stopped.exited, exited.exited]);
  }
});
