/**
 * Dedicated worker fixture for Service supervision tests. The mode comes from
 * `<OMARCHY_BOT_HOME>/fixture-mode` so one tree serves every case:
 *   resistant     – ignores SIGTERM and holds a TERM-resistant descendant
 *   scrubbed      – descendant clears its environment and ignores SIGTERM
 *   shutdown-exit – exits on stdin EOF, leaving its descendant behind
 *   crash         – dies once after starting, leaving its descendant behind
 *   exit-early    – dies once before the handshake, leaving its descendant behind
 * State: `<home>/fixture-state/starts.log` and `descendant-<worker pid>.pid`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const home = process.env.OMARCHY_BOT_HOME;
if (home === undefined) throw new Error("fixture worker needs OMARCHY_BOT_HOME");
const stateDir = path.join(home, "fixture-state");
mkdirSync(stateDir, { recursive: true });
const modeFile = path.join(home, "fixture-mode");
const mode = existsSync(modeFile) ? readFileSync(modeFile, "utf8").trim() : "resistant";

const write = (msg: unknown): void => void process.stdout.write(`${JSON.stringify(msg)}\n`);
appendFileSync(path.join(stateDir, "starts.log"), `${JSON.stringify({ mode, pid: process.pid, env: process.env })}\n`);

/** A descendant that ignores SIGTERM. `scrubbed` also drops the worker environment. */
function spawnDescendant(scrubbed = false): void {
  const pidFile = path.join(stateDir, `descendant-${process.pid}.pid`);
  const child = Bun.spawn({
    cmd: scrubbed
      ? ["sh", "-c", `exec env -i sh -c 'trap \"\" TERM; echo $$ > ${JSON.stringify(pidFile)}; while :; do sleep 1; done'`]
      : ["sh", "-c", "trap '' TERM; while :; do sleep 1; done"],
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();
  // Recorded by the leader, not the child: the pid must be known even if the
  // child is signalled before it reaches its own first statement. The scrubbed
  // child records itself, because `env -i` replaces this shell.
  if (!scrubbed) writeFileSync(pidFile, String(child.pid));
}

if (mode === "resistant") {
  spawnDescendant();
  process.on("SIGTERM", () => {});
} else if (mode === "scrubbed") {
  spawnDescendant(true);
} else if (mode === "shutdown-exit") {
  spawnDescendant();
} else if (mode === "exit-early") {
  // Dies before the handshake once, so the Service's retry path is exercised.
  if (!existsSync(path.join(stateDir, "exited-once"))) {
    writeFileSync(path.join(stateDir, "exited-once"), "1");
    spawnDescendant();
    process.exit(1);
  }
} else if (mode === "crash") {
  spawnDescendant();
  if (!existsSync(path.join(stateDir, "crashed-once"))) {
    writeFileSync(path.join(stateDir, "crashed-once"), "1");
    setTimeout(() => process.exit(2), 300);
  }
}

write({ type: "hello", v: 1, worker: "agent:pi", pid: process.pid });
setInterval(() => write({ type: "heartbeat" }), 5_000);

const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
void (async () => {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      if (mode === "resistant") return;
      writeFileSync(path.join(stateDir, `stdin-closed-${process.pid}`), "closed");
      // Leaves its descendant behind: teardown must reap it after the leader is gone.
      process.exit(0);
    }
    for (const line of decoder.decode(value).split("\n")) {
      if (line.trim() === "") continue;
      const frame = JSON.parse(line) as { type?: string; requestId?: string };
      if (frame.requestId !== undefined) {
        write({ requestId: frame.requestId, ok: true, payload: { agentVersion: `fixture-${mode}-1` } });
      }
    }
  }
})();
