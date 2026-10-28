import type { ChangeEvent, CSSProperties, DragEvent, JSX, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import * as stylex from "@stylexjs/stylex";
import { Paperclip } from "lucide-react";
import { AspectRatio } from "@astryxdesign/core/AspectRatio";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import {
  ChatComposer,
  ChatComposerDrawer,
  ChatComposerInput,
  ChatLayout,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatSystemMessage,
  ChatToolCalls,
  type ChatToolCallItem,
  type ChatComposerTrigger,
} from "@astryxdesign/core/Chat";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Markdown, type MarkdownComponents } from "@astryxdesign/core/Markdown";
import { Item } from "@astryxdesign/core/Item";
import type { SearchSource } from "@astryxdesign/core/Typeahead";
import { Token } from "@astryxdesign/core/Token";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { useContainerReveal } from "@astryxdesign/core/hooks";
import type {
  AgentDto,
  AttachmentDto,
  BotViewDto,
  DictationDto,
  DictationResultDto,
  MessageDto,
  ThreadDto,
  ToolCallSummaryDto,
} from "@omarchy-bot/protocol";
import { isTerminalTurn } from "@omarchy-bot/domain";
import { api, apiErrorMessage, randomUuid, trimSendText } from "../lib/api.ts";
import { loadDraft, saveDraft, type ConversationDraft } from "../lib/drafts.ts";
import { withDeviceToken } from "../lib/urls.ts";
import { insertDictationTranscript } from "../lib/dictation.ts";
import {
  thinkingBoundaryAnnouncements,
  toolCallBoundaryAnnouncements,
  type ThinkingAnnouncementState,
} from "../lib/transcriptAnnouncements.ts";
import { WorkingAvatarView } from "./AvatarView.tsx";
import { useTranscriptAttentionSurface } from "./TranscriptAttention.tsx";
import styles from "../lib/styles.ts";

export interface VoiceDraftTarget {
  botId: string;
  threadId?: string;
}

export interface DictationController {
  state: DictationDto;
  start: () => Promise<DictationDto>;
  stop: () => Promise<DictationResultDto>;
  cancel: () => Promise<DictationDto>;
}

interface ChatPanelProps {
  bot?: BotViewDto;
  thread?: ThreadDto;
  messages: MessageDto[];
  onMessageSent: (threadId: string) => void;
  isAgentReady: boolean;
  supportsSteering: boolean;
  agentReadiness?: AgentDto;
  onRetryAgentReadiness?: () => Promise<void>;
  dictation: DictationController;
  autoSendVoice: boolean;
  onVoiceAutoSend: (target: VoiceDraftTarget, text: string) => Promise<void>;
  messagesLoading?: boolean;
  messagesError?: string;
  onRetryMessages?: () => void;
}

interface ContextualErrorCard {
  key: string;
  title: string;
  description: string;
  retry?: () => Promise<void>;
}


type Row =
  | { kind: "message"; message: MessageDto }
  | { kind: "responses"; key: string; items: MessageDto[] }
  | { kind: "tools"; key: string; items: MessageDto[] };

function ExternalMarkdownLink({ href, children }: { href: string; children: ReactNode }): JSX.Element {
  let protocol: string;
  try {
    protocol = new URL(href).protocol.toLowerCase();
  } catch {
    return <>{children}</>;
  }
  if (protocol !== "http:" && protocol !== "https:" && protocol !== "mailto:") {
    return <>{children}</>;
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...stylex.props(styles.markdownLink)}>
      {children}
    </a>
  );
}

function DirectMarkdownImage({ src, alt }: { src: string; alt: string }): JSX.Element {
  let protocol: string;
  try {
    protocol = new URL(src).protocol.toLowerCase();
  } catch {
    return <>{`[${alt}]`}</>;
  }
  if (protocol !== "http:" && protocol !== "https:") return <>{`[${alt}]`}</>;
  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      {...stylex.props(styles.markdownImage)}
    />
  );
}

const MARKDOWN_COMPONENTS: MarkdownComponents = {
  link: ExternalMarkdownLink,
  image: DirectMarkdownImage,
};

// Astryx uses its disabled token for optional Tool Call metadata. At this
// integration boundary, promote that token to readable primary text while
// preserving the component's explicit running/completed/error and diff colors.
const TOOL_CALL_TEXT_CONTRAST_STYLE = {
  "--color-text-disabled": "var(--color-text-primary)",
} as CSSProperties;

function MessageMarkdown({ text, isStreaming = false }: { text: string; isStreaming?: boolean }): JSX.Element {
  const reveal = useContainerReveal();
  const revealProps = reveal.getContainerProps();
  return (
    <Markdown
      density="compact"
      headingLevelStart={3}
      contentWidth="100%"
      isStreaming={isStreaming}
      components={MARKDOWN_COMPONENTS}
      data-testid={isStreaming ? "streaming-markdown" : "message-markdown"}
      {...revealProps}
      className={[revealProps.className, "omarchy-message-markdown"].filter(Boolean).join(" ")}
    >
      {text}
    </Markdown>
  );
}

/** Preserve records while joining only adjacent Responses or adjacent Tool Calls. */
export function groupTranscriptRows(messages: MessageDto[]): Row[] {
  const out: Row[] = [];
  let tools: MessageDto[] = [];
  let responses: MessageDto[] = [];
  const flushTools = (): void => {
    if (tools.length > 0) {
      out.push({ kind: "tools", key: tools[0]!.id, items: tools });
      tools = [];
    }
  };
  const flushResponses = (): void => {
    if (responses.length > 0) {
      out.push({ kind: "responses", key: responses[0]!.id, items: responses });
      responses = [];
    }
  };
  for (const message of messages) {
    if (message.kind === "response") {
      flushTools();
      responses.push(message);
      continue;
    }
    if (message.kind === "tool") {
      flushResponses();
      tools.push(message);
      continue;
    }
    flushResponses();
    flushTools();
    if (message.kind === "event") continue;
    out.push({ kind: "message", message });
  }
  flushResponses();
  flushTools();
  return out;
}

function formatToolDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

export function formatThinkingDuration(startedAt: string, completedAt: string): string {
  const elapsed = Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
  return formatToolDuration(Number.isFinite(elapsed) ? elapsed : 0);
}

function ThinkingDisclosure({ message }: { message: MessageDto }): JSX.Element | null {
  const [isOpen, setIsOpen] = useState(false);
  const thinking = message.thinking;
  if (thinking === undefined) return null;
  const header = thinking.state === "streaming"
    ? "Thinking…"
    : `Thinking complete · ${formatThinkingDuration(thinking.startedAt, thinking.completedAt ?? thinking.startedAt)}`;
  return (
    <ChatMessage
      sender="assistant"
      data-testid="thinking-message"
      data-thinking-state={thinking.state}
    >
      <Collapsible
        trigger={header}
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        className="omarchy-thinking-disclosure"
        data-open={isOpen}
      >
        <div {...stylex.props(styles.disclosureContent)} inert={!isOpen} aria-hidden={!isOpen}>
          <MessageMarkdown
            text={message.text ?? ""}
            isStreaming={thinking.state === "streaming"}
          />
        </div>
      </Collapsible>
    </ChatMessage>
  );
}

function PeerMailSystemMessage({ message }: { message: MessageDto }): JSX.Element {
  return (
    <ChatSystemMessage>
      <VStack gap={1} data-testid="peer-mail-message">
        <Text type="label-lg">{`From ${message.peerMail!.sourceName}`}</Text>
        <Text>{message.text ?? ""}</Text>
      </VStack>
    </ChatSystemMessage>
  );
}

function toChatToolCall(message: MessageDto): ChatToolCallItem | undefined {
  const toolCall = message.toolCall;
  if (toolCall === undefined) return undefined;
  return {
    key: toolCall.id,
    name: toolCall.name,
    status: toolCall.status === "completed" ? "complete" : toolCall.status,
    ...(toolCall.target !== undefined ? { target: toolCall.target } : {}),
    ...(toolCall.durationMs !== undefined ? { duration: formatToolDuration(toolCall.durationMs) } : {}),
    ...(toolCall.additions !== undefined ? { additions: toolCall.additions } : {}),
    ...(toolCall.deletions !== undefined ? { deletions: toolCall.deletions } : {}),
    ...(toolCall.errorSummary !== undefined ? { errorMessage: toolCall.errorSummary } : {}),
  };
}


const EMPTY_DRAFT: ConversationDraft = { text: "", cursor: 0, stagedIds: [] };

function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function apiStatus(error: unknown): number | undefined {
  if (error !== null && typeof error === "object" && "status" in error && typeof error.status === "number") return error.status;
  return undefined;
}

function attachmentErrorMessage(error: unknown, fileName: string): string {
  const status = apiStatus(error);
  if (status === 413) return `${fileName} is too large to attach. Choose a smaller file and try again.`;
  if (status === 400 || status === 415) {
    return `This bot can’t use ${fileName}. Remove it or choose a supported file.`;
  }
  return `${fileName} couldn’t be attached. Check your connection and try again.`;
}

function AttachmentContent({ attachment, previewUrl }: { attachment: AttachmentDto; previewUrl?: string }): JSX.Element {
  // The daemon route needs the token; object URLs used for staged previews do not.
  const downloadUrl = attachment.url === undefined ? undefined : withDeviceToken(attachment.url);
  const imageUrl = attachment.mediaType.startsWith("image/")
    ? previewUrl ?? downloadUrl
    : undefined;
  const metadata = `${attachment.mediaType} · ${formatAttachmentSize(attachment.size)}`;
  if (imageUrl !== undefined) {
    return (
      <AspectRatio ratio={4 / 3} fit="cover" xstyle={styles.attachmentPreview}>
        <img
          src={imageUrl}
          alt={attachment.name}
          loading="lazy"
          {...stylex.props(styles.attachmentImage)}
          data-testid={attachment.kind === "managed" ? "message-image-attachment" : "staged-image-preview"}
        />
      </AspectRatio>
    );
  }
  return (
    <Item
      label={attachment.name}
      description={metadata}
      density="compact"
      {...(downloadUrl !== undefined ? { href: downloadUrl } : {})}
      data-testid={downloadUrl !== undefined ? "message-file-attachment" : "staged-file-row"}
    />
  );
}

function StagedAttachment({
  attachment,
  previewUrl,
  onRemove,
}: {
  attachment: AttachmentDto;
  previewUrl?: string;
  onRemove: (attachment: AttachmentDto) => Promise<void>;
}): JSX.Element {
  const reveal = useContainerReveal();
  const isImage = attachment.mediaType.startsWith("image/") && previewUrl !== undefined;
  return (
    <div
      {...reveal.getContainerProps()}
      data-testid="staged-attachment"
      data-attachment-id={attachment.id}
    >
      <Item
        label={attachment.name}
        description={attachment.mediaType}
        density="compact"
        startContent={
          isImage ? (
            <AspectRatio ratio={1} fit="cover" xstyle={styles.attachmentThumbnail}>
              <img
                src={previewUrl}
                alt={attachment.name}
                {...stylex.props(styles.attachmentImage)}
                data-testid="staged-image-preview"
              />
            </AspectRatio>
          ) : (
            <Icon icon="info" size="sm" />
          )
        }
        endContent={
          <HStack gap={1}>
            <Token
              label={formatAttachmentSize(attachment.size)}
              size="sm"
              description={`File size for ${attachment.name}`}
            />
            <Button
              {...reveal.getContentRevealProps({ isLayoutPreserved: true })}
              label={`Remove ${attachment.name}`}
              icon={<Icon icon="close" size="sm" />}
              variant="ghost"
              size="sm"
              isIconOnly
              onClick={() => void onRemove(attachment)}
              data-testid="remove-staged-attachment"
            />
          </HStack>
        }
        {...(!isImage ? { "data-testid": "staged-file-row" } : {})}
      />
    </div>
  );
}

function AttachmentDrawer({
  attachments,
  previewUrls,
  onRemove,
}: {
  attachments: AttachmentDto[];
  previewUrls: Map<string, string>;
  onRemove: (attachment: AttachmentDto) => Promise<void>;
}): JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null);
  const [retainedHeight, setRetainedHeight] = useState(0);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const isPresent = attachments.length > 0;

  // Keep only measured geometry during exit, never staged data or controls.
  // The native drawer's grid remains the sole content-size animation owner.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!isPresent || content === null) return;
    const measure = (): void => setRetainedHeight(content.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [isPresent]);

  useEffect(() => {
    if (isPresent) return;
    setIsCollapsed(false);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const clearWhenReduced = (): void => {
      if (reducedMotion.matches) setRetainedHeight(0);
    };
    clearWhenReduced();
    reducedMotion.addEventListener("change", clearWhenReduced);
    return () => reducedMotion.removeEventListener("change", clearWhenReduced);
  }, [isPresent]);

  return (
    <ChatComposerDrawer
      count={attachments.length}
      label="Attachments"
      isCollapsed={!isPresent || isCollapsed}
      onCollapsedChange={setIsCollapsed}
      className="omarchy-attachment-drawer"
      data-testid="attachment-drawer"
      data-present={isPresent}
      inert={!isPresent}
      aria-hidden={!isPresent}
      onTransitionEnd={(event) => {
        if (!isPresent && event.target === event.currentTarget) setRetainedHeight(0);
      }}
    >
      {isPresent ? (
        <VStack
          ref={contentRef}
          gap={1}
          aria-label="Staged attachments"
          inert={!isPresent || isCollapsed}
          aria-hidden={!isPresent || isCollapsed}
        >
          {attachments.map((attachment) => (
            <StagedAttachment
              key={attachment.id}
              attachment={attachment}
              previewUrl={previewUrls.get(attachment.id)}
              onRemove={onRemove}
            />
          ))}
        </VStack>
      ) : (
        <div aria-hidden style={{ height: retainedHeight, width: "100%" }} />
      )}
    </ChatComposerDrawer>
  );
}
interface DictationOrigin {
  target: VoiceDraftTarget;
  anchor: number;
}
interface AttachmentRestoreResult {
  id: string;
  attachment?: AttachmentDto;
  error?: unknown;
}

function composerCursor(root: HTMLDivElement | null, fallback: number): number {
  if (root === null) return fallback;
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.anchorNode === null || !root.contains(selection.anchorNode)) {
    return fallback;
  }
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(selection.anchorNode, selection.anchorOffset);
  return range.toString().length;
}


export function ChatPanel({
  bot,
  thread,
  messages,
  onMessageSent,
  isAgentReady,
  supportsSteering,
  agentReadiness,
  onRetryAgentReadiness,
  dictation,
  autoSendVoice,
  onVoiceAutoSend,
  messagesLoading = false,
  messagesError,
  onRetryMessages,
}: ChatPanelProps): JSX.Element {
  const [draft, setDraft] = useState<ConversationDraft>(EMPTY_DRAFT);
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);
  const [dismissedErrorKeys, setDismissedErrorKeys] = useState<ReadonlySet<string>>(() => new Set());
  const dismissError = useCallback((key: string): void => {
    setDismissedErrorKeys((current) => {
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      return next;
    });
  }, []);
  const [voiceStatus, setVoiceStatus] = useState<string | undefined>(undefined);
  const [voiceState, setVoiceState] = useState<DictationDto>(dictation.state);
  const [stagedAttachments, setStagedAttachments] = useState<AttachmentDto[]>([]);
  const [restoringAttachments, setRestoringAttachments] = useState(false);
  const composerInputRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewUrlsRef = useRef(new Map<string, string>());
  const restoreGenerationRef = useRef(0);
  const dictationOriginRef = useRef<DictationOrigin | undefined>(undefined);
  const [workingAnnouncement, setWorkingAnnouncement] = useState("");
  const workingStateRef = useRef<{ selectionKey: string; active: boolean; name: string } | undefined>(undefined);
  const [toolCallAnnouncement, setToolCallAnnouncement] = useState("");
  const toolCallAnnouncementRef = useRef<{
    selectionKey: string | undefined;
    calls: Map<string, ToolCallSummaryDto>;
  }>({ selectionKey: undefined, calls: new Map() });
  const [thinkingAnnouncement, setThinkingAnnouncement] = useState("");
  const thinkingAnnouncementRef = useRef<{
    selectionKey: string | undefined;
    blocks: Map<string, ThinkingAnnouncementState>;
  }>({ selectionKey: undefined, blocks: new Map() });
  const draftBotId = bot?.id;
  const draftThreadId = thread?.id;
  const selectedDraftRef = useRef({ botId: draftBotId, threadId: draftThreadId });
  const restoredDraftRef = useRef({ botId: draftBotId, threadId: draftThreadId });
  const transcriptAttention = useTranscriptAttentionSurface();
  selectedDraftRef.current = { botId: draftBotId, threadId: draftThreadId };

  // Restore this conversation's staged files without blocking text editing.
  useEffect(() => {
    const generation = ++restoreGenerationRef.current;
    restoredDraftRef.current = { botId: draftBotId, threadId: draftThreadId };
    setSubmitError(undefined);
    setStagedAttachments([]);
    if (draftBotId === undefined) {
      setDraft(EMPTY_DRAFT);
      setRestoringAttachments(false);
      return;
    }

    const restored = loadDraft(draftBotId, draftThreadId);
    setDraft(restored);
    if (restored.stagedIds.length === 0) {
      setRestoringAttachments(false);
      return;
    }
    setRestoringAttachments(true);
    const draftToken = restored.attachmentDraftToken;
    if (draftToken === undefined) {
      const next = { ...restored, stagedIds: [] };
      saveDraft(draftBotId, draftThreadId, next);
      setDraft(next);
      setRestoringAttachments(false);
      setSubmitError("Staged attachments from an older draft are no longer available and were removed from this draft.");
      return;
    }
    void Promise.all(restored.stagedIds.map(async (id): Promise<AttachmentRestoreResult> => {
      try {
        return { id, attachment: await api.getStagedAttachment(id, draftToken) };
      } catch (error) {
        return { id, error };
      }
    })).then((results) => {
      if (restoreGenerationRef.current !== generation) return;
      const valid = results.flatMap((result) => result.attachment === undefined ? [] : [result.attachment]);
      const missing = new Set(results.filter((result) => result.error !== undefined && apiStatus(result.error) === 404).map((result) => result.id));
      const unavailable = results.some((result) => result.error !== undefined && apiStatus(result.error) !== 404);
      const stagedIds = restored.stagedIds.filter((id) => !missing.has(id));
      const next: ConversationDraft = {
        ...restored,
        stagedIds,
        ...(stagedIds.length === 0 ? { attachmentDraftToken: undefined } : {}),
      };
      if (missing.size > 0) saveDraft(draftBotId, draftThreadId, next);
      setDraft(next);
      setStagedAttachments(valid);
      setRestoringAttachments(false);
      if (missing.size > 0) {
        setSubmitError(`${missing.size === 1 ? "A staged attachment is" : `${missing.size} staged attachments are`} no longer available and ${missing.size === 1 ? "was" : "were"} removed from this draft.`);
      } else if (unavailable) {
        setSubmitError("Some draft attachments couldn’t be checked. They are still saved with this draft; check your connection and try again.");
      }
    });
  }, [draftBotId, draftThreadId]);

  useEffect(() => () => {
    for (const previewUrl of previewUrlsRef.current.values()) URL.revokeObjectURL(previewUrl);
    previewUrlsRef.current.clear();
  }, []);

  useEffect(() => {
    setVoiceState(dictation.state);
  }, [dictation.state]);

  const onDraftChange = useCallback(
    (value: string) => {
      setDraft((current) => {
        const next: ConversationDraft = { ...current, text: value, cursor: value.length };
        if (draftBotId !== undefined) saveDraft(draftBotId, draftThreadId, next);
        return next;
      });
    },
    [draftBotId, draftThreadId],
  );
  const stageFiles = useCallback(async (files: readonly File[]): Promise<void> => {
    if (draftBotId === undefined || files.length === 0) return;
    const origin = { botId: draftBotId, threadId: draftThreadId };
    const storedDraft = loadDraft(origin.botId, origin.threadId);
    const draftToken = storedDraft.attachmentDraftToken ?? randomUuid();
    const ownedDraft = { ...storedDraft, attachmentDraftToken: draftToken };
    saveDraft(origin.botId, origin.threadId, ownedDraft);
    setDraft((current) => {
      const selected = selectedDraftRef.current;
      return selected.botId === origin.botId && selected.threadId === origin.threadId
        ? { ...current, attachmentDraftToken: draftToken }
        : current;
    });
    setSubmitError(undefined);
    const staged: AttachmentDto[] = [];
    const errors: string[] = [];
    for (const file of files) {
      try {
        const attachment = await api.stageAttachment(origin.botId, draftToken, file);
        staged.push(attachment);
        if (attachment.mediaType.startsWith("image/")) {
          previewUrlsRef.current.set(attachment.id, URL.createObjectURL(file));
        }
      } catch (error) {
        errors.push(attachmentErrorMessage(error, file.name));
      }
    }
    if (staged.length > 0) {
      const stored = loadDraft(origin.botId, origin.threadId);
      const next: ConversationDraft = {
        ...stored,
        stagedIds: [...new Set([...stored.stagedIds, ...staged.map((attachment) => attachment.id)])],
        attachmentDraftToken: draftToken,
      };
      saveDraft(origin.botId, origin.threadId, next);
      const selected = selectedDraftRef.current;
      if (selected.botId === origin.botId && selected.threadId === origin.threadId) {
        restoreGenerationRef.current += 1;
        setDraft(next);
        setStagedAttachments((current) => {
          const byId = new Map(current.map((attachment) => [attachment.id, attachment]));
          for (const attachment of staged) byId.set(attachment.id, attachment);
          return [...byId.values()];
        });
      }
    }
    if (errors.length > 0) {
      const selected = selectedDraftRef.current;
      if (selected.botId === origin.botId && selected.threadId === origin.threadId) {
        setSubmitError(errors.join(" "));
      }
    }
  }, [draftBotId, draftThreadId]);

  const selectFiles = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    void stageFiles(files);
  }, [stageFiles]);

  const dropFiles = useCallback((event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    if (event.dataTransfer.files.length > 0) void stageFiles(Array.from(event.dataTransfer.files));
  }, [stageFiles]);

  const removeStagedAttachment = useCallback(async (attachment: AttachmentDto): Promise<void> => {
    if (draftBotId === undefined) return;
    const origin = { botId: draftBotId, threadId: draftThreadId };
    const stored = loadDraft(origin.botId, origin.threadId);
    const draftToken = stored.attachmentDraftToken;
    const next = { ...stored, stagedIds: stored.stagedIds.filter((id) => id !== attachment.id) };
    saveDraft(origin.botId, origin.threadId, next);
    const selected = selectedDraftRef.current;
    if (selected.botId === origin.botId && selected.threadId === origin.threadId) {
      setSubmitError(undefined);
      setDraft(next);
      setStagedAttachments((current) => current.filter((candidate) => candidate.id !== attachment.id));
    }

    try {
      if (draftToken === undefined) return;
      await api.unstageAttachment(attachment.id, draftToken);
      const previewUrl = previewUrlsRef.current.get(attachment.id);
      if (previewUrl !== undefined) {
        URL.revokeObjectURL(previewUrl);
        previewUrlsRef.current.delete(attachment.id);
      }
    } catch (error) {
      saveDraft(origin.botId, origin.threadId, stored);
      const currentSelection = selectedDraftRef.current;
      if (currentSelection.botId === origin.botId && currentSelection.threadId === origin.threadId) {
        setDraft(stored);
        setStagedAttachments((current) =>
          current.some((candidate) => candidate.id === attachment.id) ? current : [...current, attachment],
        );
        setSubmitError(attachmentErrorMessage(error, attachment.name));
      }
    }
  }, [draftBotId, draftThreadId]);

  const rememberCursor = useCallback(() => {
    if (draftBotId === undefined) return;
    setDraft((current) => {
      const cursor = Math.max(0, Math.min(composerCursor(composerInputRef.current, current.cursor), current.text.length));
      if (cursor === current.cursor) return current;
      const next = { ...current, cursor };
      saveDraft(draftBotId, draftThreadId, next);
      return next;
    });
  }, [draftBotId, draftThreadId]);

  const saveOriginDraft = useCallback((origin: DictationOrigin, next: ConversationDraft): void => {
    saveDraft(origin.target.botId, origin.target.threadId, next);
    const selected = selectedDraftRef.current;
    if (selected.botId === origin.target.botId && selected.threadId === origin.target.threadId) setDraft(next);
  }, []);

  const clearOriginAnchor = useCallback(
    (origin: DictationOrigin): void => {
      const stored = loadDraft(origin.target.botId, origin.target.threadId);
      saveOriginDraft(origin, {
        text: stored.text,
        cursor: stored.cursor,
        stagedIds: stored.stagedIds,
        ...(stored.attachmentDraftToken !== undefined
          ? { attachmentDraftToken: stored.attachmentDraftToken }
          : {}),
      });
    },
    [saveOriginDraft],
  );

  const startDictation = useCallback(async (): Promise<void> => {
    if (bot === undefined || voiceState.state !== "idle") return;
    const anchor = Math.max(0, Math.min(composerCursor(composerInputRef.current, draft.cursor), draft.text.length));
    const target: VoiceDraftTarget = {
      botId: bot.id,
      ...(thread !== undefined ? { threadId: thread.id } : {}),
    };
    const origin: DictationOrigin = { target, anchor };
    dictationOriginRef.current = origin;
    const anchoredDraft = { ...draft, cursor: anchor, dictationAnchor: anchor };
    saveDraft(target.botId, target.threadId, anchoredDraft);
    setDraft(anchoredDraft);
    setVoiceStatus(undefined);

    try {
      const state = await dictation.start();
      setVoiceState(state);
      if (state.state !== "recording") {
        clearOriginAnchor(origin);
        dictationOriginRef.current = undefined;
        setVoiceStatus(state.error ?? "Voice dictation is unavailable.");
      }
    } catch (error) {
      clearOriginAnchor(origin);
      dictationOriginRef.current = undefined;
      setVoiceStatus(apiErrorMessage(error, "Voice dictation could not start."));
    }
  }, [bot, thread, voiceState.state, draft, dictation, clearOriginAnchor]);

  const stopDictation = useCallback(async (): Promise<void> => {
    const origin = dictationOriginRef.current;
    if (origin === undefined || voiceState.state !== "recording") return;
    setVoiceState({
      state: "transcribing",
      ...(voiceState.recordingId !== undefined ? { recordingId: voiceState.recordingId } : {}),
    });
    setVoiceStatus(undefined);

    try {
      const result = await dictation.stop();
      setVoiceState({ state: "idle" });
      if (result.outcome !== "success" || result.text === undefined) {
        clearOriginAnchor(origin);
        setVoiceStatus(
          result.outcome === "empty"
            ? "No speech detected."
            : result.outcome === "timeout"
              ? "Voice transcription timed out."
              : result.outcome === "cancelled"
                ? undefined
                : result.outcome === "unavailable"
                  ? "Voice dictation is unavailable."
                  : "Voice transcription failed.",
        );
        return;
      }

      const latest = loadDraft(origin.target.botId, origin.target.threadId);
      const inserted: ConversationDraft = {
        ...insertDictationTranscript(latest, result.text, origin.anchor),
        ...(latest.attachmentDraftToken !== undefined
          ? { attachmentDraftToken: latest.attachmentDraftToken }
          : {}),
      };
      saveOriginDraft(origin, inserted);
      if (autoSendVoice) {
        try {
          await onVoiceAutoSend(origin.target, inserted.text);
          saveOriginDraft(origin, {
            ...EMPTY_DRAFT,
            stagedIds: inserted.stagedIds,
            ...(inserted.attachmentDraftToken !== undefined
              ? { attachmentDraftToken: inserted.attachmentDraftToken }
              : {}),
          });
        } catch (error) {
          setSubmitError(apiErrorMessage(error, "Voice transcription was inserted but could not be sent."));
        }
      }
    } catch (error) {
      clearOriginAnchor(origin);
      setVoiceState({ state: "idle" });
      setVoiceStatus(apiErrorMessage(error, "Voice transcription failed."));
    } finally {
      dictationOriginRef.current = undefined;
    }
  }, [voiceState, dictation, clearOriginAnchor, saveOriginDraft, autoSendVoice, onVoiceAutoSend]);

  const cancelDictation = useCallback(async (): Promise<void> => {
    const origin = dictationOriginRef.current;
    if (origin === undefined) return;
    clearOriginAnchor(origin);
    dictationOriginRef.current = undefined;
    setVoiceStatus(undefined);
    try {
      setVoiceState(await dictation.cancel());
    } catch (error) {
      setVoiceState({ state: "idle" });
      setVoiceStatus(apiErrorMessage(error, "Voice dictation could not be cancelled."));
    }
  }, [clearOriginAnchor, dictation]);

  useEffect(() => {
    if (voiceState.state !== "recording") return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void cancelDictation();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [voiceState.state, cancelDictation]);

  const selectedThreadIsActive =
    thread?.latestTurn !== undefined && !isTerminalTurn(thread.latestTurn.status);
  const activeTurnCannotSteer = thread?.activeTurn !== undefined && !supportsSteering;
  const isAgentNotReady = !isAgentReady && agentReadiness?.status !== "checking";
  const composerIsDisabled = bot === undefined || isAgentNotReady || activeTurnCannotSteer;
  const workingSelectionKey = bot !== undefined && thread !== undefined ? `${bot.id}:${thread.id}` : undefined;
  useEffect(() => {
    if (workingSelectionKey === undefined || bot === undefined) {
      workingStateRef.current = undefined;
      setWorkingAnnouncement("");
      return;
    }

    const previous = workingStateRef.current;
    if (previous?.selectionKey !== workingSelectionKey) {
      workingStateRef.current = { selectionKey: workingSelectionKey, active: selectedThreadIsActive, name: bot.name };
      setWorkingAnnouncement(selectedThreadIsActive ? `${bot.name} is working` : "");
      return;
    }

    workingStateRef.current = { selectionKey: workingSelectionKey, active: selectedThreadIsActive, name: bot.name };
    if (previous.active !== selectedThreadIsActive) {
      setWorkingAnnouncement(
        selectedThreadIsActive ? `${bot.name} is working` : `${previous.name} is no longer working`,
      );
    } else if (previous.name !== bot.name && selectedThreadIsActive) {
      setWorkingAnnouncement(`${bot.name} is working`);
    }
  }, [bot, selectedThreadIsActive, workingSelectionKey]);
  useEffect(() => {
    const editable = composerInputRef.current?.querySelector<HTMLElement>('[contenteditable]');
    if (editable === undefined || editable === null) return;
    if (composerIsDisabled) {
      editable.setAttribute("aria-disabled", "true");
    } else {
      editable.removeAttribute("aria-disabled");
    }
  }, [composerIsDisabled]);

  const grouped = useMemo(() => groupTranscriptRows(messages), [messages]);
  useEffect(() => {
    const selectionKey = thread?.id;
    const calls = new Map<string, ToolCallSummaryDto>();
    for (const message of messages) {
      if (message.kind === "tool" && message.toolCall !== undefined) {
        calls.set(message.toolCall.id, message.toolCall);
      }
    }
    const previous = toolCallAnnouncementRef.current;
    toolCallAnnouncementRef.current = { selectionKey, calls };
    if (selectionKey === undefined || previous.selectionKey !== selectionKey || messagesLoading) {
      setToolCallAnnouncement("");
      return;
    }

    const announcements = toolCallBoundaryAnnouncements(previous.calls, calls);
    setToolCallAnnouncement(
      bot?.showToolCalls === true && announcements.length > 0
        ? announcements.join(". ")
        : "",
    );
  }, [bot?.showToolCalls, messages, messagesLoading, thread?.id]);
  useEffect(() => {
    const selectionKey = thread?.id;
    const blocks = new Map<string, ThinkingAnnouncementState>();
    for (const message of messages) {
      if (message.kind === "thinking" && message.thinking !== undefined) {
        blocks.set(message.thinking.blockId, message.thinking.state);
      }
    }
    const previous = thinkingAnnouncementRef.current;
    thinkingAnnouncementRef.current = { selectionKey, blocks };
    if (selectionKey === undefined || previous.selectionKey !== selectionKey || messagesLoading) {
      setThinkingAnnouncement("");
      return;
    }

    const announcements = thinkingBoundaryAnnouncements(previous.blocks, blocks);
    setThinkingAnnouncement(
      bot?.showThinking === true && announcements.length > 0
        ? announcements.join(". ")
        : "",
    );
  }, [bot?.showThinking, messages, messagesLoading, thread?.id]);

  const send = useCallback(
    async (): Promise<void> => {
      const trimmed = trimSendText(draft.text);
      if (trimmed.length === 0 || bot === undefined || activeTurnCannotSteer) return;
      const originThreadId = thread?.id;
      const attachmentIds = [...draft.stagedIds];
      const preservedDraft = { ...draft };
      const origin = { botId: bot.id, threadId: originThreadId };
      const body = {
        text: trimmed,
        clientTag: randomUuid(),
        ...(attachmentIds.length > 0
          ? { attachmentIds, attachmentDraftToken: draft.attachmentDraftToken }
          : {}),
      };
      setSubmitError(undefined);
      try {
        const response = thread !== undefined
          ? await api.sendMessage(thread.id, body)
          : await api.sendBotMessage(bot.id, body);
        saveDraft(bot.id, originThreadId, EMPTY_DRAFT);
        const selected = selectedDraftRef.current;
        if (selected.botId === origin.botId && selected.threadId === origin.threadId) {
          setDraft(EMPTY_DRAFT);
          setStagedAttachments([]);
        }
        for (const id of attachmentIds) {
          const previewUrl = previewUrlsRef.current.get(id);
          if (previewUrl !== undefined) {
            URL.revokeObjectURL(previewUrl);
            previewUrlsRef.current.delete(id);
          }
        }
        onMessageSent(response.threadId);
      } catch (error) {
        // Astryx clears its controlled editor on submit; restore the originating
        // draft only after the daemon rejects the whole atomic send.
        saveDraft(bot.id, originThreadId, preservedDraft);
        const selected = selectedDraftRef.current;
        if (selected.botId === origin.botId && selected.threadId === origin.threadId) {
          setDraft(preservedDraft);
          setSubmitError(apiErrorMessage(error, "Message could not be sent."));
        }
      }
    },
    [bot, thread, draft, onMessageSent, activeTurnCannotSteer],
  );

  const failedTurn = thread?.latestTurn?.status === "failed" ? thread.latestTurn : undefined;
  const failedTurnMessage = useMemo(() => {
    const message = [...messages].reverse().find(
      (candidate) => candidate.author.kind === "user" && candidate.text !== undefined,
    );
    return message?.attachments?.length ? undefined : message?.text;
  }, [messages]);
  const retryFailedTurn = useCallback(async (): Promise<void> => {
    if (thread === undefined || failedTurn === undefined || failedTurnMessage === undefined || !isAgentReady) return;
    setSubmitError(undefined);
    try {
      const response = await api.sendMessage(thread.id, {
        text: failedTurnMessage,
        clientTag: randomUuid(),
      });
      onMessageSent(response.threadId);
    } catch (error) {
      setSubmitError(apiErrorMessage(error, "Turn could not be retried."));
    }
  }, [thread, failedTurn, failedTurnMessage, isAgentReady, onMessageSent]);

  const rows = useMemo(() => {
    const out: ReactNode[] = [];
    for (const g of grouped) {
      if (g.kind === "responses") {
        out.push(
          <ChatMessage
            key={g.key}
            sender="assistant"
            data-testid="assistant-message"
            data-response-block-count={g.items.length}
          >
            <ChatMessageBubble variant="filled">
              <VStack gap={2} xstyle={styles.messageContent}>
                {g.items.map((response) => (
                  <MessageMarkdown
                    key={response.id}
                    text={response.text ?? ""}
                    isStreaming={response.response?.state === "streaming"}
                  />
                ))}
              </VStack>
            </ChatMessageBubble>
          </ChatMessage>,
        );
        continue;
      }
      if (g.kind === "tools") {
        if (bot?.showToolCalls !== true) continue;
        const calls = g.items
          .map(toChatToolCall)
          .filter((call): call is ChatToolCallItem => call !== undefined);
        out.push(
          <ChatMessage
            key={g.key}
            sender="assistant"
            data-testid="tool-call-message"
          >
            <ChatToolCalls
              calls={calls}
              style={TOOL_CALL_TEXT_CONTRAST_STYLE}
              data-testid="tool-calls"
              className="omarchy-tool-calls"
            />
          </ChatMessage>,
        );
        continue;
      }
      const message = g.message;
      if (message.kind === "thinking") {
        if (bot?.showThinking === true) {
          out.push(<ThinkingDisclosure key={message.id} message={message} />);
        }
        continue;
      }
      if (message.author.kind === "system") {
        out.push(
          message.peerMail === undefined
            ? <ChatSystemMessage key={message.id}>{message.text ?? ""}</ChatSystemMessage>
            : <PeerMailSystemMessage key={message.id} message={message} />,
        );
        continue;
      }

      const sender = message.author.kind === "user" ? "user" : "assistant";
      out.push(
        <ChatMessage
          key={message.id}
          sender={sender}
          data-testid={sender === "assistant" ? "assistant-message" : "user-message"}
        >
          <ChatMessageBubble variant="filled">
            <VStack gap={2} xstyle={styles.messageContent}>
              {message.text !== undefined ? <MessageMarkdown text={message.text} /> : null}
              {message.attachments?.map((attachment) => <AttachmentContent key={attachment.id} attachment={attachment} />)}
            </VStack>
          </ChatMessageBubble>
        </ChatMessage>,
      );
    }
    return out;
  }, [bot?.showThinking, bot?.showToolCalls, grouped]);
  useEffect(() => {
    if (agentReadiness?.status !== "ready") return;
    const readinessKeyPrefix = `agent:${agentReadiness.id}:`;
    setDismissedErrorKeys((current) => {
      const next = new Set([...current].filter((key) => !key.startsWith(readinessKeyPrefix)));
      return next.size === current.size ? current : next;
    });
  }, [agentReadiness?.id, agentReadiness?.status]);


  const readinessError: ContextualErrorCard | undefined =
    agentReadiness !== undefined && agentReadiness.status !== "ready" && agentReadiness.status !== "checking"
      ? {
          key: `agent:${agentReadiness.id}:${agentReadiness.status}:${agentReadiness.reason ?? ""}:${agentReadiness.guidance ?? ""}`,
          title: `${agentReadiness.displayName} isn’t ready`,
          description: [...new Set(
            [agentReadiness.reason, agentReadiness.guidance].filter(
              (message): message is string => message !== undefined && message.trim().length > 0,
            ),
          )].join(" "),
          ...(onRetryAgentReadiness !== undefined ? { retry: onRetryAgentReadiness } : {}),
        }
      : undefined;
  const submitErrorCard: ContextualErrorCard | undefined = submitError === undefined
    ? undefined
    : { key: `submit:${submitError}`, title: "Message wasn’t sent", description: submitError, retry: send };
  const turnErrorCard: ContextualErrorCard | undefined = failedTurn === undefined
    ? undefined
    : {
        key: `turn:${failedTurn.id}`,
        title: "Turn failed",
        description: failedTurn.reason ?? "The agent could not finish this turn.",
        ...(failedTurnMessage !== undefined && isAgentReady ? { retry: retryFailedTurn } : {}),
      };
  const visibleContextualError = [readinessError, submitErrorCard, turnErrorCard].find(
    (error): error is ContextualErrorCard =>
      error !== undefined && !dismissedErrorKeys.has(error.key),
  );

  const voiceMessage =
    voiceState.state === "recording"
      ? "Listening… Press Escape to cancel."
      : voiceState.state === "transcribing"
        ? "Transcribing voice…"
        : voiceStatus;
  const composerStatus =
    voiceMessage !== undefined
      ? {
          type: voiceState.state === "recording" || voiceState.state === "transcribing" ? ("warning" as const) : ("error" as const),
          message: voiceMessage,
        }
      : voiceState.state === "unavailable"
        ? { type: "warning" as const, message: voiceState.error ?? "Voice dictation isn’t available right now." }
        : restoringAttachments
          ? { type: "warning" as const, message: "Checking draft attachments…" }
          : activeTurnCannotSteer
            ? { type: "warning" as const, message: "This agent does not support steering an active turn." }
            : undefined;
  const dictationLabel =
    voiceState.state === "recording"
      ? "Stop voice recording"
      : voiceState.state === "transcribing"
        ? "Transcribing voice"
        : voiceState.state === "unavailable"
          ? "Voice dictation unavailable"
          : "Start voice recording";
  const dictationButton = (
    <Button
      label={dictationLabel}
      aria-label={dictationLabel}
      icon={<Icon icon="microphone" size="md" />}
      variant="ghost"
      size="md"
      isIconOnly
      isDisabled={bot === undefined || isAgentNotReady || activeTurnCannotSteer || voiceState.state === "transcribing" || voiceState.state === "unavailable"}
      onClick={() => void (voiceState.state === "recording" ? stopDictation() : startDictation())}
      data-testid="dictation-button"
      data-state={voiceState.state}
    />
  );

  const attachmentDrawer = (
    <AttachmentDrawer
      key={`${draftBotId ?? ""}:${draftThreadId ?? ""}`}
      attachments={
        restoredDraftRef.current.botId === draftBotId && restoredDraftRef.current.threadId === draftThreadId
          ? stagedAttachments
          : []
      }
      previewUrls={previewUrlsRef.current}
      onRemove={removeStagedAttachment}
    />
  );

  const queryClient = useQueryClient();
  const [skillMenuError, setSkillMenuError] = useState<string>();
  const skillSearch = useMemo<SearchSource>(() => {
    const search: SearchSource["search"] = async (query) => {
      try {
        const commands = await queryClient.fetchQuery({
          queryKey: ["plugin-commands"],
          queryFn: () => api.pluginCommands(),
          staleTime: 30_000,
          retry: false,
        });
        setSkillMenuError(undefined);
        const filter = query.replace(/^skill:/, "").toLowerCase();
        return commands.filter((skill) => skill.name.toLowerCase().includes(filter) || skill.command.toLowerCase().includes(filter)).map((skill) => ({
          id: skill.command,
          label: skill.name,
          element: <VStack gap={1}>
            <Text>{skill.name}</Text>
            <Text color="secondary">{skill.description} · {skill.source === "native" ? "Native · read-only" : "Global"}</Text>
          </VStack>,
        }));
      } catch (error) {
        setSkillMenuError(apiErrorMessage(error, "Skill commands could not load."));
        return [];
      }
    };
    return { search, bootstrap: () => search("") };
  }, [queryClient]);
  const skillTriggers = useMemo<ChatComposerTrigger[]>(() => [{
    character: "/",
    searchSource: skillSearch,
    onSelect: (item) => `${item.id} `,
    renderItem: (item) => item.element ?? item.label,
    menuLabel: "Skill commands",
    emptySearchResultsText: "No matching skills. Open Plugins in the sidebar to manage Skills.",
    loadingText: "Loading skills…",
  }], [skillSearch]);
  const canChooseSkill = !composerIsDisabled && !selectedThreadIsActive && /^\/?[^\s]*$/.test(draft.text);

  const composer = (
    <div {...stylex.props(styles.composerWrap)}>
      {visibleContextualError !== undefined ? (
        <Banner
          status="error"
          title={visibleContextualError.title}
          description={visibleContextualError.description}
          container="section"
          endContent={
            <HStack gap={1}>
              {visibleContextualError.retry !== undefined ? (
                <Button
                  label="Retry"
                  variant="secondary"
                  size="sm"
                  onClick={() => void visibleContextualError.retry?.()}
                />
              ) : null}
              <Button
                label="Close"
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (submitErrorCard?.key === visibleContextualError.key) {
                    setSubmitError(undefined);
                  } else {
                    dismissError(visibleContextualError.key);
                  }
                }}
              />
            </HStack>
          }
          data-testid="composer-error-card"
        />
      ) : null}
      <div
        {...stylex.props(styles.composerDropZone)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={dropFiles}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          aria-label="Choose files to attach"
          onChange={selectFiles}
          {...stylex.props(styles.hiddenFileInput)}
          data-testid="attachment-input"
          tabIndex={-1}
        />
        {canChooseSkill && draft.text.startsWith("/") && skillMenuError ? <Text role="alert">{skillMenuError}</Text> : null}
        <ChatComposer
          value={draft.text}
          onChange={onDraftChange}
          onSubmit={() => void send()}
          input={
            <ChatComposerInput
              ref={composerInputRef}
              {...(canChooseSkill ? { triggers: skillTriggers } : {})}
              onKeyUp={rememberCursor}
              onMouseUp={rememberCursor}
              isDisabled={composerIsDisabled}
            />
          }
          drawer={attachmentDrawer}
          footerActions={
            <Button
              label="Attach files"
              icon={<Icon icon={Paperclip} size="sm" />}
              variant="ghost"
              size="md"
              isIconOnly
              isDisabled={bot === undefined || isAgentNotReady || activeTurnCannotSteer}
              onClick={() => fileInputRef.current?.click()}
              data-testid="attachment-picker"
            />
          }
          sendActions={dictationButton}
          density="compact"
          elevation="low"
          placeholder={
            bot === undefined
              ? "Select or create a bot"
              : isAgentNotReady
                ? "This bot’s agent isn’t ready"
                : activeTurnCannotSteer
                  ? "Wait for this turn to finish"
                  : "Message…"
          }
          isDisabled={composerIsDisabled}
          data-testid="composer"
          {...(composerStatus !== undefined ? { status: composerStatus } : {})}
        />
      </div>
    </div>
  );

  const transcriptEmptyState = messagesLoading ? (
    <EmptyState
      icon={<Icon icon="clock" size="lg" />}
      title="Loading conversation"
      description="Fetching this bot’s messages."
      isCompact
    />
  ) : messagesError !== undefined ? (
    <EmptyState
      icon={<Icon icon="warning" size="lg" />}
      title="Conversation couldn’t load"
      description={messagesError}
      {...(onRetryMessages !== undefined
        ? { actions: <Button label="Try loading again" variant="secondary" onClick={onRetryMessages} /> }
        : {})}
      isCompact
    />
  ) : bot === undefined ? (
    <EmptyState
      icon={<Icon icon="info" size="lg" />}
      title="Choose a bot"
      description="Select or create a bot to begin a conversation."
      isCompact
    />
  ) : undefined;

  const transcriptContent = messagesLoading || messagesError !== undefined ? [] : [...rows];
  if (selectedThreadIsActive && bot !== undefined && !messagesLoading && messagesError === undefined) {
    transcriptContent.push(<WorkingAvatarView key="working-avatar" avatar={bot.avatar} name={bot.name} />);
  }

  return (
    <div {...stylex.props(styles.fillColumn)} data-testid="chat-panel">
      <VisuallyHidden
        as="div"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="working-announcement"
      >
        {workingAnnouncement}
      </VisuallyHidden>
      <VisuallyHidden
        as="div"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="tool-call-announcement"
      >
        {toolCallAnnouncement}
      </VisuallyHidden>
      <VisuallyHidden
        as="div"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="thinking-announcement"
      >
        {thinkingAnnouncement}
      </VisuallyHidden>
      <ChatLayout
        className="thread-chat-layout"
        {...(transcriptAttention !== null
          ? { ref: transcriptAttention.viewportRef, onScroll: transcriptAttention.onViewportScroll }
          : {})}
        composer={composer}
      >
        <ChatMessageList
          isStreaming={selectedThreadIsActive && !messagesLoading && messagesError === undefined}
          emptyState={transcriptEmptyState}
          data-testid="transcript"
        >
          {transcriptContent}
        </ChatMessageList>
      </ChatLayout>
    </div>
  );
}
