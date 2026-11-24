import type { ChangeEvent, JSX, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as stylex from "@stylexjs/stylex";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack } from "@astryxdesign/core/HStack";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Switch } from "@astryxdesign/core/Switch";
import { Typeahead, type SearchSource } from "@astryxdesign/core/Typeahead";
import { VStack } from "@astryxdesign/core/VStack";
import type { BotDto, BotViewDto } from "@omarchy-bot/protocol";
import { api, apiErrorMessage } from "../lib/api.ts";
import styles from "../lib/styles.ts";
import { rollbackBotDisplaySetting, selectBotDisplayState } from "../lib/botDisplaySettings.ts";
import type { BotDisplaySetting } from "../lib/botDisplaySettings.ts";
import { buildBotModelOptions, toBotModelOverride } from "../lib/botModelOptions.ts";
import { getShell } from "../lib/shell.ts";
import { AvatarView } from "./AvatarView.tsx";
import { WorkspaceDrawer } from "./WorkspaceDrawer.tsx";

export interface BotSettingsPanelProps {
  bot: BotViewDto;
  open: boolean;
  agentDisplayName: string;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onUpdated: (bot: BotDto) => void;
}

type BusyAction = "save" | "variation" | "upload" | "recipe";
type ImmediateSetting = BotDisplaySetting | "model";
type InvalidField = "name" | "avatarDescription";

/** Right-side Bot Settings panel. Profile identity and Display preferences remain separate. */
export function BotSettingsPanel({
  bot,
  agentDisplayName,
  open,
  returnFocusRef,
  onClose,
  onUpdated,
}: BotSettingsPanelProps): JSX.Element {
  const [current, setCurrent] = useState<BotDto>(bot);
  const [name, setName] = useState(bot.name);
  const [instructions, setInstructions] = useState(bot.instructions);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<BusyAction | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [displayError, setDisplayError] = useState<string | undefined>(undefined);
  const [modelError, setModelError] = useState<string | undefined>(undefined);
  const [settingBusy, setSettingBusy] = useState<ImmediateSetting | undefined>(undefined);
  const [invalidField, setInvalidField] = useState<InvalidField | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  const latestBotRef = useRef<BotDto>(bot);
  const profileSnapshotRef = useRef<Pick<BotDto, "id" | "name" | "instructions"> | undefined>(undefined);
  const settingBusyRef = useRef<ImmediateSetting | undefined>(undefined);
  const panelOpenRef = useRef(false);
  const panelBotIdRef = useRef<string | undefined>(undefined);
  const nameInput = useRef<HTMLInputElement>(null);
  const modelField = useRef<HTMLDivElement>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const queryClient = useQueryClient();
  const providers = useQuery({
    queryKey: ["providers", getShell().service.baseUrl()],
    queryFn: () => api.providers(),
    enabled: open,
    retry: false,
  });
  const modelOptions = useMemo(() => buildBotModelOptions(providers.data ?? [], current.model), [providers.data, current.model]);
  const modelSearch = useMemo<SearchSource>(() => ({
    search: (query) => {
      const term = query.trim().toLowerCase();
      return modelOptions.filter(({ id, label }) => id.toLowerCase().includes(term) || label.toLowerCase().includes(term));
    },
    bootstrap: () => modelOptions,
  }), [modelOptions]);

  useEffect(() => {
    if (settingBusyRef.current === undefined || latestBotRef.current.id === bot.id) latestBotRef.current = bot;
    const resetTransientState = (open && !panelOpenRef.current) || panelBotIdRef.current !== bot.id;
    panelOpenRef.current = open;
    if (!open || settingBusyRef.current !== undefined) return;
    panelBotIdRef.current = bot.id;
    setCurrent(bot);
    if (!resetTransientState) return;
    setPrompt("");
    setBusy(undefined);
    setError(undefined);
    setDisplayError(undefined);
    setModelError(undefined);
    setInvalidField(undefined);
  }, [bot, settingBusy, open]);

  useEffect(() => {
    if (!open) {
      profileSnapshotRef.current = undefined;
      return;
    }
    const previous = profileSnapshotRef.current;
    profileSnapshotRef.current = { id: bot.id, name: bot.name, instructions: bot.instructions };
    if (previous?.id !== bot.id) {
      setName(bot.name);
      setInstructions(bot.instructions);
      return;
    }
    if (previous.name !== bot.name) {
      setName((draft) => draft === previous.name ? bot.name : draft);
    }
    if (previous.instructions !== bot.instructions) {
      setInstructions((draft) => draft === previous.instructions ? bot.instructions : draft);
    }
  }, [bot.id, bot.name, bot.instructions, open]);

  const closeDrawer = useCallback((): void => {
    onClose();
    requestAnimationFrame(() => returnFocusRef.current?.focus());
  }, [onClose, returnFocusRef]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !event.defaultPrevented) closeDrawer();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDrawer, open]);

  const acceptUpdate = useCallback(
    (updated: BotDto): void => {
      latestBotRef.current = updated;
      setCurrent(updated);
      setName(updated.name);
      setInstructions(updated.instructions);
      onUpdated(updated);
    },
    [onUpdated],
  );

  const save = useCallback(async (): Promise<void> => {
    if (name.trim().length === 0) {
      setInvalidField("name");
      setError("Give this bot a name before saving.");
      nameInput.current?.focus();
      return;
    }
    setBusy("save");
    setInvalidField(undefined);
    setError(undefined);
    try {
      acceptUpdate(await api.patchBot(bot.id, { name: name.trim(), instructions }));
    } catch (updateError) {
      setError(apiErrorMessage(updateError, "This profile couldn’t be saved. Check your connection and try again."));
      nameInput.current?.focus();
    } finally {
      setBusy(undefined);
    }
  }, [acceptUpdate, bot.id, instructions, name]);

  const updateDisplaySetting = useCallback(async (setting: BotDisplaySetting, value: boolean): Promise<void> => {
    if (settingBusyRef.current !== undefined) return;
    const previousValue = current[setting];
    const optimistic = { ...current, [setting]: value };
    setCurrent(optimistic);
    settingBusyRef.current = setting;
    setDisplayError(undefined);
    setSettingBusy(setting);
    onUpdated(optimistic);
    try {
      const saved = await api.patchBot(bot.id, { [setting]: value });
      latestBotRef.current = saved;
      setCurrent(saved);
      onUpdated(saved);
    } catch (updateError) {
      const rolledBack = rollbackBotDisplaySetting(latestBotRef.current, setting, previousValue);
      latestBotRef.current = rolledBack;
      setCurrent(rolledBack);
      onUpdated(rolledBack);
      const detail = apiErrorMessage(updateError, "This display setting couldn’t be saved.");
      setDisplayError(`${detail} The previous setting has been restored.`);
    } finally {
      settingBusyRef.current = undefined;
      setSettingBusy(undefined);
    }
  }, [bot.id, current, onUpdated]);

  const updateModel = useCallback(async (value: string): Promise<void> => {
    const model = toBotModelOverride(value);
    if (busy !== undefined || settingBusyRef.current !== undefined || model === current.model) return;
    const optimistic = { ...current, model };
    latestBotRef.current = optimistic;
    settingBusyRef.current = "model";
    setSettingBusy("model");
    setModelError(undefined);
    setCurrent(optimistic);
    onUpdated(optimistic);
    try {
      const saved = await api.patchBot(bot.id, { model });
      latestBotRef.current = saved;
      setCurrent(saved);
      onUpdated(saved);
    } catch (updateError) {
      const latest = queryClient.getQueryData<BotViewDto[]>(["bots"])?.find(({ id }) => id === bot.id) ?? latestBotRef.current;
      const shouldRollback = latest.model === model;
      const resolved = shouldRollback ? { ...latest, model: current.model } : latest;
      latestBotRef.current = resolved;
      setCurrent(resolved);
      if (shouldRollback) onUpdated(resolved);
      const detail = apiErrorMessage(updateError, "Check your connection and try again.");
      const outcome = shouldRollback ? "The previous model has been restored." : "The latest model has been kept.";
      setModelError(`${detail} ${outcome}`);
    } finally {
      settingBusyRef.current = undefined;
      setSettingBusy(undefined);
    }
  }, [bot.id, busy, current, onUpdated, queryClient]);

  const newVariation = useCallback(async (): Promise<void> => {
    setBusy("variation");
    setError(undefined);
    try {
      acceptUpdate(await api.generateAvatar(bot.id));
    } catch (updateError) {
      setError(apiErrorMessage(updateError, "A new avatar variation couldn’t be created. Try again."));
    } finally {
      setBusy(undefined);
    }
  }, [acceptUpdate, bot.id]);

  const upload = useCallback(
    async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (file === undefined) return;
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
        setError("That image format isn’t supported. Choose a PNG, JPEG, or WebP image.");
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        setError("That image is larger than 8 MB. Choose a smaller image and try again.");
        return;
      }
      setBusy("upload");
      setError(undefined);
      try {
        acceptUpdate(await api.uploadAvatar(bot.id, file));
      } catch (updateError) {
        setError(apiErrorMessage(updateError, "The image couldn’t be uploaded. Check your connection and try again."));
      } finally {
        setBusy(undefined);
      }
    },
    [acceptUpdate, bot.id],
  );

  const createRecipe = useCallback(async (): Promise<void> => {
    const description = prompt.trim();
    if (description.length === 0) {
      setInvalidField("avatarDescription");
      setError("Describe the avatar you want.");
      promptInput.current?.focus();
      return;
    }
    setBusy("recipe");
    setInvalidField(undefined);
    setError(undefined);
    try {
      acceptUpdate(await api.avatarRecipe(bot.id, { prompt: description }));
      setPrompt("");
    } catch (updateError) {
      setError(apiErrorMessage(updateError, "The avatar description couldn’t be applied. Try again."));
      promptInput.current?.focus();
    } finally {
      setBusy(undefined);
    }
  }, [acceptUpdate, bot.id, prompt]);

  const disabled = busy !== undefined || settingBusy === "model";
  const displayState = selectBotDisplayState({
    showToolCalls: current.showToolCalls,
    showThinking: current.showThinking,
    thinkingAvailability: bot.thinkingAvailability,
  });
  return (
    <WorkspaceDrawer
      open={open}
      width="440px"
      label="Bot settings"
      data-testid="bot-settings-presence"
      header={
        <HStack gap={2} padding={4} vAlign="center">
          <StackItem size="fill">
            <VStack gap={0.5}>
              <Heading level={2}>Bot settings</Heading>
              <Text color="secondary">Manage this teammate’s profile and transcript display.</Text>
            </VStack>
          </StackItem>
          <IconButton
            label="Close bot settings"
            tooltip="Close bot settings"
            icon={<Icon icon="close" size="md" />}
            variant="ghost"
            onClick={closeDrawer}
            data-testid="bot-settings-close"
          />
        </HStack>
      }
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (settingBusyRef.current !== "model") void save();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.target instanceof HTMLInputElement && modelField.current?.contains(event.target)) {
            event.preventDefault();
          }
        }}
      >
        <VStack padding={4} paddingBlockStart={0} gap={4} aria-busy={disabled || settingBusy !== undefined || undefined} data-testid="bot-settings-panel">
          {error !== undefined ? <Banner status="error" title={error} /> : null}
          {displayError !== undefined ? <Banner status="error" title={displayError} /> : null}
          <Heading level={3}>Profile</Heading>
          <HStack gap={3} align="center" wrap="wrap">
            <AvatarView avatar={current.avatar} name={current.name} size="lg" presentation="static" />
            <VStack gap={0.5}>
              <Text type="label-lg">Current avatar</Text>
              <Text color="secondary">This image represents the bot throughout your workspace.</Text>
            </VStack>
          </HStack>

          <TextInput
            ref={nameInput}
            hasAutoFocus
            label="Name"
            value={name}
            onChange={(value) => {
              setName(value.slice(0, 80));
              if (invalidField === "name" && value.trim().length > 0) setInvalidField(undefined);
            }}
            isRequired
            {...(invalidField === "name" ? { status: { type: "error" as const, message: "Enter a name." } } : {})}
            width="100%"
            data-testid="profile-name"
          />
          <TextArea
            label="Job / Instructions"
            value={instructions}
            onChange={setInstructions}
            maxLength={8000}
            placeholder="What should this bot do?"
            width="100%"
            data-testid="profile-instructions"
          />
          <VStack gap={0.5}>
            <Text type="label-lg">Backing Agent</Text>
            <Text>{agentDisplayName}</Text>
            <Text color="secondary">Fixed for this bot.</Text>
          </VStack>
          <VStack gap={1}>
            <Typeahead
              ref={modelField}
              label="Model"
              width="100%"
              value={modelOptions.find(({ id }) => id === (current.model ?? "")) ?? null}
              onChange={(option) => void updateModel(option?.id ?? "")}
              searchSource={modelSearch}
              hasEntriesOnFocus
              hasClear={false}
              debounceMs={0}
              isDisabled={disabled || settingBusy !== undefined}
            />
            {settingBusy === "model" ? <Text role="status" color="secondary">Saving model…</Text> : null}
            {providers.isPending ? <Text color="secondary">Loading provider models…</Text> : null}
            {providers.isError ? <Text color="secondary">Provider models couldn’t load.</Text> : null}
            {providers.isSuccess && !providers.data.some(({ models }) => models.length > 0) ? (
              <Text color="secondary">Add models in Settings → Providers.</Text>
            ) : null}
            {modelError !== undefined ? <Banner role="alert" status="error" title="Model couldn’t be saved" description={modelError} /> : null}
          </VStack>
          <Button
            label="Save profile"
            variant="primary"
            type="submit"
            isLoading={busy === "save"}
            isDisabled={disabled && busy !== "save"}
            data-testid="profile-save"
          />

          <VStack gap={2}>
            <Text type="label-lg">Avatar choices</Text>
            <HStack gap={2} wrap="wrap">
              <Button
                label="New variation"
                variant="secondary"
                type="button"
                isLoading={busy === "variation"}
                isDisabled={disabled && busy !== "variation"}
                onClick={() => void newVariation()}
                data-testid="avatar-variation"
              />
              <Button
                label="Upload image"
                variant="secondary"
                type="button"
                isLoading={busy === "upload"}
                isDisabled={disabled}
                onClick={() => fileInput.current?.click()}
                data-testid="avatar-upload-button"
              />
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                aria-label="Choose an avatar image"
                onChange={(event) => void upload(event)}
                {...stylex.props(styles.hiddenFileInput)}
                tabIndex={-1}
                data-testid="avatar-upload-input"
              />
            </HStack>
            <TextArea
              ref={promptInput}
              label="Describe avatar"
              value={prompt}
              onChange={(value) => {
                setPrompt(value);
                if (invalidField === "avatarDescription" && value.trim().length > 0) setInvalidField(undefined);
              }}
              maxLength={2000}
              placeholder="A focused coding teammate with a warm expression and blue accents"
              {...(invalidField === "avatarDescription" ? { status: { type: "error" as const, message: "Describe the avatar you want." } } : {})}
              width="100%"
              data-testid="avatar-prompt"
            />
            <Button
              label="Create from description"
              variant="secondary"
              type="button"
              isLoading={busy === "recipe"}
              isDisabled={disabled && busy !== "recipe"}
              onClick={() => void createRecipe()}
              data-testid="avatar-recipe-submit"
            />
          </VStack>

          <VStack gap={3} data-testid="bot-display-settings">
            <VStack gap={0.5}>
              <Heading level={3}>Display</Heading>
              <Text color="secondary">
                These preferences apply to current output and history in every conversation. Hidden content is still retained.
              </Text>
            </VStack>
            <Switch
              label="Show tool calls"
              description="Show Agent tool work in every conversation for this Bot."
              value={displayState.showToolCalls}
              onChange={(value) => void updateDisplaySetting("showToolCalls", value)}
              isDisabled={settingBusy !== undefined}
              data-testid="show-tool-calls"
            />
            <Switch
              label="Show Thinking"
              description={displayState.thinkingDescription}
              value={displayState.showThinking}
              onChange={(value) => void updateDisplaySetting("showThinking", value)}
              isDisabled={settingBusy !== undefined || displayState.thinkingDisabled}
              data-testid="show-thinking"
            />
          </VStack>
        </VStack>
      </form>
    </WorkspaceDrawer>
  );
}
