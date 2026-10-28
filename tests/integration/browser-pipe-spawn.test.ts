import { expect, test } from "bun:test";
import { createConnection } from "node:net";
import { CdpPipe } from "../../apps/daemon/src/modules/computer/cdpPipe.ts";
import { spawnDetachedChild, terminateOwnedChild } from "../../apps/daemon/src/modules/computer/botScreenWaylandHelpers.ts";

test("owned browser child preserves NUL JSON command fd3 and response fd4", async () => {
  const child = spawnDetachedChild({
    argv: [process.execPath, "-e", `
      import { readSync, writeSync } from 'node:fs';
      const bytes=Buffer.alloc(4096); const length=readSync(3,bytes);
      const message=JSON.parse(bytes.subarray(0,length-1).toString());
      writeSync(4,JSON.stringify({id:message.id,result:{method:message.method}})+String.fromCharCode(0));
      process.on('SIGTERM', () => process.exit(0));
      await new Promise(() => {});
    `], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, output: "ignore", owned: true, browserPipe: true,
  });
  const pipe = new CdpPipe(createConnection({ fd: child.process.stdio[3]! }), createConnection({ fd: child.process.stdio[4]! }));
  try {
    expect(await pipe.request<{ method: string }>("Browser.getVersion", {}, undefined, { timeoutMs: 2_000 })).toEqual({ method: "Browser.getVersion" });
  } finally {
    pipe.close();
    await terminateOwnedChild(child);
  }
}, 10_000);
