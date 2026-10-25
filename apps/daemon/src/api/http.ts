import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { Config } from "../bootstrap/config.ts";
import type { EventLog } from "../modules/events/eventLog.ts";
import type { AgentsRegistry } from "../modules/agents/registry.ts";
import type { BotsService } from "../modules/bots/bots.ts";
import type { BotDeletionService } from "../modules/bots/botDeletion.ts";
import type { ThreadsService } from "../modules/threads/threads.ts";
import type { TurnService } from "../modules/turns/turns.ts";
import type { ComputerBroker } from "../modules/computer/broker.ts";
import type { BotScreenManager } from "../modules/computer/botScreenManager.ts";
import type {
  ProjectionSocketKind,
  ProjectionSocketReservation,
  ScreenProjectionService,
} from "../modules/computer/screenProjection.ts";
import type { AvatarService } from "../modules/avatars/avatarService.ts";
import type { DictationService } from "../modules/dictation/dictationService.ts";
import type { AttachmentsService } from "../modules/attachments/attachments.ts";
import { handleAvatarRequest } from "./avatarRoutes.ts";
import { handleThreadFeatureRequest } from "./threadRoutes.ts";
import { handleBotAttentionRequest } from "./botAttentionRoutes.ts";
import { handleBotDeletionRequest } from "./botDeletionRoutes.ts";
import { handleComputerRequest } from "./computerRoutes.ts";
import { handleProjectionRequest } from "./projectionRoutes.ts";
import { handleDictationRequest } from "./dictationRoutes.ts";
import { handleAttachmentRequest } from "./attachmentRoutes.ts";
import { handlePluginRequest } from "./pluginRoutes.ts";
import type { PluginsService } from "../modules/plugins/plugins.ts";
import type { DevicePort, SidecarBroker } from "../modules/devices/sidecarBroker.ts";
import type { PairingService } from "../modules/pairing/pairing.ts";
import type { Supervisor } from "../supervision/supervisor.ts";
import { existsSync } from "node:fs";
import path from "node:path";
import { isIPv4 } from "node:net";
import { CreateBotBody, PatchBotBody, SendMessageBody } from "@omarchy-bot/protocol";
import { HttpError } from "../modules/bots/bots.ts";
import { AGENT_IDS, type AgentId } from "@omarchy-bot/domain";
import daemonPackage from "../../package.json" with { type: "json" };

/** Service version reported by the health probe; the daemon manifest is the single source. */
const DAEMON_VERSION: string = daemonPackage.version;

export interface DaemonServices {
  cfg: Config;
  db: Database;
  events: EventLog;
  agents: AgentsRegistry;
  bots: BotsService;
  botDeletions: BotDeletionService;
  threads: ThreadsService;
  turns: TurnService;
  avatars: AvatarService;
  attachments: AttachmentsService;
  dictation: DictationService;
  plugins: PluginsService;
  computer: ComputerBroker;
  screens: BotScreenManager;
  projections: ScreenProjectionService;
  devices: SidecarBroker;
  pairing: PairingService;
  /** Mode-0600 Service Host secret. Required to mint pairing codes; never logged. */
  pairingHostSecret: string;
  /** Exposed for the conformance suite and advanced embedders; not used by HTTP handlers. */
  supervisor: Supervisor;
}

const JSON_HEADERS = { "content-type": "application/json" };
const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

interface EventsWsData {
  kind: "events";
  svc: DaemonServices;
  sub?: () => void;
}

interface ProjectionWsData {
  kind: "projection";
  svc: DaemonServices;
  reservation: ProjectionSocketReservation;
}

interface DeviceWsData {
  kind: "device";
  svc: DaemonServices;
  port?: DevicePort;
  deviceId?: string;
}

type WsData = (EventsWsData | ProjectionWsData | DeviceWsData) & { pairedDeviceId: string | undefined };

/**
 * Device token from `Authorization: Bearer` or `?access_token=`; the header wins
 * when it parses. A malformed header falls through to the query.
 */
function presentedToken(req: Request, url: URL): string | null {
  const header = req.headers.get("authorization");
  if (header !== null) {
    const match = /^Bearer (\S+)$/i.exec(header);
    if (match !== null) return match[1]!;
  }
  return url.searchParams.get("access_token");
}

/** Parse a JSON body with zod; 400 with the first issue on failure. */
async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  const raw: unknown = await req.json().catch(() => {
    throw new HttpError(400, "invalid JSON body");
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues[0]?.message ?? "invalid body");
  }
  return parsed.data;
}

function notFound(message: string): Response {
  return json({ error: message }, 404);
}

const isLoopbackAddress = (address: string): boolean =>
  address === "::1" || address === "127.0.0.1" || address.startsWith("127.") || address.startsWith("::ffff:127.");

export function publicOrigin(cfg: Config, peerAddress: string | undefined, headers: Headers, listenerUrl: URL): string {
  const proxy = cfg.trustedProxy;
  if (!proxy || (peerAddress !== proxy && !(isIPv4(proxy) && peerAddress === `::ffff:${proxy}`))) return listenerUrl.origin;
  const scheme = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const host = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if ((scheme !== "https" && (scheme !== "http" || cfg.tlsCert)) || !host || /[\s\\/@?#]/.test(host)) return listenerUrl.origin;
  try { return new URL(`${scheme}://${host}`).origin; } catch { return listenerUrl.origin; }
}

const PairingCodeBody = z.object({ name: z.string().trim().min(1).max(80) });
const PairingExchangeBody = z.object({
  code: z.string().trim().min(1),
  name: z.string().trim().min(1).max(80).optional(),
});

/**
 * REST + WS listener. Every route and socket requires a Paired Device token;
 * loopback is not exempt (ADR 0014).
 */
export function startHttp(svc: DaemonServices): { stop: () => Promise<void>; port: number } {
  // Only what Bun.serve needs from a socket: revoke closes these directly.
  const pairedSockets = new Map<string, Set<{ close(code?: number, reason?: string): void }>>();

  /** The Service Host is the loopback peer; a null address is only trusted on a loopback bind. */
  const fromServiceHost = (req: Request): boolean => {
    const address = server.requestIP(req)?.address;
    if (address === undefined) return svc.cfg.host === "127.0.0.1" || svc.cfg.host === "::1" || svc.cfg.host === "localhost";
    return isLoopbackAddress(address);
  };


  const route = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // Gate first: no Bot, Thread, or host data, and no upgrade, before a token is proven.
    // Public: health, the pairing exchange, and the provider's browser redirect (its state is single-use).
    // Code issue needs the host secret or an already-paired device.
    let pairedDeviceId: string | undefined;
    const pairingExchange = pathname === "/api/pairing/exchange" && req.method === "POST";
    const oauthCallback = pathname === "/api/plugins/oauth/callback" && req.method === "GET";
    if (pathname.startsWith("/api/") && !(pathname === "/api/health" && req.method === "GET") && !pairingExchange && !oauthCallback) {
      const device = svc.pairing.authenticate(presentedToken(req, url));
      if (device === null && !(pathname === "/api/pairing/codes" && req.method === "POST")) {
        return json({ error: "unauthorized" }, 401);
      }
      if (device !== null) pairedDeviceId = device.id;
    }

    if (pathname === "/api/pairing/codes" && req.method === "POST") {
      const hostAuthorized = fromServiceHost(req) && svc.pairing.hostSecretMatches(presentedToken(req, url), svc.pairingHostSecret);
      if (pairedDeviceId === undefined && !hostAuthorized) return json({ error: "unauthorized" }, 401);
      const body = await parseBody(req, PairingCodeBody);
      return json(svc.pairing.issueCode(body.name));
    }

    if (pathname === "/api/pairing/exchange" && req.method === "POST") {
      const body = await parseBody(req, PairingExchangeBody);
      const paired = svc.pairing.exchange(body.code, body.name);
      return paired === null ? json({ error: "unauthorized" }, 401) : json(paired, 201);
    }

    if (pathname === "/api/devices/paired" && req.method === "GET") return json({ devices: svc.pairing.list() });

    const pairedRevoke = pathname.match(/^\/api\/devices\/paired\/([\w-]+)\/revoke$/);
    if (pairedRevoke && req.method === "POST") {
      const id = pairedRevoke[1]!;
      if (!svc.pairing.revoke(id)) return notFound(`unknown paired device ${id}`);
      for (const socket of pairedSockets.get(id) ?? []) socket.close(1008, "revoked");
      pairedSockets.delete(id);
      return new Response(null, { status: 204 });
    }

    if (pathname === "/api/events") {
      const upgraded = server.upgrade(req, {
        data: { kind: "events", svc, pairedDeviceId } satisfies WsData,
      });
      if (upgraded) return undefined as unknown as Response;
      return json({ error: "expected websocket upgrade" }, 426);
    }

    if (pathname === "/api/devices") {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const upgraded = server.upgrade(req, {
          data: { kind: "device", svc, pairedDeviceId } satisfies WsData,
        });
        if (upgraded) return undefined as unknown as Response;
        return json({ error: "expected websocket upgrade" }, 426);
      }
      if (req.method === "GET") return json(svc.devices.list());
    }

    const projectionSocket = pathname.match(/^\/api\/computer\/projection\/(control|rfb)$/);
    if (projectionSocket !== null) {
      const botId = url.searchParams.get("botId");
      const surfaceId = url.searchParams.get("surfaceId");
      const sessionId = url.searchParams.get("sessionId");
      if (botId === null || surfaceId === null || sessionId === null) {
        return json({ error: "botId, surfaceId, and sessionId are required" }, 400);
      }
      const owner = svc.computer.resolveOwner(botId, surfaceId);
      if (owner === undefined) return json({ error: "Computer Surface was not found for this Bot" }, 404);
      if (svc.projections.status(owner, sessionId) === undefined) {
        return json({ error: "Screen Projection was not found" }, 404);
      }
      const reservation = svc.projections.reserveSocket(
        owner,
        sessionId,
        projectionSocket[1] as ProjectionSocketKind,
      );
      if (reservation === undefined) {
        return json({ error: "Screen Projection socket is not available in its current state" }, 409);
      }
      const upgraded = server.upgrade(req, {
        data: { kind: "projection", svc, reservation, pairedDeviceId } satisfies WsData,
      });
      if (upgraded) return undefined as unknown as Response;
      svc.projections.cancelSocketReservation(reservation);
      return json({ error: "expected websocket upgrade" }, 426);
    }

    if (pathname === "/api/health" && req.method === "GET") return json({ ok: true, version: DAEMON_VERSION });
    const pluginResponse = await handlePluginRequest(req, svc.plugins, pathname, publicOrigin(svc.cfg, server.requestIP(req)?.address, req.headers, url));
    if (pluginResponse !== undefined) return pluginResponse;

    if (pathname === "/api/agents" && req.method === "GET") return json(svc.agents.list());
    const agentRecheck = pathname.match(/^\/api\/agents\/([\w-]+)\/recheck$/);
    if (agentRecheck && req.method === "POST") {
      const agentId = agentRecheck[1] as AgentId;
      if (!AGENT_IDS.includes(agentId)) return notFound(`unknown agent ${agentId}`);
      return json(await svc.agents.recheck(agentId));
    }

    if (pathname === "/api/bots" && req.method === "GET") return json(svc.bots.list());
    if (pathname === "/api/bots" && req.method === "POST") {
      const body = await parseBody(req, CreateBotBody);
      return json(svc.bots.create(body), 201);
    }

    const m = (re: RegExp): RegExpMatchArray | null => pathname.match(re);

    const botGet = m(/^\/api\/bots\/([\w-]+)$/);
    if (botGet && req.method === "GET") return json(svc.bots.getView(botGet[1]!));
    if (botGet && req.method === "PATCH") {
      const raw = (await req.json().catch(() => {
        throw new HttpError(400, "invalid JSON body");
      })) as Record<string, unknown>;
      if ("agentId" in raw && raw.agentId !== undefined) return json({ error: "agent cannot change" }, 400);
      const body = PatchBotBody.safeParse(raw);
      if (!body.success) throw new HttpError(400, body.error.issues[0]?.message ?? "invalid body");
      return json(svc.bots.patch(botGet[1]!, body.data));
    }
    const deletionResponse = await handleBotDeletionRequest(req, svc.botDeletions, pathname);
    if (deletionResponse) return deletionResponse;

    const attentionResponse = await handleBotAttentionRequest(req, svc.bots, pathname);
    if (attentionResponse) return attentionResponse;


    const avatarResponse = await handleAvatarRequest(req, svc.avatars, pathname);
    if (avatarResponse) return avatarResponse;

    const threadFeatureResponse = await handleThreadFeatureRequest(req, svc.threads, pathname);
    if (threadFeatureResponse) return threadFeatureResponse;

    const attachmentResponse = await handleAttachmentRequest(req, svc.attachments, pathname);
    if (attachmentResponse) return attachmentResponse;

    const botMessages = m(/^\/api\/bots\/([\w-]+)\/messages$/);
    if (botMessages && req.method === "POST") {
      // Lazy threads: first send atomically creates thread+message+turn.
      const body = await parseBody(req, SendMessageBody);
      const result = await svc.turns.send(
        botMessages[1]!,
        null,
        body.text.trim(),
        body.attachmentIds ?? [],
        body.attachmentDraftToken,
        body.deviceId === undefined ? {} : { deviceId: body.deviceId },
      );
      return json(result, 202);
    }

    const threadGet = m(/^\/api\/threads\/([\w-]+)$/);
    if (threadGet && req.method === "GET") {
      const t = svc.threads.getThread(threadGet[1]!);
      return t ? json(t) : notFound(`unknown thread ${threadGet[1]}`);
    }

    const threadMsgs = m(/^\/api\/threads\/([\w-]+)\/messages$/);
    if (threadMsgs && req.method === "GET") return json(svc.threads.listMessages(threadMsgs[1]!));
    if (threadMsgs && req.method === "POST") {
      const body = await parseBody(req, SendMessageBody);
      const thread = svc.threads.getThread(threadMsgs[1]!);
      if (!thread) return notFound(`unknown thread ${threadMsgs[1]}`);
      const result = await svc.turns.send(
        thread.botId,
        thread.id,
        body.text.trim(),
        body.attachmentIds ?? [],
        body.attachmentDraftToken,
        body.deviceId === undefined ? {} : { deviceId: body.deviceId },
      );
      return json(result, 202);
    }


    const dictationResponse = await handleDictationRequest(req, svc.dictation, pathname);
    if (dictationResponse) return dictationResponse;

    const projectionResponse = await handleProjectionRequest(req, svc.computer, svc.projections);
    if (projectionResponse) return projectionResponse;

    const computerResponse = await handleComputerRequest(req, svc.computer, svc.screens);
    if (computerResponse) return computerResponse;

    // Release: serve the built web UI if present.
    const dist = path.resolve(import.meta.dir, "../../../web/dist");
    if (existsSync(dist) && req.method === "GET" && !pathname.startsWith("/api/")) {
      const file = pathname === "/" ? "/index.html" : pathname;
      const f = Bun.file(path.join(dist, file));
      const document = await f.exists() ? f : Bun.file(path.join(dist, "index.html"));
      return new Response(document, { headers: { "referrer-policy": "no-referrer", ...(document.type.startsWith("text/html") ? { "cache-control": "no-store" } : {}) } });
    }

    return notFound("not found");
  };

  const handle = async (req: Request): Promise<Response> => {
    try {
      return await route(req);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, ...(err.extra ?? {}) }, err.status);
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  };

  const server = Bun.serve<WsData>({
    port: svc.cfg.port,
    hostname: svc.cfg.host,
    ...(svc.cfg.tlsCert && svc.cfg.tlsKey ? { tls: { key: Bun.file(svc.cfg.tlsKey), cert: Bun.file(svc.cfg.tlsCert) } } : {}),
    fetch: handle,
    websocket: {
      open(ws) {
        const data = ws.data;
        // A revoke can land between the upgrade gate and this callback.
        if (data.pairedDeviceId !== undefined && !data.svc.pairing.isActive(data.pairedDeviceId)) {
          ws.close(1008, "revoked");
          return;
        }
        if (data.pairedDeviceId !== undefined) {
          const registered = pairedSockets.get(data.pairedDeviceId);
          if (registered === undefined) pairedSockets.set(data.pairedDeviceId, new Set([ws]));
          else registered.add(ws);
        }
        if (data.kind === "projection" && !data.svc.projections.openSocket(data.reservation, ws)) {
          ws.close(1008, "Screen Projection socket is no longer valid");
        }
      },
      message(ws, raw) {
        const data = ws.data;
        if (data.pairedDeviceId !== undefined && !data.svc.pairing.isActive(data.pairedDeviceId)) {
          if (data.kind === "events") data.sub?.();
          ws.close(1008, "revoked");
          return;
        }
        if (data.kind === "projection") {
          const message = typeof raw === "string"
            ? raw
            : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength).slice();
          data.svc.projections.socketMessage(data.reservation, message);
          return;
        }
        if (data.kind === "device") {
          const port = data.port ?? {
            send: (frame) => ws.send(JSON.stringify(frame)),
            close: (code, reason) => ws.close(code, reason),
          };
          data.port = port;
          let frame: { type?: string };
          try {
            frame = JSON.parse(String(raw)) as { type?: string };
          } catch {
            return;
          }
          if (frame.type === "register") {
            const result = data.svc.devices.register(port, frame);
            if (!result.ok) {
              ws.send(JSON.stringify({ type: "error", error: result.error }));
              return;
            }
            data.deviceId = result.device.id;
            ws.send(JSON.stringify({ type: "registered", deviceId: result.device.id }));
            return;
          }
          if (frame.type === "heartbeat" && data.deviceId !== undefined) {
            data.svc.devices.heartbeat(port, data.deviceId);
            return;
          }
          if (frame.type === "local.result" && data.deviceId !== undefined) {
            data.svc.devices.complete(port, data.deviceId, frame);
            return;
          }
          return;
        }
        let msg: { type: string; lastCursor?: number };
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.type === "hello") {
          const last = msg.lastCursor ?? 0;
          const { events, snapshotRequired } = data.svc.events.replay(last, data.svc.events.oldestCursor());
          if (snapshotRequired) {
            ws.send(JSON.stringify({ type: "snapshot_required" }));
          } else {
            for (const e of events) ws.send(JSON.stringify({ type: "event", envelope: e }));
          }
          data.sub = data.svc.events.subscribe((env) => ws.send(JSON.stringify({ type: "event", envelope: env })));
          ws.send(JSON.stringify({ type: "hello", cursor: data.svc.events.oldestCursor() }));
        }
      },
      close(ws) {
        const data = ws.data;
        if (data.pairedDeviceId !== undefined) {
          const registered = pairedSockets.get(data.pairedDeviceId);
          registered?.delete(ws);
          if (registered?.size === 0) pairedSockets.delete(data.pairedDeviceId);
        }
        if (data.kind === "events") data.sub?.();
        else if (data.kind === "device" && data.port !== undefined) data.svc.devices.disconnect(data.port, data.deviceId);
        else if (data.kind === "projection") data.svc.projections.socketClosed(data.reservation);
      },
    },
  });

  return { port: server.port ?? svc.cfg.port, stop: () => server.stop(true) };
}
