import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { CdpPipe } from "../../apps/daemon/src/modules/computer/cdpPipe.ts";

test("pipe correlates requests across split UTF8 and coalesced NUL frames", async () => {
  const commands = new PassThrough();
  const replies = new PassThrough();
  const cdp = new CdpPipe(commands, replies);
  const events: string[] = [];
  cdp.onEvent((method) => events.push(method));
  const first = cdp.request<{ text: string }>("Target.getTargets");
  const second = cdp.request("Page.enable", {}, "page");
  const bytes = Buffer.from('{"id":1,"result":{"text":"é猫"}}\0{"method":"Page.loadEventFired","params":{},"sessionId":"page"}\0{"id":2,"result":{}}\0');
  const split = bytes.indexOf(Buffer.from("猫")) + 1;
  replies.write(bytes.subarray(0, split));
  replies.write(bytes.subarray(split));
  expect(await first).toEqual({ text: "é猫" });
  expect(await second).toEqual({});
  expect(events).toEqual(["Page.loadEventFired"]);
  await expect(cdp.request("Runtime.enable")).rejects.toThrow("Runtime.enable");
  cdp.close();
});

test("deadline and abort clean up requests while late replies leave the pipe usable", async () => {
  const commands = new PassThrough();
  const replies = new PassThrough();
  const cdp = new CdpPipe(commands, replies);
  try {
    await expect(cdp.request("Target.getTargets", {}, undefined, { timeoutMs: 2 })).rejects.toThrow("timed out");
    const abort = new AbortController();
    const pending = cdp.request("Target.getTargets", {}, undefined, { signal: abort.signal });
    abort.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    replies.write('{"id":1,"result":{}}\0{"id":2,"result":{}}\0');
    const next = cdp.request("Target.getTargets");
    replies.write('{"id":3,"result":{"ok":true}}\0');
    expect(await next).toEqual({ ok: true });
    const already = new AbortController();
    already.abort();
    await expect(cdp.request("Target.getTargets", {}, undefined, { signal: already.signal })).rejects.toThrow();
  } finally { cdp.close(); }
});

for (const failure of ["eof", "error", "close", "oversize", "utf8", "json"] as const) {
  test(`pipe ${failure} rejects every pending request and future requests`, async () => {
    const commands = new PassThrough();
    const replies = new PassThrough();
    const cdp = new CdpPipe(commands, replies);
    const first = cdp.request("Target.getTargets");
    const second = cdp.request("Page.enable", {}, "page");
    const results = Promise.allSettled([first, second]);
    if (failure === "eof") replies.end();
    else if (failure === "error") commands.destroy(new Error("broken pipe"));
    else if (failure === "close") cdp.close();
    else if (failure === "oversize") replies.write(Buffer.alloc(8 * 1024 * 1024 + 1, 65));
    else if (failure === "utf8") replies.write(Buffer.from([0xff, 0]));
    else replies.write("invalid\0");
    expect((await results).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(cdp.alive).toBe(false);
    await expect(cdp.request("Target.getTargets")).rejects.toThrow();
    cdp.close();
  });
}
