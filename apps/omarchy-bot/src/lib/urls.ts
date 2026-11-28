import { getShell } from "./shell.ts";

/** Browser-loaded resources carry the paired token in the query. */
export function withDeviceToken(url: string): string {
  const service = getShell().service;
  const resolved = new URL(url, service.baseUrl());
  const token = service.deviceToken();
  if (token !== undefined) resolved.searchParams.set("access_token", token);
  return resolved.href;
}
