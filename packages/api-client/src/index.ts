import type {
  AuthorizePluginBody,
  CatalogSkillDetailDto,
  InstalledSkillDto,
  McpConnectionDto,
  PluginAccountDto,
  PluginStateDto,
  SaveMcpBody,
  SkillCatalogDto,
  SkillCommandDto,
} from "@omarchy-bot/protocol";
import type {
  AgentDto,
  AttachmentDto,
  AttachmentDraftTokenDto,
  AvatarRecipeBodyDto,
  BotDto,
  BotViewDto,
  ClientToServer,
  ComputerViewDto,
  CreateBotBodyDto,
  DeleteBotResultDto,
  DeviceDto,
  DictationDto,
  DictationResultDto,
  EventEnvelope,
  MessageDto,
  PatchBotBodyDto,
  PatchThreadBodyDto,
  PinBodyDto,
  SendMessageBodyDto,
  SendResultDto,
  ServerToClient,
  ThreadDto,
} from "@omarchy-bot/protocol";
import {
  ComputerViewDto as ComputerViewSchema,
  DeleteBotResultDto as DeleteBotResultSchema,
  isDeviceId,
} from "@omarchy-bot/protocol";

export interface ApiClientOptions {
  /** Service base URL; a getter is read for each request, browser URL, and socket. */
  baseUrl?: string | (() => string);
  fetch?: typeof fetch;
  /**
   * Device identity of the Local Sidecar this client install started
   * (`dev_<32hex>`, the same value passed as `OMARCHY_BOT_DEVICE_ID`).
   * A getter is read per `message.send` so only a running Sidecar tags This Device.
   * Omitted or undefined means this client has no Local Sidecar and sends no tag.
   */
  localSidecarDeviceId?: string | (() => string | undefined) | undefined;
  /**
   * Paired Device token (`Authorization: Bearer`, `access_token` on sockets and
   * browser-loaded URLs). A getter is read per request, so a client created
   * before pairing picks the token up once it is stored. The getter wins.
   */
  deviceToken?: string | (() => string | undefined) | undefined;
}

export interface ComputerSurfaceOwner {
  botId: string;
  surfaceId: ComputerViewDto["surfaceId"];
}

export interface ApiError extends Error {
  status: number;
  body: unknown;
}

export function randomUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Shared Service client for the Web UI in every shell. */
export class ApiClient {
  private readonly base: () => string;
  private readonly f: typeof fetch;
  private readonly localSidecarDeviceId: () => string | undefined;
  private readonly token: () => string | undefined;

  constructor(opts: ApiClientOptions = {}) {
    const baseUrl = opts.baseUrl ?? "";
    this.base = typeof baseUrl === "function" ? baseUrl : () => baseUrl;
    this.f = opts.fetch ?? fetch.bind(globalThis);
    const deviceId = opts.localSidecarDeviceId;
    if (typeof deviceId !== "function" && deviceId !== undefined && !isDeviceId(deviceId)) {
      throw new Error("localSidecarDeviceId must be a Local Sidecar device identity");
    }
    this.localSidecarDeviceId = typeof deviceId === "function" ? deviceId : () => deviceId;
    const token = opts.deviceToken;
    this.token = typeof token === "function" ? token : () => token;
  }

  get baseUrl(): string {
    return this.base().replace(/\/+$/, "");
  }

  private authHeaders(): Record<string, string> {
    const token = this.token();
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  /** Browsers cannot set headers on WebSockets, `<img>`, or noVNC: carry the token in the query. */
  private withToken(url: string): string {
    const token = this.token();
    if (!token) return url;
    const queryAt = url.indexOf("?");
    const path = queryAt === -1 ? url : url.slice(0, queryAt);
    const search = new URLSearchParams(queryAt === -1 ? "" : url.slice(queryAt + 1));
    search.set("access_token", token);
    return `${path}?${search}`;
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.f(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...this.authHeaders(),
        "content-type": "application/json",
        "x-command-id": randomUuid(),
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* keep raw text */
      }
      const err = new Error(`${res.status} ${res.statusText}: ${typeof body === "string" ? body : JSON.stringify(body)}`) as ApiError;
      err.status = res.status;
      err.body = body;
      throw err;
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // ----- agents -----
  listAgents(): Promise<AgentDto[]> {
    return this.req("/api/agents");
  }

  /** Online Local Sidecar roster. Does not start or supervise a Sidecar. */
  listDevices(): Promise<DeviceDto[]> {
    return this.req("/api/devices");
  }
  recheckAgent(id: AgentDto["id"]): Promise<AgentDto> {
    return this.req(`/api/agents/${id}/recheck`, { method: "POST" });
  }

  // ----- global plugins -----
  plugins(): Promise<PluginStateDto> {
    return this.req("/api/plugins");
  }
  saveMcp(id: string | null, body: SaveMcpBody): Promise<McpConnectionDto> {
    return this.req(`/api/plugins/mcp${id === null ? "" : `/${encodeURIComponent(id)}`}`, {
      method: id === null ? "POST" : "PUT", body: JSON.stringify(body),
    });
  }
  setMcpEnabled(id: string, enabled: boolean): Promise<void> {
    return this.req(`/api/plugins/mcp/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
  }
  deleteMcp(id: string): Promise<void> {
    return this.req(`/api/plugins/mcp/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  checkMcp(id: string): Promise<McpConnectionDto> {
    return this.req(`/api/plugins/mcp/${encodeURIComponent(id)}/check`, { method: "POST", body: "{}" });
  }
  searchSkills(query = "", cursor?: string, view = "trending"): Promise<SkillCatalogDto> {
    const search = new URLSearchParams({ q: query, view });
    if (cursor !== undefined) search.set("cursor", cursor);
    return this.req(`/api/plugins/catalog?${search}`);
  }
  skillDetail(id: string): Promise<CatalogSkillDetailDto> {
    return this.req(`/api/plugins/catalog/detail?${new URLSearchParams({ id })}`);
  }
  installSkill(id: string): Promise<InstalledSkillDto> {
    return this.req("/api/plugins/skills", { method: "POST", body: JSON.stringify({ id }) });
  }
  updateSkills(): Promise<void> {
    return this.req("/api/plugins/skills/update", { method: "POST", body: "{}" });
  }
  setSkillEnabled(id: string, enabled: boolean): Promise<void> {
    return this.req(`/api/plugins/skills/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
  }
  removeSkill(id: string): Promise<void> {
    return this.req(`/api/plugins/skills/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  pluginCommands(): Promise<SkillCommandDto[]> {
    return this.req("/api/plugins/commands");
  }
  authorizePlugin(body: AuthorizePluginBody): Promise<{ url: string }> {
    return this.req("/api/plugins/authorize", { method: "POST", body: JSON.stringify(body) });
  }
  labelPluginAccount(id: string, label: string): Promise<void> {
    return this.req(`/api/plugins/accounts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ label }) });
  }
  setPluginService(id: string, serviceId: string, enabled: boolean): Promise<PluginAccountDto> {
    return this.req(`/api/plugins/accounts/${encodeURIComponent(id)}/services`, {
      method: "PATCH", body: JSON.stringify({ serviceId, enabled }),
    });
  }
  disconnectPluginAccount(id: string): Promise<void> {
    return this.req(`/api/plugins/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  // ----- bots -----
  listBots(): Promise<BotViewDto[]> {
    return this.req("/api/bots");
  }
  createBot(body: CreateBotBodyDto): Promise<BotDto> {
    return this.req("/api/bots", { method: "POST", body: JSON.stringify(body) });
  }
  getBot(id: string): Promise<BotViewDto> {
    return this.req(`/api/bots/${id}`);
  }
  patchBot(id: string, body: PatchBotBodyDto): Promise<BotDto> {
    return this.req(`/api/bots/${id}`, { method: "PATCH", body: JSON.stringify(body) });
  }
  pinBot(id: string, body: PinBodyDto): Promise<BotDto> {
    return this.req(`/api/bots/${id}/pin`, { method: "POST", body: JSON.stringify(body) });
  }
  async deleteBot(id: string): Promise<DeleteBotResultDto> {
    try {
      const response = await this.req<unknown>(`/api/bots/${id}`, { method: "DELETE", body: "{}" });
      return DeleteBotResultSchema.parse(response);
    } catch (error) {
      if (error !== null && typeof error === "object" && "body" in error) {
        const result = DeleteBotResultSchema.safeParse(error.body);
        if (result.success) return result.data;
      }
      throw error;
    }
  }
  generateAvatar(id: string): Promise<BotDto> {
    return this.req(`/api/bots/${id}/avatar/generate`, { method: "POST" });
  }
  async uploadAvatar(id: string, file: Blob): Promise<BotDto> {
    const res = await this.f(`${this.baseUrl}/api/bots/${id}/avatar/upload`, {
      method: "POST",
      headers: { ...this.authHeaders(), "content-type": file.type || "application/octet-stream", "x-command-id": randomUuid() },
      body: file,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`${res.status}: ${text}`) as ApiError;
      err.status = res.status;
      err.body = text;
      throw err;
    }
    return (await res.json()) as BotDto;
  }
  avatarRecipe(id: string, body: AvatarRecipeBodyDto): Promise<BotDto> {
    return this.req(`/api/bots/${id}/avatar/recipe`, { method: "POST", body: JSON.stringify(body) });
  }
  avatarUrl(id: string): string {
    return this.withToken(`${this.baseUrl}/api/bots/${id}/avatar`);
  }
  markBotRead(id: string, threadId: string): Promise<void> {
    return this.req(`/api/bots/${id}/read`, { method: "POST", body: JSON.stringify({ threadId }) });
  }
  listBotThreads(id: string, q?: string): Promise<ThreadDto[]> {
    return this.req(`/api/bots/${id}/threads${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  }
  sendBotMessage(id: string, body: SendMessageBodyDto): Promise<SendResultDto> {
    return this.req(`/api/bots/${id}/messages`, { method: "POST", body: JSON.stringify(this.#sendBody(body)) });
  }

  // ----- threads & messages -----
  getThread(id: string): Promise<ThreadDto> {
    return this.req(`/api/threads/${id}`);
  }
  patchThread(id: string, body: PatchThreadBodyDto): Promise<ThreadDto> {
    return this.req(`/api/threads/${id}`, { method: "PATCH", body: JSON.stringify(body) });
  }
  listMessages(threadId: string): Promise<MessageDto[]> {
    return this.req(`/api/threads/${threadId}/messages`);
  }
  sendMessage(threadId: string, body: SendMessageBodyDto): Promise<SendResultDto> {
    return this.req(`/api/threads/${threadId}/messages`, { method: "POST", body: JSON.stringify(this.#sendBody(body)) });
  }

  /**
   * The client's own Local Sidecar identity is the only tag authority: a body
   * claim never overrides it, and a client without a Sidecar sends no tag
   * (fail closed, no This Device).
   */
  #sendBody(body: SendMessageBodyDto): SendMessageBodyDto {
    const { deviceId: _claimed, ...rest } = body;
    const deviceId = this.localSidecarDeviceId();
    if (deviceId === undefined) return rest;
    if (!isDeviceId(deviceId)) {
      throw new Error("localSidecarDeviceId must be a Local Sidecar device identity");
    }
    return { ...rest, deviceId };
  }


  // ----- attachments -----
  async stageAttachment(botId: string, draftToken: AttachmentDraftTokenDto, file: File): Promise<AttachmentDto> {
    const form = new FormData();
    form.append("file", file);
    const res = await this.f(`${this.baseUrl}/api/attachments/stage`, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "x-bot-id": botId,
        "x-attachment-draft-token": draftToken,
        "x-command-id": randomUuid(),
      },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`${res.status}: ${text}`) as ApiError;
      err.status = res.status;
      err.body = text;
      throw err;
    }
    return (await res.json()) as AttachmentDto;
  }
  getStagedAttachment(id: string, draftToken: AttachmentDraftTokenDto): Promise<AttachmentDto> {
    return this.req(`/api/attachments/staged/${id}`, {
      headers: { "x-attachment-draft-token": draftToken },
    });
  }
  unstageAttachment(id: string, draftToken: AttachmentDraftTokenDto): Promise<void> {
    return this.req(`/api/attachments/staged/${id}`, {
      method: "DELETE",
      headers: { "x-attachment-draft-token": draftToken },
    });
  }
  attachmentUrl(id: string): string {
    return this.withToken(`${this.baseUrl}/api/attachments/${id}`);
  }


  // ----- dictation -----
  dictation(): Promise<DictationDto> {
    return this.req("/api/dictation");
  }
  startDictation(): Promise<DictationDto> {
    return this.req("/api/dictation/start", { method: "POST" });
  }
  stopDictation(): Promise<DictationResultDto> {
    return this.req("/api/dictation/stop", { method: "POST" });
  }
  cancelDictation(): Promise<DictationDto> {
    return this.req("/api/dictation/cancel", { method: "POST" });
  }


  // ----- computer -----
  async computerState(owner: ComputerSurfaceOwner): Promise<ComputerViewDto> {
    try {
      return ComputerViewSchema.parse(
        await this.req<unknown>(this.computerPath("/api/computer/state", owner)),
      );
    } catch (error) {
      if (error !== null && typeof error === "object" && "body" in error) {
        const result = ComputerViewSchema.safeParse(error.body);
        if (result.success && result.data.unavailableReason === "capacity") return result.data;
      }
      throw error;
    }
  }
  takeControl(owner: ComputerSurfaceOwner): Promise<ComputerViewDto> {
    return this.req(this.computerPath("/api/computer/take-control", owner), { method: "POST" });
  }
  returnToBot(owner: ComputerSurfaceOwner): Promise<ComputerViewDto> {
    return this.req(this.computerPath("/api/computer/return-to-bot", owner), { method: "POST" });
  }
  computerProjectionUrl(owner: ComputerSurfaceOwner): string {
    return this.withToken(`${this.baseUrl}${this.computerPath("/api/computer/projection", owner)}`);
  }

  private computerPath(path: string, owner: ComputerSurfaceOwner): string {
    return `${path}?botId=${encodeURIComponent(owner.botId)}&surfaceId=${encodeURIComponent(owner.surfaceId)}`;
  }

  // ----- events -----
  /** Control/state WebSocket with cursor replay. Never guesses missed state. */
  connectEvents(
    lastCursor: number | undefined,
    onEvent: (e: EventEnvelope) => void,
    opts?: { snapshotRequired?: () => void; onOpen?: () => void; onCaughtUp?: () => void },
  ): WebSocket {
    const wsUrl = this.withToken(`${this.baseUrl.replace(/^http/, "ws")}/api/events`);
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      const hello: ClientToServer = { type: "hello", ...(lastCursor !== undefined ? { lastCursor } : {}) };
      ws.send(JSON.stringify(hello));
      opts?.onOpen?.();
    };
    ws.onmessage = (ev) => {
      let msg: ServerToClient;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "event") onEvent(msg.envelope);
      if (msg.type === "snapshot_required") opts?.snapshotRequired?.();
      if (msg.type === "hello") opts?.onCaughtUp?.();
    };
    return ws;
  }
}

