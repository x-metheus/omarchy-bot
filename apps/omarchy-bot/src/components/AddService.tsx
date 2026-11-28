import { useState, type JSX, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { VStack } from "@astryxdesign/core/VStack";
import { TextInput } from "@astryxdesign/core/TextInput";
import { connectionState, pairService } from "../lib/pairing.ts";

export function AddService({ agentControls }: { agentControls: ReactNode }): JSX.Element {
  const connection = connectionState();
  const [serviceUrl, setServiceUrl] = useState(connection.serviceUrl);
  const [code, setCode] = useState("");
  return (
    <Layout contentWidth={640} padding={6}>
      <LayoutContent>
        <form onSubmit={event => { event.preventDefault(); void pairService({ serviceUrl, code }); }}>
          <VStack gap={6}>
            <Heading level={1}>Connect to an Agent Daemon</Heading>
            {connection.message === undefined ? null : <Banner status="error" title={connection.message} />}
            <FormLayout>
              <TextInput label="Daemon address" value={serviceUrl} onChange={setServiceUrl} isRequired isDisabled={connection.pending} width="100%" />
              <TextInput label="Pairing code" value={code} onChange={setCode} isRequired isDisabled={connection.pending} width="100%" />
            </FormLayout>
            <Button label="Pair" variant="primary" type="submit" isLoading={connection.pending} />
          </VStack>
        </form>
        <VStack gap={2} paddingBlock={4}>{agentControls}</VStack>
      </LayoutContent>
    </Layout>
  );
}
