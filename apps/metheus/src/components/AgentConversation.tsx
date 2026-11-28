import { useRef, useState, type ReactNode } from "react";
import { ArrowUpIcon, BotIcon, CheckIcon, CircleAlertIcon, ClockIcon, FileIcon, FileTextIcon, FolderOpenIcon, ImageIcon, PaperclipIcon, RefreshCwIcon, ServerIcon, WrenchIcon, XIcon } from "@/components/icons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle } from "@/components/ui/attachment";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "@/components/ui/message";
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import { Trace, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { attachmentAccept, isAttachmentImage, type AgentAttachment } from "../lib/agentAttachments.ts";
import type { AgentBot, AgentWork, ToolProgress } from "../lib/agentDaemon.ts";
import { mapToolStatusToTrace, useConversationSession, type ConversationFeed } from "../lib/conversationSession.ts";
import { AgentAttachmentPreview } from "./AgentAttachmentPreview.tsx";
import { AssistantMarkdown } from "./AssistantMarkdown.tsx";

const workLabel = {
  queued: "Queued",
  running: "Working",
  waiting: "Waiting for delegated work",
  completed: "Completed",
  failed: "Work failed",
  interrupted: "Work interrupted",
};

const toolLabel = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

export function AgentConversationView({ bot, feed, onMissing }: {
  bot: AgentBot;
  feed: ConversationFeed;
  onMissing: (botId: string) => void;
}) {
  const session = useConversationSession(bot.id, feed, { onMissing });
  const [viewing, setViewing] = useState<AgentAttachment>();
  const picker = useRef<HTMLInputElement>(null);
  const { messages, delta, visibleTools, connection, composerDisabled, attachments, desktop } = session;
  const readyForMessage = !composerDisabled && session.draft.trim().length > 0;
  const duties = session.bot ? session.bot.duties : bot.duties;
  const DesktopIcon = desktop?.kind === "directory" ? FolderOpenIcon : FileIcon;

  return <section aria-label={`Conversation with ${bot.name}`} className="flex h-full min-h-0 flex-col">
    {connection === "offline" && <div className="mx-auto w-full max-w-3xl px-4 pt-3 sm:px-8">
      <Alert role="status"><CircleAlertIcon /><AlertDescription>Connection lost. Reconnecting to the Agent Daemon…</AlertDescription></Alert>
    </div>}
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="flex-1">
        <MessageScrollerViewport aria-label="Message History" role="region" tabIndex={0}>
          <MessageScrollerContent role="log" aria-label="Messages" className="mx-auto max-w-3xl gap-6 px-4 py-6 sm:px-8">
            {duties && <MessageScrollerItem messageId="duties">
              <Marker><MarkerIcon><BotIcon /></MarkerIcon><MarkerContent className="wrap-break-word">{duties}</MarkerContent></Marker>
            </MessageScrollerItem>}
            {messages.length === 0 && !delta && <MessageScrollerItem messageId="empty" className="flex flex-1 items-center">
              {session.hasHistory ? <Empty className="border-0">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><BotIcon /></EmptyMedia>
                  <EmptyTitle>Start a Conversation with {bot.name}</EmptyTitle>
                  <EmptyDescription>Send a message to give this Bot a job or ask for help.</EmptyDescription>
                </EmptyHeader>
              </Empty> : <p role="status" className="mx-auto flex items-center gap-2 text-sm text-muted-foreground">
                {connection !== "offline" && <Spinner />} {connection === "offline" ? "Waiting for a connection…" : "Loading Conversation…"}
              </p>}
            </MessageScrollerItem>}
            {messages.map(message => {
              const fromUser = message.role === "user";
              const work = session.work.get(message.id);
              return <MessageScrollerItem key={message.id} messageId={String(message.id)}>
                <ConversationMessage sender={fromUser ? "You" : bot.name} user={fromUser} text={message.text}>
                  {Boolean(message.attachments?.length) && <AttachmentGroup className="max-w-full">
                    {message.attachments?.map((attachment, position) => <Attachment key={`${attachment.id}:${position}`} size="sm">
                      <AttachmentMedia variant="icon">{isAttachmentImage(attachment.mediaType) ? <ImageIcon /> : <FileTextIcon />}</AttachmentMedia>
                      <AttachmentContent className="max-w-48">
                        <AttachmentTitle title={attachment.name}>{attachment.name}</AttachmentTitle>
                        {!attachment.available && <AttachmentDescription>Content unavailable</AttachmentDescription>}
                      </AttachmentContent>
                      <AttachmentActions>
                        <AttachmentAction aria-label={`View ${attachment.name}`} title={`View ${attachment.name}`} onClick={() => setViewing(attachment)}><FileIcon /></AttachmentAction>
                        {attachment.available && <AttachmentAction aria-label={`Reuse ${attachment.name}`} title={`Reuse ${attachment.name}`}
                          disabled={composerDisabled} onClick={() => session.attach([attachment])}><PaperclipIcon /></AttachmentAction>}
                      </AttachmentActions>
                    </Attachment>)}
                  </AttachmentGroup>}
                  {work && work.status !== "completed" && <WorkNotice work={work} retry={() => void session.retry(message.id)} />}
                </ConversationMessage>
              </MessageScrollerItem>;
            })}
            {visibleTools.length > 0 && <MessageScrollerItem messageId="tool-activity">
              <Trace aria-label="Tool activity">{visibleTools.map(tool => <ToolActivity key={tool.id} tool={tool} />)}</Trace>
            </MessageScrollerItem>}
            {delta && <MessageScrollerItem messageId="streaming-reply">
              <ConversationMessage sender={bot.name} text={delta} />
            </MessageScrollerItem>}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
    <form aria-label="Message composer" className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 px-4 pt-2 pb-4 sm:px-8"
      onSubmit={event => { event.preventDefault(); void session.send(); }}
      onDragOver={event => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = composerDisabled ? "none" : "copy";
      }}
      onDrop={event => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        session.attach(Array.from(event.dataTransfer.files));
      }}>
      <input ref={picker} type="file" accept={attachmentAccept} multiple hidden disabled={composerDisabled} onChange={event => {
        session.attach(Array.from(event.currentTarget.files ?? []));
        event.currentTarget.value = "";
      }} />
      {session.error && <Alert variant="destructive" role="alert"><CircleAlertIcon /><AlertDescription>{session.error}</AlertDescription></Alert>}
      <InputGroup className="overflow-hidden">
        {(attachments.length > 0 || desktop) && <InputGroupAddon align="block-start" className="min-w-0">
          <AttachmentGroup className="w-full" aria-label="Draft context">
            {attachments.map((attachment, index) => <Attachment key={index} size="xs">
              <AttachmentMedia variant="icon"><PaperclipIcon /></AttachmentMedia>
              <AttachmentContent className="max-w-44"><AttachmentTitle title={attachment.name}>{attachment.name}</AttachmentTitle></AttachmentContent>
              <AttachmentActions><AttachmentAction aria-label={`Remove ${attachment.name}`} title={`Remove ${attachment.name}`} disabled={composerDisabled}
                onClick={() => session.removeAttachment(index)}><XIcon /></AttachmentAction></AttachmentActions>
            </Attachment>)}
            {desktop && <Attachment size="xs">
              <AttachmentMedia variant="icon"><DesktopIcon /></AttachmentMedia>
              <AttachmentContent className="max-w-44">
                <AttachmentTitle title={desktop.name}>{desktop.name}</AttachmentTitle>
                <AttachmentDescription>Desktop {desktop.kind}</AttachmentDescription>
              </AttachmentContent>
              <AttachmentActions><AttachmentAction aria-label="Use daemon host" title="Use daemon host" disabled={composerDisabled}
                onClick={session.clearDesktopPath}><XIcon /></AttachmentAction></AttachmentActions>
            </Attachment>}
          </AttachmentGroup>
        </InputGroupAddon>}
        <InputGroupTextarea aria-label="Message" placeholder={`Message ${bot.name}…`} className="max-h-40 min-h-14 px-3" rows={2}
          value={session.draft} onChange={event => session.setDraft(event.target.value)} disabled={composerDisabled}
          onKeyDown={event => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (!event.repeat && readyForMessage) void session.send();
          }} />
        <InputGroupAddon align="block-end" className="flex-wrap justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <InputGroupButton size="icon-sm" aria-label="Attach files" title="Attach files" disabled={composerDisabled} onClick={() => picker.current?.click()}><PaperclipIcon /></InputGroupButton>
            {session.hasDesktopTools && <DropdownMenu>
              <DropdownMenuTrigger render={<InputGroupButton size="sm" disabled={composerDisabled} />}>
                <ServerIcon data-icon="inline-start" /> {desktop ? "Desktop" : "Daemon host"}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top">
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={() => void session.chooseDesktopPath("directory")}><FolderOpenIcon /> Choose desktop directory</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void session.chooseDesktopPath("file")}><FileIcon /> Choose desktop file</DropdownMenuItem>
                  {desktop && <DropdownMenuItem onClick={session.clearDesktopPath}><ServerIcon /> Use daemon host</DropdownMenuItem>}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>}
          </div>
          <InputGroupButton type="submit" variant="default" size="icon-sm" aria-label="Send message" title="Send message" disabled={!readyForMessage}>
            {session.submitting ? <Spinner /> : <ArrowUpIcon />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </form>
    {viewing && <AgentAttachmentPreview botId={bot.id} attachment={viewing} close={() => setViewing(undefined)} />}
  </section>;
}

function ConversationMessage({ sender, text, user = false, children }: {
  sender: string; text: string; user?: boolean; children?: ReactNode;
}) {
  return <Message align={user ? "end" : "start"}>
    {!user && <MessageAvatar><Avatar><AvatarFallback><BotIcon className="size-4" aria-hidden="true" /></AvatarFallback></Avatar></MessageAvatar>}
    <MessageContent>
      <MessageHeader>{sender}</MessageHeader>
      <Bubble variant={user ? "secondary" : "ghost"}>
        <BubbleContent>{user ? <p className="whitespace-pre-wrap">{text}</p> : <AssistantMarkdown text={text} />}</BubbleContent>
      </Bubble>
      {children}
    </MessageContent>
  </Message>;
}

function WorkNotice({ work, retry }: { work: AgentWork; retry: () => void }) {
  return <Marker>
    <MarkerIcon>{work.status === "running" ? <Spinner /> : work.status === "failed" || work.status === "interrupted" ? <CircleAlertIcon /> : <ClockIcon />}</MarkerIcon>
    <MarkerContent>{work.reason === "provider_unconfigured" ? "Queued until a model is configured" : workLabel[work.status]}</MarkerContent>
    {work.status === "interrupted" && <Button size="xs" variant="outline" onClick={retry}>
      <RefreshCwIcon data-icon="inline-start" /> Retry interrupted work
    </Button>}
  </Marker>;
}

function ToolActivity({ tool }: { tool: ToolProgress }) {
  const status = mapToolStatusToTrace(tool.status);
  const Icon = tool.status === "completed" ? CheckIcon : status === "error" ? CircleAlertIcon : WrenchIcon;
  return <TraceLine {...(status ? { status } : {})}>
    <TraceIcon>{status === "running" ? <Spinner /> : <Icon />}</TraceIcon>
    <TraceTitle title={tool.name}>{tool.name}</TraceTitle>
    <TraceDescription>{toolLabel[tool.status]}</TraceDescription>
  </TraceLine>;
}
