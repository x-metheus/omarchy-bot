import { useEffect, useState } from "react";
import { CircleAlertIcon, DownloadIcon, FileTextIcon, ImageIcon } from "@/components/icons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { isAttachmentImage, type AgentAttachment } from "../lib/agentAttachments.ts";
import { agentDaemon, DaemonError } from "../lib/agentDaemon.ts";

type Preview = { kind: "text" | "image" | "unavailable" | "error"; value: string };

export function AgentAttachmentPreview({ botId, attachment, close }: {
  botId: string;
  attachment: AgentAttachment;
  close: () => void;
}) {
  const [preview, setPreview] = useState<Preview>();
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const isText = attachment.mediaType === "text/plain";
  const canPreview = attachment.available && (isText || isAttachmentImage(attachment.mediaType));
  useEffect(() => {
    if (!canPreview) return;
    const controller = new AbortController();
    const { signal } = controller;
    let url: string | undefined;
    async function load() {
      try {
        const response = await agentDaemon.attachment(botId, attachment.id, signal);
        const mediaType = response.headers.get("content-type")?.split(";", 1)[0];
        if (mediaType !== attachment.mediaType) throw new Error("Unexpected attachment format");
        if (isText) {
          const text = await response.text();
          if (!signal.aborted) setPreview({ kind: "text", value: text });
        } else {
          const blob = await response.blob();
          if (signal.aborted) return;
          url = URL.createObjectURL(blob);
          setPreview({ kind: "image", value: url });
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof DaemonError && (error.status === 404 || error.status === 410)) {
          setPreview({ kind: "unavailable", value: "Submitted content is unavailable." });
        } else {
          setPreview({ kind: "error", value: "Could not load the submitted content. Check the connection and reopen the attachment." });
        }
      }
    }
    void load();
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [attachment.id, attachment.mediaType, botId, canPreview, isText]);

  async function save() {
    setSaveError("");
    setSaving(true);
    const name = attachment.name.replace(/[<>:"/\\|?*\p{Cc}]/gu, "_");
    const extension = isText ? "txt" : attachment.mediaType.slice("image/".length);
    const lower = name.toLowerCase();
    const hasExtension = lower.endsWith(`.${extension}`) || (extension === "jpeg" && lower.endsWith(".jpg"));
    try { await agentDaemon.saveAttachment(botId, attachment.id, hasExtension ? name : `${name}.${extension}`); }
    catch { setSaveError("Could not save the submitted content. Check the connection and Downloads permissions."); }
    finally { setSaving(false); }
  }

  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 wrap-anywhere">
          {isText ? <FileTextIcon className="size-4 shrink-0" aria-hidden="true" /> : <ImageIcon className="size-4 shrink-0" aria-hidden="true" />}
          {attachment.name}
        </DialogTitle>
        <DialogDescription>Preview of the submitted content.</DialogDescription>
      </DialogHeader>
      {!canPreview ? <p>Submitted content is unavailable.</p> :
        !preview ? <p role="status" className="flex items-center gap-2"><Spinner /> Loading submitted content…</p> :
        preview.kind === "text" ? <CodeBlock><CodeBlockContent wrap className="max-h-[45dvh]">{preview.value}</CodeBlockContent></CodeBlock> :
        preview.kind === "image" ? <img src={preview.value} alt={attachment.name} className="max-h-[45dvh] max-w-full object-contain" /> :
        <Alert variant={preview.kind === "error" ? "destructive" : "default"}><CircleAlertIcon /><AlertDescription>{preview.value}</AlertDescription></Alert>}
      {saveError && <Alert variant="destructive"><CircleAlertIcon /><AlertDescription>{saveError}</AlertDescription></Alert>}
      <DialogFooter>
        <Button variant="outline" onClick={close}>Close</Button>
        {canPreview && (preview?.kind === "text" || preview?.kind === "image") &&
          <Button disabled={saving} onClick={() => void save()}>
            {saving ? <Spinner data-icon="inline-start" /> : <DownloadIcon data-icon="inline-start" />} Save submitted content
          </Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
