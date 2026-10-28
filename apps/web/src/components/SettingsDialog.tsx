import type { JSX, RefObject } from "react";
import { useEffect, useState } from "react";
import { Bell, Bot, Palette } from "lucide-react";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Item } from "@astryxdesign/core/Item";
import { Layout, LayoutContent, LayoutPanel } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { BotViewDto } from "@omarchy-bot/protocol";
import { AvatarView } from "./AvatarView.tsx";
import { BottomSheetWithReturnFocus } from "./BottomSheetWithReturnFocus.tsx";

export interface SettingsDialogProps {
  open: boolean;
  mobileReturnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  bots: BotViewDto[];
  deletingBotId?: string;
  onRequestDeleteBot: (bot: BotViewDto) => void;
  botsLoading?: boolean;
  botsError?: string;
  onRetryBots?: () => void;
  notificationPermission: NotificationPermission | "unsupported";
  onRequestNotifications: () => void;
}

type SettingsSectionId = "appearance" | "notifications" | "bots";

const SETTINGS_SECTIONS = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "bots", label: "Bots", icon: Bot },
] as const satisfies ReadonlyArray<{
  id: SettingsSectionId;
  label: string;
  icon: typeof Palette;
}>;


interface SettingsContentProps extends Pick<
  SettingsDialogProps,
  | "open"
  | "bots"
  | "botsLoading"
  | "botsError"
  | "onRetryBots"
  | "notificationPermission"
  | "onRequestNotifications"
> {
  compactNav: boolean;
  deletingBotId?: string;
  onClose: () => void;
  onRequestDelete: (bot: BotViewDto) => void;
}

function AppearanceSection(): JSX.Element {
  return (
    <VStack gap={2}>
      <VStack gap={0.5}>
        <Heading level={3}>Appearance</Heading>
        <Text color="secondary">Theme follows Omarchy and your system preference.</Text>
      </VStack>
      <Item
        label="Omarchy / system"
        description="Follows your current Omarchy and system appearance."
        align="start"
      />
    </VStack>
  );
}

function NotificationsSection({
  notificationPermission,
  onRequestNotifications,
}: Pick<
  SettingsContentProps,
  "notificationPermission" | "onRequestNotifications"
>): JSX.Element {
  const notificationsDescription =
    notificationPermission === "unsupported"
      ? "Desktop notifications are not available in this browser."
      : notificationPermission === "denied"
        ? "Notifications are blocked. Allow them in this site’s browser settings."
        : notificationPermission === "granted"
          ? "Enabled for background Bot completions and requests for your attention."
          : "Enable alerts for background Bot completions and requests for your attention.";
  return (
    <VStack gap={2}>
      <VStack gap={0.5}>
        <Heading level={3}>Notifications</Heading>
        <Text color="secondary">Control alerts for background Bot activity.</Text>
      </VStack>
      <Item label="Desktop notifications" description={notificationsDescription} align="start" />
      {notificationPermission === "default" ? (
        <Button
          label="Enable desktop notifications"
          variant="secondary"
          onClick={onRequestNotifications}
          data-testid="enable-notifications"
        />
      ) : null}
    </VStack>
  );
}

function BotsSection({
  bots,
  botsLoading,
  botsError,
  onRetryBots,
  deletingBotId,
  onRequestDelete,
}: Pick<
  SettingsContentProps,
  "bots" | "botsLoading" | "botsError" | "onRetryBots" | "deletingBotId" | "onRequestDelete"
>): JSX.Element {
  const operationPending = deletingBotId !== undefined;
  return (
    <VStack gap={3}>
      <VStack gap={0.5}>
        <Heading level={3}>Bots</Heading>
        <Text color="secondary">Permanently delete a Bot and its Omarchy Bot-owned data.</Text>
      </VStack>
      {botsLoading ? (
        <EmptyState
          icon={<Icon icon="clock" size="lg" />}
          title="Loading bots"
          description="Fetching bots."
          isCompact
        />
      ) : botsError !== undefined ? (
        <EmptyState
          icon={<Icon icon="warning" size="lg" />}
          title="Bots couldn’t load"
          description={botsError}
          {...(onRetryBots !== undefined
            ? { actions: <Button label="Try loading again" variant="secondary" onClick={onRetryBots} /> }
            : {})}
          isCompact
        />
      ) : bots.length === 0 ? (
        <EmptyState
          icon={<Icon icon="checkDouble" size="lg" />}
          title="No bots"
          description="Create a Bot from the workspace to start chatting."
          isCompact
        />
      ) : (
        bots.map((bot) => (
          <VStack key={bot.id} gap={1}>
            <Item
              startContent={<AvatarView avatar={bot.avatar} name={bot.name} size="sm" presentation="static" />}
              label={bot.name}
              labelLines={2}
              description="Deletion permanently removes Omarchy Bot-owned data."
              align="start"
              data-testid={`settings-bot-${bot.id}`}
            />
            <HStack gap={1} wrap="wrap" justify="end">
              <Button
                label={`Delete ${bot.name}`}
                variant="destructive"
                size="sm"
                isLoading={deletingBotId === bot.id}
                isDisabled={operationPending}
                onClick={() => onRequestDelete(bot)}
                data-testid={`settings-delete-${bot.id}`}
              >
                Delete
              </Button>
            </HStack>
          </VStack>
        ))
      )}
    </VStack>
  );
}

function SettingsContent({
  open,
  bots,
  botsLoading = false,
  botsError,
  onRetryBots,
  notificationPermission,
  onRequestNotifications,
  compactNav,
  deletingBotId,
  onClose,
  onRequestDelete,
}: SettingsContentProps): JSX.Element {
  const [section, setSection] = useState<SettingsSectionId>("appearance");
  const operationPending = deletingBotId !== undefined;

  useEffect(() => {
    if (open) setSection("appearance");
  }, [open]);

  const selected = SETTINGS_SECTIONS.find((entry) => entry.id === section) ?? SETTINGS_SECTIONS[0];

  return (
    <Layout
      height="fill"
      defaultHasDividers
      header={
        <DialogHeader
          title="Settings"
          subtitle="Manage workspace preferences and bot lifecycle."
          onOpenChange={(nextOpen) => {
            if (!nextOpen) onClose();
          }}
        />
      }
      start={
        <LayoutPanel width={compactNav ? 148 : 220} hasDivider isScrollable>
          <nav aria-label="Settings sections">
            <VStack gap={0.5}>
              {SETTINGS_SECTIONS.map((entry) => (
                <Item
                  key={entry.id}
                  startContent={<Icon icon={entry.icon} size="sm" />}
                  label={entry.label}
                  labelLines={1}
                  density="compact"
                  isSelected={entry.id === selected.id}
                  onClick={() => setSection(entry.id)}
                  data-testid={`settings-nav-${entry.id}`}
                />
              ))}
            </VStack>
          </nav>
        </LayoutPanel>
      }
      content={
        <LayoutContent
          isScrollable
          data-testid="settings-dialog"
          aria-busy={botsLoading || operationPending || undefined}
        >
          {selected.id === "appearance" ? <AppearanceSection /> : null}
          {selected.id === "notifications" ? (
            <NotificationsSection
              notificationPermission={notificationPermission}
              onRequestNotifications={onRequestNotifications}
            />
          ) : null}
          {selected.id === "bots" ? (
            <BotsSection
              bots={bots}
              botsLoading={botsLoading}
              {...(botsError !== undefined ? { botsError } : {})}
              {...(onRetryBots !== undefined ? { onRetryBots } : {})}
              {...(deletingBotId !== undefined ? { deletingBotId } : {})}
              onRequestDelete={onRequestDelete}
            />
          ) : null}
        </LayoutContent>
      }
    />
  );
}

/** Responsive workspace settings with preferences and permanent Bot deletion. */
export function SettingsDialog({
  open,
  onClose,
  bots,
  deletingBotId,
  onRequestDeleteBot,
  botsLoading = false,
  botsError,
  onRetryBots,
  mobileReturnFocusRef,
  notificationPermission,
  onRequestNotifications,
}: SettingsDialogProps): JSX.Element {
  const { isMobile } = useAppShellMobile();
  const content = (
    <SettingsContent
      open={open}
      bots={bots}
      botsLoading={botsLoading}
      {...(botsError !== undefined ? { botsError } : {})}
      {...(onRetryBots !== undefined ? { onRetryBots } : {})}
      notificationPermission={notificationPermission}
      onRequestNotifications={onRequestNotifications}
      compactNav={isMobile}
      {...(deletingBotId !== undefined ? { deletingBotId } : {})}
      onClose={onClose}
      onRequestDelete={onRequestDeleteBot}
    />
  );

  return isMobile ? (
    <BottomSheetWithReturnFocus
      label="Settings"
      returnFocusRef={mobileReturnFocusRef}
      isOpen={open}
      onOpenChange={(nextOpen) => !nextOpen && onClose()}
      height="tall"
    >
      {content}
    </BottomSheetWithReturnFocus>
  ) : (
    <Dialog
      isOpen={open}
      onOpenChange={(nextOpen) => !nextOpen && onClose()}
      width={840}
      maxHeight="75dvh"
      padding={6}
      style={{ height: "min(36rem, 75dvh)", overflow: "hidden" }}
    >
      {content}
    </Dialog>
  );
}
