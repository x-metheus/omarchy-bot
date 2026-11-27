import { CreateProviderBody, ProviderBaseUrl, UpdateProviderBody, type ProviderDto } from "@omarchy-bot/protocol";
import type { ZodType } from "zod";
import { HttpError } from "../modules/bots/bots.ts";
import { uniqueProviderModels, type CredentialStore, type ProviderProjection, type StoredProvider } from "../modules/runtime/credentials.ts";
import { listBuiltinProviderIds, listBuiltinProviders, listProviderModels } from "../modules/runtime/models.ts";

const providersPath = "/api/providers";

function projectProvider(provider: ProviderProjection): ProviderDto {
  const { id, name, protocol, baseUrl, hasKey, models } = provider;
  const url = ProviderBaseUrl.safeParse(baseUrl);
  return { id, name, protocol, ...(url.success ? { baseUrl: url.data } : {}), hasKey, models: models ?? [] };
}

async function parseProviderBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const raw: unknown = await req.json().catch(() => {
    throw new HttpError(400, "Invalid JSON body");
  });
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  // An unrecognized field name can contain private request data.
  if (issue?.code === "unrecognized_keys") throw new HttpError(400, "Unsupported provider fields");
  if (issue?.code === "invalid_union" && "note" in issue && issue.note === "No matching discriminator") {
    throw new HttpError(400, "Provider protocol must be openai-compatible, anthropic-messages, or built-in");
  }
  throw new HttpError(400, issue?.message ?? "Invalid provider body");
}

export function createProviderRoutes(credentials: CredentialStore) {
  const builtins = listBuiltinProviders();
  const builtinNames = new Map(builtins.map(({ id, name }) => [id, name]));
  const builtinIds = new Set(listBuiltinProviderIds());
  let pending: Promise<unknown> = Promise.resolve();

  // Keep ID allocation and key-preserving updates in the same queue as their writes.
  function mutate(operation: () => Promise<Response>): Promise<Response> {
    const next = pending.catch(() => {}).then(operation);
    pending = next;
    return next;
  }

  function customId(name: string): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!slug) throw new HttpError(400, "Provider name must contain a letter A–Z or a digit");
    let id = slug;
    for (let suffix = 2; builtinIds.has(id) || credentials.has(id); suffix++) id = `${slug}-${suffix}`;
    return id;
  }

  async function save(provider: StoredProvider, status = 200): Promise<Response> {
    try {
      await credentials.add(provider, { checkEncodedKeys: true });
    } catch (error) {
      if (error instanceof Error && (error.message === "Provider metadata must not contain a key" || error.message === "Secret metadata must not contain the value")) {
        throw new HttpError(400, "Provider metadata must not contain a key");
      }
      throw new HttpError(500, "Unable to save provider");
    }
    const saved = credentials.list(listProviderModels).find(({ id }) => id === provider.id);
    if (!saved) throw new HttpError(500, "Unable to read saved provider");
    return Response.json(projectProvider(saved), { status });
  }

  return async function handleProviderRequest(req: Request, pathname: string): Promise<Response | undefined> {
    if (pathname === providersPath && req.method === "GET") return Response.json(credentials.list(listProviderModels).map(projectProvider));
    if (pathname === `${providersPath}/builtin` && req.method === "GET") return Response.json(builtins);

    if (pathname === providersPath && req.method === "POST") {
      const body = await parseProviderBody(req, CreateProviderBody);
      return mutate(async () => {
        const { protocol, key } = body;
        if (protocol === "built-in") {
          const { id } = body;
          const name = builtinNames.get(id);
          if (name === undefined) {
            throw new HttpError(400, builtinIds.has(id) ? "Built-in provider does not support API keys" : "Unknown built-in provider ID");
          }
          if (credentials.has(id)) throw new HttpError(409, "Provider already exists");
          return save({ id, name, protocol, apiKey: key }, 201);
        }
        const { name, baseUrl, models } = body;
        const providerModels = uniqueProviderModels((models ?? []).map((id) => ({ id })));
        return save({ id: customId(name), name, protocol, baseUrl, apiKey: key, models: providerModels }, 201);
      });
    }

    const match = /^\/api\/providers\/([^/]+)$/.exec(pathname);
    if (!match || (req.method !== "PUT" && req.method !== "DELETE")) return undefined;
    let id: string;
    try { id = decodeURIComponent(match[1]!); }
    catch { throw new HttpError(400, "Invalid provider ID"); }

    if (req.method === "DELETE") {
      return mutate(async () => {
        if (!credentials.has(id)) throw new HttpError(404, "Provider not found");
        try { await credentials.remove(id); }
        catch { throw new HttpError(500, "Unable to remove provider"); }
        return new Response(null, { status: 204 });
      });
    }

    const { name, baseUrl, key, models } = await parseProviderBody(req, UpdateProviderBody);
    return mutate(async () => {
      const existing = credentials.getForRuntime(id);
      if (!existing) throw new HttpError(404, "Provider not found");
      if (existing.protocol === "built-in" && (name !== undefined || baseUrl !== undefined)) {
        throw new HttpError(400, "Built-in providers only accept key and model updates");
      }
      return save({
        ...existing,
        apiKey: key ?? existing.apiKey,
        ...(name === undefined ? {} : { name }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(models === undefined ? {} : { models: uniqueProviderModels(models.map((id) => ({ id }))) }),
      });
    });
  };
}
