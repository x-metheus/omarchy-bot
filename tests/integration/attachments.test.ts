import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AttachmentDto, MessageDto } from "../../packages/protocol/src/index.ts";
import { api, authedFetch, apiStatus, makeBot, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";

const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

async function stage(
  h: Harness,
  botId: string,
  file: Blob,
  name: string,
  draftToken: string = crypto.randomUUID(),
): Promise<{ status: number; body: AttachmentDto | { error: string }; draftToken: string }> {
  const form = new FormData();
  form.set("file", file, name);
  const response = await authedFetch(h, `${h.baseUrl}/api/attachments/stage`, {
    method: "POST",
    headers: {
      "x-bot-id": botId,
      "x-attachment-draft-token": draftToken,
      "x-command-id": crypto.randomUUID(),
    },
    body: form,
  });
  return {
    status: response.status,
    body: (await response.json()) as AttachmentDto | { error: string },
    draftToken,
  };
}

async function staged(h: Harness, id: string, draftToken: string): Promise<{ status: number; body?: AttachmentDto }> {
  const response = await authedFetch(h, `${h.baseUrl}/api/attachments/staged/${id}`, {
    headers: { "x-attachment-draft-token": draftToken },
  });
  return {
    status: response.status,
    ...(response.ok ? { body: (await response.json()) as AttachmentDto } : {}),
  };
}

describe("managed attachments", () => {
  let h: Harness;
  let botId: string;

  beforeAll(async () => {
    h = await startDaemon();
    botId = await makeBot(h, "Attachment Bot");
  });

  afterAll(async () => {
    await h.stop();
    rmSync(h.home, { recursive: true, force: true });
  });

  test("bounds uploads at 32 MiB and trusts sniffed bytes rather than declared media type", async () => {
    const tooLarge = await stage(
      h,
      botId,
      new Blob([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], { type: "text/plain" }),
      "too-large.txt",
    );
    expect(tooLarge.status).toBe(400);
    expect((tooLarge.body as { error: string }).error).toContain("32 MB");

    const pngBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
    const image = await stage(h, botId, new Blob([pngBytes], { type: "application/octet-stream" }), "actual.png");
    expect(image.status).toBe(201);
    expect((image.body as AttachmentDto).mediaType).toBe("image/png");

    const spoofed = await stage(h, botId, new Blob([Uint8Array.from([0, 1, 2, 3])], { type: "image/png" }), "spoofed.png");
    expect(spoofed.status).toBe(400);
    expect((spoofed.body as { error: string }).error).toContain("unsupported or invalid file content");
  });

  test("rejects missing and malformed draft ownership tokens at attachment HTTP boundaries", async () => {
    const malformed = await stage(
      h,
      botId,
      new Blob(["private"], { type: "text/plain" }),
      "private.txt",
      "not-a-uuid",
    );
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: "x-attachment-draft-token header must be a UUID" });
    const missing = await authedFetch(h, `${h.baseUrl}/api/attachments/staged/att_00000000000000000000000000000000`);
    expect(missing.status).toBe(400);


    const response = await authedFetch(h, `${h.baseUrl}/api/attachments/staged/att_00000000000000000000000000000000`, {
      headers: { "x-attachment-draft-token": "x".repeat(129) },
    });
    expect(response.status).toBe(400);
  });

  test("enforces bot ownership before atomically promoting a staged snapshot", async () => {
    const otherBotId = await makeBot(h, "Other Attachment Bot");
    const uploaded = await stage(h, botId, new Blob(["owned bytes"], { type: "text/plain" }), "owned.txt");
    const attachment = uploaded.body as AttachmentDto;

    const rejected = await apiStatus(h, "POST", `/api/bots/${otherBotId}/messages`, {
      text: "attachment-echo",
      attachmentIds: [attachment.id],
      attachmentDraftToken: uploaded.draftToken,
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body).toEqual({ error: `attachment ${attachment.id} is not staged for this draft` });
    expect((await staged(h, attachment.id, uploaded.draftToken)).status).toBe(200);

    const sent = await api<{ threadId: string; messageId: string }>(h, "POST", `/api/bots/${botId}/messages`, {
      text: "attachment-echo",
      attachmentIds: [attachment.id],
      attachmentDraftToken: uploaded.draftToken,
    });
    expect((await staged(h, attachment.id, uploaded.draftToken)).status).toBe(404);
    await waitThreadIdle(h, sent.threadId);

    const messages = await api<MessageDto[]>(h, "GET", `/api/threads/${sent.threadId}/messages`);
    const userMessage = messages.find((message) => message.id === sent.messageId);
    expect(userMessage?.attachments).toEqual([
      {
        id: attachment.id,
        kind: "managed",
        name: "owned.txt",
        mediaType: "text/plain",
        size: 11,
        url: `/api/attachments/${attachment.id}`,
      },
    ]);
    expect(messages.some((message) => message.author.kind === "bot" && message.text?.includes("owned.txt|text/plain|owned bytes"))).toBeTrue();
  });
  test("keeps a known staged id private and intact when another draft token reads, deletes, or sends it", async () => {
    const uploaded = await stage(h, botId, new Blob(["private bytes"], { type: "text/plain" }), "private.txt");
    const attachment = uploaded.body as AttachmentDto;
    const otherDraftToken = crypto.randomUUID();

    expect((await staged(h, attachment.id, otherDraftToken)).status).toBe(404);
    const deleted = await authedFetch(h, `${h.baseUrl}/api/attachments/staged/${attachment.id}`, {
      method: "DELETE",
      headers: { "x-attachment-draft-token": otherDraftToken },
    });
    expect(deleted.status).toBe(404);
    const rejected = await apiStatus(h, "POST", `/api/bots/${botId}/messages`, {
      text: "attachment-echo",
      attachmentIds: [attachment.id],
      attachmentDraftToken: otherDraftToken,
    });
    expect(rejected).toEqual({
      status: 400,
      body: { error: `attachment ${attachment.id} is not staged for this draft` },
    });

    expect((await staged(h, attachment.id, uploaded.draftToken)).body).toEqual(attachment);
    expect(
      h.svc.db.query(`SELECT kind, draft_token FROM attachments WHERE id = ?`).get(attachment.id),
    ).toEqual({ kind: "staged", draft_token: uploaded.draftToken });

    const sent = await api<{ threadId: string }>(h, "POST", `/api/bots/${botId}/messages`, {
      text: "attachment-echo",
      attachmentIds: [attachment.id],
      attachmentDraftToken: uploaded.draftToken,
    });
    await waitThreadIdle(h, sent.threadId);
  });


  test("serves immutable local bytes after the upload source disappears", async () => {
    const source = path.join(h.home, "source-that-will-disappear.txt");
    writeFileSync(source, "original snapshot");
    const uploaded = await stage(h, botId, Bun.file(source), "snapshot.txt");
    expect(uploaded.status).toBe(201);
    rmSync(source);
    expect(existsSync(source)).toBeFalse();

    const attachment = uploaded.body as AttachmentDto;
    const sent = await api<{ threadId: string }>(h, "POST", `/api/bots/${botId}/messages`, {
      text: "attachment-echo",
      attachmentIds: [attachment.id],
      attachmentDraftToken: uploaded.draftToken,
    });
    await waitThreadIdle(h, sent.threadId);

    const response = await authedFetch(h, `${h.baseUrl}/api/attachments/${attachment.id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(await response.text()).toBe("original snapshot");
  });

  test("rejects unsupported adapter media without consuming supported files in the draft", async () => {
    const textUpload = await stage(h, botId, new Blob(["keep me"], { type: "text/plain" }), "keep.txt");
    const pdfUpload = await stage(
      h,
      botId,
      new Blob(["%PDF-1.7\nunsupported"], { type: "application/pdf" }),
      "unsupported.pdf",
    );
    const textAttachment = textUpload.body as AttachmentDto;

    expect(pdfUpload.status).toBe(400);
    expect(pdfUpload.body).toEqual({ error: "pi cannot consume attachment media type application/pdf (unsupported.pdf)" });
    expect((await staged(h, textAttachment.id, textUpload.draftToken)).status).toBe(200);

    const sent = await api<{ threadId: string }>(h, "POST", `/api/bots/${botId}/messages`, {
      text: "attachment-echo",
      attachmentIds: [textAttachment.id],
      attachmentDraftToken: textUpload.draftToken,
    });
    await waitThreadIdle(h, sent.threadId);
    expect((await staged(h, textAttachment.id, textUpload.draftToken)).status).toBe(404);
  });

  test("leaves legacy tokenless staged rows inaccessible until age GC deletes them without touching managed files", async () => {
    const stale = await stage(h, botId, new Blob(["stale"], { type: "text/plain" }), "stale.txt");
    const managed = await stage(h, botId, new Blob(["managed"], { type: "text/plain" }), "managed.txt");
    const staleAttachment = stale.body as AttachmentDto;
    const managedAttachment = managed.body as AttachmentDto;
    const sent = await api<{ threadId: string }>(h, "POST", `/api/bots/${botId}/messages`, {
      text: "attachment-echo",
      attachmentIds: [managedAttachment.id],
      attachmentDraftToken: managed.draftToken,
    });
    await waitThreadIdle(h, sent.threadId);
    h.svc.db.query("UPDATE attachments SET draft_token = NULL WHERE id = ?").run(staleAttachment.id);
    expect((await staged(h, staleAttachment.id, stale.draftToken)).status).toBe(404);
    const unstageLegacy = await authedFetch(h, `${h.baseUrl}/api/attachments/staged/${staleAttachment.id}`, {
      method: "DELETE",
      headers: { "x-attachment-draft-token": stale.draftToken },
    });
    expect(unstageLegacy.status).toBe(404);
    expect(h.svc.db.query("SELECT id FROM attachments WHERE id = ?").get(staleAttachment.id)).not.toBeNull();


    h.svc.db.query("UPDATE attachments SET created_at = ? WHERE id = ?").run(
      new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      staleAttachment.id,
    );
    expect(h.svc.attachments.gcStaged()).toBe(1);
    expect((await staged(h, staleAttachment.id, stale.draftToken)).status).toBe(404);
    expect((await authedFetch(h, `${h.baseUrl}/api/attachments/${managedAttachment.id}`)).status).toBe(200);
  });
});
