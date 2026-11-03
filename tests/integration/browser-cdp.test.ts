import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { CdpPipe, CdpReplyTooLargeError } from "../../apps/daemon/src/modules/computer/cdpPipe.ts";

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

test("an oversized reply fails only its own request with an actionable message and keeps the pipe open", async () => {
  const commands = new PassThrough();
  const replies = new PassThrough();
  const cdp = new CdpPipe(commands, replies);
  try {
    const before = cdp.request<{ ok: number }>("Target.getTargets");
    const huge = cdp.request("Accessibility.getChildAXNodes", { id: "1" }, "page");
    const after = cdp.request<{ ok: number }>("Page.getFrameTree", {}, "page");
    const hugeResult = huge.then(() => undefined, (error: unknown) => error);
    const payload = Buffer.from(`{"id":2,"result":{"nodes":[${'{"nodeId":"x"},'.repeat(700_000)}{"nodeId":"y"}]}}`);
    expect(payload.length).toBeGreaterThan(8 * 1024 * 1024);
    // Split the oversized frame across chunks and coalesce its neighbours into the first and last chunk.
    const third = Math.floor(payload.length / 3);
    replies.write(Buffer.concat([Buffer.from('{"id":1,"result":{"ok":1}}\0'), payload.subarray(0, third)]));
    replies.write(payload.subarray(third, 2 * third));
    replies.write(Buffer.concat([payload.subarray(2 * third), Buffer.from('\0{"id":3,"result":{"ok":3}}\0')]));
    const error = await hugeResult;
    expect(error).toBeInstanceOf(CdpReplyTooLargeError);
    expect((error as Error).message).toBe("page too large for a snapshot; narrow with read_text/wait_for or take a smaller snapshot");
    expect(await before).toEqual({ ok: 1 });
    expect(await after).toEqual({ ok: 3 });
    expect(cdp.alive).toBe(true);
    const next = cdp.request<{ ok: number }>("Target.getTargets");
    replies.write('{"id":4,"result":{"ok":4}}\0');
    expect(await next).toEqual({ ok: 4 });
  } finally { cdp.close(); }
});

test("oversized events and late oversized replies are dropped without closing the pipe", async () => {
  const commands = new PassThrough();
  const replies = new PassThrough();
  const cdp = new CdpPipe(commands, replies, { maxFrameBytes: 1024, hardFrameBytes: 64 * 1024 });
  const events: string[] = [];
  cdp.onEvent((method) => events.push(method));
  try {
    await expect(cdp.request("Target.getTargets", {}, undefined, { timeoutMs: 2 })).rejects.toThrow("timed out");
    const pending = cdp.request<{ ok: boolean }>("Runtime.evaluate", { expression: "1" }, "page");
    replies.write(`{"id":1,"result":{"late":"${"x".repeat(4096)}"}}\0`);
    replies.write(`{"method":"Accessibility.nodesUpdated","params":{"nodes":"${"x".repeat(4096)}"}}\0`);
    replies.write('{"method":"Page.loadEventFired","params":{}}\0{"id":2,"result":{"ok":true}}\0');
    expect(await pending).toEqual({ ok: true });
    expect(events).toEqual(["Page.loadEventFired"]);
    const big = cdp.request("Runtime.evaluate", { expression: "big" }, "page");
    replies.write(`{"id":3,"result":{"result":{"value":"${"x".repeat(4096)}"}}}\0`);
    await expect(big).rejects.toThrow("browser reply to Runtime.evaluate too large; narrow with read_text/wait_for or take a smaller snapshot");
    expect(cdp.alive).toBe(true);
  } finally { cdp.close(); }
});

for (const failure of ["hard limit", "unroutable"] as const) {
  test(`an oversized ${failure} frame still closes the pipe`, async () => {
    const commands = new PassThrough();
    const replies = new PassThrough();
    const cdp = new CdpPipe(commands, replies, { maxFrameBytes: 1024, hardFrameBytes: 64 * 1024 });
    const first = cdp.request("Target.getTargets");
    const second = cdp.request("Page.enable", {}, "page");
    const results = Promise.allSettled([first, second]);
    if (failure === "hard limit") {
      replies.write('{"id":1,"result":{"value":"');
      for (let i = 0; i < 80 && cdp.alive; i++) replies.write("x".repeat(1024));
    } else replies.write(`{"result":{"value":"${"x".repeat(4096)}"}}\0`);
    const settled = await results;
    expect(settled.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(String((settled[1] as PromiseRejectedResult).reason)).toContain(failure === "hard limit" ? "hard byte limit" : "exceeds byte limit");
    expect(cdp.alive).toBe(false);
    await expect(cdp.request("Target.getTargets")).rejects.toThrow();
  });
}
