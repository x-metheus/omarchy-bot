import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { CdpPipe } from "../../apps/daemon/src/modules/computer/cdpPipe.ts";
import { spawnDetachedChild, terminateOwnedChild } from "../../apps/daemon/src/modules/computer/botScreenWaylandHelpers.ts";
import {
  sessionMembers,
  type OwnedSession,
} from "../../apps/daemon/src/supervision/ownedProcesses.ts";

const FAKE_PACK = `
  import { readSync, writeSync } from 'node:fs';
  const bytes=Buffer.alloc(4096); const length=readSync(3,bytes);
  const message=JSON.parse(bytes.subarray(0,length-1).toString());
  writeSync(4,JSON.stringify({id:message.id,result:{method:message.method}})+String.fromCharCode(0));
  process.on('SIGTERM', () => process.exit(0));
  await new Promise(() => {});
`;

test("owned browser child preserves NUL JSON command fd3 and response fd4", async () => {
  const child = spawnDetachedChild({
    argv: [process.execPath, "-e", FAKE_PACK], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, output: "ignore", owned: true, browserPipe: true,
  });
  const pipe = new CdpPipe(createConnection({ fd: child.process.stdio[3]! }), createConnection({ fd: child.process.stdio[4]! }));
  try {
    expect(await pipe.request<{ method: string }>("Browser.getVersion", {}, undefined, { timeoutMs: 2_000 })).toEqual({ method: "Browser.getVersion" });
  } finally {
    pipe.close();
    await terminateOwnedChild(child);
  }
}, 10_000);

/**
 * The marker past its own `exec`, told apart from the session's shell and from
 * its `sleep`: only the marker's final image is `/bin/sh`, `-c`, one script.
 */
async function anchorMarkerPid(session: OwnedSession, timeoutMs = 10_000): Promise<number> {
  const entry = `${session.anchor.name}=${session.anchor.value}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const member of sessionMembers(session.sessionId)) {
      let environment: string[];
      let argv: string[];
      try {
        environment = readFileSync(`/proc/${member.pid}/environ`, "utf8").split("\0");
        argv = readFileSync(`/proc/${member.pid}/cmdline`, "utf8").split("\0");
      } catch {
        continue;
      }
      if (!environment.includes(entry)) continue;
      if (argv.length === 4 && argv[0] === "/bin/sh" && argv[1] === "-c") return member.pid;
    }
    await Bun.sleep(20);
  }
  throw new Error("the owned session started no anchor marker");
}

test("the session anchor marker inherits no descriptor above stderr, so CDP pipe EOF is observable", async () => {
  const child = spawnDetachedChild({
    argv: [process.execPath, "-e", FAKE_PACK], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, output: "ignore", owned: true, browserPipe: true,
  });
  try {
    expect(child.session).toBeDefined();
    const marker = await anchorMarkerPid(child.session!);
    // The marker keeps the session id reserved for the whole launch, so a CDP
    // pipe descriptor inherited here would hold the pipe open after the browser exits.
    expect(readdirSync(`/proc/${marker}/fd`).filter((descriptor) => Number(descriptor) > 2)).toEqual([]);
  } finally {
    await terminateOwnedChild(child);
  }
}, 20_000);

test("a captured stderr keeps only its bounded tail and leaves stdout ignored", async () => {
  const child = spawnDetachedChild({
    argv: [process.execPath, "-e", `
      import { writeSync } from 'node:fs';
      for (let index = 0; index < 512; index += 1) writeSync(2, 'noise-' + String(index).padStart(4, '0') + '\\n');
      writeSync(1, 'stdout is not the pack tail\\n');
      await new Promise(() => {});
    `],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, output: "ignore", captureStderr: true, owned: true, browserPipe: true,
  });
  try {
    const tail = child.stderrTail;
    expect(tail).toBeDefined();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !tail!.text().includes("noise-0511")) await Bun.sleep(20);
    // 512 numbered lines is more than the buffer holds: only the last part survives.
    expect(tail!.text().endsWith("noise-0511\n")).toBeTrue();
    expect(Buffer.byteLength(tail!.text())).toBeLessThanOrEqual(4 * 1024);
    expect(tail!.text()).not.toContain("noise-0000");
    // Only stderr is captured: the child's stdout went to `output`, which ignores it.
    expect(tail!.text()).not.toContain("stdout is not the pack tail");
  } finally {
    await terminateOwnedChild(child);
  }
}, 20_000);
