import { PatchThreadBody } from "@omarchy-bot/protocol";
import type { ThreadsService } from "../modules/threads/threads.ts";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

/**
 * Self-contained T04 routes. The main HTTP router can delegate before its
 * generic not-found branch and leave unrelated endpoints untouched.
 */
export async function handleThreadFeatureRequest(
  req: Request,
  threads: ThreadsService,
  pathname: string,
): Promise<Response | undefined> {
  const botThreads = /^\/api\/bots\/([\w-]+)\/threads$/.exec(pathname);
  if (botThreads !== null && req.method === "GET") {
    const q = new URL(req.url).searchParams.get("q") ?? undefined;
    return json(threads.listThreadsForBot(botThreads[1]!, q));
  }

  const thread = /^\/api\/threads\/([\w-]+)$/.exec(pathname);
  if (thread === null || req.method !== "PATCH") return undefined;

  const parsed = PatchThreadBody.safeParse(await readJson(req));
  if (!parsed.success) return json({ error: "invalid request body" }, 400);

  const updated = threads.updateTitle(thread[1]!, parsed.data.title);
  return updated === undefined
    ? json({ error: `unknown thread ${thread[1]!}` }, 404)
    : json(updated);
}
