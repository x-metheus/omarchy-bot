import { useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { agentDaemon, DaemonError, type AgentSettings, type Provider } from "../../lib/agentDaemon.ts";

export interface LaunchPreference {
  enabled: boolean;
  setEnabled?: (enabled: boolean) => Promise<void>;
}

export function AgentDaemonSettings({ baseUrl, close, launch }: {
  baseUrl: string;
  close: () => void;
  launch: LaunchPreference;
}) {
  const settings = useQuery({ queryKey: ["agent-settings", baseUrl], queryFn: agentDaemon.settings });
  const [launchError, setLaunchError] = useState("");
  return (
    <Dialog isOpen onOpenChange={open => { if (!open) close(); }} purpose="form" width={520}>
      <DialogHeader title="Settings" onOpenChange={open => { if (!open) close(); }} />
      <VStack gap={4}>
        <Text color="secondary">Connected daemon: {baseUrl}</Text>
        {launch.setEnabled && <CheckboxInput label="Start the local daemon when opening Omarchy Bot" value={launch.enabled}
          changeAction={async enabled => {
            setLaunchError("");
            try { await launch.setEnabled?.(enabled); }
            catch { setLaunchError("Could not save the local daemon launch preference."); }
          }} onChange={() => {}} />}
        {launchError && <Banner status="error" title={launchError} />}
        {settings.isPending && <Text>Loading daemon Settings…</Text>}
        {settings.isError && <>
          <Banner status="error" title="Could not read daemon Settings." />
          <Button label="Try again" clickAction={async () => { await settings.refetch(); }} />
        </>}
        {settings.data && <ModelForm initial={settings.data} baseUrl={baseUrl} />}
      </VStack>
    </Dialog>
  );
}

const providers = [{ label: "OpenAI", value: "openai" }, { label: "Anthropic", value: "anthropic" }];

function ModelForm({ initial, baseUrl }: { initial: AgentSettings; baseUrl: string }) {
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<Provider>(initial.active?.provider ?? "openai");
  const [model, setModel] = useState(initial.active?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ status: "success" | "error"; text: string }>();
  const keyStored = initial.storedCredentials[provider];

  async function save() {
    if (saving || !model.trim() || (!keyStored && !apiKey)) return;
    setSaving(true);
    setFeedback(undefined);
    try {
      const settings = await agentDaemon.saveSettings({ provider, model: model.trim(), ...(apiKey ? { apiKey } : {}) });
      queryClient.setQueryData(["agent-settings", baseUrl], settings);
      setApiKey("");
      setFeedback({ status: "success", text: "Daemon Settings saved." });
    } catch (error) {
      setFeedback({ status: "error", text: error instanceof DaemonError ? error.message : "Could not confirm the Settings update." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <VStack gap={3}>
        {!initial.writable && <Banner status="warning" title="The daemon operator must enable writable Settings." />}
        {feedback && <Banner status={feedback.status} title={feedback.text} />}
        <FormLayout>
          <Selector label="Provider" options={providers} value={provider} isDisabled={!initial.writable || saving}
            onChange={value => {
              if (value !== "openai" && value !== "anthropic") return;
              setProvider(value);
              setModel(initial.active?.provider === value ? initial.active.model : "");
              setApiKey("");
              setFeedback(undefined);
            }} />
          <TextInput label="Model ID" value={model} onChange={setModel} isRequired isDisabled={!initial.writable || saving} />
          <TextInput label={keyStored ? "Replacement API key" : "API key"} type="password" autoComplete="new-password"
            description={keyStored ? "Leave blank to use the stored key." : "The Agent Daemon stores this key."}
            value={apiKey} onChange={setApiKey} isRequired={!keyStored} isDisabled={!initial.writable || saving} />
        </FormLayout>
        <Button label="Save daemon Settings" variant="primary" type="submit" isLoading={saving}
          isDisabled={!initial.writable || !model.trim() || (!keyStored && !apiKey)} />
      </VStack>
    </form>
  );
}
