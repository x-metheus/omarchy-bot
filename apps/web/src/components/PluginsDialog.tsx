import { useEffect, useState, type FormEvent, type JSX, type RefObject } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as stylex from "@stylexjs/stylex";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { SKILL_CATALOG_PAGE_SIZE, type BotViewDto, type InstalledSkillDto, type McpConnectionDto, type PluginAccountDto, type PluginStateDto, type SaveMcpBody } from "@omarchy-bot/protocol";
import { api, apiErrorMessage } from "../lib/api.ts";
import { getShell } from "../lib/shell.ts";
import { onPluginAuthorization } from "../lib/events.ts";
import { BottomSheetWithReturnFocus } from "./BottomSheetWithReturnFocus.tsx";
import { ServicesBrowser } from "./ServicesBrowser.tsx";
import { SkillCreationForm } from "./SkillCreationForm.tsx";
import { ServiceLogo } from "./ServiceLogo.tsx";

const styles = stylex.create({
  root: { minWidth: 0, width: "100%", maxWidth: 1120, overflowWrap: "anywhere" },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--spacing-2)", minWidth: 0 },
  card: { padding: "var(--spacing-3)", borderWidth: 1, borderStyle: "solid", borderColor: "var(--color-border)", borderRadius: "var(--radius-container)", minWidth: 0 },
  code: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", minWidth: 0, fontSize: "0.85rem" },
  link: { color: "var(--color-text-accent)", textDecoration: "underline" },
  document: { maxHeight: "45vh", overflow: "auto", minWidth: 0 },
  skillGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 260px), 1fr))", gap: "var(--spacing-4)", minWidth: 0 },
  skillCard: { minWidth: 0, display: "flex", flexDirection: "column" },
  skillBody: { display: "flex", flexDirection: "column", gap: "var(--spacing-2)", flexGrow: 1, minWidth: 0 },
  skillActions: { marginTop: "auto", paddingTop: "var(--spacing-3)", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "var(--spacing-2)" },
  skillDescription: { display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" },
  search: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "var(--spacing-3)", alignItems: "end" },
  pager: { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "var(--spacing-2)" },
  skeleton: { height: 14, width: "75%", backgroundColor: "var(--color-border)", borderRadius: "var(--radius-container)", marginBottom: "var(--spacing-3)" },
});

type Section = "services" | "mcp" | "skills";

function McpEditor({ initial, busy, onSave, onCancel }: {
  initial?: McpConnectionDto; busy: boolean; onSave(body: SaveMcpBody): Promise<void>; onCancel(): void;
}): JSX.Element {
  const [name, setName] = useState(initial?.name ?? "");
  const [transport, setTransport] = useState<"stdio" | "http" | "package">(initial?.package ? "package" : initial?.transport.type ?? "http");
  const [url, setUrl] = useState(initial?.transport.type === "http" ? initial.transport.url : "");
  const [command, setCommand] = useState(!initial?.package && initial?.transport.type === "stdio" ? initial.transport.command : "");
  const [packageName, setPackageName] = useState(initial?.package?.name ?? "");
  const [binary, setBinary] = useState(initial?.package?.bin ?? "");
  const [args, setArgs] = useState(initial?.package ? JSON.stringify(initial.package.args, null, 2) : initial?.transport.type === "stdio" ? JSON.stringify(initial.transport.args, null, 2) : "[]");
  const [secrets, setSecrets] = useState("");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(undefined);
    try {
      let values: Record<string, string> | undefined;
      if (secrets.trim()) {
        const parsed: unknown = JSON.parse(secrets);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((value) => typeof value !== "string")) throw new Error("Credentials must be a JSON object with string values.");
        values = parsed as Record<string, string>;
      }
      if (!name.trim()) throw new Error("Enter a connection name.");
      if (transport === "http") {
        const endpoint = new URL(url);
        if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("Use an HTTP or HTTPS MCP endpoint.");
        await onSave({ name: name.trim(), enabled, transport: { type: "http", url: endpoint.href, ...(values === undefined ? {} : { headers: values }) } });
      } else {
        const arguments_: unknown = JSON.parse(args);
        if (!Array.isArray(arguments_) || arguments_.some((value) => typeof value !== "string")) throw new Error("Arguments must be a JSON array of strings.");
        if (transport === "package") {
          if (!packageName.trim()) throw new Error("Enter an exact public npm package name without a version.");
          await onSave({ name: name.trim(), enabled, package: { name: packageName.trim(), ...(binary.trim() ? { bin: binary.trim() } : {}), args: arguments_, ...(values === undefined ? {} : { env: values }) } });
        } else {
          if (!command.trim()) throw new Error("Enter the MCP server executable.");
          await onSave({ name: name.trim(), enabled, transport: { type: "stdio", command: command.trim(), args: arguments_, ...(values === undefined ? {} : { env: values }) } });
        }
      }
    } catch (failure) {
      setError(failure instanceof SyntaxError ? "Enter valid JSON for arguments and credentials." : apiErrorMessage(failure, "Connection could not be saved."));
    }
  };
  const savedKeys = initial?.transport.type === "http" ? initial.transport.headerKeys : initial?.transport.envKeys ?? [];
  return <form onSubmit={(event) => void submit(event)}>
    <VStack gap={3}>
      <Heading level={3}>{initial ? "Edit MCP connection" : "Add MCP connection"}</Heading>
      {error ? <Banner status="error" title="Connection not saved" description={error} /> : null}
      <TextInput label="Connection name" value={name} onChange={setName} width="100%" isRequired isDisabled={busy} />
      <div {...stylex.props(styles.row)} aria-label="MCP transport">
        <Button label="HTTP" variant={transport === "http" ? "primary" : "secondary"} aria-pressed={transport === "http"} isDisabled={busy} onClick={() => { setTransport("http"); setSecrets(""); }} />
        <Button label="Native command" variant={transport === "stdio" ? "primary" : "secondary"} aria-pressed={transport === "stdio"} isDisabled={busy} onClick={() => { setTransport("stdio"); setSecrets(""); }} />
        <Button label="Managed npm package" variant={transport === "package" ? "primary" : "secondary"} aria-pressed={transport === "package"} isDisabled={busy} onClick={() => { setTransport("package"); setSecrets(""); }} />
      </div>
      {transport === "http" ? <TextInput label="MCP endpoint URL" value={url} onChange={setUrl} placeholder="https://…/mcp" width="100%" isRequired isDisabled={busy} /> : <>
        {transport === "package" ? <>
          <TextInput label="Public npm package name" value={packageName} onChange={setPackageName} placeholder="@scope/package or package" width="100%" isRequired isDisabled={busy} />
          <Text color="secondary">Enter the exact package name, without a version, tag, URL, or install command. The latest release is installed privately. Node 24 or newer is required.</Text>
          <TextInput label="Binary name (optional)" value={binary} onChange={setBinary} placeholder="Required when the package has multiple binaries" width="100%" isDisabled={busy} />
        </> : <TextInput label="Executable" value={command} onChange={setCommand} placeholder="An installed executable or absolute path" width="100%" isRequired isDisabled={busy} />}
        <TextArea label="Arguments (JSON array)" value={args} onChange={setArgs} width="100%" isDisabled={busy} />
        <Text color="secondary">Commands and arguments are displayed. Put credentials in environment variables, not arguments. {transport === "package" ? "Installation does not confirm that the MCP server is connected." : "Install and update this executable outside the app."}</Text>
      </>}
      <TextArea label={transport === "http" ? "Headers (write-only JSON object)" : "Environment (write-only JSON object)"} value={secrets} onChange={setSecrets} width="100%" isDisabled={busy} />
      <Text color="secondary">{savedKeys.length ? `Saved keys: ${savedKeys.join(", ")}. ` : ""}Leave blank to keep values for the same source. Changing package identity or switching package ownership clears credentials unless supplied again. Enter {"{}"} to clear them. Saved values are never returned to this client.</Text>
      <Switch label="Enable for every Bot" value={enabled} onChange={setEnabled} isDisabled={busy} />
      <div {...stylex.props(styles.row)}><Button label={busy ? "Saving…" : "Save"} type="submit" isDisabled={busy} /><Button label="Cancel" variant="ghost" isDisabled={busy} onClick={onCancel} /></div>
    </VStack>
  </form>;
}

function McpAuthorization({ connectionId, busy, execute }: {
  connectionId: string;
  busy: boolean;
  execute(action: () => Promise<unknown>, message?: string): void;
}): JSX.Element {
  const [redirectUrl, setRedirectUrl] = useState("");
  const [notice, setNotice] = useState("");
  const authorize = (redirect?: string): void => {
    setNotice("");
    execute(async () => {
      const result = await api.authorizeMcp(connectionId, redirect);
      if (result.error) throw new Error(result.error);
      if (result.authorizationUrl) {
        await getShell().browser.open(result.authorizationUrl);
        setNotice("Complete consent in your system browser, then return to Omarchy Bot. Authorization is not complete yet.");
      } else {
        setNotice(result.authenticated ? "Authorization completed. Check the connection to discover its tools." : "Authorization is not complete. Follow the provider’s consent instructions.");
      }
      setRedirectUrl("");
    }, "");
  };
  return <VStack gap={2}>
    <Button label="Reconnect / Authorize" size="sm" variant="secondary" isDisabled={busy} onClick={() => authorize()} />
    <details><summary>Complete authorization manually</summary>
      <form onSubmit={(event) => { event.preventDefault(); authorize(redirectUrl.trim()); }}>
        <VStack gap={2}>
          <Text color="secondary">For headless authorization, paste the full redirect URL returned after provider consent. Do not paste an access token.</Text>
          <TextInput label="Full authorization redirect URL" value={redirectUrl} onChange={setRedirectUrl} width="100%" isRequired isDisabled={busy} />
          <Button label="Complete authorization" type="submit" size="sm" variant="secondary" isDisabled={busy || !redirectUrl.trim()} />
        </VStack>
      </form>
    </details>
    {notice ? <Text role="status">{notice}</Text> : null}
  </VStack>;
}

const mcpStatusLabels: Record<McpConnectionDto["status"], string> = {
  connected: "Connected",
  unchecked: "Not checked yet",
  error: "Connection failed",
  "not-connected": "Not connected",
  "needs-auth": "Authorization required",
  disabled: "Disabled",
  conflict: "Configuration conflict",
};

function AccountLabel({ account, busy, onSave }: { account: PluginAccountDto; busy: boolean; onSave(label: string): void }): JSX.Element {
  const [label, setLabel] = useState(account.label);
  return <form onSubmit={(event) => { event.preventDefault(); if (label.trim()) onSave(label.trim()); }}>
    <VStack gap={1}>
      <TextInput label="Account label" value={label} onChange={setLabel} width="100%" isDisabled={busy} />
      <Button label="Save label" type="submit" variant="secondary" size="sm" isDisabled={busy || !label.trim() || label.trim() === account.label} />
    </VStack>
  </form>;
}


export function PluginsDialog({ open, onClose, mobileReturnFocusRef, bots, selectedBotId, onCreateSkill }: {
  open: boolean;
  onClose: () => void;
  mobileReturnFocusRef: RefObject<HTMLElement | null>;
  bots: BotViewDto[];
  selectedBotId?: string;
  onCreateSkill(botId: string, description: string): Promise<void>;
}): JSX.Element {
  const { isMobile } = useAppShellMobile();
  const onOpenChange = (nextOpen: boolean): void => { if (!nextOpen) onClose(); };
  const content = (
    <Layout
      height="fill"
      padding={6}
      defaultHasDividers
      header={<DialogHeader title="Plugins" onOpenChange={onOpenChange} />}
      content={
        <LayoutContent isScrollable label="Global plugins" data-testid="plugins-dialog">
          <PluginsContent open={open} bots={bots} selectedBotId={selectedBotId} onCreateSkill={onCreateSkill} />
        </LayoutContent>
      }
    />
  );
  return isMobile ? (
    <BottomSheetWithReturnFocus
      label="Plugins"
      returnFocusRef={mobileReturnFocusRef}
      isOpen={open}
      onOpenChange={onOpenChange}
      height="tall"
    >
      {content}
    </BottomSheetWithReturnFocus>
  ) : (
    <Dialog
      isOpen={open}
      onOpenChange={onOpenChange}
      width={1120}
      maxHeight="90dvh"
      padding={6}
      style={{ height: "min(52rem, 90dvh)", overflow: "hidden" }}
    >
      {content}
    </Dialog>
  );
}

function PluginsContent({ open, bots, selectedBotId, onCreateSkill }: {
  open: boolean;
  bots: BotViewDto[];
  selectedBotId?: string;
  onCreateSkill(botId: string, description: string): Promise<void>;
}): JSX.Element {
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: ["plugins"], queryFn: () => api.plugins(), enabled: open, refetchInterval: open ? 5_000 : false, retry: false });
  const [section, setSection] = useState<Section>("services");
  const [selectedService, setSelectedService] = useState<string>();
  const [editing, setEditing] = useState<McpConnectionDto | "new">();
  const [confirm, setConfirm] = useState<{ kind: "mcp" | "skill" | "account"; id: string; name: string } | { kind: "service"; accountId: string; serviceId: string; name: string }>();
  const [notice, setNotice] = useState("");
  const [authorizationNotice, setAuthorizationNotice] = useState("");
  const change = useMutation({
    mutationFn: async (action: () => Promise<unknown>) => {
      await action();
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["plugins"] }), queryClient.invalidateQueries({ queryKey: ["plugin-commands"] })]);
    },
  });
  const run = async (action: () => Promise<unknown>, message = "Saved. File resources are updated immediately; active native sessions may need to reload configuration."): Promise<void> => {
    setNotice("");
    setAuthorizationNotice("");
    await change.mutateAsync(action);
    setNotice(message);
  };
  const execute = (action: () => Promise<unknown>, message?: string): void => { void run(action, message).catch(() => undefined); };
  const provider = state.data?.providers.find((entry) => entry.services.some((service) => service.id === selectedService));
  const service = provider?.services.find((entry) => entry.id === selectedService);
  const busy = change.isPending;

  useEffect(() => { setConfirm(undefined); setNotice(""); setAuthorizationNotice(""); change.reset(); }, [section]);
  useEffect(() => onPluginAuthorization((event) => {
    setAuthorizationNotice(event.type === "plugin.authorization_completed"
      ? "Account connected."
      : "Authorization failed. Try Add account or Reconnect again.");
  }), []);

  const authorize = (providerId: PluginAccountDto["providerId"], accountId?: string): void => {
    execute(async () => {
      const result = await api.authorizePlugin({ providerId, ...(accountId === undefined ? {} : { accountId }), ...(selectedService === undefined ? {} : { serviceId: selectedService }) });
      if (result.url) await getShell().browser.open(result.url);
    }, "Check the account status below. If prompted, complete consent in your system browser, then return to Omarchy Bot.");
  };

  if (state.isPending) return <Text>Loading global plugins…</Text>;
  if (!state.data) return <VStack gap={2}><Banner status="error" title="Plugins could not load" description={apiErrorMessage(state.error, "Daemon is unavailable.")} /><Button label="Retry" onClick={() => void state.refetch()} /></VStack>;
  const data = state.data;
  const companionSkills = provider && service ? data.skills.filter((skill) => skill.origin === "service" && skill.serviceId === `${provider.id}/${service.id}`) : [];

  return <VStack gap={4} {...stylex.props(styles.root)} data-testid="plugins-section">
    <Text color="secondary">Plugins are shared across Bots. File resources update immediately; active tools may retain connections until their native session closes, and configuration changes may require a native-session reload.</Text>
    <div {...stylex.props(styles.row)} aria-label="Plugin sections">
      {(["services", "mcp", "skills"] as const).map((id) => <Button key={id} label={id === "mcp" ? "MCP" : id[0]!.toUpperCase() + id.slice(1)} variant={section === id ? "primary" : "secondary"} size="sm" aria-pressed={section === id} onClick={() => setSection(id)} />)}
    </div>
    {state.isError ? <Banner status="warning" title="Plugin state could not be refreshed" description={apiErrorMessage(state.error, "Showing previously loaded state.")} /> : null}
    {change.isError ? <Banner status="error" title="Change not completed" description={apiErrorMessage(change.error, "Plugin operation failed.")} /> : null}
    {authorizationNotice ? <Text role="status">{authorizationNotice}</Text> : busy ? <Text role="status">Applying change…</Text> : notice ? <Text role="status">{notice}</Text> : null}
    {data.cloudError ? <Banner status="warning" title="Catalog or publisher unavailable" description={`${data.cloudError} Native connections and local Skills remain available.`} /> : null}
    {confirm ? <VStack gap={2} {...stylex.props(styles.card)}>
      <Heading level={2}>{confirm.kind === "account" ? "Disconnect" : "Remove"} {confirm.name}?</Heading>
      <Text>{confirm.kind === "account" ? "Remove this account’s native components and private application grant. Native OAuth credentials and provider access are managed by the native client and provider. Other account connections are unaffected." : confirm.kind === "service" ? "Remove only this Service’s installed components for this account, not the account connection or its other Services. Companion Skills still used by other accounts remain. Active tools may retain connections until their native session closes; file resources are removed immediately." : "Remove this shared native resource. Active tools may retain connections until their native session closes; file resources are removed immediately."}</Text>
      <div {...stylex.props(styles.row)}><Button label="Confirm removal" isDisabled={busy} onClick={() => execute(async () => {
        if (confirm.kind === "mcp") await api.deleteMcp(confirm.id);
        else if (confirm.kind === "skill") await api.removeSkill(confirm.id);
        else if (confirm.kind === "service") await api.removePluginService(confirm.accountId, confirm.serviceId);
        else await api.disconnectPluginAccount(confirm.id);
        setConfirm(undefined);
      })} /><Button label="Cancel" variant="ghost" isDisabled={busy} onClick={() => setConfirm(undefined)} /></div>
    </VStack> : null}

    {section === "services" ? <VStack gap={3}>
      <div hidden={Boolean(provider && service)}><ServicesBrowser data={data} onSelectService={setSelectedService} /></div>
      {provider && service ? <>
        <Button label="All services" variant="ghost" onClick={() => setSelectedService(undefined)} />
        <HStack gap={3} align="center"><ServiceLogo serviceId={service.id} serviceName={service.name} size="lg" /><Heading level={2}>{service.name}</Heading></HStack>
        <Text>{service.description}</Text>
        <Text color="secondary">Each connection is bound to its own native MCP server. The Agent sees its label and identity-verification status; it must not assume an account identity that the provider has not exposed.</Text>
        {provider.registrationNote ? <Text color="secondary">{provider.registrationNote}</Text> : null}
        <a {...stylex.props(styles.link)} href={provider.documentationUrl} target="_blank" rel="noreferrer">Official setup and permissions</a>
        {provider.setupReason ? <Banner status="warning" title="Connection prerequisite" description={provider.setupReason} /> : null}
        <VStack gap={2} {...stylex.props(styles.card)}>
          <Heading level={3}>Official companion Skills</Heading>
          <Text color="secondary">Companion Skills are managed with this Service, not as independent shared resources.</Text>
          {service.skillSources?.length ? <VStack gap={1}>
            {service.skillSources.map((source) => <Text key={source} color="secondary">Official source: {source}</Text>)}
            {!companionSkills.length ? <Text color="secondary">The provider publishes companion Skills, but none are installed for this Service.</Text> : null}
          </VStack> : <Text color="secondary">No provider-published companion Skill is supplied for this Service.</Text>}
          {companionSkills.map((skill) => <VStack key={skill.id} gap={1}>
            <Heading level={4}>{skill.name}</Heading>
            <Text>{skill.description}</Text>
            <Text color="secondary">Source: {skill.source}</Text>
            {skill.path ? <Text color="secondary">Native path: {skill.path}</Text> : null}
            {skill.skillPath ? <Text color="secondary">Skill path in source: {skill.skillPath}</Text> : null}
            <Text color="secondary">{skill.enabled ? "Enabled" : "Disabled"}{skill.readOnly ? " · Read-only" : ""}</Text>
            <Text color="secondary">Revision: {skill.revision || "No recorded revision"}</Text>
            <Text color="secondary">Update status: {skill.updateStatus ?? "Not checked"}</Text>
            {skill.availableRevision ? <Text color="secondary">Available revision: {skill.availableRevision}</Text> : null}
            {skill.lastCheckedAt ? <Text color="secondary">Checked {new Date(skill.lastCheckedAt).toLocaleString()}</Text> : null}
            {skill.modified || skill.updateStatus === "modified" ? <Banner status="warning" title="Locally modified" description="The local Skill differs from its installed revision. Review local changes before updating." /> : null}
            {skill.updateStatus === "failed" && !skill.error ? <Banner status="error" title="Skill update failed" description="The update did not complete." /> : null}
            {skill.error ? <Banner status="error" title="Skill needs attention" description={skill.error} /> : null}
          </VStack>)}
        </VStack>
        {data.accounts.filter((account) => account.providerId === provider.id).map((account) => <VStack key={account.id} gap={2} {...stylex.props(styles.card)}>
          <Heading level={3}>{account.label}</Heading><Text color="secondary">{account.identity}</Text><Text color="secondary">{account.id}</Text>
          {account.identityVerified === false ? <Text color="secondary">Provider identity is not verified by this panel. Use an explicit label and verify the selected account in the provider’s consent page.</Text> : null}
          {account.components?.filter((component) => component.serviceId === service.id).map((component) => <VStack key={component.serviceId} gap={1}>
            <Text>{mcpStatusLabels[component.status]}{component.status === "connected" ? ` · ${component.toolCount} tools` : ""}</Text>
            {component.error ? <Banner status="warning" title="Service component needs attention" description={component.error} /> : null}
            {component.mcpId ? <Button label="Check official MCP" variant="secondary" size="sm" isDisabled={busy} onClick={() => execute(() => api.checkMcp(component.mcpId!), "Official MCP check completed.")} /> : null}
          </VStack>)}
          {account.nativeConnectionId ? <McpAuthorization connectionId={account.nativeConnectionId} busy={busy} execute={execute} /> : null}
          <Switch label={`Use for ${service.name}`} value={account.enabledServices.includes(service.id)} isDisabled={busy} onChange={(enabled) => execute(() => api.setPluginService(account.id, service.id, enabled))} />
          {account.error ? <Banner status={account.status === "reauthorize" ? "error" : "warning"} title={account.status === "reauthorize" ? "Reconnect required" : "Connection needs attention"} description={account.error} /> : null}
          <details><summary>Account label and granted permissions</summary><VStack gap={2}><AccountLabel key={account.label} account={account} busy={busy} onSave={(label) => execute(() => api.labelPluginAccount(account.id, label))} /><Text color="secondary">{account.grantedScopes.length ? account.grantedScopes.join("\n") : "Permissions are managed by the provider’s MCP application."}</Text></VStack></details>
          {account.components?.some((component) => component.serviceId === service.id && component.mcpId) ? <div {...stylex.props(styles.row)}>
            <Button label="Check service updates" variant="secondary" size="sm" isDisabled={busy} onClick={() => execute(() => api.updatePluginService(account.id, service.id), "Service update check completed. See component and companion Skill status above.")} />
            <Button label="Remove service" variant="ghost" size="sm" isDisabled={busy} onClick={() => setConfirm({ kind: "service", accountId: account.id, serviceId: service.id, name: `${service.name} from ${account.label}` })} />
          </div> : null}
          <div {...stylex.props(styles.row)}><Button label="Reconnect" variant="secondary" size="sm" isDisabled={busy || Boolean(provider.setupReason)} onClick={() => authorize(provider.id, account.id)} /><Button label="Disconnect" variant="ghost" size="sm" isDisabled={busy} onClick={() => setConfirm({ kind: "account", id: account.id, name: account.label })} /></div>
        </VStack>)}
        {!data.accounts.some((account) => account.providerId === provider.id) ? <Text color="secondary">No {provider.name} accounts connected.</Text> : null}
        <Button label="Add account" isDisabled={busy || Boolean(provider.setupReason)} onClick={() => authorize(provider.id)} />
        <Text color="secondary">{provider.nativeAuthorization ? "This consent belongs only to the selected Service and region. Other native clients authorize independently; OAuth secrets are not copied between clients." : `First consent requests the supported ${provider.name} permission group. Native clients authorize independently; the application grant stays private. Expanded permissions require renewed consent.`}</Text>
      </> : null}
    </VStack> : null}

    {section === "mcp" ? <VStack gap={3}>
      <Heading level={2}>MCP connections</Heading><Text color="secondary">Choose a managed public npm package, a native local command, or a hosted HTTP endpoint. Installing a package does not confirm a server connection. Configuration changes may require the Agent to reload before they take effect.</Text>
      <Text color="secondary">Managed npm packages install privately from the latest release and can be checked for updates here; local modifications are preserved. Only Node-compatible entrypoints are supported, and packages requiring unsupported install-time scripts are rejected. Native commands must be installed and updated outside the app. Hosted servers control their own deployments; a saved URL does not pin a remote version.</Text>
      {editing !== undefined ? <McpEditor key={editing === "new" ? "new" : editing.id} {...(editing === "new" ? {} : { initial: editing })} busy={busy} onCancel={() => setEditing(undefined)} onSave={async (body) => { await run(() => api.saveMcp(editing === "new" ? null : editing.id, body)); setEditing(undefined); }} /> : <Button label="Add MCP" onClick={() => setEditing("new")} isDisabled={busy} />}
      {!data.mcp.length && editing === undefined ? <Text color="secondary">No custom MCP connections. Add a managed npm package, an endpoint, or a locally installed server.</Text> : null}
      {data.mcp.map((connection) => <VStack key={connection.id} gap={2} {...stylex.props(styles.card)}>
        <Heading level={3}>{connection.name}</Heading><Text color="secondary">{connection.transport.type === "http" ? connection.transport.url : `${connection.transport.command} ${connection.transport.args.join(" ")}`}</Text>
        {connection.source ? <Text color="secondary">Source: {connection.source}</Text> : null}
        {connection.package ? <VStack gap={1}>
          <Text color="secondary">Package source: public npm · {connection.package.name} · Binary: {connection.package.bin}</Text>
          <Text color="secondary">Installed version: {connection.package.version}{connection.package.availableVersion ? ` · Available version: ${connection.package.availableVersion}` : ""}</Text>
          <Text color="secondary">Last package check: {connection.package.lastCheckedAt ? new Date(connection.package.lastCheckedAt).toLocaleString() : "Not checked yet"}</Text>
          {connection.package.modified || connection.package.updateStatus === "modified"
            ? <Banner status="warning" title="Package modified locally" description={connection.package.error ?? "Local changes are preserved; package updates will not overwrite them."} />
            : connection.package.updateStatus === "failed" || connection.package.error ? <Banner status="warning" title="Package update needs attention" description={connection.package.error ?? "The package update could not be completed. Check again to retry."} /> : null}
          {connection.package.updateStatus === "available" ? <Text color="secondary">A package update is available.</Text> : connection.package.updateStatus === "current" ? <Text color="secondary">Package is current as of the last check.</Text> : null}
          <Button label="Check update" size="sm" variant="secondary" isDisabled={busy || Boolean(connection.readOnly)} onClick={() => execute(() => api.updateMcp(connection.id), "Package update check completed. See package status; installation does not confirm connectivity, and active native sessions may need to reload configuration.")} />
        </VStack> : null}
        {connection.readOnly ? <Text color="secondary">Read-only native configuration. Edit its source file to change or remove this connection.</Text> : null}
        <Switch label={`Enable ${connection.name}`} value={connection.enabled} isDisabled={busy || Boolean(connection.readOnly)} onChange={(enabled) => execute(() => api.setMcpEnabled(connection.id, enabled))} />
        <Text>{connection.pendingReload ? "Configuration pending reload" : !connection.enabled ? "Disabled" : connection.status === "connected" ? `Connected · ${connection.toolCount} tools discovered` : mcpStatusLabels[connection.status]}</Text>
        {connection.pendingReload ? <Text color="secondary">Saved configuration has not been loaded by the Agent. Any previous connection status or tools may be out of date.</Text> : null}
        {connection.error ? <Banner status="error" title="MCP error" description={connection.error} /> : null}
        {connection.status === "needs-auth" ? <McpAuthorization connectionId={connection.id} busy={busy} execute={execute} /> : null}
        <div {...stylex.props(styles.row)}><Button label="Check" size="sm" variant="secondary" isDisabled={busy} onClick={() => execute(() => api.checkMcp(connection.id), "Connection check completed. See its reported status below.")} /><Button label="Edit" size="sm" variant="secondary" isDisabled={busy || Boolean(connection.readOnly)} onClick={() => setEditing(connection)} /><Button label="Remove" size="sm" variant="ghost" isDisabled={busy || Boolean(connection.readOnly)} onClick={() => setConfirm({ kind: "mcp", id: connection.id, name: connection.name })} /></div>
      </VStack>)}
    </VStack> : null}

    {section === "skills" ? <SkillsPanel data={data} bots={bots} selectedBotId={selectedBotId} onCreateSkill={onCreateSkill} busy={busy} execute={execute} onRemove={(skill) => setConfirm({ kind: "skill", id: skill.id, name: skill.name })} /> : null}

  </VStack>;
}

function SkillsPanel({ data, bots, selectedBotId, onCreateSkill, busy, execute, onRemove }: {
  data: PluginStateDto;
  bots: BotViewDto[];
  selectedBotId?: string;
  onCreateSkill(botId: string, description: string): Promise<void>;
  busy: boolean;
  execute(action: () => Promise<unknown>, message?: string): void;
  onRemove(skill: InstalledSkillDto): void;
}): JSX.Element {
  const [view, setView] = useState<"discover" | "installed">("discover");
  const [creating, setCreating] = useState(false);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [detailId, setDetailId] = useState<string>();
  const [source, setSource] = useState("");
  const [skillPath, setSkillPath] = useState("");
  const [ref, setRef] = useState("");
  const cursor = !search && page > 0 ? String(page) : undefined;
  const catalog = useQuery({
    queryKey: ["skill-catalog", data.cloudUrl, search, cursor],
    queryFn: () => api.searchSkills(search, cursor),
    enabled: view === "discover" && detailId === undefined,
    retry: false,
    staleTime: 60_000,
  });
  const detail = useQuery({
    queryKey: ["skill-detail", data.cloudUrl, detailId],
    queryFn: () => api.skillDetail(detailId!),
    enabled: view === "discover" && detailId !== undefined,
    retry: false,
  });
  const sharedSkills = data.skills.filter((skill) => skill.origin !== "service");
  const creator = sharedSkills.find((skill) => skill.name === "skill-creator");
  const seenPaths = new Set(data.skills.flatMap((skill) => skill.path ? [skill.path] : []));
  const nativeSkills = data.nativeSkills.filter((skill) => {
    if (seenPaths.has(skill.path)) return false;
    seenPaths.add(skill.path);
    return true;
  });
  const installedCount = sharedSkills.length;
  const pageSize = search ? SKILL_CATALOG_PAGE_SIZE : catalog.data?.pageSize ?? SKILL_CATALOG_PAGE_SIZE;
  const total = catalog.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const visibleSkills = search ? catalog.data?.skills.slice(page * pageSize, (page + 1) * pageSize) : catalog.data?.skills;
  const canNext = catalog.isSuccess && (search ? page + 1 < pageCount : Boolean(catalog.data.nextCursor));
  const selectedInstalled = data.skills.find((skill) => skill.id === detailId);
  const pagination = <nav {...stylex.props(styles.pager)} aria-label="Skills pagination">
    <Button label="Previous" variant="secondary" size="sm" isDisabled={page === 0 || catalog.isFetching} onClick={() => setPage((current) => current - 1)} />
    <Text role="status">{catalog.isPending ? "Loading…" : catalog.isError ? "Unavailable" : `Page ${page + 1} of ${pageCount}`}</Text>
    <Button label="Next" variant="secondary" size="sm" isDisabled={!canNext || catalog.isFetching} onClick={() => setPage((current) => current + 1)} />
  </nav>;

  return <VStack gap={4} data-testid="skills-panel">
    <div {...stylex.props(styles.pager)}>
      <Heading level={2}>Skills</Heading>
      <div {...stylex.props(styles.row)} aria-label="Skill views">
        <Button label="Discover" variant={view === "discover" ? "primary" : "secondary"} size="sm" aria-pressed={view === "discover"} onClick={() => setView("discover")} />
        <Button label={`Installed (${installedCount})`} variant={view === "installed" ? "primary" : "secondary"} size="sm" aria-pressed={view === "installed"} onClick={() => setView("installed")} />
      </div>
    </div>
    <Card padding={4}>
      <VStack gap={3}>
        <div {...stylex.props(styles.pager)}>
          <Heading level={3}>Skill Creator</Heading>
          {!creating ? <Button label="Create skill" isDisabled={busy || !creator?.enabled} onClick={() => setCreating(true)} /> : null}
        </div>
        <Text color="secondary">Create a reusable Skill for all Bots and Agents with the installed Skill Creator.</Text>
        {!creator ? <Banner status="warning" title="Skill Creator is not installed" description={data.nativeError ?? "The current daemon has not provided the default Skill Creator. Update and restart the daemon, or install the official skill-creator from source."} /> : !creator.enabled ? <Button label="Enable Skill Creator" variant="secondary" isDisabled={busy || Boolean(creator.readOnly)} onClick={() => execute(() => api.setSkillEnabled(creator.id, true), "Skill Creator enabled.")} /> : creating ? <SkillCreationForm bots={bots} selectedBotId={selectedBotId} onCreate={onCreateSkill} onCancel={() => setCreating(false)} /> : <Text color="secondary">Describe the workflow, choose a Bot, and continue in a new conversation. Existing drafts stay unchanged.</Text>}
      </VStack>
    </Card>
    <details><summary>Install a Skill from source</summary>
      <form onSubmit={(event) => {
        event.preventDefault();
        execute(async () => {
          await api.installSkill({ source: source.trim(), ...(skillPath.trim() ? { skillPath: skillPath.trim() } : {}), ...(ref.trim() ? { ref: ref.trim() } : {}) });
          setSource(""); setSkillPath(""); setRef(""); setView("installed");
        }, "Skill installed. See its native path and status below.");
      }}>
        <VStack gap={3}>
          <Text color="secondary">Install from a repository, a supported Skill URL, or a local source path on the daemon host. Review third-party instructions before installing.</Text>
          <TextInput label="Skill source" value={source} onChange={setSource} width="100%" isRequired isDisabled={busy} />
          <TextInput label="Exact Skill path (optional)" value={skillPath} onChange={setSkillPath} width="100%" placeholder="Path within the source when it contains multiple Skills" isDisabled={busy} />
          <TextInput label="Git ref (optional)" value={ref} onChange={setRef} width="100%" placeholder="Branch, tag, or commit" isDisabled={busy} />
          <Button label="Install from source" type="submit" isDisabled={busy || !source.trim()} />
        </VStack>
      </form>
    </details>
    {view === "installed" ? <VStack gap={4}>
      <div {...stylex.props(styles.pager)}>
        <Heading level={3}>Shared Skills · {sharedSkills.length}</Heading>
        {sharedSkills.some((skill) => !skill.readOnly) ? <Button label="Check updates" size="sm" variant="secondary" isDisabled={busy} onClick={() => execute(() => api.updateSkills(), "Update check completed. See each skill’s status below.")} /> : null}
      </div>
      <Text color="secondary">Installed once, shared across all Bots and Agents. Disabled Skills stay on disk but are not offered for use. Local modifications and update failures are shown below.</Text>
      {sharedSkills.length ? <div {...stylex.props(styles.skillGrid)} aria-label="Shared native Skills">
        {sharedSkills.map((skill) => <Card key={skill.id} padding={4} xstyle={styles.skillCard} role="article" aria-label={skill.name}>
          <div {...stylex.props(styles.skillBody)}>
            <Heading level={4}>{skill.name}</Heading>
            <Text {...stylex.props(styles.skillDescription)}>{skill.description}</Text>
            <Text color="secondary">Source: {skill.source}</Text>
            <Text color="secondary">{skill.origin === "default" ? "Default official Skill" : skill.origin === "local" ? "Local Skill" : skill.origin === "installed" ? "Installed Skill" : "Native Skill"}</Text>
            {skill.path ? <Text color="secondary">Native path: {skill.path}</Text> : null}
            {skill.skillPath ? <Text color="secondary">Skill path in source: {skill.skillPath}</Text> : null}
            {skill.readOnly ? <Text color="secondary">Read-only</Text> : null}
            <Switch label={`Enable ${skill.name}`} value={skill.enabled} isDisabled={busy || skill.readOnly} onChange={(enabled) => execute(() => api.setSkillEnabled(skill.id, enabled))} />
            {skill.modified || skill.updateStatus === "modified" ? <Banner status="warning" title="Locally modified" description="The local Skill differs from its installed revision. Review local changes before updating." /> : null}
            {skill.updateStatus === "available" ? <Text>Update available{skill.availableRevision ? ` · ${skill.availableRevision}` : ""}</Text> : null}
            {skill.updateStatus === "current" ? <Text color="secondary">Up to date</Text> : null}
            {skill.updateStatus === "failed" && !skill.error ? <Banner status="error" title="Skill update failed" description="The update did not complete." /> : null}
            <details>
              <summary>Version and updates</summary>
              <VStack gap={2}>
                <Text color="secondary">Installed revision</Text>
                <code {...stylex.props(styles.code)}>{skill.revision || "No recorded revision"}</code>
                {skill.availableRevision && skill.updateStatus !== "available" ? <Text color="secondary">Available revision: {skill.availableRevision}</Text> : null}
                {skill.lastCheckedAt ? <Text color="secondary">Checked {new Date(skill.lastCheckedAt).toLocaleString()}</Text> : null}
              </VStack>
            </details>
            {skill.error ? <Banner status="error" title="Skill needs attention" description={skill.error} /> : null}
            <div {...stylex.props(styles.skillActions)}><Text color="secondary">{skill.enabled ? "Enabled" : "Disabled"}</Text><Button label="Remove" aria-label={`Remove ${skill.name}`} variant="ghost" size="sm" isDisabled={busy || Boolean(skill.readOnly)} onClick={() => onRemove(skill)} /></div>
          </div>
        </Card>)}
      </div> : <Card padding={4}><VStack gap={2}>
        <Text>No shared Skills installed.</Text>
        <Button label="Discover Skills" variant="secondary" onClick={() => { setView("discover"); setDetailId(undefined); }} />
      </VStack></Card>}
      <Heading level={3}>Other discovered Skills · {nativeSkills.length}</Heading>
      <Text color="secondary">These read-only resources were discovered outside the shared installation. They are not counted as installed shared Skills.</Text>
      {data.nativeError ? <Banner status="warning" title="Native Skills could not be refreshed" description={data.nativeError} /> : null}
      <div {...stylex.props(styles.skillGrid)} aria-label="Other discovered Skills">
        {nativeSkills.map((skill) => <Card key={skill.path} padding={4} variant="muted" xstyle={styles.skillCard} role="article" aria-label={skill.name}>
          <div {...stylex.props(styles.skillBody)}>
            <Heading level={4}>{skill.name}</Heading>
            <Text {...stylex.props(styles.skillDescription)}>{skill.description}</Text>
            <Text color="secondary">Native path: {skill.path}</Text>
            <div {...stylex.props(styles.skillActions)}><Text color="secondary">Read-only</Text></div>
          </div>
        </Card>)}
      </div>
      {!data.nativeError && !nativeSkills.length ? <Text color="secondary">No other discovered Skills.</Text> : null}
    </VStack> : detailId ? <VStack gap={3}>
      <Button label="Back to catalog" variant="ghost" onClick={() => setDetailId(undefined)} />
      {detail.isPending ? <Text role="status">Loading skill…</Text> : detail.isError ? <VStack gap={2}><Banner status="error" title="Skill detail unavailable" description="This Skill could not be loaded. Please try again." /><Button label="Retry" variant="secondary" onClick={() => void detail.refetch()} /></VStack> : detail.data ? <>
        <Card padding={4}><VStack gap={3}>
          <Heading level={3}>{detail.data.name}</Heading><Text>{detail.data.description}</Text><Text color="secondary">{detail.data.source}</Text>
          <div {...stylex.props(styles.pager)}>
            <a href={detail.data.url} target="_blank" rel="noopener noreferrer" {...stylex.props(styles.link)}>View on skills.sh</a>
            <Button label={selectedInstalled ? "Installed" : "Install"} isDisabled={busy || Boolean(selectedInstalled)} onClick={() => execute(() => api.installSkill(detailId), "Skill installed. Use / in the composer, or let the Agent discover it on the next turn.")} />
          </div>
        </VStack></Card>
        <Text color="secondary">Review third-party instructions before installing. The complete Skill folder is saved, but its scripts do not run during installation.</Text>
        {detail.data.content ? <div {...stylex.props(styles.document)}><Markdown>{detail.data.content}</Markdown></div> : <Text color="secondary">No text preview is available. Installation checks the original source.</Text>}
      </> : null}
    </VStack> : <VStack gap={3}>
      <Text color="secondary">Find new capabilities for your Bots in the skills.sh catalog.</Text>
      <form {...stylex.props(styles.search)} onSubmit={(event) => { event.preventDefault(); setSearch(searchDraft.trim()); setPage(0); }}>
        <TextInput label="Search skills.sh" value={searchDraft} onChange={setSearchDraft} width="100%" placeholder="Search by task or skill name" />
        <Button label="Search" type="submit" variant="secondary" isDisabled={searchDraft.trim().length === 1 || searchDraft.trim().length > 256} />
      </form>
      {catalog.isSuccess ? <div {...stylex.props(styles.pager)}>
        <Text color="secondary">{total ? `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, total)} of ${total.toLocaleString()} ${search ? "matches" : "trending Skills"}` : "0 matches"}</Text>
        {search ? <Button label="Clear search" variant="ghost" size="sm" onClick={() => { setSearch(""); setSearchDraft(""); setPage(0); }} /> : null}
      </div> : null}
      {catalog.data?.searchLimit && total >= catalog.data.searchLimit ? <Text color="secondary">Showing the top {catalog.data.searchLimit} matches. Refine your search to narrow the results.</Text> : null}
      {pagination}
      {catalog.isPending ? <>
        <Text role="status">Loading Skills…</Text>
        <div {...stylex.props(styles.skillGrid)} aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <Card key={index} padding={4} minHeight={150}><div {...stylex.props(styles.skeleton)} /><div {...stylex.props(styles.skeleton)} /></Card>)}</div>
      </> : catalog.isError ? <VStack gap={2}><Banner status="error" title="Catalog unavailable" description="Skills could not be loaded. Your installed Skills are unchanged." /><Button label="Retry catalog" variant="secondary" onClick={() => void catalog.refetch()} /></VStack> : visibleSkills?.length ? <div {...stylex.props(styles.skillGrid)} aria-label="Skill catalog" data-testid="skill-catalog-grid">
        {visibleSkills.map((skill) => {
          const installed = data.skills.find((entry) => entry.id === skill.id);
          return <Card key={skill.id} padding={4} minHeight={170} xstyle={styles.skillCard} role="article" aria-label={skill.name}>
            <div {...stylex.props(styles.skillBody)}>
              <Heading level={3}>{skill.name}</Heading><Text color="secondary">{skill.source}</Text>
              {skill.description ? <Text {...stylex.props(styles.skillDescription)}>{skill.description}</Text> : null}
              <div {...stylex.props(styles.skillActions)}>
                <Text color="secondary">{installed ? installed.enabled ? "Enabled" : "Installed · Disabled" : skill.installs === undefined ? "Available" : `${skill.installs.toLocaleString()} installs`}</Text>
                <Button label="View skill" aria-label={`View ${skill.name}`} variant="secondary" size="sm" onClick={() => setDetailId(skill.id)} />
              </div>
            </div>
          </Card>;
        })}
      </div> : <Card padding={4}><VStack gap={2}><Heading level={3}>No matching Skills</Heading><Text color="secondary">Try another name or describe the task you want your Bot to do.</Text></VStack></Card>}
      {catalog.isSuccess && Boolean(visibleSkills?.length) ? pagination : null}
    </VStack>}
  </VStack>;
}
