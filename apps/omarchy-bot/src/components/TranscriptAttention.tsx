import type { JSX, ReactNode, RefObject, UIEventHandler } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { VStack } from "@astryxdesign/core/VStack";
import styles from "../lib/styles.ts";

const LATEST_THRESHOLD_PX = 8;

export interface TranscriptAttentionProps {
  botId?: string;
  threadId?: string;
  unreadCount: number;
  unreadThreadId?: string;
  latestMessageId?: string;
  onRead: (botId: string, threadId: string) => Promise<void>;
  children: ReactNode;
}

interface TranscriptAttentionSurface {
  viewportRef: RefObject<HTMLDivElement | null>;
  onViewportScroll: UIEventHandler<HTMLDivElement>;
}

const TranscriptAttentionContext = createContext<TranscriptAttentionSurface | null>(null);

export function useTranscriptAttentionSurface(): TranscriptAttentionSurface | null {
  return useContext(TranscriptAttentionContext);
}

function isAtLatest(viewport: HTMLElement): boolean {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= LATEST_THRESHOLD_PX;
}

/** Owns the read boundary while ChatLayout remains the one native scrolling surface. */
export function TranscriptAttention({
  botId,
  threadId,
  unreadCount,
  unreadThreadId,
  latestMessageId,
  onRead,
  children,
}: TranscriptAttentionProps): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const atLatestRef = useRef(true);
  const readInFlightRef = useRef<string | undefined>(undefined);

  const acknowledgeIfLatest = useCallback(
    (atLatest: boolean): void => {
      atLatestRef.current = atLatest;
      const hasMatchingUnread =
        unreadCount > 0
        && botId !== undefined
        && threadId !== undefined
        && unreadThreadId === threadId
        && latestMessageId !== undefined;
      if (!hasMatchingUnread || !atLatest) return;

      const readKey = `${botId}:${threadId}:${latestMessageId}`;
      if (readInFlightRef.current === readKey) return;
      readInFlightRef.current = readKey;
      void onRead(botId, threadId).catch(() => {
        if (readInFlightRef.current === readKey) readInFlightRef.current = undefined;
      });
    },
    [botId, threadId, unreadCount, unreadThreadId, latestMessageId, onRead],
  );

  const inspectViewport = useCallback((): void => {
    const viewport = viewportRef.current;
    if (viewport !== null) acknowledgeIfLatest(isAtLatest(viewport));
  }, [acknowledgeIfLatest]);

  const onViewportScroll = useCallback<UIEventHandler<HTMLDivElement>>(
    (event): void => acknowledgeIfLatest(isAtLatest(event.currentTarget)),
    [acknowledgeIfLatest],
  );

  useEffect(() => {
    atLatestRef.current = true;
    readInFlightRef.current = undefined;
  }, [botId, threadId]);

  useEffect(() => {
    const followLatest = atLatestRef.current;
    const frame = requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (viewport === null) return;
      if (followLatest) viewport.scrollTop = viewport.scrollHeight;
      acknowledgeIfLatest(isAtLatest(viewport));
    });
    return () => cancelAnimationFrame(frame);
  }, [latestMessageId, botId, threadId, acknowledgeIfLatest]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const observer = new ResizeObserver(inspectViewport);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [inspectViewport]);

  const surface = useMemo(
    () => ({ viewportRef, onViewportScroll }),
    [onViewportScroll],
  );

  return (
    <TranscriptAttentionContext value={surface}>
      <VStack gap={0} xstyle={styles.fillColumn} data-testid="transcript-attention">
        {children}
      </VStack>
    </TranscriptAttentionContext>
  );
}
