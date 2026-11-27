import type { JSX } from "react";
import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { BottomSheet } from "@astryxdesign/core/BottomSheet";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Item } from "@astryxdesign/core/Item";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { VStack } from "@astryxdesign/core/VStack";
import type { ThreadDto } from "@omarchy-bot/protocol";
import { api, apiErrorMessage } from "../lib/api.ts";

export interface HistoryDialogProps {
  botId: string;
  open: boolean;
  onClose: () => void;
  onSelectThread: (threadId: string) => void;
  onNewConversation: () => void;
}

interface HistoryContentProps {
  compactHeading: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  threads: ThreadDto[];
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onSelectThread: (threadId: string) => void;
  onNewConversation: () => void;
}

function HistoryContent({
  compactHeading,
  query,
  onQueryChange,
  threads,
  loading,
  error,
  onRetry,
  onSelectThread,
  onNewConversation,
}: HistoryContentProps): JSX.Element {
  return (
    <VStack gap={3} padding={4} aria-busy={loading || undefined} data-testid="history-dialog">
      {compactHeading ? <Heading level={2}>Conversation history</Heading> : null}
      <IconButton
        label="New conversation"
        tooltip="New conversation"
        icon={<Icon icon={Plus} size="md" />}
        variant="primary"
        onClick={onNewConversation}
        data-testid="history-new-conversation"
      />
      <TextInput
        hasAutoFocus
        label="Search conversations"
        value={query}
        onChange={onQueryChange}
        placeholder="Search by title"
        width="100%"
        data-testid="history-search"
      />
      {loading ? (
        <EmptyState
          icon={<Icon icon="clock" size="lg" />}
          title="Loading conversations"
          description="Fetching this bot’s recent conversations."
          isCompact
        />
      ) : error !== undefined ? (
        <EmptyState
          icon={<Icon icon="warning" size="lg" />}
          title="Conversation history couldn’t load"
          description={error}
          actions={<Button label="Try loading again" variant="secondary" onClick={onRetry} />}
          isCompact
        />
      ) : threads.length === 0 ? (
        <EmptyState
          icon={<Icon icon="clock" size="lg" />}
          title={query.trim() === "" ? "No conversations yet" : "No matching conversations"}
          description={query.trim() === "" ? "Start a new conversation when you are ready." : "Try a different title."}
          isCompact
        />
      ) : (
        threads.map((thread) => (
          <Item
            key={thread.id}
            label={thread.title}
            labelLines={2}
            description="Conversation"
            endContent={<Timestamp value={thread.updatedAt} format="relative_short" />}
            align="start"
            onClick={() => onSelectThread(thread.id)}
            data-testid={`history-thread-${thread.id}`}
          />
        ))
      )}
    </VStack>
  );
}

/** Responsive history surface: Dialog on desktop, BottomSheet on narrow screens. */
export function HistoryDialog({
  botId,
  open,
  onClose,
  onSelectThread,
  onNewConversation,
}: HistoryDialogProps): JSX.Element {
  const { isMobile: isSmallScreen } = useAppShellMobile();
  const [query, setQuery] = useState("");
  const [threads, setThreads] = useState<ThreadDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setQuery("");
    setThreads([]);
    setError(undefined);
  }, [botId]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(undefined);

    void api
      .listBotThreads(botId, query.trim())
      .then((list) => {
        if (!cancelled) setThreads(list);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setThreads([]);
          setError(apiErrorMessage(loadError, "Conversation history couldn’t be loaded. Check your connection and try again."));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [botId, open, query, reloadKey]);

  const selectThread = (threadId: string): void => {
    onSelectThread(threadId);
    onClose();
  };
  const startNewConversation = (): void => {
    onNewConversation();
    onClose();
  };

  const content = (
    <HistoryContent
      compactHeading={isSmallScreen}
      query={query}
      onQueryChange={setQuery}
      threads={threads}
      loading={loading}
      {...(error !== undefined ? { error } : {})}
      onRetry={() => setReloadKey((key) => key + 1)}
      onSelectThread={selectThread}
      onNewConversation={startNewConversation}
    />
  );

  if (isSmallScreen) {
    return (
      <BottomSheet
        label="Conversation history"
        isOpen={open}
        onOpenChange={(nextOpen) => !nextOpen && onClose()}
        height="tall"
        padding={0}>
        {content}
      </BottomSheet>
    );
  }

  return (
    <Dialog isOpen={open} onOpenChange={(nextOpen) => !nextOpen && onClose()} width={560}>
      <DialogHeader title="Conversation history" subtitle="Search and return to this bot’s recent conversations." />
      {content}
    </Dialog>
  );
}
