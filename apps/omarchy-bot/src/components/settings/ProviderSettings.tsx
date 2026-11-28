import { useState } from "react";
import { CheckIcon, CircleAlertIcon, KeyRoundIcon, PencilIcon, RefreshCwIcon, SaveIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from "@/components/ui/combobox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useProviderModelDiscovery, type ProviderConnectionDraft } from "../../lib/providerDiscovery.ts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  agentDaemon, DaemonError, type AgentSettings, type ProviderConfiguration, type ProviderConfigurations, type ProviderConnection,
} from "../../lib/agentDaemon.ts";

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
      label: config.name, value: config.id,
    })) ?? []),
    ...(providers.data ? [{ label: "Add custom provider…", value: addProvider, disabled: !settings.writable }] : []),
  ];

  return <div className="flex flex-col gap-4">
    <Field data-disabled={busy}>
      <FieldLabel htmlFor="provider">Provider</FieldLabel>
      <Select items={options} value={selected ?? null} onValueChange={select} disabled={busy}>
        <SelectTrigger id="provider" className="w-full"><SelectValue placeholder="Choose a provider" /></SelectTrigger>
        <SelectContent><SelectGroup>{options.map(option => <SelectItem key={option.value} value={option.value}
          disabled={option.value === addProvider && !settings.writable}>{option.label}</SelectItem>)}</SelectGroup></SelectContent>
      </Select>
    </Field>
    {!settings.writable && <Alert><CircleAlertIcon /><AlertDescription>The daemon operator must enable writable Settings.</AlertDescription></Alert>}
    {feedback && <Alert variant={feedback.status === "error" ? "destructive" : "default"} role={feedback.status === "error" ? "alert" : "status"}>
      {feedback.status === "error" ? <CircleAlertIcon /> : <CheckIcon />}<AlertDescription>{feedback.message}</AlertDescription>
    </Alert>}
    {providers.isPending && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /> Loading Provider Configurations…</p>}
    {providers.isError && <div className="flex flex-col items-start gap-2">
      <Alert variant="destructive" role="alert"><CircleAlertIcon /><AlertDescription>{providers.error instanceof DaemonError && providers.error.status === 404
        ? "Update the Agent Daemon to use custom providers."
        : "Could not load saved Provider Configurations."}</AlertDescription></Alert>
      <Button variant="outline" disabled={providers.isFetching} onClick={() => void providers.refetch()}><RefreshCwIcon data-icon="inline-start" /> Retry loading providers</Button>
    </div>}
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
    {configuration && !editor && <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Base URL</dt><dd className="wrap-anywhere">{configuration.baseUrl}</dd>
        <dt className="text-muted-foreground">Model</dt><dd className="wrap-anywhere">{configuration.model}</dd>
        <dt className="text-muted-foreground">API key</dt><dd>{configuration.hasApiKey ? "Configured" : "None"}</dd>
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={disabled} onClick={() => { setFeedback(undefined); setEditor(configuration); }}><PencilIcon data-icon="inline-start" /> Edit</Button>
        {configuration.id !== providers.data?.currentId && <Button disabled={disabled} onClick={() => void update(async () => {
          await applyConfigurations(await agentDaemon.activateProviderConfiguration(configuration.id));
        }, "Current Provider Configuration updated.")}>
          {busy ? <Spinner data-icon="inline-start" /> : <CheckIcon data-icon="inline-start" />} Set as current
        </Button>}
      </div>
    </div>}
  </div>;
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
    <FieldGroup>
      <Field data-disabled={disabled}>
        <FieldLabel htmlFor="builtin-model">Model ID</FieldLabel>
        <Input id="builtin-model" value={model} onChange={event => setModel(event.target.value)} required disabled={disabled} />
      </Field>
      <Field data-disabled={disabled}>
        <FieldLabel htmlFor="builtin-key">{keyStored ? "Replacement API key" : "API key"}</FieldLabel>
        <Input id="builtin-key" type="password" autoComplete="new-password" aria-describedby="builtin-key-help"
          value={apiKey} onChange={event => setApiKey(event.target.value)} required={!keyStored} disabled={disabled} />
        <FieldDescription id="builtin-key-help">{keyStored ? "Leave blank to use the stored key." : "The Agent Daemon stores this key."}</FieldDescription>
      </Field>
      <Button type="submit" className="self-start" disabled={!canSave}>
        {saving ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />} Save daemon Settings
      </Button>
    </FieldGroup>
  </form>;
}

function ProviderForm({ configuration, disabled, close, save }: {
  configuration: ProviderConfiguration | undefined;
  disabled: boolean;
  close: () => void;
  save: (connection: ProviderConnection, name: string, model: string) => void;
}) {
  const [name, setName] = useState(configuration?.name ?? "");
  const [connection, setConnection] = useState<ProviderConnectionDraft>({ baseUrl: configuration?.baseUrl ?? "", apiKey: "" });
  const [model, setModel] = useState<string | null>(configuration?.model ?? null);
  const { apiKey, omitStoredKey } = connection;
  const { baseUrl, authentication, keyStored, ready, result, models, error, loading } = useProviderModelDiscovery(connection, configuration);
  const modelSelected = model !== null && models.includes(model);
  const canSave = !disabled && ready && Boolean(name.trim()) && modelSelected;

  function changeConnection(next: ProviderConnectionDraft) {
    setConnection(next);
    setModel(null);
  }

  return <form onSubmit={event => {
    event.preventDefault();
    if (canSave && baseUrl !== undefined && model !== null) {
      save({ baseUrl, authentication, ...(apiKey ? { apiKey } : {}) }, name.trim(), model);
    }
  }}>
    <FieldGroup>
      {configuration && <h3 className="text-sm font-semibold">Edit {configuration.name}</h3>}
      <Field data-disabled={disabled}>
        <FieldLabel htmlFor="custom-name">Provider name</FieldLabel>
        <Input id="custom-name" value={name} onChange={event => setName(event.target.value)} required disabled={disabled} />
      </Field>
      <Field data-disabled={disabled}>
        <FieldLabel htmlFor="custom-base-url">Base URL</FieldLabel>
        <Input id="custom-base-url" value={connection.baseUrl} required disabled={disabled} aria-describedby="custom-base-url-help"
          placeholder="https://example.com/v1" onChange={event => changeConnection({ baseUrl: event.target.value, apiKey: "" })} />
        <FieldDescription id="custom-base-url-help">Use the API root reachable from the Agent Daemon, including any prefix such as /v1.</FieldDescription>
      </Field>
      <Field data-disabled={disabled}>
        <FieldLabel htmlFor="custom-key">API key</FieldLabel>
        <Input id="custom-key" type="password" autoComplete="new-password" disabled={disabled} aria-describedby="custom-key-help"
          value={apiKey} onChange={event => changeConnection({ ...connection, apiKey: event.target.value })} />
        <FieldDescription id="custom-key-help">{keyStored && !omitStoredKey ? "Leave blank to use the saved API key." : "Leave blank for anonymous access."}</FieldDescription>
        {keyStored && !apiKey && <Button variant="outline" size="sm" className="self-start" disabled={disabled}
          onClick={() => changeConnection({ ...connection, omitStoredKey: !omitStoredKey })}>
          <KeyRoundIcon data-icon="inline-start" /> {omitStoredKey ? "Use saved API key" : "Remove saved API key"}
        </Button>}
      </Field>
      <Field data-disabled={disabled || models.length === 0}>
        <FieldLabel htmlFor="custom-model">Provider Model</FieldLabel>
        <Combobox items={models} value={modelSelected ? model : null} onValueChange={setModel} disabled={disabled || models.length === 0}>
          <ComboboxInput id="custom-model" placeholder="Search models" showClear disabled={disabled || models.length === 0} />
          <ComboboxContent>
            <ComboboxEmpty>No matching models.</ComboboxEmpty>
            <ComboboxList>
              {(model: string) => <ComboboxItem key={model} value={model}>{model}</ComboboxItem>}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
        {loading && <FieldDescription role="status" className="flex items-center gap-2"><Spinner /> Loading models…</FieldDescription>}
        {result && "models" in result && models.length === 0 && <FieldDescription role="status">No models were returned by the provider.</FieldDescription>}
      </Field>
      {error && <Alert variant="destructive" role="alert"><CircleAlertIcon /><AlertDescription>{error}</AlertDescription></Alert>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={disabled || !ready || loading} onClick={() => setConnection(previous => ({ ...previous }))}>
          <RefreshCwIcon data-icon="inline-start" /> Refresh models
        </Button>
        <Button type="submit" disabled={!canSave}><SaveIcon data-icon="inline-start" /> Save Provider Configuration</Button>
        <Button variant="ghost" disabled={disabled} onClick={close}>Cancel</Button>
      </div>
    </FieldGroup>
  </form>;
}
