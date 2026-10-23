import { createToolChannelWorker, writeJsonl } from "@omarchy-bot/agent-contract";

/** One channel for every daemon-owned tool call this worker makes; pending calls are session-scoped. */
export const toolChannel = createToolChannelWorker();
toolChannel.send = (frame) => writeJsonl(frame);
