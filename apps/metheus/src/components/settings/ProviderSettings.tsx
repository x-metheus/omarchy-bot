import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CircleAlertIcon, KeyRoundIcon, PlusIcon, RefreshCwIcon, SaveIcon } from "@/components/icons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from "@/components/ui/combobox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useProviderModelDiscovery, type ProviderConnectionDraft } from "../../lib/providerDiscovery.ts";
import {
  agentDaemon, DaemonError, type Provider, type ProviderConfiguration, type ProviderConfigurations, type ProviderConnection,
} from "../../lib/agentDaemon.ts";

const builtInProviders = { openai: "OpenAI", anthropic: "Anthropic" } satisfies Record<Provider, string>;
const builtInProviderIds = Object.keys(builtInProviders) as Provider[];

type Feedback = { status: "success" | "error"; message: string };
type ProviderEditor = { kind: "built-in"; provider: Provider } | { kind: "custom"; configuration?: ProviderConfiguration };

export function ProviderSettings({ baseUrl }: { baseUrl: string }) {
  const queryClient = useQueryClient();
  const settingsKey = ["agent-settings", baseUrl];
  const providersKey = ["provider-configurations", baseUrl];
  const settingsQuery = useQuery({ queryKey: settingsKey, queryFn: agentDaemon.settings });
  const settings = settingsQuery.data;
  const providers = useQuery({
    queryKey: providersKey,
    queryFn: ({ signal }) => agentDaemon.providerConfigurations(signal),
    enabled: settings !== undefined,
  });
  const [editor, setEditor] = useState<ProviderEditor>();
  const [feedback, setFeedback] = useState<Feedback>();
  const [busy, setBusy] = useState(false);

  const active = settings?.active;
  const configurations = providers.data?.configurations ?? [];
  const currentCustomId = providers.data?.currentId;
  const showCurrentCustomSummary = active?.provider === "custom" && !configurations.some(config => config.id === currentCustomId);
  const configuredBuiltIns = builtInProviderIds.filter(provider => active?.provider === provider || settings?.storedCredentials[provider]);
  const addableBuiltIns = builtInProviderIds.filter(provider => !configuredBuiltIns.includes(provider));
  const hasProviders = configuredBuiltIns.length > 0 || configurations.length > 0 || showCurrentCustomSummary;
  const canAddCustom = !!providers.data;
  const writable = settings?.writable ?? false;
  const disabled = !writable || busy;

  function openEditor(next: ProviderEditor) {
    setFeedback(undefined);
    setEditor(next);
  }

  function closeEditor() {
    if (busy) return;
    setFeedback(undefined);
    setEditor(undefined);
  }

  async function applyConfigurations(saved: ProviderConfigurations) {
    await queryClient.cancelQueries({ queryKey: providersKey });
    queryClient.setQueryData(providersKey, saved);
    await queryClient.invalidateQueries({ queryKey: settingsKey });
  }

  async function update(action: () => Promise<void>, message: string) {
    if (disabled) return;
    setBusy(true);
    setFeedback(undefined);
    try {
      await action();
      setEditor(undefined);
      setFeedback({ status: "success", message });
    } catch (error) {
      if (error instanceof DaemonError && error.status === 409) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: providersKey }),
          queryClient.invalidateQueries({ queryKey: settingsKey }),
        ]);
        setFeedback({ status: "error", message: "This configuration changed. Cancel and reopen the editor to load the latest version." });
      } else {
        setFeedback({ status: "error", message: error instanceof DaemonError ? error.message : "Could not update the Provider Configuration." });
      }
    } finally {
      setBusy(false);
    }
  }

  const notice = feedback && <Alert variant={feedback.status === "error" ? "destructive" : "default"} role={feedback.status === "error" ? "alert" : "status"}>
    {feedback.status === "error" ? <CircleAlertIcon /> : <CheckIcon />}<AlertDescription>{feedback.message}</AlertDescription>
  </Alert>;

  return <section aria-labelledby="settings-providers" className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 id="settings-providers" className="text-lg font-semibold tracking-tight">Providers</h2>
      {writable && (canAddCustom || addableBuiltIns.length > 0) && <DropdownMenu>
        <DropdownMenuTrigger disabled={busy} render={<Button variant="outline" size="icon-sm" aria-label="Add provider" title="Add provider" />}>
          <PlusIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuGroup>
            {addableBuiltIns.map(provider => <DropdownMenuItem key={provider} onClick={() => openEditor({ kind: "built-in", provider })}>
              {builtInProviders[provider]}
            </DropdownMenuItem>)}
            {canAddCustom && <DropdownMenuItem onClick={() => openEditor({ kind: "custom" })}>Custom provider</DropdownMenuItem>}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>}
    </div>
    {settingsQuery.isPending && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /> Loading daemon Settings…</p>}
    {settingsQuery.isError && <>
      <Alert variant="destructive" role="alert"><CircleAlertIcon /><AlertDescription>Could not read daemon Settings.</AlertDescription></Alert>
      <Button variant="outline" className="self-start" disabled={settingsQuery.isFetching} onClick={() => void settingsQuery.refetch()}>
        <RefreshCwIcon data-icon="inline-start" /> Try again
      </Button>
    </>}
    {settings && <>
      {!writable && <Alert><CircleAlertIcon /><AlertDescription>The daemon operator must enable writable Settings.</AlertDescription></Alert>}
      {!editor && notice}
      {hasProviders ? <ul role="list" className="divide-y divide-border rounded-xl border">
        {configuredBuiltIns.map(provider => {
          const name = builtInProviders[provider];
          const current = !currentCustomId && active?.provider === provider;
          const action = current ? "Edit" : "Configure";
          return <ProviderRow key={provider} name={name} model={current ? active.model : undefined} current={current}>
            {writable && <Button variant="ghost" size="sm" disabled={busy} aria-label={`${action} ${name}`}
              onClick={() => openEditor({ kind: "built-in", provider })}>{action}</Button>}
          </ProviderRow>;
        })}
        {showCurrentCustomSummary && <ProviderRow name={active.name ?? "Custom OpenAI-compatible"} model={active.model} current />}
        {configurations.map(configuration => {
          const current = configuration.id === currentCustomId;
          return <ProviderRow key={configuration.id} name={configuration.name} model={configuration.model} current={current}>
            <Button variant="ghost" size="sm" disabled={busy} aria-label={`${writable ? "Edit" : "Details for"} ${configuration.name}`}
              onClick={() => openEditor({ kind: "custom", configuration })}>{writable ? "Edit" : "Details"}</Button>
            {!current && writable && <Button variant="outline" size="sm" disabled={busy} aria-label={`Set as current (${configuration.name})`}
              onClick={() => void update(async () => {
                await applyConfigurations(await agentDaemon.activateProviderConfiguration(configuration.id));
              }, "Current Provider Configuration updated.")}>Set as current</Button>}
          </ProviderRow>;
        })}
      </ul> : providers.isSuccess && <Empty className="rounded-xl border p-4">
        <EmptyHeader><EmptyDescription>No providers configured.</EmptyDescription></EmptyHeader>
      </Empty>}
      {providers.isPending && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /> Loading Provider Configurations…</p>}
      {providers.isError && <>
        <Alert variant="destructive" role="alert"><CircleAlertIcon /><AlertDescription>{providers.error instanceof DaemonError && providers.error.status === 404
          ? "Update the Agent Daemon to use custom providers."
          : "Could not load saved Provider Configurations."}</AlertDescription></Alert>
        <Button variant="outline" className="self-start" disabled={providers.isFetching} onClick={() => void providers.refetch()}>
          <RefreshCwIcon data-icon="inline-start" /> Retry loading providers
        </Button>
      </>}
      {editor && <Dialog open onOpenChange={open => { if (!open) closeEditor(); }}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg" showCloseButton={!busy}>
          <DialogHeader className="pr-7">
            <DialogTitle className="wrap-anywhere">{editor.kind === "built-in" ? builtInProviders[editor.provider]
              : editor.configuration ? editor.configuration.name : "Add custom provider"}</DialogTitle>
            {editor.kind === "built-in" && active?.provider !== editor.provider && <DialogDescription>
              Saving makes this the current provider for all Bots on this Agent Daemon.
            </DialogDescription>}
          </DialogHeader>
          {notice}
          {editor.kind === "built-in" ? <ModelForm
            modelId={active?.provider === editor.provider ? active.model : ""}
            keyStored={settings.storedCredentials[editor.provider]} disabled={disabled} saving={busy} close={closeEditor}
            save={(model, apiKey) => void update(async () => {
              const saved = await agentDaemon.saveSettings({ provider: editor.provider, model, ...(apiKey ? { apiKey } : {}) });
              await Promise.all([
                queryClient.cancelQueries({ queryKey: settingsKey }),
                queryClient.cancelQueries({ queryKey: providersKey }),
              ]);
              queryClient.setQueryData(settingsKey, saved);
              queryClient.setQueryData<ProviderConfigurations>(providersKey, previous => previous && { ...previous, currentId: null });
              void queryClient.invalidateQueries({ queryKey: providersKey });
            }, "Daemon Settings saved.")} /> : writable ? <ProviderForm
            configuration={editor.configuration} disabled={disabled} saving={busy} close={closeEditor}
            save={(connection, name, model) => void update(async () => {
              const saved = await agentDaemon.saveProviderConfiguration({ ...connection, name, model }, editor.configuration);
              await applyConfigurations(saved);
            }, "Provider Configuration saved.")} /> : editor.configuration && <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2">
              <dt className="text-muted-foreground">Base URL</dt><dd className="wrap-anywhere">{editor.configuration.baseUrl}</dd>
              <dt className="text-muted-foreground">API key</dt><dd>{editor.configuration.hasApiKey ? "Configured" : "None"}</dd>
            </dl>}
        </DialogContent>
      </Dialog>}
    </>}
  </section>;
}

function ProviderRow({ name, model, current, children }: { name: string; model: string | undefined; current: boolean; children?: ReactNode }) {
  return <li className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2.5 text-sm sm:px-4">
    <div className="min-w-0 flex-[1_1_10rem]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 font-medium wrap-anywhere">{name}</span>
        {current && <Badge variant="secondary">Current</Badge>}
      </div>
      {model && <p className="text-xs text-muted-foreground wrap-anywhere">{model}</p>}
    </div>
    {children && <div className="flex flex-wrap items-center gap-1">{children}</div>}
  </li>;
}

function ModelForm({ modelId, keyStored, disabled, saving, close, save }: {
  modelId: string;
  keyStored: boolean;
  disabled: boolean;
  saving: boolean;
  close: () => void;
  save: (model: string, apiKey: string) => void;
}) {
  const [model, setModel] = useState(modelId);
  const [apiKey, setApiKey] = useState("");
  const canSave = !disabled && !!model.trim() && (keyStored || !!apiKey);

  return <form onSubmit={event => {
    event.preventDefault();
    if (canSave) save(model.trim(), apiKey);
  }}>
    <FieldGroup className="gap-4">
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
      <DialogFooter>
        <Button variant="outline" disabled={saving} onClick={close}>Cancel</Button>
        <Button type="submit" disabled={!canSave}>
          {saving ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />} Save daemon Settings
        </Button>
      </DialogFooter>
    </FieldGroup>
  </form>;
}

function ProviderForm({ configuration, disabled, saving, close, save }: {
  configuration: ProviderConfiguration | undefined;
  disabled: boolean;
  saving: boolean;
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
    <FieldGroup className="gap-4">
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
        <Button variant="outline" size="sm" className="self-start" disabled={disabled || !ready || loading} onClick={() => setConnection(previous => ({ ...previous }))}>
          <RefreshCwIcon data-icon="inline-start" /> Refresh models
        </Button>
      </Field>
      {error && <Alert variant="destructive" role="alert"><CircleAlertIcon /><AlertDescription>{error}</AlertDescription></Alert>}
      <DialogFooter>
        <Button variant="outline" disabled={saving} onClick={close}>Cancel</Button>
        <Button type="submit" disabled={!canSave}>
          {saving ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />} Save Provider Configuration
        </Button>
      </DialogFooter>
    </FieldGroup>
  </form>;
}
