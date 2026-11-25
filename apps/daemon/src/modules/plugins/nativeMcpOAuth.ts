import { z } from "zod";

const callbackAuthority = /^(http:\/\/(?:127\.0\.0\.1|localhost))(?::(\d+))?(?=\/|$)/i;

export function parseMcpOAuthCallbackUrl(value: string): { url: URL; port: number | undefined } | undefined {
  const authority = callbackAuthority.exec(value);
  if (!authority || /[\x00-\x1f\x7f ?#\\]/.test(value)) return;
  const url = URL.parse(value);
  // URL.port omits an explicitly configured default HTTP port.
  const port = authority[2] === undefined ? undefined : Number(authority[2]);
  if (!url || url.pathname === "/" || port === 0) return;
  return { url, port };
}

const nonempty = z.string().refine((value) => value.trim().length > 0);
const callbackUrl = nonempty.refine((value) => parseMcpOAuthCallbackUrl(value) !== undefined);
const oauth = z.object({
  clientId: nonempty.optional(),
  clientSecret: nonempty.optional(),
  callbackPort: z.number().int().min(1).max(65_535).optional(),
  callbackUrl: callbackUrl.optional(),
  scope: nonempty.optional(),
  clientName: nonempty.optional(),
  clientRegistration: z.enum(["auto", "dcr", "cimd"]).optional(),
  authServerMetadataUrl: nonempty.refine((value) => /^https?:\/\/[^/]/i.test(value) && URL.canParse(value)).optional(),
});

export type NativeMcpOAuthSettings = z.infer<typeof oauth>;

const nativeOAuth = oauth.extend({ redirectUri: callbackUrl.optional() });

export function projectNativeMcpOAuth(value: unknown): NativeMcpOAuthSettings | null | undefined {
  if (value === undefined || value === false) return;
  const result = nativeOAuth.safeParse(value);
  if (!result.success) return null;
  const { redirectUri, ...settings } = result.data;
  if (redirectUri !== undefined && settings.callbackUrl === undefined) {
    if (settings.callbackPort === undefined) {
      settings.callbackUrl = redirectUri;
      const port = parseMcpOAuthCallbackUrl(redirectUri)?.port;
      if (port !== undefined) settings.callbackPort = port;
    } else {
      settings.callbackUrl = redirectUri.replace(callbackAuthority, `$1:${settings.callbackPort}`);
    }
  }
  return settings;
}
