import { ApprovalAnswerBody } from "@omarchy-bot/protocol";
import { HttpError } from "../modules/bots/bots.ts";
import type { ApprovalStore } from "../modules/runtime/approvals.ts";

const json = (data: unknown): Response => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });

/** List pending requests (optionally for one Thread) and answer one. */
export async function handleApprovalRequest(req: Request, approvals: ApprovalStore | undefined, url: URL): Promise<Response | undefined> {
  if (url.pathname === "/api/approvals" && req.method === "GET") {
    const threadId = url.searchParams.get("threadId");
    return json(approvals?.listPending(threadId ? { threadId } : {}) ?? []);
  }
  const match = /^\/api\/approvals\/([\w-]+)\/answer$/.exec(url.pathname);
  if (match === null || req.method !== "POST") return undefined;
  const raw: unknown = await req.json().catch(() => {
    throw new HttpError(400, "invalid JSON body");
  });
  const body = ApprovalAnswerBody.safeParse(raw);
  if (!body.success) throw new HttpError(400, body.error.issues[0]?.message ?? "invalid body");
  if (!approvals) throw new HttpError(404, "approval not found");
  return json(approvals.answer(match[1]!, body.data.answer));
}
