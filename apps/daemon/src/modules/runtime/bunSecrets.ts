import { randomUUID } from "node:crypto";
import type { SecretBackend } from "./secrets.ts";

export const bunSecretsService = "com.omarchy.bot";
const probeTimeoutMs = 5_000;
const cleanupTimeoutMs = 1_000;
const timedOut = Symbol("keychain probe timeout");

interface BunSecretAccount {
  service: string;
  name: string;
}

// Bun.secrets is experimental. Bun 1.4.5 supports Windows persistence ahead of the installed types.
export interface BunSecretsApi {
  get(options: BunSecretAccount): Promise<string | null>;
  set(options: BunSecretAccount & {
    value: string;
    allowUnrestrictedAccess?: boolean;
    persist?: "local" | "enterprise" | undefined;
  }): Promise<void>;
  delete(options: BunSecretAccount): Promise<boolean>;
}

export class BunSecretsBackend implements SecretBackend {
  readonly kind = "keychain";

  constructor(private readonly api: BunSecretsApi, private readonly platform = process.platform) {}

  async get(account: string): Promise<string | undefined> {
    return (await this.api.get({ service: bunSecretsService, name: account })) ?? undefined;
  }

  async set(account: string, value: string): Promise<void> {
    await this.api.set(writeOptions({ service: bunSecretsService, name: account }, value, this.platform));
  }

  async delete(account: string): Promise<void> {
    await this.api.delete({ service: bunSecretsService, name: account });
  }
}

type ProbeFailure = "no-backend" | "timeout" | "write-failed" | "readback-mismatch" | "delete-failed";

export type BunSecretsProbeResult =
  | { available: true; reason?: never }
  | { available: false; reason: ProbeFailure };

/** Check keychain availability using a disposable account and a single deadline. */
export async function probeBunSecrets(
  api: BunSecretsApi,
  { platform = process.platform, timeoutMs = probeTimeoutMs }: { platform?: NodeJS.Platform; timeoutMs?: number } = {},
): Promise<BunSecretsProbeResult> {
  const deadline = performance.now() + timeoutMs;
  // Store accounts are two hex hashes. The probe prefix is outside that namespace.
  const account = { service: bunSecretsService, name: `probe:${randomUUID()}` };
  const read = () => beforeDeadline(() => api.get(account), deadline);
  const remove = (deadline: number) => beforeDeadline(() => api.delete(account), deadline);
  let reason: ProbeFailure = "no-backend";
  let writeAttempted = false;

  try {
    if (await read() !== null) return { available: false, reason };
    const value = randomUUID();
    reason = "write-failed";
    await beforeDeadline(() => {
      writeAttempted = true;
      return api.set(writeOptions(account, value, platform));
    }, deadline);
    reason = "readback-mismatch";
    if (await read() === value) {
      reason = "delete-failed";
      if (await remove(deadline) === true && await read() === null) return { available: true };
    }
  } catch (error) {
    if (error === timedOut) reason = "timeout";
  }

  if (writeAttempted) {
    // Bun can't cancel a timed-out write, so it may complete after cleanup.
    const cleanupDeadline = performance.now() + Math.min(timeoutMs, cleanupTimeoutMs);
    await remove(cleanupDeadline).catch(() => undefined);
  }
  return { available: false, reason };
}

function writeOptions(account: BunSecretAccount, value: string, platform: NodeJS.Platform): Parameters<BunSecretsApi["set"]>[0] {
  return platform === "win32" ? { ...account, value, persist: "local" } : { ...account, value };
}

async function beforeDeadline<T>(operation: () => Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw timedOut;
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(timedOut), Math.ceil(remaining));
  try {
    return await Promise.race([operation(), timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}
