import { useEffect, useRef, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { ChatComposer, ChatLayout, ChatMessage, ChatMessageBubble, ChatMessageList } from "@astryxdesign/core/Chat";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { attachmentAccept, AttachmentSelectionError, maxAttachments, type AgentAttachment, type DraftAttachment } from "../lib/agentAttachments.ts";
import { agentDaemon, DaemonError, followConversation, type AgentConversation, type AgentMessage, type AgentWork, type ToolProgress } from "../lib/agentDaemon.ts";
import { AgentAttachmentPreview } from "./AgentAttachmentPreview.tsx";

export interface ConversationFeed {
  cursor: string;
  conversation?: AgentConversation;
  replies: Map<number, AgentMessage>;
  work: Map<number, AgentWork>;
  tools: Map<string, ToolProgress>;
  delta: string;
  error: string;
}

const workLabel = {
  queued: "Queued",
  running: "Working",
  waiting: "Waiting for delegated work",
  completed: "Completed",
  failed: "Work failed",
  interrupted: "Work interrupted",
};

export function AgentConversationView({ botId, feed, onMissing }: {
  botId: string;
  feed: ConversationFeed;
  onMissing: (botId: string) => void;
}) {
  const [, paint] = useState(0);
  const [connection, setConnection] = useState<"connecting" | "connected" | "offline">("connecting");
  const [draft, setDraft] = useState("");
  const [failure, setFailure] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [viewing, setViewing] = useState<AgentAttachment>();
  const composerDisabled = connection !== "connected" || submitting;

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let refreshing = false;
    let refreshAgain = false;
    const update = () => paint(value => value + 1);
    async function refresh() {
      refreshAgain = true;
      if (refreshing) return;
      refreshing = true;
      try {
        while (refreshAgain && !signal.aborted) {
          refreshAgain = false;
          const result = await agentDaemon.conversation(botId, signal);
          if (signal.aborted) break;
          feed.conversation = result;
          for (const message of result.messages) feed.replies.delete(message.id);
          update();
        }
      } catch (error) {
        if (!signal.aborted && error instanceof DaemonError && error.status === 404) onMissing(botId);
      } finally {
        refreshing = false;
      }
    }
    async function connect() {
      while (!signal.aborted) {
        try {
          await followConversation(botId, feed.cursor, signal, () => {
            setConnection("connected");
            void refresh();
          }, ({ id, event, data }) => {
            if (signal.aborted) return;
            feed.cursor = id;
            switch (event) {
              case "work": {
                const work = data as AgentWork;
                feed.work.set(work.messageId, work);
                if (work.status === "queued") void refresh();
                if (work.status === "interrupted") feed.delta = "";
                break;
              }
              case "delta":
                if (typeof data === "string") feed.delta += data;
                feed.error = "";
                break;
              case "committed": {
                const reply = data as AgentMessage;
                if (!feed.conversation?.messages.some(message => message.id === reply.id)) feed.replies.set(reply.id, reply);
                feed.delta = "";
                feed.error = "";
                void refresh();
                break;
              }
              case "error":
                feed.delta = "";
                feed.error = data && typeof data === "object" && "message" in data && typeof data.message === "string"
                  ? data.message : "The Agent could not complete the reply.";
                break;
              case "tool": {
                const tool = data as ToolProgress;
                feed.tools.set(tool.id, tool);
                break;
              }
              default:
                return;
            }
            update();
          });
        } catch (error) {
          if (signal.aborted) return;
          if (error instanceof DaemonError && error.status === 401) return;
          if (error instanceof DaemonError && error.status === 404) {
            onMissing(botId);
            return;
          }
        }
        if (signal.aborted) return;
        setConnection("offline");
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 1000);
        await promise;
      }
    }
    void refresh();
    void connect();
    return () => controller.abort();
  }, [botId, feed, onMissing]);

  function attach(items: DraftAttachment[]) {
    if (composerDisabled || !items.length) return;
    if (attachments.length + items.length > maxAttachments) {
      setFailure(`A message can include up to ${maxAttachments} attachments.`);
      return;
    }
    setFailure("");
    setAttachments([...attachments, ...items]);
  }

  async function send(text: string) {
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    setDraft("");
    setFailure("");
    try {
      await agentDaemon.send(botId, text, attachments);
      setAttachments([]);
    } catch (error) {
      if (error instanceof DaemonError || error instanceof AttachmentSelectionError) {
        setDraft(current => current || text);
        setFailure(error.message);
      } else {
        setAttachments([]);
        setFailure("Could not confirm submission. Check the Conversation before sending it again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function retry(messageId: number) {
    setFailure("");
    try { await agentDaemon.retry(botId, messageId); }
    catch (error) { setFailure(error instanceof DaemonError ? error.message : "Could not confirm retry. Check the work status."); }
  }

  const messages = [...(feed.conversation?.messages ?? []), ...feed.replies.values()].sort((a, b) => a.id - b.id);
  const tools = [...feed.tools.values()];
  const visibleTools = tools.filter((tool, index) => tool.status === "running" || index >= tools.length - 5);
  return (
    <ChatLayout composer={<ChatComposer role="region" aria-label="Message composer"
      onDragOver={event => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = composerDisabled ? "none" : "copy";
      }}
      onDrop={event => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        attach(Array.from(event.dataTransfer.files));
      }}
      value={draft} onChange={setDraft} onSubmit={text => { void send(text); }}
      isDisabled={composerDisabled} placeholder="Message this Bot…"
      headerActions={<HStack gap={1} wrap="wrap" vAlign="center">
        <input ref={picker} type="file" accept={attachmentAccept} multiple hidden disabled={composerDisabled}
          onChange={event => {
            attach(Array.from(event.currentTarget.files ?? []));
            event.currentTarget.value = "";
          }} />
        <Button label="Attach files" size="sm" isDisabled={composerDisabled} onClick={() => picker.current?.click()} />
        <Text type="supporting" color="secondary">or drop files here</Text>
      </HStack>}
      footerActions={attachments.map((attachment, index) =>
        <Button key={index} label={`Remove ${attachment.name}`} size="sm" isDisabled={composerDisabled} onClick={() => {
          setAttachments(current => current.filter((_, position) => index !== position));
          setFailure("");
        }} />)}
      {...(failure || feed.error ? { status: { type: "error", message: failure || feed.error } } : {})} />}>
      <ChatMessageList isStreaming={Boolean(feed.delta)}>
        {connection === "offline" && <Banner status="warning" title="Connection lost. Reconnecting to the Agent Daemon…" />}
        {feed.conversation?.bot.duties && <Text color="secondary">Duties: {feed.conversation.bot.duties}</Text>}
        {messages.map(message => {
          const work = feed.work.get(message.id);
          return <ChatMessage key={message.id} sender={message.role}>
            <ChatMessageBubble>{message.text}</ChatMessageBubble>
            {message.attachments?.map((attachment, position) => <HStack key={`${attachment.id}:${position}`} gap={1} wrap="wrap" vAlign="center">
              <Button label={`View ${attachment.name}`} size="sm" onClick={() => setViewing(attachment)} />
              {attachment.available ? <Button label={`Reuse ${attachment.name}`} size="sm" isDisabled={composerDisabled}
                onClick={() => attach([attachment])} /> : <Text type="supporting" color="secondary">Submitted content unavailable</Text>}
            </HStack>)}
            {work && work.status !== "completed" && <VStack gap={1}>
              <Text color="secondary">{work.reason === "provider_unconfigured" ? "Queued until a model is configured" : workLabel[work.status]}</Text>
              {work.status === "interrupted" && <Button label="Retry interrupted work" size="sm" clickAction={() => retry(message.id)} />}
            </VStack>}
          </ChatMessage>;
        })}
        {feed.delta && <ChatMessage sender="assistant"><ChatMessageBubble>{feed.delta}</ChatMessageBubble></ChatMessage>}
        {visibleTools.map(tool => <Text key={tool.id} color="secondary">{tool.name} · {tool.status}</Text>)}
      </ChatMessageList>
      {viewing && <AgentAttachmentPreview botId={botId} attachment={viewing} close={() => setViewing(undefined)} />}
    </ChatLayout>
  );
}
