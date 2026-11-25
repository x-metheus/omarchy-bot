import { useEffect, useRef, useState, type JSX } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Item } from "@astryxdesign/core/Item";
import { List } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import * as stylex from "@stylexjs/stylex";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProviderDto } from "@omarchy-bot/protocol";
import { api, apiErrorMessage } from "../../lib/api.ts";
import { providerSummaryLabel } from "../../lib/providerPresentation.ts";
import { getShell } from "../../lib/shell.ts";
import { ProviderEditor } from "./ProviderEditor.tsx";

const styles = stylex.create({ root: { overflowWrap: "anywhere" } });

export function ProvidersSection(): JSX.Element {
  const queryClient = useQueryClient();
  const queryKey = ["providers", getShell().service.baseUrl()];
  const providers = useQuery({ queryKey, queryFn: () => api.providers(), retry: false });
  const [editing, setEditing] = useState<ProviderDto | "new">();
  const [confirm, setConfirm] = useState<{ provider: ProviderDto; trigger: HTMLButtonElement }>();
  const cancelRemovalRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirm) cancelRemovalRef.current?.focus();
  }, [confirm]);
  const refresh = () => queryClient.invalidateQueries({ queryKey });
  const removal = useMutation({
    mutationFn: (id: string) => api.deleteProvider(id),
    onSuccess: async () => {
      await refresh();
      setConfirm(undefined);
    },
  });
  const rowActionsDisabled = editing !== undefined || confirm !== undefined;

  return (
    <VStack as="section" aria-label="Providers" gap={3} xstyle={styles.root} data-testid="settings-providers">
      <Heading level={3}>Providers</Heading>
      {providers.isPending ? (
        <EmptyState icon={<Icon icon="clock" size="lg" />} title="Loading providers" headingLevel={4} isCompact />
      ) : null}
      {providers.isError ? (
        <VStack gap={2}>
          <Banner role="alert" status="error" title="Providers couldn’t load" description={apiErrorMessage(providers.error, "The Service is unavailable.")} />
          <Button label="Retry" variant="secondary" onClick={() => void providers.refetch()} />
        </VStack>
      ) : null}
      {providers.data ? (
        <>
          {editing !== undefined ? (
            <ProviderEditor
              key={editing === "new" ? "new" : editing.id}
              {...(editing === "new" ? {} : { initial: editing })}
              onCancel={() => setEditing(undefined)}
              onSaved={() => {
                setEditing(undefined);
                void refresh();
              }}
            />
          ) : <Button label="Add provider" variant="primary" isDisabled={confirm !== undefined} onClick={() => setEditing("new")} />}
          {confirm ? (
            <VStack gap={2}>
              <Heading level={4}>Remove {confirm.provider.name}?</Heading>
              <Text>This removes the provider and its saved key.</Text>
              {removal.isError ? (
                <Banner role="alert" status="error" title="Provider could not be removed" description={apiErrorMessage(removal.error, "Try again.")} />
              ) : null}
              <HStack gap={1} wrap="wrap">
                <Button label="Confirm removal" variant="destructive" isLoading={removal.isPending} onClick={() => removal.mutate(confirm.provider.id)} />
                <Button ref={cancelRemovalRef} label="Cancel" variant="ghost" isDisabled={removal.isPending} onClick={() => {
                  removal.reset();
                  setConfirm(undefined);
                  requestAnimationFrame(() => confirm.trigger.focus());
                }} />
              </HStack>
            </VStack>
          ) : null}
          {providers.data.length > 0 ? (
            <List aria-label="Saved providers">
              {providers.data.map((provider) => (
                <VStack as="li" key={provider.id} gap={1} paddingBlockEnd={1} data-testid={`settings-provider-${provider.id}`}>
                  <Item
                    label={provider.name}
                    labelLines={2}
                    description={
                      <>
                        <Text color="secondary" display="block">{providerSummaryLabel(provider)}</Text>
                        {provider.protocol !== "built-in" && provider.baseUrl ? (
                          <Text color="secondary" display="block">{provider.baseUrl}</Text>
                        ) : null}
                      </>
                    }
                  />
                  <HStack gap={1} wrap="wrap" justify="end">
                    <Button label={`Edit ${provider.name}`} size="sm" variant="secondary" isDisabled={rowActionsDisabled} onClick={() => setEditing(provider)}>Edit</Button>
                    <Button label={`Remove ${provider.name}`} size="sm" variant="ghost" isDisabled={rowActionsDisabled} onClick={(event) => setConfirm({ provider, trigger: event.currentTarget })}>Remove</Button>
                  </HStack>
                </VStack>
              ))}
            </List>
          ) : editing === undefined ? (
            <EmptyState title="No providers" description="Add a provider to make its models available." headingLevel={4} isCompact />
          ) : null}
        </>
      ) : null}
    </VStack>
  );
}
