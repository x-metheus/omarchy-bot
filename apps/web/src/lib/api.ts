import { queryOptions } from "@tanstack/react-query";
import { PROTOCOL_VERSION } from "@omarchy-bot/protocol";
import { ApiClient, randomUuid } from "@omarchy-bot/api-client";
import { isDeviceId } from "@omarchy-bot/domain";
import { getShell } from "./shell.ts";
import { deviceRevoked } from "./pairing.ts";
import { serviceFetch } from "./serviceFetch.ts";
export { randomUuid };

export const api = new ApiClient({
  fetch: serviceFetch,
  baseUrl: () => getShell().service.baseUrl(),
  deviceToken: () => getShell().service.deviceToken(),
  onUnauthorized: deviceRevoked,
  localSidecarDeviceId: () => {
    const status = getShell().localSidecar.status();
    return status.running && status.deviceId !== undefined && isDeviceId(status.deviceId)
      ? status.deviceId : undefined;
  },
});

export function serviceHealthQuery() {
  return queryOptions({
    queryKey: ["health", getShell().service.baseUrl()],
    queryFn: () => api.health(),
    staleTime: 0,
  });
}

export function isSupportedServiceProtocol(protocol: unknown): boolean {
  return typeof protocol === "number" && Number.isInteger(protocol)
    && protocol >= 1 && protocol <= PROTOCOL_VERSION;
}

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
