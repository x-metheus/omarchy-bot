import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  spawnDetachedChild,
  terminateOwnedChild,
} from "../../apps/daemon/src/modules/computer/botScreenWaylandHelpers.ts";

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

test("an owned child whose PATH has no shell still stops with its whole session", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-owned-path-"));
  // A Bot Computer child env can carry a PATH of bundle-only or fixture-only
  // directories; the session anchor must not depend on it.
  const child = spawnDetachedChild({
    argv: ["/bin/sh", "-c", "trap '' TERM; /bin/sleep 600 & wait"],
    env: { PATH: path.join(root, "empty-bin") },
    output: "ignore",
    owned: true,
  });
  await Bun.sleep(300);
  expect(child.process.exitCode).toBeNull();

  const stopped = await Promise.race([
    terminateOwnedChild(child).then(() => true),
    Bun.sleep(15_000).then(() => false),
  ]);
  expect(stopped).toBeTrue();
  expect(child.process.exitCode !== null || child.process.signalCode !== null).toBeTrue();
}, 20_000);
