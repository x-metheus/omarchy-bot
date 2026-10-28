import { expect, test } from "bun:test";
import { createMemoryShell } from "./shell.ts";

test("the memory shell stores and clears the Service connection", async () => {
  const shell = createMemoryShell({ storage: null });
  expect(shell.service.baseUrl()).toBe("http://127.0.0.1:7321");
  expect(shell.service.deviceToken()).toBeUndefined();
  await shell.service.store("https://service.example/", "paired-token");
  expect(shell.service.baseUrl()).toBe("https://service.example");
  expect(shell.service.deviceToken()).toBe("paired-token");
  await shell.service.clear();
  expect(shell.service.baseUrl()).toBe("http://127.0.0.1:7321");
  expect(shell.service.deviceToken()).toBeUndefined();
});

test("memory pairing intake and approvals unsubscribe and exchange decisions", async () => {
  const shell = createMemoryShell({ storage: null });
  const requests: unknown[] = [];
  const unsubscribe = shell.pairing.onRequest((request) => requests.push(request));
  shell.receivePairingRequest({ serviceUrl: "https://service.example", code: "ABCD2345" });
  unsubscribe();
  shell.receivePairingRequest({ serviceUrl: "https://other.example", code: "OTHER234" });
  expect(requests).toEqual([{ serviceUrl: "https://service.example", code: "ABCD2345" }]);
  const approvals: string[] = [];
  const stop = shell.localSidecar.onApproval((approval) => approvals.push(approval.command!));
  const decision = shell.receiveApproval({ jobId: "job-1", hostname: "laptop", action: "run", command: "pwd" });
  expect(approvals).toEqual(["pwd"]);
  await shell.localSidecar.decide("job-1", "deny");
  expect(await decision).toBe("deny");
  stop();
  const second = shell.receiveApproval({ jobId: "job-2", hostname: "laptop", action: "read", path: "/work" });
  await shell.localSidecar.decide("job-2", "allow-once");
  expect(await second).toBe("allow-once");
  expect(approvals).toEqual(["pwd"]);
  await expect(shell.localSidecar.decide("unknown", "always")).rejects.toThrow("Unknown");
});

test("dismissed memory approvals fail closed and dismissal listeners unsubscribe", async () => {
  const shell = createMemoryShell({ storage: null });
  const dismissed: string[] = [];
  const stop = shell.localSidecar.onApprovalDismiss(jobId => dismissed.push(jobId));
  const decision = shell.receiveApproval({ jobId: "cancelled", hostname: "laptop", action: "run", command: "pwd" });
  shell.receiveApprovalDismiss("cancelled");
  expect(await decision).toBe("deny");
  expect(dismissed).toEqual(["cancelled"]);
  await expect(shell.localSidecar.decide("cancelled", "always")).rejects.toThrow("Unknown");
  stop();
  shell.receiveApprovalDismiss("other");
  expect(dismissed).toEqual(["cancelled"]);
});

test("memory shell reports Sidecar and platform state and remembers key mapping", async () => {
  const defaults = createMemoryShell({ storage: null });
  expect(defaults.localSidecar.status()).toEqual({ running: false });
  expect(defaults.keyMapping.platform()).toBe("linux");
  expect(defaults.keyMapping.metaSendsSuper()).toBe(false);
  const shell = createMemoryShell({ storage: null, localSidecar: { running: true, deviceId: "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, platform: "macos" });
  expect(shell.localSidecar.status()).toEqual({ running: true, deviceId: "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  expect(shell.keyMapping.platform()).toBe("macos");
  await shell.keyMapping.setMetaSendsSuper(true);
  expect(shell.keyMapping.metaSendsSuper()).toBe(true);
  expect(await shell.updates.check()).toEqual({ available: false });
  await expect(shell.updates.download()).rejects.toThrow("no update");
});

test("memory connection survives harness reload and storage failure leaves it unpaired", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const shell = createMemoryShell({ storage });
  await shell.service.store("https://service.example/", "token");
  const reloaded = createMemoryShell({ storage });
  expect(reloaded.service.baseUrl()).toBe("https://service.example");
  expect(reloaded.service.deviceToken()).toBe("token");
  await reloaded.service.clear();
  expect(createMemoryShell({ storage }).service.deviceToken()).toBeUndefined();
  const blocked = createMemoryShell({ storage: { ...storage, setItem() { throw new Error("quota"); } } });
  await expect(blocked.service.store("https://service.example", "token")).rejects.toThrow("quota");
  expect(blocked.service.deviceToken()).toBeUndefined();
});

test("key mapping persists true and false per device without following the Service connection", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const shell = createMemoryShell({ storage, platform: "macos" });
  expect(shell.keyMapping.metaSendsSuper()).toBe(false);
  await shell.keyMapping.setMetaSendsSuper(true);
  expect(createMemoryShell({ storage }).keyMapping.metaSendsSuper()).toBe(true);
  expect(createMemoryShell({ storage, metaSendsSuper: false }).keyMapping.metaSendsSuper()).toBe(false);
  await shell.service.clear();
  expect(createMemoryShell({ storage }).keyMapping.metaSendsSuper()).toBe(true);
  await shell.keyMapping.setMetaSendsSuper(false);
  expect(createMemoryShell({ storage }).keyMapping.metaSendsSuper()).toBe(false);
  expect(createMemoryShell({ storage: null }).keyMapping.metaSendsSuper()).toBe(false);
  const blocked = createMemoryShell({ storage: { ...storage, setItem() { throw new Error("quota"); } } });
  await expect(blocked.keyMapping.setMetaSendsSuper(true)).rejects.toThrow("quota");
  expect(blocked.keyMapping.metaSendsSuper()).toBe(false);
});

test("the harness reports the browser platform unless the shell platform is supplied", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    for (const [platform, expected] of [["MacIntel", "macos"], ["Win32", "windows"], ["Linux x86_64", "linux"]] as const) {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform } });
      expect(createMemoryShell({ storage: null }).keyMapping.platform()).toBe(expected);
      expect(createMemoryShell({ storage: null, platform: "linux" }).keyMapping.platform()).toBe("linux");
    }
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, "navigator");
    else Object.defineProperty(globalThis, "navigator", original);
  }
});
