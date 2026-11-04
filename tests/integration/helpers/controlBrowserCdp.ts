import { appendFileSync, readFileSync, writeSync, createReadStream } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { updateFakeSwayTree } from "./fakeSwayIpc.ts";

/** Offline Chromium pipe for the control fixture's shared browser process. */
export function serveControlBrowserCdp(treePath: string): void {
  const eventsPath = path.join(path.dirname(treePath), "events.jsonl");
  type Node = { id: number; pid?: number; app_id?: string; name?: string; nodes?: Node[]; floating_nodes?: Node[] };
  const nodes = (node: Node): Node[] => [node, ...(node.nodes ?? []).flatMap(nodes), ...(node.floating_nodes ?? []).flatMap(nodes)];
  const pages = new Map<string, number>();
  let discovering = false;
  const reply = (message: unknown) => writeSync(4, JSON.stringify(message) + "\0");
  const info = (targetId: string, node: Node) => ({ targetId, type: "page", title: node.name ?? "", url: "about:blank" });
  const scan = () => {
    const tree = JSON.parse(readFileSync(treePath, "utf8")) as Node;
    for (const node of nodes(tree)) {
      if (node.app_id !== "chromium" || node.pid !== process.pid) continue;
      const targetId = `control-page-${node.id}`;
      if (pages.has(targetId)) continue;
      pages.set(targetId, node.id);
      appendFileSync(eventsPath, JSON.stringify({ change: "new", container: node }) + "\n");
      if (discovering) reply({ method: "Target.targetCreated", params: { targetInfo: info(targetId, node) } });
    }
    return tree;
  };
  const timer = setInterval(scan, 10);
  let pending = "";
  createReadStream("", { fd: 3, autoClose: false }).on("data", chunk => {
    pending += chunk.toString();
    while (true) {
      const end = pending.indexOf("\0");
      if (end < 0) break;
      const command = JSON.parse(pending.slice(0, end)) as { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };
      pending = pending.slice(end + 1);
      const params = command.params ?? {};
      try {
        const tree = scan();
        const windows = nodes(tree);
        const targetId = command.sessionId?.replace(/^session-/, "");
        const node = windows.find(node => node.id === pages.get(targetId ?? ""));
        let result: unknown = {};
        switch (command.method) {
          case "Target.setDiscoverTargets":
            discovering = true;
            for (const [id, nativeId] of pages) {
              const window = windows.find(node => node.id === nativeId);
              if (window) reply({ method: "Target.targetCreated", params: { targetInfo: info(id, window) } });
            }
            break;
          case "Target.getTargets": result = { targetInfos: [...pages].flatMap(([id, nativeId]) => {
            const window = windows.find(node => node.id === nativeId);
            return window ? [info(id, window)] : [];
          }) }; break;
          case "SystemInfo.getProcessInfo": result = { processInfo: [{ type: "browser", id: process.pid }] }; break;
          case "Browser.getWindowForTarget": {
            const nativeId = pages.get(String(params.targetId));
            if (nativeId === undefined) throw new Error("Target gone");
            result = { windowId: nativeId + 1000 }; break;
          }
          case "Target.attachToTarget": result = { sessionId: `session-${params.targetId}` }; break;
          case "Page.getFrameTree": result = { frameTree: { frame: { id: "main" } } }; break;
          case "Page.createIsolatedWorld": result = { executionContextId: 1 }; break;
          case "Runtime.evaluate": {
            if (!node) throw new Error("Target gone");
            let value: unknown;
            updateFakeSwayTree(path.dirname(treePath), latest => {
              const current = nodes(latest as Node).find(current => current.id === node.id);
              if (!current) throw new Error("Target gone");
              const document = {
                get title() { return current.name ?? ""; },
                set title(title: string) { current.name = title; },
                visibilityState: "visible",
              };
              value = runInNewContext(String(params.expression), { document });
              appendFileSync(eventsPath, JSON.stringify({ change: "title", container: current }) + "\n");
              return latest;
            });
            result = { result: { value } }; break;
          }
        }
        reply({ id: command.id, result });
      } catch (error) { reply({ id: command.id, error: { message: String(error) } }); }
    }
  }).on("end", () => { clearInterval(timer); process.exit(0); }).on("error", () => { clearInterval(timer); process.exit(0); });
}
