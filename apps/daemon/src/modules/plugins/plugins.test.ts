import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentPluginToolOutput } from "@omarchy-bot/agent-contract";
import type { CatalogSkillDetailDto } from "@omarchy-bot/protocol";
import { PluginsService } from "./plugins.ts";

async function withPlugins<T>(use: (service: PluginsService, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "plugin-manage-"));
  const service = new PluginsService(path.join(root, "plugins"), path.join(root, "workspace"), () => ({ skills: [] }));
  try { return await use(service, root); }
  finally {
    await service.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}

test("PluginsService.callManage and lease.call dispatch the same authorization with tool-specific pending status", () => withPlugins(async (service) => {
  const authorize = spyOn(service, "authorize").mockResolvedValue({ url: "https://authorize.invalid" });
  const lease = await service.acquire();
  const args = { action: "authorize_service", providerId: "google", id: "account-example" };
  const signal = new AbortController().signal;
  try {
    const expected: AgentPluginToolOutput = { content: [{ type: "text", text: '{"url":"https://authorize.invalid","pendingAuthorization":true}' }] };
    expect(await service.callManage("manage_plugins", args, signal)).toEqual(expected);
    expect(await lease.call("manage_plugins", args, signal)).toEqual(expected);
    expect(authorize.mock.calls).toEqual([
      [{ providerId: "google", accountId: "account-example" }, undefined],
      [{ providerId: "google", accountId: "account-example" }, undefined],
    ]);
    await expect(lease.call("mcp", args, signal)).rejects.toThrow("Plugin management tool does not belong to this turn");
    lease.release();
    await expect(lease.call("manage_plugins", args, signal)).rejects.toThrow("Plugin turn snapshot was released");
  } finally { lease.release(); authorize.mockRestore(); }
}));

test("PluginsService.callManage forwards the signal and keeps connection credentials out of the result", () => withPlugins(async (service) => {
  const save = spyOn(service, "saveMcp");
  const connection = {
    name: "demo",
    transport: { type: "http", url: "https://mcp.invalid", headers: { Authorization: "Bearer secret-token" } },
  };
  const args = { action: "save_mcp", connection };
  const signal = new AbortController().signal;
  try {
    const result = await service.callManage("manage_plugins", args, signal);
    expect(save).toHaveBeenCalledWith(null, { ...connection, enabled: true }, signal);
    expect(save.mock.calls[0]?.[2]).toBe(signal);
    expect(result.content).toMatchObject([{ type: "text", text: expect.stringContaining('"name":"demo"') }]);
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(service.mcp.list()).toMatchObject([{ name: "demo" }]);
    await expect(service.callManage("manage_plugins", args, AbortSignal.abort(new Error("already cancelled")))).rejects.toThrow("already cancelled");
    expect(save).toHaveBeenCalledTimes(1);
  } finally { save.mockRestore(); }
}));

test("PluginsService.callManage spills only above the 2 MiB encoded output limit", () => withPlugins(async (service, root) => {
  const info: CatalogSkillDetailDto = {
    id: "catalog.invalid/example", name: "example", description: "Example", source: "catalog.invalid",
    sourceType: "well-known", installUrl: "https://catalog.invalid", content: "", url: "https://skills.sh/catalog.invalid/example",
  };
  const detail = spyOn(service, "detail").mockImplementation(async () => info);
  const args = { action: "inspect_skill", id: info.id };
  const signal = new AbortController().signal;
  const directory = path.join(root, "plugins", "results");
  function expectedOutput(): AgentPluginToolOutput {
    return { content: [{ type: "text", text: JSON.stringify(info) }] };
  }
  try {
    const limit = 2 * 1024 * 1024;
    info.content = "x".repeat(limit - Buffer.byteLength(JSON.stringify(expectedOutput())));
    expect(await service.callManage("manage_plugins", args, signal)).toEqual(expectedOutput());
    await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });

    info.content += "x";
    const spilled = await service.callManage("manage_plugins", args, signal);
    const names = await readdir(directory);
    expect(names).toHaveLength(1);
    const file = path.join(directory, names[0]!);
    expect(spilled).toEqual({ content: [{ type: "text", text: `Full plugin output saved to ${file}; ${limit + 1} bytes. Read this file for the complete result.` }] });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(expectedOutput());
  } finally { detail.mockRestore(); }
}));
