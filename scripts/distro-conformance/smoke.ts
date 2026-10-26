import assert from "node:assert/strict";
import { pairForToken } from "../../tests/integration/helpers/harness.ts";
import { glyphProbeHtml, readGlyphProbe, maskDistance } from "../../tests/integration/helpers/portableBrowserGlyphs.ts";

async function until<T>(read: () => Promise<T | undefined>, label: string, timeout = 30_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await read();
    if (result !== undefined) return result;
    await Bun.sleep(150);
  }
  throw new Error(`Timed out: ${label}`);
}

/** The same public Service protocol runs against fixtures and every installed distribution. */
export async function exerciseService(base: string, state: string, realBrowser = true): Promise<void> {
  const token = await pairForToken(base, state, "distribution smoke");
  assert(token, "pairing must issue a device token");
  const request = async (route: string, body?: unknown): Promise<Response> => {
    const response = await fetch(`${base}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-command-id": crypto.randomUUID() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert(response.ok, `${route}: HTTP ${response.status}: ${response.ok ? "" : await response.text()}`);
    return response;
  };
  await until(async () => {
    const agents = await (await request("/api/agents")).json() as Array<{ id: string; status: string }>;
    return agents.some(agent => agent.id === "pi" && agent.status === "ready") ? true : undefined;
  }, "scripted Agent readiness");
  const bot = await (await request("/api/bots", { name: "Distribution smoke", instructions: "", agentId: "pi" })).json() as { id: string; surfaceId: string };
  const query = new URLSearchParams({ botId: bot.id, surfaceId: bot.surfaceId });
  const tool = async (directive: string): Promise<string> => {
    const turn = await (await request(`/api/bots/${bot.id}/messages`, { text: `computer:${directive}` })).json() as { threadId: string; turnId: string };
    await until(async () => {
      const thread = await (await request(`/api/threads/${turn.threadId}`)).json() as { activeTurn?: unknown };
      return thread.activeTurn === undefined ? true : undefined;
    }, directive, 600_000);
    const messages = await (await request(`/api/threads/${turn.threadId}/messages`)).json() as Array<{ text?: string; toolCall?: { id: string; status: string; errorSummary?: string } }>;
    const call = messages.find(message => message.toolCall?.id === `computer-${turn.turnId}`)?.toolCall;
    assert.equal(call?.status, "completed", `computer:${directive}: ${JSON.stringify(call)}`);
    return messages.slice(messages.findIndex(message => message.toolCall?.id === call!.id) + 1)
      .map(message => message.text ?? "").join("\n");
  };
  await tool("observe");
  const view = await (await request(`/api/computer/state?${query}`)).json() as { state: string };
  assert.equal(view.state, "ready");
  const capture = async (): Promise<Uint8Array> => {
    const bytes = new Uint8Array(await (await request(`/api/computer/snapshot?${query}`)).arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    return bytes;
  };
  await capture();
  let typed = "";
  let focused = false;
  const page = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/focused") { focused = true; return new Response("ok"); }
    if (url.pathname === "/typed") { typed = url.searchParams.get("text") ?? ""; return new Response("ok"); }
    return new Response(`${glyphProbeHtml()}<textarea autofocus style="position:absolute;left:0;top:150px;width:500px;height:300px" onfocus="fetch('/focused')" oninput="fetch('/typed?text='+encodeURIComponent(this.value))"></textarea><script>document.querySelector('textarea').focus()</script>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  } });
  try {
    await tool(`open_url:http://127.0.0.1:${page.port}/?label=DISTRO-SMOKE`);
    if (realBrowser) {
      await until(async () => (await tool("list_windows")).includes("DISTRO-SMOKE") ? true : undefined, "portable browser window", 90_000);
      const glyphs = await until(async () => {
        try { return await readGlyphProbe(await capture()); } catch { return undefined; }
      }, "portable CJK page pixels");
      const tofu = glyphs.cells.find(cell => cell.id === "tofu")!;
      for (const id of ["latin", "zh", "ja", "ko"]) {
        const glyph = glyphs.cells.find(cell => cell.id === id)!;
        assert(glyph.count > 800 && maskDistance(glyph, tofu) > 0.3, `${id} glyph must differ from tofu`);
      }
    }
    // The local page owns focus; waiting for its acknowledgement avoids typing into browser chrome.
    if (realBrowser) await until(async () => focused ? true : undefined, "browser editor focus");
    await tool("type:distribution smoke: 你好");
    if (realBrowser) await until(async () => typed === "distribution smoke: 你好" ? true : undefined, "typed text in browser");
  } finally { page.stop(true); }
  console.log("PASS install/serve/pair/screen/capture/open_url/type");
}

if (import.meta.main) {
  const base = `http://127.0.0.1:${process.env.OMARCHY_BOT_PORT}`;
  await until(async () => {
    try { return (await fetch(`${base}/api/health`)).ok ? true : undefined; } catch { return undefined; }
  }, "serve health");
  await exerciseService(base, process.env.OMARCHY_BOT_STATE!);
}
