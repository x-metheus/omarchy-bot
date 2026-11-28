import { useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Divider } from "@astryxdesign/core/Divider";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { Layout, LayoutContent, LayoutHeader } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { agentDaemon, DaemonError, type AgentSettings, type Provider } from "../../lib/agentDaemon.ts";
import { CustomProviders } from "./CustomProviders.tsx";

export interface LaunchPreference {
  enabled: boolean;
  setEnabled?: (enabled: boolean) => Promise<void>;
}

export function AgentDaemonSettings({ baseUrl, launch }: { baseUrl: string; launch: LaunchPreference }) {
  const settings = useQuery({ queryKey: ["agent-settings", baseUrl], queryFn: agentDaemon.settings });
  const [launchError, setLaunchError] = useState("");
  const active = settings.data?.active;
  return (
    <Layout height="fill" contentWidth={640} header={<LayoutHeader hasDivider><Heading level={1}>Settings</Heading></LayoutHeader>}>
      <LayoutContent padding={4}>
        <VStack gap={4}>
          <VStack as="section" gap={2}>
            <Heading level={2}>General</Heading>
            {launch.setEnabled && <CheckboxInput label="Start the local daemon when opening Omarchy Bot" value={launch.enabled}
              changeAction={async enabled => {
                setLaunchError("");
                try { await launch.setEnabled?.(enabled); }
                catch { setLaunchError("Could not save the local daemon launch preference."); }
              }} onChange={() => {}} />}
            {launchError && <Banner status="error" title={launchError} />}
          </VStack>
          <Divider />
          <VStack as="section" gap={3}>
            <Heading level={2}>Providers</Heading>
            <VStack gap={1}>
              <Text color="secondary" wordBreak="break-word">Connected daemon: {baseUrl}</Text>
              {active && <>
                <Text color="secondary">Current provider: {providerLabels[active.provider]}</Text>
                <Text color="secondary" wordBreak="break-word">Current model: {active.model}</Text>
              </>}
              {settings.data && !active && <Text color="secondary">No model configured.</Text>}
            </VStack>
            {settings.isPending && <Text>Loading daemon Settings…</Text>}
            {settings.isError && <>
              <Banner status="error" title="Could not read daemon Settings." />
              <Button label="Try again" clickAction={async () => { await settings.refetch(); }} />
            </>}
            {settings.data && <>
              <CustomProviders baseUrl={baseUrl} writable={settings.data.writable} />
              <Divider />
              <Heading level={3}>Built-in providers</Heading>
              <ModelForm initial={settings.data} baseUrl={baseUrl} />
            </>}
          </VStack>
        </VStack>
      </LayoutContent>
    </Layout>
  );
}

const providers = [{ label: "OpenAI", value: "openai" }, { label: "Anthropic", value: "anthropic" }];
const providerLabels = { openai: "OpenAI", anthropic: "Anthropic", custom: "Custom OpenAI-compatible" };

function ModelForm({ initial, baseUrl }: { initial: AgentSettings; baseUrl: string }) {
  const queryClient = useQueryClient();
  const active = initial.active?.provider === "custom" ? null : initial.active;
  const [provider, setProvider] = useState<Provider>(active?.provider === "anthropic" ? "anthropic" : "openai");
  const [model, setModel] = useState(active?.model ?? "");
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
      void queryClient.invalidateQueries({ queryKey: ["provider-configurations", baseUrl] });
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
