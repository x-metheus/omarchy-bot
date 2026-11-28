import { useEffect, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { List, ListItem } from "@astryxdesign/core/List";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  agentDaemon, DaemonError, type ProviderConfiguration, type ProviderConfigurations, type ProviderConnection,
} from "../../lib/agentDaemon.ts";

const discoveryDelay = 350;
const authOptions = [
  { label: "API Key", value: "apiKey" },
  { label: "No authentication", value: "none" },
];

type Feedback = { status: "success" | "error"; message: string };
type Editor = { configuration?: ProviderConfiguration };

export function CustomProviders({ baseUrl, writable }: { baseUrl: string; writable: boolean }) {
  const queryClient = useQueryClient();
  const queryKey = ["provider-configurations", baseUrl];
  const providers = useQuery({ queryKey, queryFn: ({ signal }) => agentDaemon.providerConfigurations(signal) });
  const [editor, setEditor] = useState<Editor>();
  const [feedback, setFeedback] = useState<Feedback>();
  const [busy, setBusy] = useState(false);

  async function update(action: () => Promise<ProviderConfigurations>, message: string) {
    setBusy(true);
    setFeedback(undefined);
    try {
      const saved = await action();
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData(queryKey, saved);
      await queryClient.invalidateQueries({ queryKey: ["agent-settings", baseUrl] });
      setEditor(undefined);
      setFeedback({ status: "success", message });
    } catch (error) {
      setFeedback({ status: "error", message: error instanceof DaemonError ? error.message : "Could not update the Provider Configuration." });
    } finally {
      setBusy(false);
    }
  }

  return <VStack gap={3}>
    <Heading level={3}>Custom OpenAI-compatible providers</Heading>
    {feedback && <Banner status={feedback.status} title={feedback.message} />}
    {providers.isPending && <Text>Loading Provider Configurations…</Text>}
    {providers.isError && <VStack gap={2}>
      <Banner status="error" title="Could not load custom Provider Configurations." />
      <Button label="Retry loading providers" onClick={() => void providers.refetch()} />
    </VStack>}
    {providers.data && <>
      <List hasDividers edge="flush">
        {providers.data.configurations.map(configuration => {
          const current = configuration.id === providers.data.currentId;
          const credential = configuration.hasApiKey ? "API key configured" : "No authentication";
          return <ListItem key={configuration.id} label={configuration.name}
            description={`${current ? "Current model: " : ""}${configuration.model} · ${credential}`}
            endContent={<HStack gap={1} wrap="wrap">
              <Button label={`Edit ${configuration.name}`} size="sm" isDisabled={!writable || busy || !!editor}
                onClick={() => { setFeedback(undefined); setEditor({ configuration }); }} />
              {!current && <Button label={`Set ${configuration.name} as current`} size="sm" isDisabled={!writable || busy || !!editor}
                onClick={() => void update(() => agentDaemon.activateProviderConfiguration(configuration.id), "Current Provider Configuration updated.")} />}
            </HStack>} />;
        })}
      </List>
      {editor ? <ProviderForm configuration={editor.configuration} disabled={!writable || busy}
        close={() => { setEditor(undefined); setFeedback(undefined); }}
        save={(connection, name, model) => update(
          () => agentDaemon.saveProviderConfiguration({ ...connection, name, model }, editor.configuration?.id),
          "Provider Configuration saved.",
        )} /> : <Button label="Add custom provider" isDisabled={!writable || busy}
          onClick={() => { setFeedback(undefined); setEditor({}); }} />}
    </>}
  </VStack>;
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

type Discovery = { connection: ProviderConnection; models: string[] } | { connection: ProviderConnection; error: string };

function ProviderForm({ configuration, disabled, close, save }: {
  configuration: ProviderConfiguration | undefined;
  disabled: boolean;
  close: () => void;
  save: (connection: ProviderConnection, name: string, model: string) => Promise<void>;
}) {
  const [name, setName] = useState(configuration?.name ?? "");
  const [connection, setConnection] = useState<ProviderConnection>({
    baseUrl: configuration?.baseUrl ?? "",
    authentication: configuration?.authentication ?? "apiKey",
  });
  const [model, setModel] = useState<string | null>(configuration?.model ?? null);
  const [discovery, setDiscovery] = useState<Discovery>();
  const baseUrl = apiRoot(connection.baseUrl);
  const { authentication, apiKey } = connection;
  const id = configuration?.id;
  const keyStored = !!configuration?.hasApiKey && baseUrl === configuration.baseUrl;
  const ready = baseUrl !== undefined && (authentication === "none" || (apiKey ? /^[!-~]+$/.test(apiKey) : keyStored));
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

  function changeConnection(next: ProviderConnection) {
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
      <Heading level={4}>{configuration ? `Edit ${configuration.name}` : "Add custom provider"}</Heading>
      <FormLayout>
        <TextInput label="Provider name" value={name} onChange={setName} isRequired isDisabled={disabled} />
        <TextInput label="API Base URL" value={connection.baseUrl} isRequired isDisabled={disabled}
          description="Use the API root reachable from the Agent Daemon, including any prefix such as /v1."
          placeholder="https://example.com/v1" onChange={value => changeConnection({ baseUrl: value, authentication })} />
        <Selector label="Authentication" options={authOptions} value={authentication} isDisabled={disabled}
          onChange={value => {
            if (value === "apiKey" || value === "none") {
              changeConnection({ baseUrl: connection.baseUrl, authentication: value });
            }
          }} />
        {authentication === "apiKey" && <TextInput label={keyStored ? "Replacement API key" : "Custom provider API key"}
          type="password" autoComplete="new-password" isRequired={!keyStored} isDisabled={disabled}
          description={keyStored ? "Leave blank to use the stored key." : "The Agent Daemon encrypts the key when you save."}
          value={apiKey ?? ""} onChange={value => changeConnection({ ...connection, apiKey: value })} />}
        <Selector label="Custom provider model" hasSearch hasClear options={models} value={modelSelected ? model : null} isRequired
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
