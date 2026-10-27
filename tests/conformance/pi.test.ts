import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createConformanceHome, startBrowserConformanceFixture } from "./helpers.ts";

test("Pi conformance keeps native sessions and readiness records in a private child home", async () => {
  const parentHome = process.env.HOME;
  const fixture = createConformanceHome();
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { SessionManager, getAgentDir } from "@earendil-works/pi-coding-agent";
      import { mkdirSync, writeFileSync } from "node:fs";
      import os from "node:os";
      import path from "node:path";
      const session = SessionManager.create(process.cwd());
      session.appendMessage({ role: "assistant", content: [{ type: "text", text: "fixture" }] });
      const record = path.join(process.env.OMARCHY_BOT_HOME, "conformance", "pi-fixture.json");
      mkdirSync(path.dirname(record), { recursive: true });
      writeFileSync(record, JSON.stringify({ ok: true }));
      console.log(JSON.stringify({ home: os.homedir(), agentDir: getAgentDir(), session: session.getSessionFile(), record }));
    `], { cwd: path.resolve(import.meta.dir, "../../workers/pi"), env: fixture.env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const locations = JSON.parse(stdout);
    expect(locations.home).toBe(fixture.root);
    expect(locations.agentDir).toBe(path.join(fixture.root, ".pi/agent"));
    expect(locations.session.startsWith(path.join(fixture.root, ".pi/agent/sessions/"))).toBeTrue();
    expect(existsSync(locations.session)).toBeTrue();
    expect(locations.record).toBe(path.join(fixture.env.OMARCHY_BOT_HOME, "conformance/pi-fixture.json"));
    expect(JSON.parse(readFileSync(locations.record, "utf8"))).toEqual({ ok: true });
    expect(statSync(fixture.root).mode & 0o777).toBe(0o700);
    for (const name of ["auth.json", "models.json", "settings.json"]) {
      const file = path.join(locations.agentDir, name);
      if (existsSync(file)) expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(process.env.HOME).toBe(parentHome);
    expect(os.homedir()).not.toBe(fixture.root);
  } finally {
    fixture.cleanup();
  }
  expect(existsSync(fixture.root)).toBeFalse();
});

test("browser conformance fixture reveals its receipt only after the expected form submission", async () => {
  const fixture = startBrowserConformanceFixture();
  try {
    expect(new URL(fixture.url).hostname).toBe("127.0.0.1");
    const page = await fetch(fixture.url).then(response => response.text());
    expect(page).toContain('name="message"');
    expect(page).not.toContain(fixture.receipt);
    const rejected = await fetch(fixture.url, { method: "POST", body: new URLSearchParams({ message: "wrong" }) });
    expect(rejected.status).toBe(400);
    expect(fixture.submissions).toEqual([]);
    const accepted = await fetch(fixture.url, { method: "POST", body: new URLSearchParams({ message: fixture.value }) });
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toContain(fixture.receipt);
    expect(fixture.submissions).toEqual([fixture.value]);
  } finally {
    await fixture.stop();
  }
});

test("pi conformance (11 steps, real model) > all eleven steps pass", async () => {
  const fixture = createConformanceHome();
  try {
    console.log(`conformance: private HOME ${fixture.root}`);
    const child = Bun.spawn([process.execPath, "test", "--no-orphans", path.join(import.meta.dir, "pi.steps.ts")], {
      env: fixture.env, stdout: "inherit", stderr: "inherit", timeout: 860_000,
    });
    expect(await child.exited).toBe(0);
  } finally {
    fixture.cleanup();
    expect(existsSync(fixture.root)).toBeFalse();
    console.log(`conformance: private HOME removed ${fixture.root}`);
  }
}, 890_000);
