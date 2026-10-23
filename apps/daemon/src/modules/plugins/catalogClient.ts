import { redactToolErrorSummary } from "@omarchy-bot/agent-contract";
import {
  HttpsOrigin, NormalisedCatalogResponse, NormalisedSkillDetail, PLUGIN_OPERATIONS, PLUGIN_PROVIDERS,
  PublisherProvidersResponse, SKILL_CATALOG_PAGE_SIZE, SKILL_SEARCH_LIMIT,
  type CatalogSkillDetailDto, type CatalogSkillDto, type PluginProviderDto, type SkillCatalogDto,
} from "@omarchy-bot/protocol";
import { HttpError } from "../bots/bots.ts";
import { skillFrontmatter } from "./skillInstaller.ts";

/** Daemon side of the publisher catalog. Unknown response fields are dropped by the contract. */
export class CatalogClient {
  readonly entries = new Map<string, CatalogSkillDto>();
  #providers: { at: number; providers: PluginProviderDto[]; error?: string } | undefined;

  constructor(private readonly origin: () => string) {}

  clear(): void {
    this.#providers = undefined;
    this.entries.clear();
  }
  async request(route: string, body?: unknown, base = this.origin()): Promise<unknown> {
    let parsed: string;
    try { parsed = HttpsOrigin.parse(base); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "Publisher URL must be an HTTPS origin"); }
    const response = await fetch(`${parsed}/api/plugins/${route}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json", accept: "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new HttpError(502, "Publisher backend returned an invalid response"); }
    if (!response.ok) {
      const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : `Publisher backend returned HTTP ${response.status}`;
      throw new HttpError(response.status, redactToolErrorSummary(message));
    }
    return payload;
  }

  async providers(): Promise<{ providers: PluginProviderDto[]; error?: string }> {
    if (this.#providers && Date.now() - this.#providers.at < 30_000) return this.#providers;
    let providers: PluginProviderDto[] = Object.values(PLUGIN_PROVIDERS).map(({ id, name, mode, services, documentationUrl, nativeOAuth, registrationNote }) => ({ id, name, mode, documentationUrl, registrationNote,
      services: services.map(({ id: serviceId, name: serviceName, description, skillSources }) => ({ id: serviceId, name: serviceName, description, ...(skillSources === undefined ? {} : { skillSources }) })),
      ...(nativeOAuth ? { nativeAuthorization: true } : { setupReason: "Publisher backend is unavailable." }) }));
    let error: string | undefined;
    try {
      const remote = PublisherProvidersResponse.parse(await this.request("providers"));
      providers = providers.map((provider) => {
        if (provider.nativeAuthorization) return provider;
        const registered = remote.find((item) => item.id === provider.id);
        const { setupReason: _reason, ...known } = provider;
        return { ...known, ...(registered === undefined ? { setupReason: "Publisher does not support this provider." } : registered.setupReason ? { setupReason: registered.setupReason } : {}) };
      });
    } catch (failure) { error = redactToolErrorSummary(failure instanceof Error ? failure.message : failure); }
    this.#providers = { at: Date.now(), providers, ...(error ? { error } : {}) };
    return this.#providers;
  }

  async catalog(query = "", cursor?: string, view = "trending"): Promise<SkillCatalogDto> {
    const parameters = new URLSearchParams({ q: query, view, ...(cursor === undefined ? {} : { cursor }) });
    const route = PLUGIN_OPERATIONS.find((operation) => operation.action === "search_skills")?.upstream;
    if (!route) throw new HttpError(500, "Catalog search has no publisher route");
    const raw = NormalisedCatalogResponse.parse(await this.request(`${route}?${parameters}`));
    const isSearch = Boolean(query.trim());
    if (!isSearch && !raw.pagination) throw new HttpError(502, "Catalog pagination is unavailable");
    const skills = raw.skills.map((entry): CatalogSkillDto => {
      const { installs, ...fields } = entry;
      const skill: CatalogSkillDto = { ...fields, description: "", ...(installs === undefined ? {} : { installs }) };
      this.entries.set(skill.id, skill);
      return skill;
    });
    return {
      skills,
      total: isSearch ? skills.length : raw.pagination!.total,
      pageSize: isSearch ? SKILL_CATALOG_PAGE_SIZE : raw.pagination!.perPage,
      ...(isSearch ? { searchLimit: SKILL_SEARCH_LIMIT } : raw.pagination!.hasMore ? { nextCursor: String(raw.pagination!.page + 1) } : {}),
    };
  }

  async detail(id: string): Promise<CatalogSkillDetailDto> {
    const route = PLUGIN_OPERATIONS.find((operation) => operation.action === "inspect_skill")?.upstream;
    if (!route) throw new HttpError(500, "Catalog detail has no publisher route");
    const raw = NormalisedSkillDetail.parse(await this.request(`${route}?${new URLSearchParams({ id })}`));
    const content = raw.content;
    const cached = this.entries.get(id);
    const sourceType = cached?.sourceType ?? (raw.source.includes("/") ? "github" : "well-known");
    let metadata = { name: cached?.name ?? raw.slug, description: cached?.description ?? "" };
    if (content) metadata = skillFrontmatter(content);
    // The catalog can use the original name while detail returns a canonical slug.
    if (raw.id !== `${raw.source}/${raw.slug}` || (raw.id !== id && (!content || id !== `${raw.source}/${metadata.name}`))) throw new HttpError(502, "Catalog returned a mismatched skill identity");
    return { id, ...metadata, source: raw.source, sourceType, installUrl: cached?.installUrl ?? (sourceType === "github" ? `https://github.com/${raw.source}` : `https://${raw.source}`),
      ...(raw.installs === undefined ? {} : { installs: raw.installs }), content, url: `https://skills.sh/${id.split("/").map(encodeURIComponent).join("/")}` };
  }
}
