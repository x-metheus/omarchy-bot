import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/** PID reuse protection: Linux boot + start ticks. */
export interface ProcessIdentity {
  pid: number;
  startTime: string;
  bootId: string;
}

/**
 * Private-environment proof of ownership. A child that inherits one exact
 * `name=value` environment entry is ours, and so are its descendants.
 */
export interface ProcessOwnership {
  name: string;
  value: string;
}

/** PID reuse protection bound to the private runtime directory that owns the process. */
export interface OwnedProcessIdentity extends ProcessIdentity {
  runtimeDir: string;
  unitName?: string;
}

/**
 * One detached child session the Service owns. The session id is the leader pid
 * captured at spawn, and an anchor process keeps that id reserved for the whole
 * session, so members stay provable after the leader exits and even when a
 * descendant scrubbed its environment (`env -i`).
 */
export interface OwnedSession {
  sessionId: number;
  anchor: ProcessOwnership;
}

const ANCHOR_ENV = "OMARCHY_BOT_SESSION_ANCHOR";
const SIGNAL_POLL_MS = 50;
const FORCED_EXIT_WAIT_MS = 1_000;
const TERMINATE_GRACE_MS = 3_000;

function readBootId(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return undefined;
  }
}

interface ProcessStat {
  sessionId: number;
  startTime: string;
}

/** Fields 4 (session) and 19 (start ticks) of /proc/<pid>/stat; zombies are dead. */
function readStat(pid: number): ProcessStat | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z" || fields[0] === "X") return undefined;
    const sessionId = fields[3];
    const startTime = fields[19];
    if (
      sessionId === undefined || !/^\d+$/.test(sessionId)
      || startTime === undefined || !/^\d+$/.test(startTime)
    ) {
      return undefined;
    }
    return { sessionId: Number(sessionId), startTime };
  } catch {
    return undefined;
  }
}

function readEnvironment(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
  } catch {
    return [];
  }
}

export function processIdentity(pid: number): ProcessIdentity | undefined {
  const bootId = readBootId();
  const stat = readStat(pid);
  return bootId === undefined || stat === undefined
    ? undefined
    : { pid, startTime: stat.startTime, bootId };
}

export function processIdentityRunning(candidate: ProcessIdentity | undefined): boolean {
  if (candidate === undefined) return false;
  const current = processIdentity(candidate.pid);
  return current !== undefined
    && current.startTime === candidate.startTime
    && current.bootId === candidate.bootId;
}


function signalAll(members: readonly ProcessIdentity[], signal: NodeJS.Signals): void {
  for (const member of members) {
    if (!processIdentityRunning(member)) continue;
    try {
      process.kill(member.pid, signal);
    } catch {
      // Exited between the identity check and the signal.
    }
  }
}

function survivorsOf(members: readonly ProcessIdentity[]): ProcessIdentity[] {
  return members.filter(processIdentityRunning);
}

/** Waits on captured identities only, so no /proc rescan runs while waiting. */
async function waitUntilGone(members: readonly ProcessIdentity[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (survivorsOf(members).length === 0) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(SIGNAL_POLL_MS);
  }
}

function throwSurvivors(members: readonly ProcessIdentity[], owner: string): void {
  const survivors = survivorsOf(members);
  if (survivors.length === 0) return;
  throw new Error(`${owner} processes survived SIGKILL: ${survivors.map((member) => member.pid).join(", ")}`);
}


export function sessionAnchor(token: string): ProcessOwnership {
  return { name: ANCHOR_ENV, value: token };
}

/**
 * Wraps a detached child so its session outlives its leader: a marker process
 * that ignores SIGTERM keeps the session id reserved. Only the marker's own
 * descriptors go to `/dev/null`; the child keeps the descriptors it was spawned
 * with, so a worker's stdio pipes survive the `exec`. Teardown kills the marker last.
 */
export function anchoredSessionCommand(argv: readonly string[], token: string): string[] {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("owned session token has invalid characters");
  const script = [
    "trap '' HUP TERM",
    `( ${ANCHOR_ENV}='${token}' exec sh -c 'trap \"\" HUP TERM; while :; do sleep 3600; done' ) >/dev/null 2>&1 </dev/null &`,
    "trap - HUP TERM",
    'exec "$@"',
  ].join("\n");
  return ["/bin/sh", "-c", script, "omarchy-bot-session", ...argv];
}

/** Every live process in one session, including environment-scrubbed descendants. */
export function sessionMembers(sessionId: number): ProcessIdentity[] {
  const bootId = readBootId();
  if (bootId === undefined || !Number.isSafeInteger(sessionId) || sessionId <= 0) return [];
  const members: ProcessIdentity[] = [];
  for (const candidate of readdirSync("/proc")) {
    if (!/^\d+$/.test(candidate)) continue;
    const pid = Number(candidate);
    const stat = readStat(pid);
    if (stat === undefined || stat.sessionId !== sessionId) continue;
    members.push({ pid, startTime: stat.startTime, bootId });
  }
  return members;
}

/** Anchors proving this session id still belongs to the token the Service issued. */
function provenAnchors(session: OwnedSession): ProcessIdentity[] {
  const entry = `${session.anchor.name}=${session.anchor.value}`;
  return sessionMembers(session.sessionId)
    .filter((member) => readEnvironment(member.pid).includes(entry));
}

/**
 * Re-adopts a live session only when the recorded leader pid still is that
 * process: same start ticks and boot id, and it leads the session. The anchor
 * token is read from that proven session. A recycled pid fails the identity
 * check before any token is trusted.
 */
export function ownedSessionAt(
  leaderPid: number | undefined,
  identity?: ProcessIdentity,
): OwnedSession | undefined {
  if (leaderPid === undefined || !Number.isSafeInteger(leaderPid) || leaderPid <= 0) return undefined;
  if (identity !== undefined && (identity.pid !== leaderPid || !processIdentityRunning(identity))) {
    return undefined;
  }
  const stat = readStat(leaderPid);
  if (stat === undefined || stat.sessionId !== leaderPid) return undefined;
  if (identity !== undefined && stat.startTime !== identity.startTime) return undefined;
  for (const member of sessionMembers(leaderPid)) {
    const anchor = readEnvironment(member.pid).find((entry) => entry.startsWith(`${ANCHOR_ENV}=`));
    if (anchor === undefined) continue;
    return { sessionId: leaderPid, anchor: { name: ANCHOR_ENV, value: anchor.slice(ANCHOR_ENV.length + 1) } };
  }
  return undefined;
}


/**
 * Tears down one owned session. Membership is proven by an anchor of our token
 * still sitting in that exact session, so a recycled session id is never
 * signalled; every member is then signalled individually by re-verified
 * identity, never by `-PGID`. Members are rescanned while the anchors live, so a
 * descendant forked during teardown cannot escape. Anchors ignore SIGTERM and
 * are killed last, which frees the session id.
 */
export async function terminateOwnedSession(
  session: OwnedSession | undefined,
  graceMs = TERMINATE_GRACE_MS,
): Promise<void> {
  if (session === undefined) return;
  const anchors = provenAnchors(session);
  if (anchors.length === 0) return;
  const anchorPids = new Set(anchors.map((anchor) => anchor.pid));
  const payload = (): ProcessIdentity[] =>
    sessionMembers(session.sessionId).filter((member) => !anchorPids.has(member.pid));
  const graceDeadline = Date.now() + graceMs;
  for (;;) {
    const members = payload();
    if (members.length === 0 || Date.now() >= graceDeadline) break;
    signalAll(members, "SIGTERM");
    await Bun.sleep(SIGNAL_POLL_MS);
  }
  const killDeadline = Date.now() + FORCED_EXIT_WAIT_MS;
  for (;;) {
    const members = payload();
    if (members.length === 0 || Date.now() >= killDeadline) break;
    signalAll(members, "SIGKILL");
    await Bun.sleep(SIGNAL_POLL_MS);
  }
  signalAll(survivorsOf(anchors), "SIGKILL");
  await waitUntilGone(anchors, FORCED_EXIT_WAIT_MS);
  throwSurvivors([...payload(), ...survivorsOf(anchors)], "owned session");
}

/** Kills a finished session's markers once no payload is left; true when settled. */
export function settleOwnedSession(session: OwnedSession | undefined): boolean {
  if (session === undefined) return false;
  const anchors = provenAnchors(session);
  if (anchors.length === 0) return false;
  const anchorPids = new Set(anchors.map((anchor) => anchor.pid));
  if (sessionMembers(session.sessionId).some((member) => !anchorPids.has(member.pid))) return false;
  signalAll(anchors, "SIGKILL");
  return true;
}

export function ownedProcessIdentity(
  pid: number,
  runtimeDir: string,
  unitName?: string,
): OwnedProcessIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !path.isAbsolute(runtimeDir)) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z" || fields[0] === "X") return undefined;
    const startTime = fields[19];
    if (startTime === undefined || !/^\d+$/.test(startTime)) return undefined;
    const environment = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    const privateEnvironment = environment.includes(`XDG_RUNTIME_DIR=${runtimeDir}`);
    // systemd-run lives in the daemon environment; its exact service and env -i
    // arguments are the ownership evidence, not that launcher's host runtime.
    const ownedLauncher = unitName !== undefined
      && path.basename(args[0] ?? "") === "systemd-run"
      && args.includes(`--unit=${unitName.replace(/\.service$/, "")}`)
      && args.includes(`XDG_RUNTIME_DIR=${runtimeDir}`);
    if (!privateEnvironment && !ownedLauncher) return undefined;
    const bootId = readBootId();
    if (bootId === undefined) return undefined;
    return { pid, startTime, bootId, runtimeDir, ...(unitName === undefined ? {} : { unitName }) };
  } catch {
    return undefined;
  }
}

export function ownedProcessRunning(candidate: OwnedProcessIdentity | undefined): boolean {
  if (candidate === undefined) return false;
  const current = ownedProcessIdentity(candidate.pid, candidate.runtimeDir, candidate.unitName);
  return current !== undefined
    && current.startTime === candidate.startTime
    && current.bootId === candidate.bootId;
}

/** Validates a serialized identity against the private runtime directory that must own it. */
export function readOwnedIdentity(
  value: unknown,
  pid: number | undefined,
  runtimeDir: string,
): OwnedProcessIdentity | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<OwnedProcessIdentity>;
  if (
    candidate.pid !== pid
    || candidate.runtimeDir !== runtimeDir
    || typeof candidate.startTime !== "string"
    || !/^\d+$/.test(candidate.startTime)
    || typeof candidate.bootId !== "string"
    || (candidate.unitName !== undefined && typeof candidate.unitName !== "string")
  ) {
    return undefined;
  }
  return candidate as OwnedProcessIdentity;
}

export function privateRuntimeProcesses(runtimeDir: string): OwnedProcessIdentity[] {
  const identities: OwnedProcessIdentity[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const candidate = ownedProcessIdentity(Number(entry), runtimeDir);
    if (candidate !== undefined) identities.push(candidate);
  }
  return identities;
}

export async function terminateOwnedProcess(candidate: OwnedProcessIdentity | undefined): Promise<void> {
  if (candidate === undefined || !ownedProcessRunning(candidate)) return;
  // Never signal a numeric process group recovered from disk. Each member must
  // carry its own private ownership evidence, rechecked immediately before kill.
  try { process.kill(candidate.pid, "SIGTERM"); } catch { return; }
  if (await waitUntilGone([candidate], TERMINATE_GRACE_MS)) return;
  try { process.kill(candidate.pid, "SIGKILL"); } catch { /* already gone */ }
  await waitUntilGone([candidate], FORCED_EXIT_WAIT_MS);
}

/**
 * Terminates every process still carrying this private runtime directory. A
 * session's anchors are torn down as a whole session first, so descendants that
 * scrubbed their environment still go with their leader.
 */
export async function terminateRuntimeProcesses(runtimeDir: string): Promise<void> {
  const owned = privateRuntimeProcesses(runtimeDir);
  const sessions = new Map<number, OwnedSession>();
  for (const candidate of owned) {
    const stat = readStat(candidate.pid);
    const token = readEnvironment(candidate.pid).find((entry) => entry.startsWith(`${ANCHOR_ENV}=`));
    if (stat === undefined || token === undefined) continue;
    sessions.set(stat.sessionId, {
      sessionId: stat.sessionId,
      anchor: { name: ANCHOR_ENV, value: token.slice(ANCHOR_ENV.length + 1) },
    });
  }
  await Promise.allSettled([...sessions.values()].map((session) => terminateOwnedSession(session)));
  const sessionIds = new Set(sessions.keys());
  await Promise.all(owned
    .filter((candidate) => !sessionIds.has(readStat(candidate.pid)?.sessionId ?? -1))
    .map(terminateOwnedProcess));
}

export async function watchOwnedProcess(candidate: OwnedProcessIdentity | undefined): Promise<number> {
  while (ownedProcessRunning(candidate)) await Bun.sleep(100);
  return 0;
}
