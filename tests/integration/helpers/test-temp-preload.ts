// Preloaded for every `bun test` run (bunfig.toml): one temporary folder per run, and cleanup of killed runs.
import { afterAll } from "bun:test";
import { claimTestTempRun } from "./test-temp.ts";

// Bun runs no process "exit" handlers from a test preload; a preload's afterAll runs once after the last file.
claimTestTempRun({ onExit: (removeRun) => afterAll(removeRun) });
