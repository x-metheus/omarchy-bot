import { fileURLToPath } from "node:url";

// Quickshell destroys Process objects with SIGKILL. Keep the Service behind a
// pipe whose EOF can request graceful cleanup even when this supervisor dies.
// The Service itself is started by the launcher-neutral serve entry.
const serve = process.argv[2];
if (serve === undefined) {
  console.error("Plugin supervisor requires the serve entry path");
  process.exit(1);
}

// Descriptor 9 is launch.sh's preparation lock over the per-user Service lock;
// serve.sh adopts it so preparation, the Service and its cleanup never overlap.
// Bun's declared type only allows raw descriptors for the first three slots, but
// the runtime accepts one per index and the index is the child's descriptor, so
// slots 3-8 are explicit "ignore" placeholders and 9 carries parent fd 9.
const child = Bun.spawn({
  cmd: [
    "bash",
    serve,
    "--preload",
    fileURLToPath(new URL("./daemon-lifetime.ts", import.meta.url)),
  ],
  stdio: ["pipe", "inherit", "inherit", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", 9],
});

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  // stdin is "pipe" as written above; Bun's type unions it with the descriptor
  // form, which this process never receives.
  if (typeof child.stdin === "object") child.stdin.end();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

const code = await child.exited;
stop();
process.exitCode = code;
