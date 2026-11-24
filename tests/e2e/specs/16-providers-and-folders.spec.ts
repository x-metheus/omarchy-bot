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

test("Bot settings saves a model immediately and can restore the Service default", async ({ page, request, createdProviderIds }) => {
  const suffix = randomUUID();
  const providerName = `Bot Model Gateway ${suffix}`;
  const modelId = "example-model";
  const remoteModelId = "remote-model";
  const provider = await request.post("/api/providers", { data: {
    protocol: "openai-compatible",
    name: providerName,
    baseUrl: "http://127.0.0.1:9/v1",
    models: [modelId, remoteModelId],
    key: "fixture-bot-model-key",
  } });
  expect(provider.status()).toBe(201);
  const { id: providerId } = await provider.json() as { id: string };
  createdProviderIds.push(providerId);

  const botName = `Model Picker ${suffix}`;
  const openSettings = () => page.getByRole("button", { name: `Open settings for ${botName}`, exact: true }).click();
  const settings = page.getByRole("complementary", { name: "Bot settings" });
  const picker = settings.getByRole("combobox", { name: "Model", exact: true });
  const modelLabel = `${providerName} — ${modelId}`;
  const modelChoice = settings.getByRole("button", { name: modelLabel, exact: true });
  const remoteModelLabel = `${providerName} — ${remoteModelId}`;
  const remoteModelChoice = settings.getByRole("button", { name: remoteModelLabel, exact: true });
  const serviceDefault = settings.getByRole("button", { name: "Service default", exact: true });

  await page.goto("/");
  await page.getByRole("navigation", { name: "Bot navigation" }).getByRole("button", { name: "New bot" }).click();
  await page.getByRole("textbox", { name: /^Name\b/ }).fill(botName);
  await page.getByRole("radio", { name: /^Pi/ }).check();
  const [created] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/bots"),
    page.getByRole("button", { name: "Create bot", exact: true }).click(),
  ]);
  expect(created.status()).toBe(201);
  const { id: botId } = await created.json() as { id: string };
  const botPath = `/api/bots/${botId}`;

  async function searchFromSelectedModel(selectedLabel: string, query: string): Promise<void> {
    await settings.getByRole("button", { name: selectedLabel, exact: true }).click();
    await expect(picker).toHaveValue(selectedLabel);
    await picker.fill(query);
  }

  async function selectModel(label: string): Promise<void> {
    const [response] = await Promise.all([
      page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === botPath),
      page.getByRole("option", { name: label, exact: true }).click(),
    ]);
    expect(response.status()).toBe(200);
  }

  async function failModelChange(whilePending?: () => Promise<void>): Promise<void> {
    const patchHeld = Promise.withResolvers<void>();
    const releaseFailure = Promise.withResolvers<void>();
    let failedPatch: Promise<void> | undefined;
    const rejectModelChange: Parameters<Page["route"]>[1] = (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      failedPatch = releaseFailure.promise.then(() => route.fulfill({ status: 500, json: {} }));
      patchHeld.resolve();
      return failedPatch;
    };
    await page.route(`**${botPath}`, rejectModelChange);
    try {
      await searchFromSelectedModel(modelLabel, "Service default");
      await page.getByRole("option", { name: "Service default", exact: true }).click();
      await patchHeld.promise;
      await expect(serviceDefault).toBeVisible();
      await expect(serviceDefault).toBeDisabled();
      await whilePending?.();
      releaseFailure.resolve();
      await expect(settings.getByRole("alert")).toContainText("Model couldn’t be saved");
    } finally {
      releaseFailure.resolve();
      await failedPatch;
      await page.unroute(`**${botPath}`, rejectModelChange);
    }
  }

  try {
    await openSettings();
    const instructions = settings.getByRole("textbox", { name: "Job / Instructions", exact: true });
    await instructions.fill("An unsaved profile draft");
    await serviceDefault.click();
    await expect(picker).toHaveValue("Service default");
    await picker.fill(providerName);
    await selectModel(modelLabel);
    await expect(modelChoice).toBeVisible();
    await expect(settings.getByRole("alert")).toHaveCount(0);
    await expect(instructions).toHaveValue("An unsaved profile draft");

    await page.reload();
    await openSettings();
    await expect(modelChoice).toBeVisible();
    await expect(instructions).toHaveValue("");

    await failModelChange();
    await expect(settings.getByRole("alert")).toContainText("The previous model has been restored.");
    await expect(modelChoice).toBeVisible();

    const draftName = "An unsaved bot name";
    const remoteInstructions = "Updated in another window";
    const name = settings.getByRole("textbox", { name: /^Name\b/ });
    await failModelChange(async () => {
      await name.fill(draftName);
      const refreshed = await request.patch(botPath, { data: {
        instructions: remoteInstructions,
        showToolCalls: true,
        model: `${providerId}/${remoteModelId}`,
      } });
      expect(refreshed.status()).toBe(200);
      await expect(instructions).toHaveValue(remoteInstructions);
      await expect(name).toHaveValue(draftName);
    });
    await expect(remoteModelChoice).toBeVisible();
    await expect(modelChoice).toHaveCount(0);
    await expect(settings.getByRole("alert")).toContainText("The latest model has been kept.");
    await expect(settings.getByRole("switch", { name: "Show tool calls", exact: true })).toBeChecked();
    await expect(name).toHaveValue(draftName);

    await searchFromSelectedModel(remoteModelLabel, "Service default");
    await selectModel("Service default");
    await expect(serviceDefault).toBeVisible();
    await expect(settings.getByRole("alert")).toHaveCount(0);

    const saved = await request.get(botPath);
    expect(saved.status()).toBe(200);
    expect(await saved.json()).toMatchObject({ id: botId, model: null });

    const remoteUpdate = await request.patch(botPath, { data: { model: `${providerId}/${modelId}` } });
    expect(remoteUpdate.status()).toBe(200);
    await expect(modelChoice).toBeVisible();
  } finally {
    const removed = await request.delete(botPath, { data: {} });
    expect(removed.status()).toBe(200);
  }
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
