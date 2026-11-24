import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test as base, type Locator, type Page } from "../fixtures.ts";

const test = base.extend<{ createdProviderIds: string[] }>({
  createdProviderIds: async ({ request }, use) => {
    const ids: string[] = [];
    try {
      await use(ids);
    } finally {
      for (const id of ids) {
        const response = await request.delete(`/api/providers/${encodeURIComponent(id)}`);
        expect([204, 404]).toContain(response.status());
      }
    }
  },
});

async function saveNewProvider(page: Page, editor: Locator, createdProviderIds: string[]): Promise<string> {
  const [response] = await Promise.all([
    page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/providers"),
    editor.getByRole("button", { name: "Save", exact: true }).click(),
  ]);
  expect(response.status()).toBe(201);
  const { id } = await response.json() as { id: string };
  createdProviderIds.push(id);
  return id;
}

async function openSettingsSection(page: Page, name: string): Promise<Locator> {
  await page.getByRole("navigation", { name: "Bot navigation" })
    .getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name, exact: true }).click();
  return settings;
}

test("a custom provider persists and can be renamed without reentering its key", async ({ page, createdProviderIds }) => {
  const key = "fixture-key-123";
  const name = `Example Gateway ${randomUUID()}`;
  const renamed = `${name} Renamed`;
  await page.goto("/");
  const settings = await openSettingsSection(page, "Providers");
  const providers = settings.getByTestId("settings-providers");
  const editor = providers.getByRole("form", { name: "Add provider", exact: true });

  await providers.getByRole("button", { name: "Add provider", exact: true }).click();
  const protocol = editor.getByRole("radio", { name: "OpenAI-compatible", exact: true });
  await expect(protocol).toBeFocused();
  await expect(protocol).toBeChecked();
  await editor.getByRole("textbox", { name: "Name Required", exact: true }).fill(name);
  await editor.getByRole("textbox", { name: "Base URL Required", exact: true }).fill("http://127.0.0.1:9/v1");
  await editor.getByLabel(/^API Key\b/).fill(key);
  await editor.getByRole("textbox", { name: "Models Optional", exact: true }).fill("example-model");
  const id = await saveNewProvider(page, editor, createdProviderIds);
  const row = providers.getByTestId(`settings-provider-${id}`);

  await expect(row).toContainText(name);
  await expect(row).toContainText("OpenAI-compatible · 1 model · Key saved");
  await expect(row).toContainText("http://127.0.0.1:9/v1");
  await expect(editor).toHaveCount(0);
  expect(await page.content()).not.toContain(key);

  await page.reload();
  await openSettingsSection(page, "Providers");
  await expect(row).toContainText(name);
  await expect(row).toContainText("Key saved");
  expect(await page.content()).not.toContain(key);

  await row.getByRole("button", { name: `Edit ${name}`, exact: true }).click();
  const edit = providers.getByRole("form", { name: "Edit provider", exact: true });
  await expect(edit.getByText("Leave blank to keep the saved key", { exact: true })).toBeVisible();
  await expect(edit.getByLabel(/^API Key\b/)).toHaveValue("");
  expect(await page.content()).not.toContain(key);

  await edit.getByRole("textbox", { name: "Name Required", exact: true }).fill(renamed);
  const [update] = await Promise.all([
    page.waitForRequest((request) =>
      request.method() === "PUT" && new URL(request.url()).pathname === `/api/providers/${encodeURIComponent(id)}`),
    edit.getByRole("button", { name: "Save", exact: true }).click(),
  ]);
  const body: unknown = update.postDataJSON();
  expect(body).toMatchObject({ name: renamed });
  expect(body).not.toHaveProperty("key");
  await expect(row).toContainText(renamed);
  await expect(row).toContainText("Key saved");
  await expect(edit).toHaveCount(0);
  expect(await page.content()).not.toContain(key);

  const remove = row.getByRole("button", { name: `Remove ${renamed}`, exact: true });
  const confirmation = providers.getByRole("heading", { name: `Remove ${renamed}?`, exact: true });
  const cancel = providers.getByRole("button", { name: "Cancel", exact: true });
  await remove.click();
  await expect(confirmation).toBeVisible();
  await expect(cancel).toBeFocused();
  await cancel.press("Enter");
  await expect(confirmation).toHaveCount(0);
  await expect(remove).toBeFocused();

  await remove.press("Enter");
  await expect(confirmation).toBeVisible();
  await providers.getByRole("button", { name: "Confirm removal", exact: true }).click();
  await expect(row).toHaveCount(0);
});

test("a built-in provider uses the searchable catalog and a key-only form", async ({ page, createdProviderIds }) => {
  const key = "fixture-builtin-key";
  await page.goto("/");
  const settings = await openSettingsSection(page, "Providers");
  const providers = settings.getByTestId("settings-providers");
  await providers.getByRole("button", { name: "Add provider", exact: true }).click();
  const editor = providers.getByRole("form", { name: "Add provider", exact: true });
  await editor.getByRole("radio", { name: "Built-in pi-ai", exact: true }).check();

  const picker = editor.getByRole("combobox", { name: /^Built-in provider\b/ });
  await picker.fill("openai");
  await picker.press("ArrowDown");
  await page.getByRole("option", { name: "OpenAI", exact: true }).click();
  await expect(editor.getByRole("textbox", { name: /^Base URL\b/ })).toHaveCount(0);
  await expect(editor.getByRole("textbox", { name: /^Models\b/ })).toHaveCount(0);
  await editor.getByLabel(/^API Key\b/).fill(key);
  expect(await saveNewProvider(page, editor, createdProviderIds)).toBe("openai");

  const row = providers.getByTestId("settings-provider-openai");
  await expect(row).toContainText("Built-in pi-ai");
  await expect(row).toContainText("Key saved");
  await expect(editor).toHaveCount(0);
  expect(await page.content()).not.toContain(key);

  await row.getByRole("button", { name: "Edit OpenAI", exact: true }).click();
  const edit = providers.getByRole("form", { name: "Edit provider", exact: true });
  await expect(edit.getByRole("combobox")).toHaveCount(0);
  await expect(edit.getByRole("radiogroup")).toHaveCount(0);
  await expect(edit.getByLabel(/^API Key\b/)).toHaveValue("");
  expect(await page.content()).not.toContain(key);
});

test("an absolute folder can be added to and removed from Settings", async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), "omarchy-bot-e2e-allowed-"));
  try {
    await page.goto("/");
    const settings = await openSettingsSection(page, "Allowed folders");
    const folders = settings.getByTestId("settings-allowed-folders");
    const row = folders.getByTestId("settings-allowed-folder").filter({ hasText: directory });
    const path = folders.getByRole("textbox", { name: "Folder path Required", exact: true });
    const add = folders.getByRole("button", { name: "Add", exact: true });

    await expect(folders.getByText("Shared Workspace and Downloads are always allowed.", { exact: true })).toBeVisible();
    await path.fill("relative/folder");
    await add.click();
    await expect(folders.getByText("Enter an absolute folder path.", { exact: true })).toBeVisible();
    await expect(path).toBeFocused();
    await path.fill(directory);
    await add.click();
    await expect(row).toContainText(directory);
    await row.getByRole("button", { name: `Remove ${directory}`, exact: true }).click();
    await expect(row).toHaveCount(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
