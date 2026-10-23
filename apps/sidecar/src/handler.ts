import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DeviceServerFrameSchema,
  type DeviceClientFrame,
  type DeviceLocalJobFrame,
  type DeviceServerFrame,
} from "@omarchy-bot/protocol";
import type { LocalActionName } from "@omarchy-bot/agent-contract";
import { executeLocalJob, ruleKey } from "./execute.ts";

export interface LocalAsk {
  jobId: string;
  hostname: string;
  action: LocalActionName;
  command?: string;
  path?: string;
  destination?: string;
  query?: string;
  signal: AbortSignal;
  dismissed: Promise<void>;
}

export type LocalAskDecision = "allow-once" | "deny" | "always" | "never";

export interface LocalApprover {
  ask(ask: LocalAsk): Promise<LocalAskDecision>;
}

export interface LocalJobHandlerOptions {
  root: string;
  approver: LocalApprover;
  send(frame: DeviceClientFrame): void;
  observe?(event: { action: LocalActionName; rule: string; executed: boolean }): void;
}

interface Policy {
  always: string[];
  never: string[];
}

/** Policy and execution for one Local Sidecar. The shell supplies the socket and Ask card. */
export function createLocalJobHandler(options: LocalJobHandlerOptions): {
  receive(raw: unknown): void;
  close(): Promise<void>;
} {
  const policyPath = path.join(options.root, ".omarchy-bot-local-policy.json");
  const policy = loadPolicy(policyPath);
  const pending = new Map<string, { job: DeviceLocalJobFrame; abort: AbortController; dismiss(): void }>();
  // Executor promises outlive a cancel: close() must still be able to await their teardown.
  const running = new Set<Promise<void>>();
  const cancelled = new Set<string>();
  let closed = false;

  const finish = (job: DeviceLocalJobFrame, result: Awaited<ReturnType<typeof executeLocalJob>>): void => {
    pending.delete(job.jobId);
    if (cancelled.has(job.jobId)) return;
    options.send(result.ok
      ? {
          type: "local.result",
          jobId: job.jobId,
          ok: true,
          text: result.text,
          ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        }
      : { type: "local.result", jobId: job.jobId, ok: false, error: result.error });
  };

  const deny = (job: DeviceLocalJobFrame, error: string): void => {
    pending.delete(job.jobId);
    if (cancelled.has(job.jobId)) return;
    options.send({ type: "local.result", jobId: job.jobId, ok: false, error });
  };

  const run = (job: DeviceLocalJobFrame, signal: AbortSignal): void => {
    if (cancelled.has(job.jobId) || signal.aborted) return;
    options.observe?.({ action: job.action, rule: ruleKey(job), executed: true });
    const execution = executeLocalJob(job, options.root, signal).then((result) => finish(job, result));
    running.add(execution);
    // A settled executor is dropped; a rejected one stays so close() reports it.
    void execution.then(() => running.delete(execution), () => undefined);
  };

  const decide = (job: DeviceLocalJobFrame, decision: LocalAskDecision, signal: AbortSignal): void => {
    if (cancelled.has(job.jobId) || signal.aborted) return;
    const key = ruleKey(job);
    if (decision === "always" || decision === "never") {
      const rules = decision === "always" ? policy.always : policy.never;
      if (!rules.includes(key)) rules.push(key);
      savePolicy(policyPath, policy);
    }
    if (decision === "deny" || decision === "never") {
      options.observe?.({ action: job.action, rule: key, executed: false });
      deny(job, decision === "never" ? "Local Sidecar Never allowed this work" : "Local Sidecar denied this work");
      return;
    }
    run(job, signal);
  };

  const onJob = (job: DeviceLocalJobFrame): void => {
    if (cancelled.has(job.jobId) || pending.has(job.jobId)) return;
    if (job.action === "search" && (job.query === "/" || job.path === "/")) {
      deny(job, "Local Sidecar search cannot scan /");
      return;
    }
    const key = ruleKey(job);
    if (policy.never.includes(key)) {
      options.observe?.({ action: job.action, rule: key, executed: false });
      deny(job, "Local Sidecar Never allowed this work");
      return;
    }
    const abort = new AbortController();
    const dismissed = Promise.withResolvers<void>();
    pending.set(job.jobId, { job, abort, dismiss: () => dismissed.resolve() });
    if (policy.always.includes(key)) {
      run(job, abort.signal);
      return;
    }
    const ask: LocalAsk = {
      jobId: job.jobId,
      hostname: job.hostname,
      action: job.action,
      ...(job.command !== undefined ? { command: job.command } : {}),
      ...(job.path !== undefined ? { path: job.path } : {}),
      ...(job.destination !== undefined ? { destination: job.destination } : {}),
      ...(job.query !== undefined ? { query: job.query } : {}),
      signal: abort.signal,
      dismissed: dismissed.promise,
    };
    void options.approver.ask(ask).then((decision) => decide(job, decision, abort.signal));
  };

  return {
    receive(raw) {
      if (closed) return;
      const parsed = DeviceServerFrameSchema.safeParse(raw);
      if (!parsed.success) return;
      const frame = parsed.data;
      if (frame.type === "local.cancel") {
        cancelled.add(frame.jobId);
        const current = pending.get(frame.jobId);
        current?.abort.abort();
        current?.dismiss();
        pending.delete(frame.jobId);
        return;
      }
      if (frame.type === "local.job") onJob(frame);
    },
    close() {
      closed = true;
      for (const [jobId, current] of pending) {
        cancelled.add(jobId);
        current.abort.abort();
        current.dismiss();
      }
      pending.clear();
      return Promise.allSettled([...running]).then((settled) => {
        for (const entry of settled) {
          if (entry.status === "rejected") throw entry.reason;
        }
      });
    },
  };
}

function loadPolicy(policyPath: string): Policy {
  try {
    const parsed = JSON.parse(readFileSync(policyPath, "utf8")) as { always?: string[]; never?: string[] };
    return { always: parsed.always ?? [], never: parsed.never ?? [] };
  } catch {
    return { always: [], never: [] };
  }
}

function savePolicy(policyPath: string, policy: Policy): void {
  writeFileSync(policyPath, JSON.stringify(policy));
}

export type { DeviceServerFrame };
