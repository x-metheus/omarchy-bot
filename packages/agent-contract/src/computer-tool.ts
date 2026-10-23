import { Type } from "typebox";
import { COMPUTER_ACTION_NAMES, type ComputerActionName } from "@omarchy-bot/domain";

export interface AgentComputerToolDefinition {
  readonly name: "computer";
  readonly description: string;
  readonly systemPrompt: {
    readonly summary: string;
    readonly guidelines: readonly string[];
  };
}

/** Every graphical action the `computer` tool accepts. */
export const COMPUTER_TOOL_ACTIONS: readonly ComputerActionName[] = COMPUTER_ACTION_NAMES;

/** One schema for the action and its args; the ToolChannel validates it. */
export const COMPUTER_TOOL_SCHEMA = Type.Object({
  action: Type.Union(COMPUTER_TOOL_ACTIONS.map((action) => Type.Literal(action))),
  args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: false });

/** Mandatory Bot Screen semantics shared by every Agent adapter exposing computer. */
export const AGENT_COMPUTER_TOOL: AgentComputerToolDefinition = Object.freeze({
  name: "computer",
  description:
    "Operate only this Bot's routed Bot Screen inside the shared, private Bot Computer. Every unqualified graphical request targets this Screen. Use computer for screenshots, input, open_app, and open_url; never use native shell commands, Host Session compositor IPC, or host processes to satisfy GUI requests.",
  systemPrompt: Object.freeze({
    summary: "Observe and operate this Bot's routed Screen in the shared Bot Computer, never the user's Host Session.",
    guidelines: Object.freeze([
      "Session map: your Native Session is conversation memory; the Bot Computer is the shared private graphical environment and application profile; this Bot Screen is its routed output/workspace; a Screen Projection is only a client's view. Switching or closing a view does not end desktop work.",
      "Treat every unqualified request to open, start, show, focus, or control a graphical application, browser, terminal, or window as a request for this Bot Screen, including when earlier conversation discussed the Host Session. Use computer open_app/open_url rather than native shell commands, compositor sockets, global WAYLAND_DISPLAY/SWAYSOCK values, or host process inspection. If the computer action fails, report that failure; never fall back to the Host Session or another Bot Screen.",
      "Each computer result identifies its botId, surfaceId and runtimeGeneration. The Surface remains the Bot's identity across runtime restarts; a new runtimeGeneration is a new Screen attachment, not a new conversation or browser identity. Use current observations rather than remembered windows or coordinates.",
      "A gray or blank image describes only this Bot Screen; it does not show that the user's Hyprland desktop or another Bot's Screen is empty. The Bot Computer is not a full Omarchy session, and this workspace may have no application open. Observe or list_windows, then open the needed application here when appropriate.",
      "An open_app/open_url acknowledgement confirms dispatch, not a visible usable window. Verify the requested application with list_windows and focus it when necessary before claiming success. Use a screenshot as verification only when the active model can inspect its image content.",
      "Observe before coordinate-sensitive input and after an action when visual confirmation matters. Input is serialized across Bot Screens because the shared compositor has one seat; unavailable authority rejects actions rather than falling back to the Host Session. Files, browser profile state, and native Agent capabilities are shared, but this is not a security sandbox.",
    ]),
  }),
});
