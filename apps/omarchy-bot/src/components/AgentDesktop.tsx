import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell, useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutHeader } from "@astryxdesign/core/Layout";
import { MobileNav } from "@astryxdesign/core/MobileNav";
import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { agentDaemon, type AgentBot } from "../lib/agentDaemon.ts";
import { pairService } from "../lib/pairing.ts";
import type { LocalAgentDaemon } from "../lib/shell.ts";
import { AddService } from "./AddService.tsx";
import { AgentConversationView, type ConversationFeed } from "./AgentConversation.tsx";
import { AgentDaemonSettings, type LaunchPreference } from "./settings/AgentDaemonSettings.tsx";

export function AgentDesktop({ daemon, paired, baseUrl }: {
  daemon: LocalAgentDaemon;
  paired: boolean;
  baseUrl: string;
}) {
  const [autostart, setAutostart] = useState(daemon.autostart);
  const [ready, setReady] = useState(false);
  const [launchError, setLaunchError] = useState("");
  const [checking, setChecking] = useState(false);
  const [pairing, setPairing] = useState(false);
  const check = useCallback(async () => {
    setLaunchError("");
    setChecking(true);
    try { setReady(await daemon.ensure()); }
    catch (error) { setReady(false); setLaunchError(typeof error === "string" ? error : "Could not reach the local Agent Daemon."); }
    finally { setChecking(false); }
  }, [daemon]);

  useEffect(() => {
    if (!paired || baseUrl === daemon.baseUrl) void check();
  }, [baseUrl, check, daemon.baseUrl, paired]);

  const setLaunchEnabled = async (enabled: boolean) => {
    await daemon.setAutostart(enabled);
    setAutostart(enabled);
  };
  const launch: LaunchPreference = { enabled: autostart, setEnabled: setLaunchEnabled };

  if (paired) return <AgentWorkspace key={baseUrl} baseUrl={baseUrl} launch={launch} />;
  return <AddService agentControls={<VStack gap={2}>
    {launchError && <Banner title={launchError} status="warning" />}
    <CheckboxInput label="Start the local daemon when opening Omarchy Bot" value={autostart}
      changeAction={async enabled => {
        setLaunchError("");
        try { await setLaunchEnabled(enabled); }
        catch { setLaunchError("Could not save the local daemon launch preference."); }
      }} onChange={() => {}} />
    <HStack gap={2}>
      <Button label="Check local daemon" clickAction={check} isLoading={checking} />
      {ready && <Button label="Pair local daemon" variant="primary" isLoading={pairing} clickAction={async () => {
        setPairing(true);
        setLaunchError("");
        try {
          const code = await daemon.pairingCode();
          if (code) await pairService({ serviceUrl: daemon.baseUrl, code });
        } catch (error) {
          setLaunchError(typeof error === "string" ? error : "Could not pair the local Agent Daemon.");
        } finally { setPairing(false); }
      }} />}
    </HStack>
  </VStack>} />;
}

type BotAction = { kind: "create" } | { kind: "rename" | "delete"; bot: AgentBot };

function AgentWorkspace({ baseUrl, launch }: { baseUrl: string; launch: LaunchPreference }) {
  const queryClient = useQueryClient();
  const bots = useQuery({ queryKey: ["agent-bots", baseUrl], queryFn: ({ signal }) => agentDaemon.bots(signal) });
  const selectedKey = `omarchy-bot.agent-bot:${baseUrl}`;
  const [selected, setSelected] = useState(() => {
    try { return localStorage.getItem(selectedKey) ?? ""; } catch { return ""; }
  });
  const [settings, setSettings] = useState(false);
  const [action, setAction] = useState<BotAction>();
  const feeds = useRef(new Map<string, ConversationFeed>());
  const bot = bots.data?.find(candidate => candidate.id === selected) ?? bots.data?.[0];
  let feed = bot && feeds.current.get(bot.id);
  if (bot && !feed) {
    feed = { cursor: "0", replies: new Map(), work: new Map(), tools: new Map(), delta: "", error: "" };
    feeds.current.set(bot.id, feed);
  }

  function select(id: string) {
    setSelected(id);
    try { localStorage.setItem(selectedKey, id); } catch { /* Selection is still available this session. */ }
  }

  const forget = useCallback((id: string) => {
    feeds.current.delete(id);
    queryClient.setQueryData<AgentBot[]>(["agent-bots", baseUrl], current => current?.filter(bot => bot.id !== id));
    void queryClient.invalidateQueries({ queryKey: ["agent-bots", baseUrl] });
  }, [baseUrl, queryClient]);

  const nav = <AgentBotNav bots={bots.data ?? []} selected={bot?.id ?? ""} select={select}
    create={() => setAction({ kind: "create" })} settings={() => setSettings(true)} />;

  return <AppShell height="fill" contentPadding={0} variant="section" sideNav={nav}
    mobileNav={{ breakpoint: "md", content: <MobileNav header="Bot navigation">{nav}</MobileNav> }}>
    <Layout height="fill" padding={0} header={bot && <LayoutHeader>
      <HStack gap={2} justify="between" vAlign="center">
        <Heading level={1}>{bot.name}</Heading>
        <HStack gap={1}>
          <Button label="Rename" size="sm" onClick={() => setAction({ kind: "rename", bot })} />
          <Button label="Delete Bot" size="sm" onClick={() => setAction({ kind: "delete", bot })} />
        </HStack>
      </HStack>
    </LayoutHeader>}>
      {bot && feed ? <AgentConversationView key={bot.id} botId={bot.id} feed={feed} onMissing={forget} /> :
        <LayoutContent><VStack gap={2} padding={4}>
          {bots.isError ? <>
            <Banner status="error" title="Could not load Bots from the connected daemon." />
            <Button label="Try again" clickAction={async () => { await bots.refetch(); }} />
          </> : <Text>{bots.isPending ? "Loading Bots…" : "Create a Bot to start a Conversation."}</Text>}
        </VStack></LayoutContent>}
    </Layout>
    {settings && <AgentDaemonSettings baseUrl={baseUrl} close={() => setSettings(false)} launch={launch} />}
    {action && <BotDialog action={action} close={() => setAction(undefined)} submit={async name => {
      if (action.kind === "delete") {
        await agentDaemon.remove(action.bot.id);
        forget(action.bot.id);
      } else {
        const changed = action.kind === "create" ? await agentDaemon.create(name) : await agentDaemon.rename(action.bot.id, name);
        queryClient.setQueryData<AgentBot[]>(["agent-bots", baseUrl], current =>
          [...(current ?? []).filter(bot => bot.id !== changed.id), changed]);
        if (action.kind === "create") select(changed.id);
        void queryClient.invalidateQueries({ queryKey: ["agent-bots", baseUrl] });
      }
      setAction(undefined);
    }} />}
  </AppShell>;
}

function AgentBotNav({ bots, selected, select, create, settings }: {
  bots: AgentBot[]; selected: string; select: (id: string) => void; create: () => void; settings: () => void;
}) {
  const { isMobile, closeMobileNav } = useAppShellMobile();
  function navigate(action: () => void) {
    if (isMobile) closeMobileNav();
    action();
  }
  return <SideNav aria-label="Bot navigation" topContent={<Button label="New Bot" variant="primary" onClick={() => navigate(create)} />}
    footer={<SideNavItem label="Settings" onClick={() => navigate(settings)} />}>
    <SideNavSection title="Bots">
      {bots.map(bot => <SideNavItem key={bot.id} label={bot.name} isSelected={bot.id === selected}
        onClick={() => navigate(() => select(bot.id))} />)}
    </SideNavSection>
  </SideNav>;
}

function BotDialog({ action, close, submit }: { action: BotAction; close: () => void; submit: (name: string) => Promise<void> }) {
  const [name, setName] = useState(action.kind === "create" ? "" : action.bot.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const deleting = action.kind === "delete";
  const title = deleting ? `Delete ${action.bot.name}?` : action.kind === "create" ? "New Bot" : "Rename Bot";

  async function save() {
    if (busy || (!deleting && !name.trim())) return;
    setBusy(true);
    setError("");
    try { await submit(name.trim()); }
    catch (error) { setError(error instanceof Error ? error.message : "The Agent Daemon request failed."); }
    finally { setBusy(false); }
  }

  return <Dialog isOpen onOpenChange={open => { if (!open && !busy) close(); }} purpose="form" width={520}>
    <DialogHeader title={title} />
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <VStack gap={3}>
        {error && <Banner status="error" title={error} />}
        {deleting ? <Text>The daemon will permanently delete this Bot and its Conversation.</Text> :
          <TextInput label="Bot name" isRequired value={name} onChange={setName} hasAutoFocus isDisabled={busy} />}
        <HStack gap={2} justify="end">
          <Button label="Cancel" onClick={close} isDisabled={busy} />
          <Button label={deleting ? "Delete Bot permanently" : action.kind === "create" ? "Create Bot" : "Save name"}
            variant={deleting ? "destructive" : "primary"} isLoading={busy} type="submit" />
        </HStack>
      </VStack>
    </form>
  </Dialog>;
}
