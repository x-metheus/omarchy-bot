import { useEffect, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { isAttachmentImage, type AgentAttachment } from "../lib/agentAttachments.ts";
import { agentDaemon, DaemonError } from "../lib/agentDaemon.ts";

const styles = stylex.create({
  text: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "45dvh", overflow: "auto" },
  image: { maxWidth: "100%", maxHeight: "45dvh", objectFit: "contain", alignSelf: "start" },
});

type Preview = { kind: "text" | "image" | "unavailable" | "error"; value: string };

export function AgentAttachmentPreview({ botId, attachment, close }: {
  botId: string;
  attachment: AgentAttachment;
  close: () => void;
}) {
  const [preview, setPreview] = useState<Preview>();
  const [saveError, setSaveError] = useState("");
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
    const name = attachment.name.replace(/[<>:"/\\|?*\p{Cc}]/gu, "_");
    const extension = isText ? "txt" : attachment.mediaType.slice("image/".length);
    const lower = name.toLowerCase();
    const hasExtension = lower.endsWith(`.${extension}`) || (extension === "jpeg" && lower.endsWith(".jpg"));
    try { await agentDaemon.saveAttachment(botId, attachment.id, hasExtension ? name : `${name}.${extension}`); }
    catch { setSaveError("Could not save the submitted content. Check the connection and Downloads permissions."); }
  }

  return <Dialog isOpen onOpenChange={open => { if (!open) close(); }} width={520}>
    <DialogHeader title={attachment.name} />
    <VStack gap={2}>
      <Text color="secondary">Original file unavailable in Conversation.</Text>
      {!canPreview ? <Text>Submitted content is unavailable.</Text> :
        !preview ? <Text>Loading submitted content…</Text> :
        preview.kind === "text" ? <Text as="p" xstyle={styles.text}>{preview.value}</Text> :
        preview.kind === "image" ? <img src={preview.value} alt={attachment.name} {...stylex.props(styles.image)} /> :
        <Banner status={preview.kind === "error" ? "error" : "warning"} title={preview.value} />}
      {saveError && <Banner status="error" title={saveError} />}
      <HStack gap={2} justify="end" wrap="wrap">
        <Button label="Close" onClick={close} />
        {canPreview && (preview?.kind === "text" || preview?.kind === "image") &&
          <Button label="Save submitted content" variant="primary" clickAction={save} />}
      </HStack>
    </VStack>
  </Dialog>;
}
