import { ApiClient, randomUuid } from "@omarchy-bot/api-client";
import { isDeviceId } from "@omarchy-bot/domain";
import { deviceToken } from "./deviceToken.ts";
export { randomUuid };

/**
 * The client shell that started a Local Sidecar installs this global before the
 * web bundle loads. Its value is that Sidecar's `OMARCHY_BOT_DEVICE_ID`, so
 * the daemon can resolve This Device for Turns this client starts.
 * A browser tab, a mobile-class client, and Omarchy Bot on the plugin host
 * never install it: they have no This Device and send no tag.
 */
const LOCAL_SIDECAR_DEVICE_ID_GLOBAL = "__OMARCHY_BOT_DEVICE_ID__";

/** Malformed or absent shell input fails closed: no tag, no This Device. */
function localSidecarDeviceId(): string | undefined {
  const value = (globalThis as Record<string, unknown>)[LOCAL_SIDECAR_DEVICE_ID_GLOBAL];
  return typeof value === "string" && isDeviceId(value) ? value : undefined;
}

/**
 * The browser talks to the daemon it was served from — no hardcoded origin.
 * In dev the Vite proxy forwards /api to 127.0.0.1:7321.
 */
export const api = new ApiClient({
  baseUrl: "",
  localSidecarDeviceId: localSidecarDeviceId(),
  // Read at request time: pairing happens after this module is loaded.
  deviceToken: deviceToken,
});

export function trimSendText(text: string): string {
  return text.replace(/\s+$/, "");
}

export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && "body" in error) {
    const body = error.body;
    if (body !== null && typeof body === "object" && "error" in body && typeof body.error === "string") {
      return body.error;
    }
  }
  return error instanceof Error ? error.message : fallback;
}
