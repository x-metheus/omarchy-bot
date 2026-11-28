import { getShell } from "./shell.ts";

/** Diagnose connection failures without changing the page's fetch implementation. */
export const serviceFetch = (async (input: string | URL | Request, options?: RequestInit) => {
  try { return await globalThis.fetch(input, options); }
  catch (error) {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = options?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.protocol === "https:" && url.pathname === "/api/pairing/exchange" && method === "POST"
      && await getShell().service.certificateUntrusted(url.origin).catch(() => false)) {
      const certificateError = new Error("The Service TLS certificate is not trusted. Install a publicly trusted certificate, or connect through an SSH tunnel to loopback.");
      certificateError.name = "TlsCertificateError";
      throw certificateError;
    }
    throw error;
  }
}) as typeof fetch;
