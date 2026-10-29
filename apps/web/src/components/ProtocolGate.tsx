import type { JSX, ReactNode } from "react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { PROTOCOL_VERSION } from "@omarchy-bot/protocol";
import { isSupportedServiceProtocol, serviceHealthQuery } from "../lib/api.ts";
import { getShell } from "../lib/shell.ts";

export function ProtocolGate({ children }: { children: ReactNode }): JSX.Element {
  const health = useQuery(serviceHealthQuery());
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string>();

  async function updateApp(): Promise<void> {
    setUpdating(true);
    setUpdateError(undefined);
    try {
      const updates = getShell().updates;
      if (!(await updates.check()).available) {
        setUpdateError("No update is available right now.");
        return;
      }
      await updates.download();
      await updates.restart();
    } catch {
      setUpdateError("Omarchy Bot could not update. Try again.");
    } finally {
      setUpdating(false);
    }
  }

  const certificateError = health.error instanceof Error && health.error.name === "TlsCertificateError";
  if (health.isError || health.data === undefined) {
    return health.isError
      ? <Banner status="error" title={certificateError ? "Service TLS certificate is not trusted" : "Cannot connect to the Service"} description={certificateError ? health.error.message : "Check the Service is running and try again."} container="section"
          endContent={<Button label="Try again" isLoading={health.isFetching} onClick={() => void health.refetch()} />} />
      : <Text>Connecting to the Service…</Text>;
  }
  const protocol = health.data.protocol;
  if (isSupportedServiceProtocol(protocol)) {
    return <>{children}</>;
  }
  const appBehind = typeof protocol === "number" && Number.isInteger(protocol) && protocol > PROTOCOL_VERSION;
  return (
    <VStack padding={6} gap={4}>
      <Heading level={1}>{appBehind ? "Update Omarchy Bot" : "Update the Service"}</Heading>
      <Text>{appBehind
        ? "This Service requires a newer Omarchy Bot. Update the app to connect."
        : "This Service is too old for Omarchy Bot. Update the Service on its Linux host, then reconnect."}</Text>
      {appBehind ? <Button label="Update Omarchy Bot" variant="primary" isLoading={updating} onClick={() => void updateApp()} /> : null}
      {updateError === undefined ? null : <Banner status="error" title="Update unavailable" description={updateError} container="section" />}
    </VStack>
  );
}
