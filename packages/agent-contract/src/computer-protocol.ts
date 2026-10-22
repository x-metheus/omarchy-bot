import type { ComputerAction, SurfaceId } from "@omarchy-bot/domain";
import type { Hello } from "./shared.ts";

/** Daemon-issued authority for one Bot-bound input action. */
export interface ComputerInputAuthority {
  surfaceId: SurfaceId;
  botId: string;
  turnId: string;
  /** Present when the Screen input lease already granted this epoch. */
  controllerEpoch?: number;
}

export type ComputerCommand =
  | {
      type: "act";
      requestId: string;
      surfaceId: SurfaceId;
      runtimeGeneration: number;
      action: ComputerAction;
      /** Input actions fail closed when the owning Bot context is absent. */
      inputAuthority?: ComputerInputAuthority;
    }
  | { type: "shutdown"; requestId: string };


export type ComputerResult =
  | { requestId: string; ok: true; payload: ComputerActPayload }
  | { requestId: string; ok: false; error: string };

export interface ComputerActPayload {
  done?: boolean;
  /** Textual observation result (accessibility tree excerpt etc). */
  text?: string;
  /** Screenshot as PNG/JPEG bytes — daemon persists to artifacts and returns a ref. */
  image?: { mediaType: "image/png" | "image/jpeg"; base64: string };
  windowList?: ComputerWindowListItem[];
}

export interface ComputerWindowListItem {
  id: string;
  title: string;
  appId?: string;
  focused: boolean;
  pid?: number;
  bounds?: { x: number; y: number; width: number; height: number };
  workspace?: string;
  clientType?: "x11" | "wayland";
}

export type ComputerWorkerOutbound =
  | Hello
  | { type: "heartbeat" }
  | ComputerResult;
