import * as stylex from "@stylexjs/stylex";
import type { JSX, RefObject } from "react";
import { Monitor } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { LayoutHeader } from "@astryxdesign/core/Layout";
import { StackItem } from "@astryxdesign/core/Stack";
import type { BotViewDto, ComputerViewDto, ThreadDto } from "@omarchy-bot/protocol";
import { AvatarView } from "./AvatarView.tsx";
import { avatarStatusScope, avatarStatusStyles } from "./avatarStatus.stylex.ts";

const COMPUTER_TOOLTIPS: Record<ComputerViewDto["state"], string> = {
  starting: "Open Computer Surface, Screen is starting",
  ready: "Open Computer Surface",
  "bot-using": "Open Computer Surface, Bot using screen",
  "needs-you": "Open Computer Surface, Bot Screen needs you",
  "user-control": "Open Computer Surface, you have control",
  unavailable: "Open Computer Surface, Screen unavailable",
};

export interface ConversationHeaderProps {
  bot?: BotViewDto;
  thread?: ThreadDto;
  computerState: ComputerViewDto["state"];
  computerOpen: boolean;
  botSettingsOpen: boolean;
  onOpenHistory: () => void;
  onToggleBotSettings: () => void;
  onToggleComputer: () => void;
  mobileNavigationTriggerRef: RefObject<HTMLButtonElement | null>;
  historyTriggerRef: RefObject<HTMLButtonElement | null>;
  computerTriggerRef: RefObject<HTMLButtonElement | null>;
  botSettingsTriggerRef: RefObject<HTMLButtonElement | null>;
}

function MobileSidebarTrigger({ triggerRef }: { triggerRef: RefObject<HTMLButtonElement | null> }): JSX.Element | null {
  const {
    isMobile,
    isMobileNavEnabled,
    isMobileNavOpen,
    mobileNavId,
    openMobileNav,
  } = useAppShellMobile();

  if (!isMobile || !isMobileNavEnabled) return null;

  return (
    <IconButton
      ref={triggerRef}
      label="Open bot navigation"
      tooltip="Open bot navigation"
      icon={<Icon icon="menu" size="md" />}
      variant="ghost"
      onClick={openMobileNav}
      aria-expanded={isMobileNavOpen}
      {...(mobileNavId !== undefined ? { "aria-controls": mobileNavId } : {})}
      data-testid="mobile-sidebar-trigger"
    />
  );
}

/**
 * Conversation-local header: the sole page heading, thread history, Computer,
 * and Bot Settings actions. AppShell provides the global navigation frame.
 */
export function ConversationHeader({
  bot,
  thread,
  computerState,
  computerOpen,
  botSettingsOpen,
  onOpenHistory,
  onToggleBotSettings,
  onToggleComputer,
  mobileNavigationTriggerRef,
  historyTriggerRef,
  computerTriggerRef,
  botSettingsTriggerRef,
}: ConversationHeaderProps): JSX.Element {
  return (
    <LayoutHeader hasDivider label="Conversation" padding={2}>
      <HStack
        gap={3}
        vAlign="center"
        data-testid="conversation-header"
      >
        <MobileSidebarTrigger triggerRef={mobileNavigationTriggerRef} />
        <StackItem size="fill">
          <HStack gap={1} vAlign="center">
            {bot !== undefined ? (
              <Button
                ref={botSettingsTriggerRef}
                label={`${botSettingsOpen ? "Close" : "Open"} settings for ${bot.name}`}
                variant="ghost"
                size="sm"
                onClick={onToggleBotSettings}
                xstyle={avatarStatusScope}
                data-testid="bot-settings-open"
                style={{
                  minWidth: 0,
                  maxWidth: "min(220px, 45vw)",
                  height: "auto",
                  paddingBlock: 4,
                  paddingInline: 6,
                  overflow: "hidden",
                }}
                aria-expanded={botSettingsOpen}
              >
                <HStack gap={1} vAlign="center" xstyle={avatarStatusStyles.identity}>
                  <AvatarView
                    avatar={bot.avatar}
                    name={bot.name}
                    size="sm"
                    presentation="static"
                    decorative
                  />
                  <Text as="h1" type="body" weight="medium" xstyle={avatarStatusStyles.nameLine}>
                    <span {...stylex.props(avatarStatusStyles.name)}>{bot.name}</span>
                    {bot.status === "active" ? (
                      <span {...stylex.props(avatarStatusStyles.reveal)} aria-hidden="true" data-testid="header-working-status">
                        <span {...stylex.props(avatarStatusStyles.content)}>{" is working"}</span>
                      </span>
                    ) : null}
                  </Text>
                </HStack>
              </Button>
            ) : (
              <Text as="h1" type="body" weight="medium" maxLines={1}>
                omarchy-bot
              </Text>
            )}
            <StackItem size="fill">
              <Button
                ref={historyTriggerRef}
                label="Open conversation history"
                variant="ghost"
                size="sm"
                isDisabled={bot === undefined}
                onClick={onOpenHistory}
                data-testid="thread-history-trigger"
                style={{ minWidth: 0, maxWidth: "100%", overflow: "hidden" }}
              >
                <Text type="supporting" color="secondary" maxLines={1}>
                  {thread?.title ?? "New conversation"}
                </Text>
              </Button>
            </StackItem>
          </HStack>
        </StackItem>
        <IconButton
          ref={computerTriggerRef}
          label={computerOpen ? "Close Computer Surface" : "Open Computer Surface"}
          tooltip={computerOpen ? "Close Computer Surface" : COMPUTER_TOOLTIPS[computerState]}
          isDisabled={bot === undefined}
          icon={<Icon icon={Monitor} size="md" />}
          variant={
            computerOpen || (computerState !== "ready" && computerState !== "unavailable") ? "secondary" : "ghost"
          }
          onClick={onToggleComputer}
          aria-expanded={computerOpen}
          data-state={computerState}
          data-testid="header-computer"
        />
      </HStack>
    </LayoutHeader>
  );
}
