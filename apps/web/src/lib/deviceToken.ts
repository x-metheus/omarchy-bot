export const DEVICE_TOKEN_STORAGE_KEY = "omarchy-bot.device-token";

/** Read per request so a pairing in another tab is picked up without a reload. */
export function deviceToken(): string | undefined {
  try {
    return localStorage.getItem(DEVICE_TOKEN_STORAGE_KEY) ?? undefined;
  } catch {
    // Storage can be blocked; the daemon then answers 401 and the UI says so.
    return undefined;
  }
}

/** Browsers cannot set headers on `<img>`, anchors, WebSockets, or noVNC. */
export function withDeviceToken(url: string): string {
  const token = deviceToken();
  if (token === undefined) return url;
  const queryAt = url.indexOf("?");
  const path = queryAt === -1 ? url : url.slice(0, queryAt);
  const search = new URLSearchParams(queryAt === -1 ? "" : url.slice(queryAt + 1));
  search.set("access_token", token);
  return `${path}?${search}`;
}
