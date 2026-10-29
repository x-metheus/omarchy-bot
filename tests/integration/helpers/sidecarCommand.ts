import path from "node:path";

/** Exercise the selected release binary, or the TypeScript Sidecar during source-only development. */
export const sidecarCommand = process.env.OMARCHY_BOT_TEST_SIDECAR_BINARY
  ? [path.resolve(process.env.OMARCHY_BOT_TEST_SIDECAR_BINARY)]
  : [process.execPath, path.resolve(import.meta.dir, "../../../apps/sidecar/src/main.ts")];
