import { test, expect, type Page } from "../fixtures.ts";
import type { LocalApproval, LocalApprovalDecision } from "../../../apps/web/src/lib/shell.ts";

declare global {
  var __localApprovalDecisions__: Record<string, Promise<LocalApprovalDecision>>;
}

async function receiveApproval(page: Page, approval: LocalApproval): Promise<void> {
  await page.evaluate(approval => {
    globalThis.__localApprovalDecisions__ ??= {};
    globalThis.__localApprovalDecisions__[approval.jobId] = globalThis.__OMARCHY_BOT_MEMORY_SHELL__!.receiveApproval(approval);
  }, approval);
}

async function decision(page: Page, jobId: string): Promise<LocalApprovalDecision> {
  return page.evaluate(jobId => globalThis.__localApprovalDecisions__[jobId]!, jobId);
}

test("Sidecar startup failure shows recovery through the shared UI", async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("omarchy-bot.device-token"));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Add Service" })).toBeVisible();
  await page.route("**/api/pairing/exchange", route => route.fulfill({ status: 201, json: { token: "fixture-token" } }));
  await page.route("**/api/health", route => route.fulfill({ json: { protocol: 1 } }));
  await page.route("**/api/agents", route => route.fulfill({ json: [] }));
  await page.route("**/api/bots", route => route.fulfill({ json: [] }));
  await page.evaluate(() => {
    const shell = globalThis.__OMARCHY_BOT_MEMORY_SHELL__!;
    shell.localSidecar.start = async () => { throw new Error("Local actions are unavailable. Check the connection and reopen Omarchy Bot to retry."); };
  });
  await page.getByLabel("Pairing code").fill("STARTUP1");
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Local actions are unavailable");
  await expect(page.getByRole("alert")).toContainText("reopen Omarchy Bot to retry");
  await expect(page.getByRole("navigation", { name: "Bot navigation" }).getByRole("button", { name: "New bot", exact: true })).toBeVisible();
});

for (const [label, expected] of [
  ["Allow once", "allow-once"],
  ["Always allow", "always"],
  ["Never allow", "never"],
  ["Deny", "deny"],
] as const) {
  test(`${label} answers the Local Sidecar with the exact decision`, async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "New bot", exact: true }).first()).toBeVisible();
    await page.setViewportSize({ width: 375, height: 812 });
    const command = `printf 'a b'  '${"long command ".repeat(25)}'\nprintf '<done> & finished'`;
    await receiveApproval(page, { jobId: "run-job", hostname: "colin-laptop", action: "run", command });
    const dialog = page.getByRole("alertdialog", { name: "Allow local run on colin-laptop?" });
    await expect(dialog).toBeVisible();
    const detail = dialog.getByTestId("local-approval-detail");
    await expect(detail).toBeVisible();
    expect(await detail.textContent()).toBe(command);
    await page.keyboard.press("Escape");
    await page.mouse.click(1, 1);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: label, exact: true }).click();
    expect(await decision(page, "run-job")).toBe(expected);
    await expect(dialog).toBeHidden();
  });
}

test("Local Sidecar asks queue and show exact file, search, and transfer details", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "New bot", exact: true }).first()).toBeVisible();
  const readPath = "/home/colin/Reports/a file with spaces [final].txt";
  const writePath = "C:\\Users\\Colin\\Documents\\new report.txt";
  const searchPath = "/home/colin/projects/<draft>";
  const query = "a  b\n[exact] & query";
  const transferPath = "/home/colin/Reports/source file.txt";
  const destination = "workspace/reports/renamed file.txt";
  await receiveApproval(page, { jobId: "read-job", hostname: "laptop", action: "read", path: readPath });
  await receiveApproval(page, { jobId: "write-job", hostname: "laptop", action: "write", path: writePath });
  await receiveApproval(page, { jobId: "search-job", hostname: "laptop", action: "search", path: searchPath, query });
  await receiveApproval(page, { jobId: "transfer-job", hostname: "laptop", action: "transfer", path: transferPath, destination });
  await expect(page.getByRole("alertdialog", { name: "Allow local read on laptop?" })).toBeVisible();
  expect(await page.getByTestId("local-approval-detail").textContent()).toBe(readPath);
  await expect(page.getByText(writePath, { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  expect(await decision(page, "read-job")).toBe("allow-once");
  await expect(page.getByRole("alertdialog", { name: "Allow local write on laptop?" })).toBeVisible();
  expect(await page.getByTestId("local-approval-detail").textContent()).toBe(writePath);
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  expect(await decision(page, "write-job")).toBe("deny");
  await expect(page.getByRole("alertdialog", { name: "Allow local search on laptop?" })).toBeVisible();
  expect(await page.getByTestId("local-approval-detail").textContent()).toBe(`Query:\n${query}\nPath:\n${searchPath}`);
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  expect(await decision(page, "search-job")).toBe("allow-once");
  await expect(page.getByRole("alertdialog", { name: "Allow local transfer on laptop?" })).toBeVisible();
  expect(await page.getByTestId("local-approval-detail").textContent()).toBe(`Path:\n${transferPath}\nDestination:\n${destination}`);
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  expect(await decision(page, "transfer-job")).toBe("deny");
  await expect(page.getByTestId("local-approval")).toBeHidden();
});

test("a failed decision keeps the approval open and explains the error", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "New bot", exact: true }).first()).toBeVisible();
  await receiveApproval(page, { jobId: "expired-job", hostname: "laptop", action: "run", command: "printf expired" });
  await expect(page.getByTestId("local-approval")).toBeVisible();
  await page.evaluate(() => globalThis.__OMARCHY_BOT_MEMORY_SHELL__!.localSidecar.decide("expired-job", "deny"));
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Unknown Local Sidecar approval.");
  await expect(page.getByRole("alertdialog", { name: "Allow local run on laptop?" })).toBeVisible();
  expect(await page.getByTestId("local-approval-detail").textContent()).toBe("printf expired");
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeEnabled();
});

test("dismissed head and queued approvals disappear and a new Ask can be answered", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "New bot", exact: true }).first()).toBeVisible();
  await receiveApproval(page, { jobId: "head", hostname: "laptop", action: "run", command: "printf head" });
  await receiveApproval(page, { jobId: "queued", hostname: "laptop", action: "read", path: "/cancelled/path" });
  await expect(page.getByTestId("local-approval-detail")).toHaveText("printf head");
  await page.evaluate(() => globalThis.__OMARCHY_BOT_MEMORY_SHELL__!.receiveApprovalDismiss("queued"));
  expect(await decision(page, "queued")).toBe("deny");
  await expect(page.getByTestId("local-approval-detail")).toHaveText("printf head");
  await page.evaluate(() => globalThis.__OMARCHY_BOT_MEMORY_SHELL__!.localSidecar.decide("head", "deny"));
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Unknown Local Sidecar approval.");
  await page.evaluate(() => globalThis.__OMARCHY_BOT_MEMORY_SHELL__!.receiveApprovalDismiss("head"));
  await expect(page.getByTestId("local-approval")).toBeHidden();
  await receiveApproval(page, { jobId: "new", hostname: "laptop", action: "run", command: "printf new" });
  await expect(page.getByTestId("local-approval-detail")).toHaveText("printf new");
  await expect(page.getByRole("alert")).toBeHidden();
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  expect(await decision(page, "new")).toBe("allow-once");
  await expect(page.getByTestId("local-approval")).toBeHidden();
});

for (const outcome of ["success", "error"] as const) {
  test(`a dismissed decision's late ${outcome} leaves the next Ask actionable`, async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "New bot", exact: true }).first()).toBeVisible();
    await receiveApproval(page, { jobId: "old", hostname: "laptop", action: "run", command: "printf old" });
    await receiveApproval(page, { jobId: "next", hostname: "laptop", action: "read", path: "/still/pending" });
    await expect(page.getByTestId("local-approval-detail")).toHaveText("printf old");
    if (outcome === "error") {
      await page.evaluate(() => globalThis.__OMARCHY_BOT_MEMORY_SHELL__!.localSidecar.decide("old", "deny"));
    }
    await page.evaluate(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="local-approval"] button')]
        .find(button => button.textContent?.trim() === "Allow once");
      if (button === undefined) throw new Error("Approval decision button missing");
      // Dismiss in the same task, before the real decision promise continuation runs.
      button.click();
      globalThis.__OMARCHY_BOT_MEMORY_SHELL__!.receiveApprovalDismiss("old");
    });
    expect(await decision(page, "old")).toBe(outcome === "success" ? "allow-once" : "deny");
    await expect(page.getByRole("alertdialog", { name: "Allow local read on laptop?" })).toBeVisible();
    await expect(page.getByTestId("local-approval-detail")).toHaveText("/still/pending");
    await expect(page.getByRole("alert")).toBeHidden();
    await page.getByRole("button", { name: "Allow once", exact: true }).click();
    expect(await decision(page, "next")).toBe("allow-once");
    await expect(page.getByTestId("local-approval")).toBeHidden();
  });
}
