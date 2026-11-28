import * as stylex from "@stylexjs/stylex";
import type { JSX } from "react";
import { useEffect, useRef } from "react";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import {
  SideNav,
  SideNavItem,
  SideNavSection,
} from "@astryxdesign/core/SideNav";
import { Plus, Plug } from "lucide-react";
import { Item } from "@astryxdesign/core/Item";
import { Badge } from "@astryxdesign/core/Badge";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { ContextMenu } from "@astryxdesign/core/ContextMenu";
import type { BotViewDto } from "@omarchy-bot/protocol";
import { AvatarStatusDot } from "@astryxdesign/core/Avatar";
import { AvatarView } from "./AvatarView.tsx";
import { avatarStatusScope, avatarStatusStyles } from "./avatarStatus.stylex.ts";

export interface SidebarProps {
  bots: BotViewDto[];
  selectedBotId?: string;
  pluginsOpen: boolean;
  onOpenPlugins: () => void;
  onSelectBot: (botId: string) => void;
  onOpenBotSettings: (botId: string) => void;
  onDeleteBot: (bot: BotViewDto) => void;
  onCreateBot: () => void;
  onOpenSettings: () => void;
}

const sidebarStyles = stylex.create({
  row: {
    transitionDuration: {
      default: null,
      "@media (prefers-reduced-motion: reduce)": "0s",
    },
  },
});

const activityTime = (bot: BotViewDto): string => bot.lastActivityAt ?? bot.createdAt;

export function orderSidebarBots(bots: BotViewDto[]): BotViewDto[] {
  return [...bots].sort(
    (a, b) => activityTime(b).localeCompare(activityTime(a)) || a.id.localeCompare(b.id),
  );
}

/** Open the teammate with newest activity. */
export function mostRecentlyActiveBot(bots: BotViewDto[]): BotViewDto | undefined {
  return [...bots].sort(
    (a, b) => activityTime(b).localeCompare(activityTime(a)) || a.id.localeCompare(b.id),
  )[0];
}

/**
 * The global navigation surface (workspace-redesign §2–§3): one row per
 * user-created Bot — never one row per Agent. Bots sort by recent activity;
 * Plugins and Settings sit fixed at the bottom, with Plugins first.
 */
export function Sidebar({
  bots,
  selectedBotId,
  pluginsOpen,
  onOpenPlugins,
  onSelectBot,
  onOpenBotSettings,
  onDeleteBot,
  onCreateBot,
  onOpenSettings,
}: SidebarProps): JSX.Element {
  const { closeMobileNav, isMobile } = useAppShellMobile();
  const sidebarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const suppressKeyboardContextMenu = (event: MouseEvent): void => {
      if (event.button === 2 || !sidebarRef.current?.contains(event.target as Node)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("contextmenu", suppressKeyboardContextMenu, true);
    return () => document.removeEventListener("contextmenu", suppressKeyboardContextMenu, true);
  }, []);
  const ordered = orderSidebarBots(bots);
  const renderBot = (bot: BotViewDto): JSX.Element => (
    <ContextMenu
      key={bot.id}
      label={`${bot.name} actions`}
      items={[
        { label: "Bot Settings", onClick: () => onOpenBotSettings(bot.id) },
        {
          label: "Delete",
          variant: "destructive",
          onClick: () => onDeleteBot(bot),
        },
      ]}
    >
      <Item
        xstyle={[avatarStatusScope, sidebarStyles.row]}
        startContent={
          <HStack height={48} vAlign="center">
            <AvatarView
              avatar={bot.avatar}
              name={bot.name}
              size={42}
              presentation="ambient"
              decorative
            />
          </HStack>
        }
        label={
          <strong {...stylex.props(avatarStatusStyles.nameLine)}>
            <span {...stylex.props(avatarStatusStyles.name)}>{bot.name}</span>
            {bot.status === "active" ? (
              <span {...stylex.props(avatarStatusStyles.reveal)} aria-hidden="true" data-testid="sidebar-working-status">
                <span {...stylex.props(avatarStatusStyles.content)}>{" is working"}</span>
              </span>
            ) : null}
          </strong>
        }
        labelLines={1}
        description={
          <Text aria-hidden="true" type="supporting" color={bot.id === selectedBotId ? "primary" : "secondary"} maxLines={1}>
            {bot.previewText ?? "No output yet"}
          </Text>
        }
        descriptionLines={1}
        density="compact"
        isSelected={bot.id === selectedBotId}
        onClick={() => {
          onSelectBot(bot.id);
          if (isMobile) closeMobileNav();
        }}
        endContent={
          bot.status === "active" || bot.unreadCount > 0 ? (
            <HStack gap={1} vAlign="center">
              {bot.status === "active" ? (
                <span data-testid="sidebar-activity-point">
                  <AvatarStatusDot variant="success" label={`${bot.name} is active`} />
                </span>
              ) : null}
              {bot.unreadCount > 0 ? (
                <Badge
                  variant="blue"
                  label={bot.unreadCount}
                  aria-label={`${bot.unreadCount} unread ${bot.unreadCount === 1 ? "message" : "messages"}`}
                  data-testid={`sidebar-unread-${bot.id}`}
                />
              ) : null}
            </HStack>
          ) : undefined
        }
        data-testid={`sidebar-bot-${bot.id}`}
      />
    </ContextMenu>
  );

  return (
    <VStack ref={sidebarRef} height="100%" data-testid="sidebar">
      <SideNav
        aria-label="Bot navigation"
        {...(isMobile ? { "data-testid": "mobile-sidebar" } : {})}
        footer={
          <VStack gap={0.5}>
            <SideNavItem
              label="Plugins"
              icon={<Icon icon={Plug} size="sm" />}
              isSelected={pluginsOpen}
              aria-haspopup="dialog"
              aria-expanded={pluginsOpen}
              onClick={() => {
                if (isMobile) closeMobileNav();
                onOpenPlugins();
              }}
              data-testid="plugins-trigger"
            />
            <SideNavItem
              label="Settings"
              aria-label="Settings"
              icon={<Icon icon="wrench" size="sm" />}
              onClick={() => {
                if (isMobile) closeMobileNav();
                onOpenSettings();
              }}
              data-testid="settings-trigger"
            />
          </VStack>
        }
        topContent={
          <HStack justify="end">
            <IconButton
              label="New bot"
              tooltip="New bot"
              variant="primary"
              icon={<Icon icon={Plus} size="md" />}
              onClick={() => {
                if (isMobile) closeMobileNav();
                onCreateBot();
              }}
              data-testid="sidebar-create-bot"
            />
          </HStack>
        }
      >
        <SideNavSection title="Bots" isHeaderHidden>
          {ordered.length === 0 ? (
            <VStack padding={4}>
              <Text color="secondary">No bots yet. Create one to start chatting.</Text>
            </VStack>
          ) : (
            ordered.map(renderBot)
          )}
        </SideNavSection>
      </SideNav>
    </VStack>
  );
}
