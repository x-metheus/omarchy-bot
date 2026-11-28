import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BotIcon, CircleAlertIcon, EllipsisIcon, MessageSquareIcon, PencilIcon, PlusIcon, RefreshCwIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { agentDaemon, type AgentBot } from "../lib/agentDaemon.ts";
import { createConversationFeed, type ConversationFeed } from "../lib/conversationSession.ts";
import { useLocalDaemon, type LocalDaemonController } from "../lib/localDaemon.ts";
import type { LocalAgentDaemon } from "../lib/shell.ts";
import { AddService } from "./AddService.tsx";
import { AgentConversationView } from "./AgentConversation.tsx";
import { AgentDaemonSettings } from "./settings/AgentDaemonSettings.tsx";

export function AgentDesktop({ daemon, paired, baseUrl }: {
  daemon: LocalAgentDaemon;
  paired: boolean;
  baseUrl: string;
}) {
  const local = useLocalDaemon(daemon, { paired, baseUrl });
  return paired ? <AgentWorkspace key={baseUrl} baseUrl={baseUrl} local={local} /> : <AddService local={local} />;
}

type BotAction = { kind: "create" } | { kind: "rename" | "delete"; bot: AgentBot };

function AgentWorkspace({ baseUrl, local }: { baseUrl: string; local: LocalDaemonController }) {
  const queryClient = useQueryClient();
  const bots = useQuery({ queryKey: ["agent-bots", baseUrl], queryFn: ({ signal }) => agentDaemon.bots(signal) });
  const selectedKey = `omarchy-bot.agent-bot:${baseUrl}`;
  const [selected, setSelected] = useState(() => {
    try { return localStorage.getItem(selectedKey) ?? ""; } catch { return ""; }
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [action, setAction] = useState<BotAction>();
  const feeds = useRef(new Map<string, ConversationFeed>());
  const bot = bots.data?.find(candidate => candidate.id === selected) ?? bots.data?.[0];
  let feed = bot && feeds.current.get(bot.id);
  if (bot && !feed) {
    feed = createConversationFeed();
    feeds.current.set(bot.id, feed);
  }

  function select(id: string) {
    setSelected(id);
    setSettingsOpen(false);
    try { localStorage.setItem(selectedKey, id); } catch { /* Selection is still available this session. */ }
  }

  const forget = useCallback((id: string) => {
    feeds.current.delete(id);
    queryClient.setQueryData<AgentBot[]>(["agent-bots", baseUrl], current => current?.filter(bot => bot.id !== id));
    void queryClient.invalidateQueries({ queryKey: ["agent-bots", baseUrl] });
  }, [baseUrl, queryClient]);

  const create = () => setAction({ kind: "create" });

  return <SidebarProvider className="h-dvh overflow-hidden">
    <AgentBotNav bots={bots.data ?? []} selected={settingsOpen ? undefined : bot?.id} select={select} baseUrl={baseUrl}
      settingsOpen={settingsOpen} create={create} settings={() => setSettingsOpen(true)} />
    <SidebarInset className="min-w-0 overflow-hidden">
      <header className="flex min-h-16 shrink-0 items-center gap-3 border-b px-4 sm:px-6">
        <SidebarTrigger />
        {settingsOpen ? <h1 className="text-base font-semibold">Settings</h1> : bot ? <>
          <h1 className="min-w-0 flex-1 truncate text-base font-semibold" title={bot.name}>{bot.name}</h1>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="Bot actions" title="Bot actions" />}>
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => setAction({ kind: "rename", bot })}><PencilIcon /> Rename</DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem variant="destructive" onClick={() => setAction({ kind: "delete", bot })}><Trash2Icon /> Delete Bot</DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </> : <h1 className="text-base font-semibold">Bots</h1>}
      </header>
      {/* Settings shares the main area with the mounted Conversation and its live event stream. */}
      <div hidden={settingsOpen} className="min-h-0 flex-1">
        {bot && feed ? <AgentConversationView key={bot.id} bot={bot} feed={feed} onMissing={forget} /> :
          <div className="grid h-full place-items-center overflow-auto p-4">
            {bots.isPending ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /> Loading Bots…</p> :
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">{bots.isError ? <CircleAlertIcon /> : <BotIcon />}</EmptyMedia>
                  <EmptyTitle>{bots.isError ? "Could not load Bots" : "Create your first Bot"}</EmptyTitle>
                  <EmptyDescription>{bots.isError ? "Check the connection to the Agent Daemon." : "Each Bot has an ongoing job and its own Conversation."}</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>{bots.isError ? <Button variant="outline" onClick={() => void bots.refetch()} disabled={bots.isFetching}>
                  {bots.isFetching ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />} Try again
                </Button> : <Button onClick={create}><PlusIcon data-icon="inline-start" /> New Bot</Button>}</EmptyContent>
              </Empty>}
          </div>}
      </div>
      {settingsOpen && <AgentDaemonSettings baseUrl={baseUrl} local={local} />}
    </SidebarInset>
    {action && <BotDialog action={action} close={() => setAction(undefined)} submit={async name => {
      if (action.kind === "delete") {
        await agentDaemon.remove(action.bot.id);
        forget(action.bot.id);
      } else {
        const changed = action.kind === "create" ? await agentDaemon.create(name) : await agentDaemon.rename(action.bot.id, name);
        await queryClient.cancelQueries({ queryKey: ["agent-bots", baseUrl] });
        queryClient.setQueryData<AgentBot[]>(["agent-bots", baseUrl], current => action.kind === "create"
          ? [...(current ?? []), changed]
          : current?.map(candidate => candidate.id === changed.id ? changed : candidate));
        if (action.kind === "create") select(changed.id);
        void queryClient.invalidateQueries({ queryKey: ["agent-bots", baseUrl] });
      }
      setAction(undefined);
    }} />}
  </SidebarProvider>;
}

function AgentBotNav({ bots, selected, select, create, settings, settingsOpen, baseUrl }: {
  bots: AgentBot[]; selected: string | undefined; select: (id: string) => void; create: () => void;
  settings: () => void; settingsOpen: boolean; baseUrl: string;
}) {
  const { setOpenMobile } = useSidebar();
  function navigate(action: () => void) {
    setOpenMobile(false);
    action();
  }
  const host = new URL(baseUrl).host;
  return <Sidebar collapsible="icon">
    <SidebarHeader>
      <div className="flex min-w-0 items-center gap-2 p-2 group-data-[collapsible=icon]:p-0">
        <div className="grid size-8 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground">
          <BotIcon className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 group-data-[collapsible=icon]:hidden">
          <p className="truncate text-sm font-semibold">Omarchy Bot</p>
          <p className="truncate text-xs text-muted-foreground" title={host}>{host}</p>
        </div>
      </div>
      <SidebarMenu>
        <SidebarMenuItem><SidebarMenuButton tooltip="New Bot" aria-label="New Bot"
          onClick={() => navigate(create)} render={<Button variant="outline" className="justify-start" />}>
          <PlusIcon /><span>New Bot</span>
        </SidebarMenuButton></SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupLabel>Bots</SidebarGroupLabel>
        <SidebarGroupContent>
          <nav aria-label="Bots">
            <SidebarMenu>{bots.map(bot => <SidebarMenuItem key={bot.id}>
              <SidebarMenuButton render={<button type="button" />} isActive={bot.id === selected} aria-current={bot.id === selected ? "page" : undefined}
                aria-label={bot.name} tooltip={bot.name} onClick={() => navigate(() => select(bot.id))}>
                <MessageSquareIcon /><span>{bot.name}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>)}</SidebarMenu>
          </nav>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter>
      <SidebarMenu><SidebarMenuItem>
        <SidebarMenuButton render={<button type="button" />} isActive={settingsOpen} aria-current={settingsOpen ? "page" : undefined}
          aria-label="Settings" tooltip="Settings" onClick={() => navigate(settings)}>
          <SettingsIcon /><span>Settings</span>
        </SidebarMenuButton>
      </SidebarMenuItem></SidebarMenu>
    </SidebarFooter>
  </Sidebar>;
}

function BotDialog({ action, close, submit }: { action: BotAction; close: () => void; submit: (name: string) => Promise<void> }) {
  const [name, setName] = useState(action.kind === "create" ? "" : action.bot.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deleting = action.kind === "delete";

  async function save() {
    if (busy || (!deleting && !name.trim())) return;
    setBusy(true);
    setError("");
    try { await submit(name.trim()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The Agent Daemon request failed."); }
    finally { setBusy(false); }
  }

  const closeOnDismiss = (open: boolean) => { if (!open && !busy) close(); };
  const notice = error && <Alert variant="destructive"><CircleAlertIcon /><AlertDescription>{error}</AlertDescription></Alert>;
  if (deleting) return <AlertDialog open onOpenChange={closeOnDismiss}>
    <AlertDialogContent initialFocus={cancelRef}>
      <AlertDialogHeader>
        <AlertDialogTitle>Delete {action.bot.name}?</AlertDialogTitle>
        <AlertDialogDescription>The daemon will permanently delete this Bot and its Conversation.</AlertDialogDescription>
      </AlertDialogHeader>
      {notice}
      <AlertDialogFooter>
        <Button ref={cancelRef} variant="outline" onClick={close} disabled={busy}>Cancel</Button>
        <Button variant="destructive" disabled={busy} onClick={() => void save()}>
          {busy ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />} Delete Bot permanently
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;

  return <Dialog open onOpenChange={closeOnDismiss}>
    <DialogContent showCloseButton={!busy}>
      <DialogHeader>
        <DialogTitle>{action.kind === "create" ? "New Bot" : "Rename Bot"}</DialogTitle>
        <DialogDescription>{action.kind === "create" ? "Choose a name for your assistant." : "Change how this Bot appears in the sidebar."}</DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void save(); }}>
        {notice}
        <FieldGroup><Field data-disabled={busy}>
          <FieldLabel htmlFor="bot-name">Bot name</FieldLabel>
          <Input id="bot-name" value={name} onChange={event => setName(event.target.value)} required disabled={busy} />
        </Field></FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>Cancel</Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy && <Spinner data-icon="inline-start" />}{action.kind === "create" ? "Create Bot" : "Save name"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
