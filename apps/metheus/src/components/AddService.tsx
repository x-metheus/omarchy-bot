import { useState } from "react";
import { BotIcon, CircleAlertIcon, LinkIcon, MonitorIcon, RefreshCwIcon, ServerIcon } from "@/components/icons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import type { LocalDaemonController } from "../lib/localDaemon.ts";
import { connectionState, pairService } from "../lib/pairing.ts";

export function AddService({ local }: { local: LocalDaemonController }) {
  const connection = connectionState();
  const [serviceUrl, setServiceUrl] = useState(connection.serviceUrl);
  const [code, setCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [launchError, setLaunchError] = useState("");
  const pending = connection.pending || local.pairing;

  async function changeAutostart(enabled: boolean) {
    setSaving(true);
    setLaunchError("");
    try { await local.setAutostart(enabled); }
    catch { setLaunchError("Could not save the local daemon launch preference."); }
    finally { setSaving(false); }
  }

  return <main className="h-dvh overflow-y-auto bg-muted/35">
    <div className="mx-auto flex min-h-full max-w-2xl flex-col justify-center gap-7 px-4 py-10 sm:px-8">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-3 text-sm font-semibold">
          <div className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground">
            <BotIcon className="size-5" aria-hidden="true" />
          </div>
          Metheus
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">Connect to an Agent Daemon</h1>
      </header>
      {connection.message && <Alert variant="destructive"><CircleAlertIcon /><AlertDescription>{connection.message}</AlertDescription></Alert>}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><MonitorIcon className="size-4" aria-hidden="true" /> Local daemon</CardTitle>
          <CardDescription role="status">{local.checking ? "Checking this computer…" : local.ready ? "Ready to pair" : "Local daemon unavailable"}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {(local.error || launchError) && <Alert variant="destructive"><CircleAlertIcon /><AlertDescription>{launchError || local.error}</AlertDescription></Alert>}
          <Field orientation="horizontal" data-disabled={saving}>
            <FieldLabel htmlFor="pair-autostart" className="flex-1">Start the local daemon on launch</FieldLabel>
            <Switch id="pair-autostart" checked={local.autostart} onCheckedChange={enabled => void changeAutostart(enabled)} disabled={saving} />
          </Field>
          <div className="flex flex-wrap gap-2">
            {local.ready && <Button disabled={pending || local.checking} onClick={() => void local.pairLocal()}>
              {local.pairing ? <Spinner data-icon="inline-start" /> : <LinkIcon data-icon="inline-start" />} Pair local daemon
            </Button>}
            <Button variant="outline" disabled={local.checking || pending} onClick={() => void local.check()}>
              {local.checking ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />} Check local daemon
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ServerIcon className="size-4" aria-hidden="true" /> Remote daemon</CardTitle>
          <CardDescription>Use the address and pairing code from your Agent Daemon.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={event => { event.preventDefault(); void pairService({ serviceUrl, code }); }}>
            <FieldGroup>
              <Field data-disabled={pending}>
                <FieldLabel htmlFor="daemon-address">Daemon address</FieldLabel>
                <Input id="daemon-address" type="url" placeholder="https://daemon.example.com" value={serviceUrl} onChange={event => setServiceUrl(event.target.value)} required disabled={pending} />
              </Field>
              <Field data-disabled={pending}>
                <FieldLabel htmlFor="pairing-code">Pairing code</FieldLabel>
                <Input id="pairing-code" autoComplete="off" value={code} onChange={event => setCode(event.target.value)} required disabled={pending} />
              </Field>
              <Button type="submit" variant="outline" className="self-start" disabled={pending}>
                {connection.pending && !local.pairing ? <Spinner data-icon="inline-start" /> : <LinkIcon data-icon="inline-start" />} Pair remote daemon
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  </main>;
}
