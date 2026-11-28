import { useEffect, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  agentDaemon, DaemonError, type AgentSettings, type ProviderConfiguration, type ProviderConfigurations, type ProviderConnection,
} from "../../lib/agentDaemon.ts";

const discoveryDelay = 350;

type Feedback = { status: "success" | "error"; message: string };
const addProvider = "add-provider";

export function ProviderSettings({ baseUrl, settings }: { baseUrl: string; settings: AgentSettings }) {
  const queryClient = useQueryClient();
  const queryKey = ["provider-configurations", baseUrl];
  const providers = useQuery({ queryKey, queryFn: ({ signal }) => agentDaemon.providerConfigurations(signal) });
  const [selection, setSelection] = useState<string>();
  const [editor, setEditor] = useState<ProviderConfiguration>();
  const [feedback, setFeedback] = useState<Feedback>();
  const [busy, setBusy] = useState(false);

  const current = settings.active?.provider === "custom" ? providers.data?.currentId : settings.active?.provider ?? "openai";
  const selected = selection ?? current ?? undefined;
  const configuration = providers.data?.configurations.find(config => config.id === selected);
  const creating = selected === addProvider;
  const disabled = !settings.writable || busy;

  function select(value: string | null | undefined) {
    setSelection(value ?? undefined);
    setEditor(undefined);
    setFeedback(undefined);
  }

  async function applyConfigurations(saved: ProviderConfigurations) {
    await queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData(queryKey, saved);
    await queryClient.invalidateQueries({ queryKey: ["agent-settings", baseUrl] });
  }

  async function update(action: () => Promise<void>, message: string) {
    if (disabled) return false;
    setBusy(true);
    setFeedback(undefined);
    try {
      await action();
      setFeedback({ status: "success", message });
      return true;
    } catch (error) {
      if (error instanceof DaemonError && error.status === 409) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey }),
          queryClient.invalidateQueries({ queryKey: ["agent-settings", baseUrl] }),
        ]);
        setFeedback({ status: "error", message: "This configuration changed. Cancel and reopen the editor to load the latest version." });
      } else {
        setFeedback({ status: "error", message: error instanceof DaemonError ? error.message : "Could not update the Provider Configuration." });
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  const options = [
    { label: "OpenAI", value: "openai" },
    { label: "Anthropic", value: "anthropic" },
    ...(providers.data?.configurations.map(config => ({
      label: config.name, value: config.id, description: `${config.model} · ${config.baseUrl}`,
    })) ?? []),
    ...(providers.data ? [{ label: "Add custom provider…", value: addProvider, disabled: !settings.writable }] : []),
  ];

  return <VStack gap={3}>
    <Selector label="Provider" options={options} {...(selected === undefined ? {} : { value: selected })}
      onChange={select} isDisabled={busy} />
    {!settings.writable && <Banner status="warning" title="The daemon operator must enable writable Settings." />}
    {feedback && <Banner status={feedback.status} title={feedback.message} />}
    {providers.isPending && <Text>Loading Provider Configurations…</Text>}
    {providers.isError && <VStack gap={2}>
      <Banner status="error" title={providers.error instanceof DaemonError && providers.error.status === 404
        ? "Update the Agent Daemon to use custom providers."
        : "Could not load saved Provider Configurations."} />
      <Button label="Retry loading providers" onClick={() => void providers.refetch()} />
    </VStack>}
    {(selected === "openai" || selected === "anthropic") && <ModelForm key={selected}
      modelId={settings.active?.provider === selected ? settings.active.model : ""}
      keyStored={settings.storedCredentials[selected]} disabled={disabled} saving={busy}
      save={(model, apiKey) => update(async () => {
        const saved = await agentDaemon.saveSettings({ provider: selected, model, ...(apiKey ? { apiKey } : {}) });
        queryClient.setQueryData(["agent-settings", baseUrl], saved);
        void queryClient.invalidateQueries({ queryKey });
      }, "Daemon Settings saved.")} />}
    {(creating || editor) && <ProviderForm key={selected} configuration={editor} disabled={disabled}
      close={() => select(creating ? undefined : selected)}
      save={(connection, name, model) => {
        void update(async () => {
          const saved = await agentDaemon.saveProviderConfiguration({ ...connection, name, model }, editor);
          await applyConfigurations(saved);
          if (creating) setSelection(undefined);
          setEditor(undefined);
        }, "Provider Configuration saved.");
      }} />}
    {configuration && !editor && <VStack gap={2}>
      <Text color="secondary" wordBreak="break-word">Base URL: {configuration.baseUrl}</Text>
      <Text color="secondary" wordBreak="break-word">Model: {configuration.model}</Text>
      <Text color="secondary">{configuration.hasApiKey ? "API key configured" : "No API key"}</Text>
      <HStack gap={2} wrap="wrap">
        <Button label="Edit" isDisabled={disabled} onClick={() => { setFeedback(undefined); setEditor(configuration); }} />
        {configuration.id !== providers.data?.currentId && <Button label="Set as current" variant="primary"
          isDisabled={disabled} onClick={() => void update(async () => {
            await applyConfigurations(await agentDaemon.activateProviderConfiguration(configuration.id));
          }, "Current Provider Configuration updated.")} />}
      </HStack>
    </VStack>}
  </VStack>;
}

function ModelForm({ modelId, keyStored, disabled, saving, save }: {
  modelId: string;
  keyStored: boolean;
  disabled: boolean;
  saving: boolean;
  save: (model: string, apiKey: string) => Promise<boolean>;
}) {
  const [model, setModel] = useState(modelId);
  const [apiKey, setApiKey] = useState("");
  const canSave = !disabled && !!model.trim() && (keyStored || !!apiKey);

  return <form onSubmit={async event => {
    event.preventDefault();
    if (canSave && await save(model.trim(), apiKey)) setApiKey("");
  }}>
    <VStack gap={3}>
      <FormLayout>
        <TextInput label="Model ID" value={model} onChange={setModel} isRequired isDisabled={disabled} />
        <TextInput label={keyStored ? "Replacement API key" : "API key"} type="password" autoComplete="new-password"
          description={keyStored ? "Leave blank to use the stored key." : "The Agent Daemon stores this key."}
          value={apiKey} onChange={setApiKey} isRequired={!keyStored} isDisabled={disabled} />
      </FormLayout>
      <Button label="Save daemon Settings" variant="primary" type="submit" isLoading={saving} isDisabled={!canSave} />
    </VStack>
  </form>;
}

function apiRoot(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
        && !url.href.includes("?") && !url.href.includes("#")) {
      return url.href.replace(/\/+$/, "");
    }
  } catch {
    // An incomplete URL is normal while editing.
  }
}

type ConnectionDraft = { baseUrl: string; apiKey: string; omitStoredKey?: boolean };
type Discovery = { connection: ConnectionDraft; models: string[] } | { connection: ConnectionDraft; error: string };

function ProviderForm({ configuration, disabled, close, save }: {
  configuration: ProviderConfiguration | undefined;
  disabled: boolean;
  close: () => void;
  save: (connection: ProviderConnection, name: string, model: string) => void;
}) {
  const [name, setName] = useState(configuration?.name ?? "");
  const [connection, setConnection] = useState<ConnectionDraft>({ baseUrl: configuration?.baseUrl ?? "", apiKey: "" });
  const [model, setModel] = useState<string | null>(configuration?.model ?? null);
  const [discovery, setDiscovery] = useState<Discovery>();
  const baseUrl = apiRoot(connection.baseUrl);
  const { apiKey, omitStoredKey } = connection;
  const id = configuration?.id;
  const keyStored = !!configuration?.hasApiKey && baseUrl === configuration.baseUrl;
  const authentication: ProviderConnection["authentication"] = apiKey || (keyStored && !omitStoredKey) ? "apiKey" : "none";
  const ready = baseUrl !== undefined && (!apiKey || /^[!-~]+$/.test(apiKey));
  const result = discovery?.connection === connection ? discovery : undefined;
  const models = result && "models" in result ? result.models : [];
  const modelSelected = model !== null && models.includes(model);
  const writable = !disabled;

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    const lookup = window.setTimeout(async () => {
      try {
        const listing = await agentDaemon.providerModels({
          baseUrl, authentication, ...(apiKey ? { apiKey } : {}), ...(id ? { id } : {}),
        }, controller.signal);
        if (!controller.signal.aborted) setDiscovery({ connection, models: listing.models });
      } catch (error) {
        if (!controller.signal.aborted) setDiscovery({
          connection, error: error instanceof DaemonError ? error.message : "Could not load the provider's models.",
        });
      }
    }, discoveryDelay);
    return () => {
      window.clearTimeout(lookup);
      controller.abort();
    };
  }, [ready, baseUrl, authentication, apiKey, id, connection]);

  function changeConnection(next: ConnectionDraft) {
    setConnection(next);
    setModel(null);
    setDiscovery(undefined);
  }

  return <form onSubmit={event => {
    event.preventDefault();
    if (writable && ready && name.trim() && model !== null && modelSelected) {
      void save({ baseUrl, authentication, ...(apiKey ? { apiKey } : {}) }, name.trim(), model);
    }
  }}>
    <VStack gap={3}>
      {configuration && <Heading level={4}>Edit {configuration.name}</Heading>}
      <FormLayout>
        <TextInput label="Provider name" value={name} onChange={setName} isRequired isDisabled={disabled} />
        <TextInput label="Base URL" value={connection.baseUrl} isRequired isDisabled={disabled}
          description="Use the API root reachable from the Agent Daemon, including any prefix such as /v1."
          placeholder="https://example.com/v1" onChange={value => changeConnection({ baseUrl: value, apiKey: "" })} />
        <TextInput label="API key" type="password" autoComplete="new-password" isOptional isDisabled={disabled}
          description={keyStored && !omitStoredKey ? "Leave blank to use the saved API key." : "Leave blank for anonymous access."}
          value={apiKey} onChange={value => changeConnection({ ...connection, apiKey: value })} />
        {keyStored && !apiKey && <Button label={omitStoredKey ? "Use saved API key" : "Remove saved API key"}
          type="button" size="sm" variant="secondary" isDisabled={disabled}
          onClick={() => changeConnection({ ...connection, omitStoredKey: !omitStoredKey })} />}
        <Selector label="Provider Model" hasSearch hasClear options={models} value={modelSelected ? model : null} isRequired
          onChange={setModel} isDisabled={disabled || models.length === 0} isLoading={ready && !result} />
      </FormLayout>
      <VStack gap={2}>
        {ready && !result && <Text>Loading models…</Text>}
        {result && "error" in result && <Banner status="error" title={result.error} />}
        {result && "models" in result && models.length === 0 && <Text>No models were returned by the provider.</Text>}
        <HStack gap={2} wrap="wrap">
          <Button label="Refresh models" type="button" isDisabled={disabled || !ready}
            onClick={() => setConnection(previous => ({ ...previous }))} />
          <Button label="Save Provider Configuration" type="submit" variant="primary"
            isDisabled={disabled || !ready || !name.trim() || !modelSelected} />
          <Button label="Cancel" type="button" isDisabled={disabled} onClick={close} />
        </HStack>
      </VStack>
    </VStack>
  </form>;
}
