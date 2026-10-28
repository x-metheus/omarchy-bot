export type ShellPlatform = "linux" | "macos" | "windows";
export interface PairingRequest { serviceUrl: string; code: string }
export interface LocalSidecarStatus { running: boolean; deviceId?: string }
export interface LocalApproval {
  jobId: string;
  hostname: string;
  action: "run" | "search" | "read" | "write" | "transfer";
  command?: string;
  path?: string;
  destination?: string;
  query?: string;
}
export type LocalApprovalDecision = "allow-once" | "deny" | "always" | "never";
export interface UpdateStatus { available: boolean; version?: string }

export interface Shell {
  readonly service: {
    baseUrl(): string;
    deviceToken(): string | undefined;
    store(baseUrl: string, token: string): Promise<void>;
    clear(): Promise<void>;
  };
  readonly pairing: { onRequest(listener: (request: PairingRequest) => void): () => void };
  readonly browser: { open(url: string): Promise<void> };
  readonly updates: {
    check(): Promise<UpdateStatus>;
    download(): Promise<void>;
    restart(): Promise<void>;
  };
  readonly localSidecar: {
    status(): LocalSidecarStatus;
    onApproval(listener: (approval: LocalApproval) => void): () => void;
    decide(approvalId: string, decision: LocalApprovalDecision): Promise<void>;
  };
  readonly keyMapping: {
    platform(): ShellPlatform;
    metaSendsSuper(): boolean;
    setMetaSendsSuper(value: boolean): Promise<void>;
  };
}

export const DEVICE_TOKEN_STORAGE_KEY = "omarchy-bot.device-token";
export const SERVICE_URL_STORAGE_KEY = "omarchy-bot.service-url";
const DEFAULT_SERVICE_URL = "http://127.0.0.1:7321";
type ConnectionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

interface MemoryShellOptions {
  storage?: ConnectionStorage | null;
  baseUrl?: string;
  deviceToken?: string;
  localSidecar?: LocalSidecarStatus;
  platform?: ShellPlatform;
  metaSendsSuper?: boolean;
}

function browserStorage(): ConnectionStorage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export function createMemoryShell(options: MemoryShellOptions = {}) {
  // Harness persistence stands in for the app's keychain; callers only see the shell.
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  let baseUrl = options.baseUrl ?? DEFAULT_SERVICE_URL;
  let token = options.deviceToken;
  try {
    baseUrl = options.baseUrl ?? storage?.getItem(SERVICE_URL_STORAGE_KEY) ?? baseUrl;
    token = options.deviceToken ?? storage?.getItem(DEVICE_TOKEN_STORAGE_KEY) ?? token;
  } catch { /* Blocked browser storage leaves the harness unpaired. */ }
  baseUrl = baseUrl.replace(/\/+$/, "");
  let metaSendsSuper = options.metaSendsSuper ?? false;
  const pairingListeners = new Set<(request: PairingRequest) => void>();
  const approvalListeners = new Set<(approval: LocalApproval) => void>();
  const decisions = new Map<string, (decision: LocalApprovalDecision) => void>();

  return {
    service: {
      baseUrl: () => baseUrl,
      deviceToken: () => token,
      async store(nextBaseUrl: string, nextToken: string) {
        const normalized = nextBaseUrl.replace(/\/+$/, "");
        storage?.setItem(SERVICE_URL_STORAGE_KEY, normalized);
        storage?.setItem(DEVICE_TOKEN_STORAGE_KEY, nextToken);
        baseUrl = normalized;
        token = nextToken;
      },
      async clear() {
        storage?.removeItem(DEVICE_TOKEN_STORAGE_KEY);
        storage?.removeItem(SERVICE_URL_STORAGE_KEY);
        token = undefined;
        baseUrl = DEFAULT_SERVICE_URL;
      },
    },
    pairing: {
      onRequest(listener: (request: PairingRequest) => void) {
        pairingListeners.add(listener);
        return () => { pairingListeners.delete(listener); };
      },
    },
    browser: { async open(url: string) { window.open(url, "_blank", "noopener"); } },
    updates: {
      async check() { return { available: false }; },
      async download() { throw new Error("The development shell has no update to download."); },
      async restart() { throw new Error("The development shell cannot restart the app."); },
    },
    localSidecar: {
      status: () => ({ ...options.localSidecar ?? { running: false } }),
      onApproval(listener: (approval: LocalApproval) => void) {
        approvalListeners.add(listener);
        return () => { approvalListeners.delete(listener); };
      },
      async decide(approvalId: string, decision: LocalApprovalDecision) {
        const resolve = decisions.get(approvalId);
        if (resolve === undefined) throw new Error("Unknown Local Sidecar approval.");
        decisions.delete(approvalId);
        resolve(decision);
      },
    },
    keyMapping: {
      platform: () => options.platform ?? "linux",
      metaSendsSuper: () => metaSendsSuper,
      async setMetaSendsSuper(value: boolean) { metaSendsSuper = value; },
    },
    receivePairingRequest(request: PairingRequest) {
      for (const listener of pairingListeners) listener(request);
    },
    receiveApproval(approval: LocalApproval): Promise<LocalApprovalDecision> {
      if (decisions.has(approval.jobId)) throw new Error("Duplicate Local Sidecar approval.");
      const { promise, resolve } = Promise.withResolvers<LocalApprovalDecision>();
      decisions.set(approval.jobId, resolve);
      for (const listener of approvalListeners) listener(approval);
      return promise;
    },
  } satisfies Shell & {
    receivePairingRequest(request: PairingRequest): void;
    receiveApproval(approval: LocalApproval): Promise<LocalApprovalDecision>;
  };
}

// The app installs __OMARCHY_BOT_SHELL__ before the Web UI bundle loads.
declare global { var __OMARCHY_BOT_SHELL__: Shell | undefined; }
let memoryShell: Shell | undefined;
export function getShell(): Shell {
  return globalThis.__OMARCHY_BOT_SHELL__ ?? (memoryShell ??= createMemoryShell());
}
export function installShell(next: Shell): void { globalThis.__OMARCHY_BOT_SHELL__ = next; }
