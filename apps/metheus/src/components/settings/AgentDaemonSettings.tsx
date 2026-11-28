import { useState } from "react";
import { CircleAlertIcon, MonitorIcon, MoonIcon, SunIcon } from "@/components/icons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { isColorMode, useAppearance } from "../../lib/appearance.tsx";
import type { LocalDaemonController } from "../../lib/localDaemon.ts";
import { ProviderSettings } from "./ProviderSettings.tsx";

export function AgentDaemonSettings({ baseUrl, local }: { baseUrl: string; local: LocalDaemonController }) {
  const [launchError, setLaunchError] = useState("");
  const [saving, setSaving] = useState(false);
  const { mode, setMode } = useAppearance();

  async function changeAutostart(enabled: boolean) {
    setLaunchError("");
    setSaving(true);
    try { await local.setAutostart(enabled); }
    catch { setLaunchError("Could not save the local daemon launch preference."); }
    finally { setSaving(false); }
  }

  return <div className="min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto flex max-w-3xl flex-col gap-7 px-4 py-6 sm:px-8">
      <section aria-labelledby="settings-general" className="flex flex-col gap-4">
        <h2 id="settings-general" className="text-lg font-semibold tracking-tight">General</h2>
        <FieldGroup>
          <Field orientation="responsive" data-disabled={saving}>
            <FieldLabel htmlFor="autostart" className="flex-1">Start the local daemon on launch</FieldLabel>
            <Switch id="autostart" checked={local.autostart} disabled={saving} onCheckedChange={enabled => void changeAutostart(enabled)} />
          </Field>
          {launchError && <Alert variant="destructive" role="alert"><CircleAlertIcon /><AlertDescription>{launchError}</AlertDescription></Alert>}
          <Field orientation="responsive">
            <FieldLabel id="appearance-label" className="flex-1">Appearance</FieldLabel>
            <ToggleGroup aria-labelledby="appearance-label" size="sm" variant="outline" spacing={0} value={[mode]} onValueChange={([value]) => {
              if (isColorMode(value)) setMode(value);
            }}>
              <ToggleGroupItem value="system"><MonitorIcon data-icon="inline-start" /> System</ToggleGroupItem>
              <ToggleGroupItem value="light"><SunIcon data-icon="inline-start" /> Light</ToggleGroupItem>
              <ToggleGroupItem value="dark"><MoonIcon data-icon="inline-start" /> Dark</ToggleGroupItem>
            </ToggleGroup>
          </Field>
        </FieldGroup>
      </section>
      <Separator />
      <ProviderSettings baseUrl={baseUrl} />
    </div>
  </div>;
}
