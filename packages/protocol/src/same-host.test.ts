import { describe, expect, test } from "bun:test";
import { shouldStartLocalSidecar } from "./same-host.ts";

describe("shouldStartLocalSidecar", () => {
  test("never starts a Sidecar from a browser tab", () => {
    expect(shouldStartLocalSidecar({
      clientKind: "web",
      daemonHost: "127.0.0.1",
      daemonPort: 7321,
      thisDaemonHost: "127.0.0.1",
      thisDaemonPort: 7321,
    })).toBeFalse();
    expect(shouldStartLocalSidecar({
      clientKind: "web",
      daemonHost: "192.168.1.20",
      daemonPort: 7321,
      thisDaemonHost: "127.0.0.1",
      thisDaemonPort: 7321,
    })).toBeFalse();
  });

  test("skips Sidecar when Omarchy Bot is connected to this plugin daemon on loopback", () => {
    expect(shouldStartLocalSidecar({
      clientKind: "omarchy-bot",
      daemonHost: "127.0.0.1",
      daemonPort: 7321,
      thisDaemonHost: "127.0.0.1",
      thisDaemonPort: 7321,
    })).toBeFalse();
    expect(shouldStartLocalSidecar({
      clientKind: "omarchy-bot",
      daemonHost: "localhost",
      daemonPort: 7321,
      thisDaemonHost: "127.0.0.1",
      thisDaemonPort: 7321,
    })).toBeFalse();
    expect(shouldStartLocalSidecar({
      clientKind: "omarchy-bot",
      daemonHost: "::1",
      daemonPort: 7321,
      thisDaemonHost: "localhost",
      thisDaemonPort: 7321,
    })).toBeFalse();
  });

  test("starts a Sidecar when Omarchy Bot is connected to a different plugin daemon", () => {
    expect(shouldStartLocalSidecar({
      clientKind: "omarchy-bot",
      daemonHost: "127.0.0.1",
      daemonPort: 8000,
      thisDaemonHost: "127.0.0.1",
      thisDaemonPort: 7321,
    })).toBeTrue();
    expect(shouldStartLocalSidecar({
      clientKind: "omarchy-bot",
      daemonHost: "192.168.1.20",
      daemonPort: 7321,
      thisDaemonHost: "127.0.0.1",
      thisDaemonPort: 7321,
    })).toBeTrue();
  });
});
