import type { JSX, ReactNode } from "react";
import { AppShell, useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Banner } from "@astryxdesign/core/Banner";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { MobileNav } from "@astryxdesign/core/MobileNav";
import { VStack } from "@astryxdesign/core/VStack";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import type { BotViewDto } from "@omarchy-bot/protocol";
import { api, apiErrorMessage, randomUuid } from "../lib/api.ts";
import { requestDesktopNotificationPermission, startEventPump, type QueryTag } from "../lib/events.ts";
import { mostRecentlyActiveBot, Sidebar } from "../components/Sidebar.tsx";
import { clearDraftsByBot, restoreDrafts, takeDraftsByBot } from "../lib/drafts.ts";
import { ConversationHeader } from "../components/ConversationHeader.tsx";
import { ChatPanel } from "../components/ChatPanel.tsx";
import { CreateBotDialog } from "../components/CreateBotDialog.tsx";
import { HistoryDialog } from "../components/HistoryDialog.tsx";
import { BotSettingsPanel } from "../components/BotSettingsPanel.tsx";
import { SettingsDialog } from "../components/SettingsDialog.tsx";
import { PluginsDialog } from "../components/PluginsDialog.tsx";
import { CapabilityPanel } from "../components/CapabilityPanel.tsx";
import { useVoiceAutoSendSetting } from "../components/VoiceSettingsControl.tsx";
import { TranscriptAttention } from "../components/TranscriptAttention.tsx";

export const Route = createFileRoute("/")({
  component: HomeScreen,
  // Selection lives in the URL so a refresh restores it (contract §Web app).
  validateSearch: (search: Record<string, unknown>): { bot?: string; thread?: string } => ({
    ...(typeof search.bot === "string" ? { bot: search.bot } : {}),
    ...(typeof search.thread === "string" ? { thread: search.thread } : {}),
  }),
});

type Tags = Record<QueryTag, string[]>;
const QUERY_KEYS: Tags = {
  agents: ["agents"],
  bots: ["bots"],
  threads: ["threads"],
  messages: ["messages"],
  dictation: ["dictation"],
  turns: ["turns"],
  computer: ["computer"],
};

type RightRegionState =
  | { mode: "closed" }
  | { mode: "bot-settings" }
  | { mode: "capabilities" };

interface ConversationWorkspaceProps {
  children: ReactNode;
  panelOpen: boolean;
}

function ConversationWorkspace({ children, panelOpen }: ConversationWorkspaceProps): JSX.Element | null {
  const { isMobile } = useAppShellMobile();
  if (isMobile && panelOpen) return null;
  return (
    <LayoutContent padding={0} isScrollable={false} label="Conversation workspace">
      {children}
    </LayoutContent>
  );
}

function HomeScreen(): JSX.Element {
  const qc = useQueryClient();
  const navigate = Route.useNavigate();
  const { bot: selectedBotId, thread: selectedThreadId } = Route.useSearch();
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [rightRegion, setRightRegion] = useState<RightRegionState>({ mode: "closed" });
  const botSettingsOpen = rightRegion.mode === "bot-settings";
  const computerOpen = rightRegion.mode === "capabilities";
  const [computerError, setComputerError] = useState<string | undefined>(undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingDeleteBot, setPendingDeleteBot] = useState<BotViewDto | undefined>(undefined);
  const [deletingBotId, setDeletingBotId] = useState<string | undefined>(undefined);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);
  const [autoSendVoice, setAutoSendVoice] = useVoiceAutoSendSetting();
  const [isOnline, setIsOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  const selectedBotRef = useRef<string | undefined>(selectedBotId);
  const botNamesRef = useRef<Record<string, string>>({});
  const mobileNavigationTriggerRef = useRef<HTMLButtonElement>(null);
  const computerTriggerRef = useRef<HTMLButtonElement>(null);
  const botSettingsTriggerRef = useRef<HTMLButtonElement>(null);
  selectedBotRef.current = selectedBotId;


  const invalidate = useCallback(
    (tag: QueryTag, threadId?: string) => {
      void qc.invalidateQueries({ queryKey: threadId ? [tag, threadId] : QUERY_KEYS[tag] });
    },
    [qc],
  );

  useEffect(() => {
    startEventPump(invalidate, () => void qc.invalidateQueries(), () => {
      const current = selectedBotRef.current;
      return {
        ...(current !== undefined ? { selectedBotId: current } : {}),
        botName: (botId) => botNamesRef.current[botId],
      };
    });
  }, [qc, invalidate]);

  useEffect(() => {
    const markOnline = (): void => setIsOnline(true);
    const markOffline = (): void => setIsOnline(false);
    window.addEventListener("online", markOnline);
    window.addEventListener("offline", markOffline);
    return () => {
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
    };
  }, []);

  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.listAgents(), refetchInterval: 30_000 });
  const bots = useQuery({ queryKey: ["bots"], queryFn: () => api.listBots(), refetchInterval: 30_000 });
  botNamesRef.current = Object.fromEntries((bots.data ?? []).map((candidate) => [candidate.id, candidate.name]));
  const dictation = useQuery({
    queryKey: ["dictation"],
    queryFn: () => api.dictation(),
    refetchInterval: 15_000,
  });
  const dictationController = useMemo(
    () => ({
      state: dictation.data ?? { state: "unavailable" as const },
      start: async () => {
        const state = await api.startDictation();
        qc.setQueryData(["dictation"], state);
        return state;
      },
      stop: async () => {
        const result = await api.stopDictation();
        invalidate("dictation");
        return result;
      },
      cancel: async () => {
        const state = await api.cancelDictation();
        qc.setQueryData(["dictation"], state);
        return state;
      },
    }),
    [dictation.data, invalidate, qc],
  );

  const bot = useMemo(() => bots.data?.find((b) => b.id === selectedBotId), [bots.data, selectedBotId]);
  const computer = useQuery({
    queryKey: ["computer", bot?.id, bot?.surfaceId],
    queryFn: () => api.computerState({ botId: bot!.id, surfaceId: bot!.surfaceId }),
    enabled: bot !== undefined,
    refetchInterval: 15_000,
  });

  const computerAction = useMutation({
    mutationFn: (action: "take" | "return") => {
      if (bot === undefined) throw new Error("No Bot is selected");
      const owner = { botId: bot.id, surfaceId: bot.surfaceId };
      return action === "take" ? api.takeControl(owner) : api.returnToBot(owner);
    },
    onSuccess: () => {
      setComputerError(undefined);
      invalidate("computer");
    },
    onError: (error) => setComputerError(apiErrorMessage(error, "Bot Screen control could not be updated.")),
  });

  const threads = useQuery({
    queryKey: ["threads", bot?.id],
    queryFn: () => api.listBotThreads(bot!.id),
    enabled: bot !== undefined,
    refetchInterval: 60_000,
  });

  // Startup and deletion recovery select the most recent surviving Bot.
  useEffect(() => {
    if (bots.data === undefined) return;
    if (selectedBotId !== undefined && bots.data.some((candidate) => candidate.id === selectedBotId)) return;
    if (selectedBotId !== undefined) clearDraftsByBot(selectedBotId);
    const first = mostRecentlyActiveBot(bots.data);
    if (first === undefined) {
      if (selectedBotId !== undefined) void navigate({ search: {}, replace: true });
      return;
    }
    void navigate({ search: { bot: first.id }, replace: true });
  }, [selectedBotId, bots.data, navigate]);

  // Resolve the selected thread; `blank` keeps the genuinely empty composer.
  const thread = useMemo(() => {
    if (selectedThreadId === undefined || selectedThreadId === "blank") return undefined;
    return threads.data?.find((t) => t.id === selectedThreadId);
  }, [threads.data, selectedThreadId]);

  // When a bot is selected without an explicit thread, open its most recent one.
  useEffect(() => {
    if (bot === undefined || selectedThreadId !== undefined || threads.data === undefined) return;
    const latest = threads.data[0];
    void navigate({ search: { bot: bot.id, thread: latest?.id ?? "blank" }, replace: true });
  }, [bot, selectedThreadId, threads.data, navigate]);

  const messages = useQuery({
    queryKey: ["messages", thread?.id],
    queryFn: () => api.listMessages(thread!.id),
    enabled: thread !== undefined,
    refetchInterval: 15_000,
  });


  const selectBot = useCallback(
    (botId: string): void => {
      invalidate("computer");
      setComputerError(undefined);
      const unreadThreadId = bots.data?.find((candidate) => candidate.id === botId)?.unreadThreadId;
      void navigate({
        search: {
          bot: botId,
          ...(unreadThreadId === undefined ? {} : { thread: unreadThreadId }),
        },
      });
    },
    [bots.data, navigate, invalidate],
  );

  const onMessageSent = useCallback(
    (threadId: string): void => {
      invalidate("threads");
      invalidate("bots");
      if (bot !== undefined && selectedBotRef.current === bot.id && threadId !== selectedThreadId) {
        void navigate({ search: { bot: bot.id, thread: threadId } });
      }
    },
    [bot, selectedThreadId, navigate, invalidate],
  );

  const selectedAgent = useMemo(
    () => (bot === undefined ? undefined : agents.data?.find((candidate) => candidate.id === bot.agentId)),
    [agents.data, bot],
  );
  const isAgentReady = selectedAgent?.status === "ready";
  const supportsSteering = selectedAgent?.capabilities?.steering === true;

  const workspaceBanner: ReactNode =
    !isOnline ? (
      <Banner
        status="warning"
        title="You’re offline"
        description="Drafts remain available. Reconnect to send messages or refresh workspace data."
        container="section"
      />
    ) : bots.error !== null && bots.data !== undefined ? (
      <Banner
        status="error"
        title="Workspace refresh failed"
        description={apiErrorMessage(bots.error, "Your bots could not be refreshed.")}
        container="section"
        endContent={
          <Button label="Retry" variant="secondary" size="sm" onClick={() => void bots.refetch()} />
        }
      />
    ) : undefined;

  const conversationNotice: ReactNode =
    bot !== undefined && threads.error !== null ? (
      <Banner
        status="error"
        title="Conversations could not be loaded"
        description={apiErrorMessage(threads.error, "Try loading this bot’s conversations again.")}
        container="section"
        endContent={
          <Button label="Retry" variant="secondary" size="sm" onClick={() => void threads.refetch()} />
        }
      />
    ) : bot !== undefined && threads.isPending ? (
      <Banner
        status="info"
        title="Loading conversations"
        description="Your composer will be ready while recent conversation history loads."
        container="section"
      />
    ) : bot !== undefined && agents.error !== null ? (
      <Banner
        status="error"
        title="Agent status could not be loaded"
        description={apiErrorMessage(agents.error, "The selected bot’s agent status is unknown.")}
        container="section"
        endContent={
          <Button label="Retry" variant="secondary" size="sm" onClick={() => void agents.refetch()} />
        }
      />
    ) : bot !== undefined && agents.isPending ? (
      <Banner
        status="info"
        title="Checking agent availability"
        description="You can review this conversation while the agent connection is checked."
        container="section"
      />
    ) : undefined;

  let workspaceContent: ReactNode;
  if (bots.isPending && bots.data === undefined) {
    workspaceContent = (
      <VStack
        gap={3}
        padding={6}
        role="status"
        aria-label="Loading workspace"
        data-testid="workspace-loading"
      >
        <Skeleton width="100%" height="var(--spacing-4)" radius={3} />
        <Skeleton width="100%" height="var(--spacing-10)" radius={3} index={1} />
        <Skeleton width="100%" height="var(--spacing-4)" radius={3} index={2} />
      </VStack>
    );
  } else if (bots.error !== null && bots.data === undefined) {
    workspaceContent = (
      <VStack padding={6}>
        <Banner
          status="error"
          title="Workspace could not be loaded"
          description={apiErrorMessage(bots.error, "Check your connection and try again.")}
          endContent={
            <Button label="Retry" variant="secondary" onClick={() => void bots.refetch()} />
          }
        />
      </VStack>
    );
  } else if ((bots.data?.length ?? 0) === 0) {
    workspaceContent = (
      <VStack height="100%" padding={6} vAlign="center">
        <EmptyState
          headingLevel={2}
          title="Create your first bot"
          description="Give a teammate a name, a job, and an available agent to start a conversation."
          icon={<Icon icon="info" size="lg" />}
          actions={
            <Button
              label="New bot"
              variant="primary"
              onClick={() => setCreateOpen(true)}
              data-testid="empty-create-bot"
            />
          }
        />
      </VStack>
    );
  } else if (bot === undefined) {
    workspaceContent = (
      <VStack
        gap={3}
        padding={6}
        role="status"
        aria-label="Opening bot"
        data-testid="bot-selection-loading"
      >
        <Skeleton width="100%" height="var(--spacing-4)" radius={3} />
        <Skeleton width="100%" height="var(--spacing-10)" radius={3} index={1} />
      </VStack>
    );
  } else {
    workspaceContent = (
      <VStack height="100%" gap={0}>
        {conversationNotice}
          <TranscriptAttention
            botId={bot.id}
            {...(thread !== undefined ? { threadId: thread.id } : {})}
            unreadCount={bot.unreadCount}
            {...(bot.unreadThreadId !== undefined ? { unreadThreadId: bot.unreadThreadId } : {})}
            {...(messages.data?.at(-1)?.id !== undefined ? { latestMessageId: messages.data.at(-1)!.id } : {})}
            onRead={async (botId, threadId) => {
              await api.markBotRead(botId, threadId);
              invalidate("bots");
            }}
          >
            <ChatPanel
              bot={bot}
              {...(thread !== undefined ? { thread } : {})}
              messages={messages.data ?? []}
              {...(thread !== undefined && messages.isPending ? { messagesLoading: true } : {})}
              {...(messages.error !== null
                ? { messagesError: apiErrorMessage(messages.error, "Messages could not be loaded.") }
                : {})}
              {...(thread !== undefined ? { onRetryMessages: () => void messages.refetch() } : {})}
              {...(selectedAgent !== undefined ? { agentReadiness: selectedAgent } : {})}
              onRetryAgentReadiness={async () => {
                await api.recheckAgent(bot.agentId);
                await agents.refetch();
                invalidate("bots");
              }}
              dictation={dictationController}
              autoSendVoice={autoSendVoice}
              onVoiceAutoSend={async (target, text) => {
                const response =
                  target.threadId !== undefined
                    ? await api.sendMessage(target.threadId, { text, clientTag: randomUuid() })
                    : await api.sendBotMessage(target.botId, { text, clientTag: randomUuid() });
                invalidate("threads");
                invalidate("bots");
                invalidate("messages", target.threadId);
                if (target.threadId === undefined && bot.id === target.botId && thread === undefined) onMessageSent(response.threadId);
              }}
              onMessageSent={onMessageSent}
              isAgentReady={isAgentReady}
              supportsSteering={supportsSteering}
            />
          </TranscriptAttention>
      </VStack>
    );
  }

  const currentPendingDeleteBot =
    pendingDeleteBot === undefined
      ? undefined
      : bots.data?.find((candidate) => candidate.id === pendingDeleteBot.id) ?? pendingDeleteBot;

  const requestBotDeletion = (target: BotViewDto): void => {
    setPendingDeleteBot(target);
    setDeleteError(undefined);
  };

  const deletePendingBot = async (): Promise<void> => {
    const target = pendingDeleteBot;
    if (target === undefined) return;
    setDeletingBotId(target.id);
    setDeleteError(undefined);

    const clearedDrafts = takeDraftsByBot(target.id);
    if (clearedDrafts === undefined) {
      setDeleteError(
        `Drafts saved in this browser couldn’t be cleared. ${target.name} was not deleted. Close other tabs using this Bot and try again.`,
      );
      setDeletingBotId(undefined);
      return;
    }

    try {
      const result = await api.deleteBot(target.id);
      if (result.status === "failed") {
        const draftsRestored = restoreDrafts(clearedDrafts);
        const firstFailure = result.failures[0];
        const barrierFailed =
          firstFailure?.stage === "turn_cancellation" || firstFailure?.stage === "terminal_wait";
        setDeleteError(
          `${barrierFailed
            ? `Active work couldn’t be stopped, so no local cleanup began and ${target.name} remains available.`
            : `Some local data couldn’t be removed, so ${target.name} remains available.`}`
          + `${firstFailure === undefined ? "" : ` ${firstFailure.message}.`} Try again.`
          + `${draftsRestored ? "" : " Drafts saved in this browser also couldn’t be restored."}`,
        );
        return;
      }

      await qc.cancelQueries({ queryKey: ["bots"] });
      const remaining = (bots.data ?? []).filter((candidate) => candidate.id !== target.id);
      qc.setQueryData(["bots"], remaining);
      qc.removeQueries({ queryKey: ["threads", target.id], exact: true });
      qc.removeQueries({ queryKey: ["messages"] });
      setPendingDeleteBot(undefined);
      setDeleteError(undefined);

      if (selectedBotId === target.id) {
        setHistoryOpen(false);
        setRightRegion({ mode: "closed" });
        const fallback = mostRecentlyActiveBot(remaining);
        await navigate({
          search: fallback === undefined ? {} : { bot: fallback.id },
          replace: true,
        });
      }
      invalidate("bots");
    } catch (failure) {
      const draftsRestored = restoreDrafts(clearedDrafts);
      setDeleteError(
        apiErrorMessage(
          failure,
          `Local deletion couldn’t be completed, so ${target.name} remains available. Try again.`,
        )
        + `${draftsRestored ? "" : " Drafts saved in this browser also couldn’t be restored."}`,
      );
    } finally {
      setDeletingBotId(undefined);
    }
  };

  const sidebar = (
    <Sidebar
      bots={bots.data ?? []}
      {...(selectedBotId !== undefined ? { selectedBotId } : {})}
      pluginsOpen={pluginsOpen}
      onOpenPlugins={() => setPluginsOpen(true)}
      onSelectBot={selectBot}
      onOpenBotSettings={(botId) => {
        setRightRegion({ mode: "closed" });
        if (selectedBotId === botId) {
          setRightRegion({ mode: "bot-settings" });
          return;
        }
        void navigate({ search: { bot: botId } }).then(() => setRightRegion({ mode: "bot-settings" }));
      }}
      onDeleteBot={requestBotDeletion}
      onCreateBot={() => setCreateOpen(true)}
      onOpenSettings={() => {
        setNotificationPermission(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
        setSettingsOpen(true);
      }}
    />
  );

  return (
    <AppShell
      height="fill"
      contentPadding={0}
      variant="section"
      mobileNav={{
        breakpoint: "md",
        hasToggle: false,
        content: <MobileNav header="Bot navigation">{sidebar}</MobileNav>,
      }}
      {...(workspaceBanner !== undefined ? { banner: workspaceBanner } : {})}
      sideNav={sidebar}
    >
      <Layout
        height="fill"
        padding={0}
        className="workspace-layout"
        header={
          <ConversationHeader
            {...(bot !== undefined ? { bot } : {})}
            {...(thread !== undefined ? { thread } : {})}
            onOpenHistory={() => setHistoryOpen(true)}
            botSettingsOpen={botSettingsOpen}
            onToggleBotSettings={() => {
              setRightRegion((current) =>
                current.mode === "bot-settings" ? { mode: "closed" } : { mode: "bot-settings" }
              );
            }}
            computerState={computer.data?.state ?? "unavailable"}
            computerOpen={computerOpen}
            onToggleComputer={() => {
              if (computerOpen) {
                setRightRegion({ mode: "closed" });
                return;
              }
              setRightRegion({ mode: "capabilities" });
            }}
            mobileNavigationTriggerRef={mobileNavigationTriggerRef}
            computerTriggerRef={computerTriggerRef}
            botSettingsTriggerRef={botSettingsTriggerRef}
          />
        }
        content={
          <ConversationWorkspace panelOpen={rightRegion.mode !== "closed"}>
            {workspaceContent}
          </ConversationWorkspace>
        }
        end={
          bot !== undefined ? (
            rightRegion.mode === "bot-settings" ? (
              <BotSettingsPanel
                bot={bot}
                agentDisplayName={selectedAgent?.displayName ?? bot.agentId}
                open
                returnFocusRef={botSettingsTriggerRef}
                onClose={() => setRightRegion({ mode: "closed" })}
                onUpdated={(updated) => {
                  qc.setQueryData<BotViewDto[]>(["bots"], (currentBots) =>
                    currentBots?.map((candidate) =>
                      candidate.id === updated.id ? { ...candidate, ...updated } : candidate,
                    ),
                  );
                }}
              />
            ) : (
              <CapabilityPanel
                key={`${bot.id}:${bot.surfaceId}`}
                open={rightRegion.mode === "capabilities"}
                bot={bot}
                view={
                  computer.data
                    ?? {
                      botId: bot.id,
                      surfaceId: bot.surfaceId,
                      state: "unavailable",
                      takeover: "unavailable",
                      activity:
                        computer.error !== null
                          ? apiErrorMessage(computer.error, "Bot Screen status could not be loaded.")
                          : "Bot Screen state is loading.",
                    }
                }
                projectionUrl={api.computerProjectionUrl({ botId: bot.id, surfaceId: bot.surfaceId })}
                returnFocusRef={computerTriggerRef}
                busy={computerAction.isPending}
                {...(computer.isPending ? { loading: true } : {})}
                {...(computer.error !== null ? { onRetry: () => void computer.refetch() } : {})}
                {...(computerError !== undefined ? { error: computerError } : {})}
                onClose={() => setRightRegion({ mode: "closed" })}
                onTakeControl={() => computerAction.mutateAsync("take").then(() => true, () => false)}
                onReturnToBot={() => computerAction.mutateAsync("return").then(() => true, () => false)}
              />
            )
          ) : undefined
        }
      />
      <PluginsDialog
        open={pluginsOpen}
        onClose={() => setPluginsOpen(false)}
        mobileReturnFocusRef={mobileNavigationTriggerRef}
        bots={bots.data ?? []}
        selectedBotId={selectedBotId}
        onCreateSkill={async (botId, description) => {
          const response = await api.sendBotMessage(botId, {
            text: `Use the installed skill-creator Skill to create and validate a reusable Agent Skill for this request:\n\n${description}\n\nSave the complete Skill in the shared native Skills installation so all Bots and Agents can discover it. Keep the Skill Agent-neutral, preserve existing resources, and do not publish it automatically.`,
            clientTag: randomUuid(),
          });
          invalidate("threads");
          invalidate("bots");
          void navigate({ search: { bot: botId, thread: response.threadId } });
          setPluginsOpen(false);
        }}
      />
      <CreateBotDialog
        isOpen={createOpen}
        mobileReturnFocusRef={mobileNavigationTriggerRef}
        onClose={() => setCreateOpen(false)}
        onCreated={(botId) => {
          void qc.invalidateQueries({ queryKey: ["bots"] }).then(() => {
            void navigate({ search: { bot: botId, thread: "blank" } });
          });
        }}
      />
      {bot !== undefined ? (
        <HistoryDialog
          botId={bot.id}
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          onSelectThread={(threadId) => void navigate({ search: { bot: bot.id, thread: threadId } })}
          onNewConversation={() => void navigate({ search: { bot: bot.id, thread: "blank" } })}
        />
      ) : null}
      <SettingsDialog
        open={settingsOpen}
        mobileReturnFocusRef={mobileNavigationTriggerRef}
        onClose={() => setSettingsOpen(false)}
        bots={bots.data ?? []}
        {...(bots.isPending ? { botsLoading: true } : {})}
        {...(bots.error !== null
          ? { botsError: apiErrorMessage(bots.error, "Bots could not be loaded.") }
          : {})}
        {...(bots.error !== null ? { onRetryBots: () => void bots.refetch() } : {})}
        dictation={
          dictation.data
          ?? {
            state: "unavailable",
            ...(dictation.error !== null
              ? { error: apiErrorMessage(dictation.error, "Voice dictation status could not be checked.") }
              : {}),
          }
        }
        autoSendVoice={autoSendVoice}
        onAutoSendVoiceChange={setAutoSendVoice}
        notificationPermission={notificationPermission}
        onRequestNotifications={() => {
          void requestDesktopNotificationPermission().then(setNotificationPermission);
        }}
        {...(deletingBotId !== undefined ? { deletingBotId } : {})}
        onRequestDeleteBot={requestBotDeletion}
      />
      <AlertDialog
        isOpen={pendingDeleteBot !== undefined}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && deletingBotId === undefined) {
            setPendingDeleteBot(undefined);
            setDeleteError(undefined);
          }
        }}
        title={
          deleteError === undefined
            ? `Delete ${currentPendingDeleteBot?.name ?? "this Bot"}?`
            : `Couldn’t delete ${currentPendingDeleteBot?.name ?? "this Bot"}`
        }
        description={
          deleteError
          ?? `${currentPendingDeleteBot?.status === "active"
            ? `${currentPendingDeleteBot.name} has active work. Deleting it will stop all of this Bot’s current work. `
            : ""}Deleting ${currentPendingDeleteBot?.name ?? "this Bot"} permanently removes its Omarchy Bot conversations, messages, managed attachments, uploaded avatar data, and local drafts. Agent-owned Native Sessions may remain. This cannot be undone.`
        }
        cancelLabel="Cancel"
        actionLabel={deleteError === undefined ? "Delete permanently" : "Try again"}
        actionVariant="destructive"
        isActionLoading={deletingBotId !== undefined}
        onAction={() => void deletePendingBot()}
        data-testid="permanent-delete-confirmation"
      />
    </AppShell>
  );
}
