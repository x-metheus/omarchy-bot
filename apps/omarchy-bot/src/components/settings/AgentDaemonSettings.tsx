import { useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { Layout, LayoutContent, LayoutHeader } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useQuery } from "@tanstack/react-query";
import { agentDaemon } from "../../lib/agentDaemon.ts";
import { ProviderSettings } from "./ProviderSettings.tsx";

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
              {active && <>
                <Text color="secondary" wordBreak="break-word">Current provider: {active.name ?? providerLabels[active.provider]}</Text>
                <Text color="secondary" wordBreak="break-word">Current model: {active.model}</Text>
              </>}
              {settings.data && !active && <Text color="secondary">No model configured.</Text>}
            </VStack>
            {settings.isPending && <Text>Loading daemon Settings…</Text>}
            {settings.isError && <>
              <Banner status="error" title="Could not read daemon Settings." />
              <Button label="Try again" clickAction={async () => { await settings.refetch(); }} />
            </>}
            {settings.data && <ProviderSettings baseUrl={baseUrl} settings={settings.data} />}
          </VStack>
        </VStack>
      </LayoutContent>
    </Layout>
  );
}

const providerLabels = { openai: "OpenAI", anthropic: "Anthropic", custom: "Custom OpenAI-compatible" };
