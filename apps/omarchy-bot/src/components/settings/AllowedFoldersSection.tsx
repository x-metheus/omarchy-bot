import { useRef, useState, type FormEvent, type JSX } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import * as stylex from "@stylexjs/stylex";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAbsoluteFolderPath, removableAllowedFolders } from "../../lib/allowedFolderPath.ts";
import { api, apiErrorMessage } from "../../lib/api.ts";
import { getShell } from "../../lib/shell.ts";

const styles = stylex.create({ root: { overflowWrap: "anywhere" } });

export function AllowedFoldersSection(): JSX.Element {
  const queryClient = useQueryClient();
  const queryKey = ["allowed-folders", getShell().service.baseUrl()];
  const folders = useQuery({ queryKey, queryFn: () => api.allowedFolders(), retry: false });
  const [folderPath, setFolderPath] = useState("");
  const [invalid, setInvalid] = useState(false);
  const pathRef = useRef<HTMLInputElement>(null);
  const change = useMutation({
    mutationFn: ({ action, folder }: { action: "add" | "remove"; folder: string }) =>
      action === "add" ? api.addAllowedFolder(folder) : api.removeAllowedFolder(folder),
    onSuccess: async (_, { action }) => {
      if (action === "add") setFolderPath("");
      await queryClient.invalidateQueries({ queryKey });
    },
  });
  const add = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (change.isPending) return;
    change.reset();
    if (!isAbsoluteFolderPath(folderPath)) {
      setInvalid(true);
      pathRef.current?.focus();
      return;
    }
    change.mutate({ action: "add", folder: folderPath });
  };
  const data = folders.data;
  const removableFolders = data ? removableAllowedFolders(data) : [];

  return (
    <VStack as="section" aria-label="Allowed folders" gap={3} xstyle={styles.root} data-testid="settings-allowed-folders">
      <Heading level={3}>Allowed folders</Heading>
      {folders.isPending ? (
        <EmptyState icon={<Icon icon="clock" size="lg" />} title="Loading allowed folders" headingLevel={4} isCompact />
      ) : null}
      {folders.isError ? (
        <VStack gap={2}>
          <Banner role="alert" status="error" title="Allowed folders couldn’t load" description={apiErrorMessage(folders.error, "The Service is unavailable.")} />
          <Button label="Retry" variant="secondary" onClick={() => void folders.refetch()} />
        </VStack>
      ) : null}
      {data ? (
        <>
          <VStack gap={0.5}>
            <Text color="secondary">
              {data.alwaysAllowed.length > 1
                ? "Shared Workspace and Downloads are always allowed."
                : "Shared Workspace is always allowed. Downloads is allowed when configured on the Service."}
            </Text>
            {data.alwaysAllowed.map((folder) => <Text key={folder} color="secondary">{folder}</Text>)}
          </VStack>
          {change.isError ? (
            <Banner role="alert" status="error" title={change.variables?.action === "add" ? "Folder could not be added" : "Folder could not be removed"} description={apiErrorMessage(change.error, "Try again.")} />
          ) : null}
          <form onSubmit={add} noValidate>
            <VStack gap={2}>
              <TextInput
                ref={pathRef}
                label="Folder path"
                value={folderPath}
                onChange={(value) => {
                  setFolderPath(value);
                  setInvalid(false);
                }}
                placeholder="/path/to/folder"
                width="100%"
                isRequired
                isDisabled={change.isPending}
                {...(invalid ? { status: { type: "error" as const, message: "Enter an absolute folder path." } } : {})}
              />
              <HStack>
                <Button label="Add" type="submit" variant="primary" isDisabled={change.isPending} isLoading={change.isPending && change.variables.action === "add"} />
              </HStack>
            </VStack>
          </form>
          {removableFolders.length === 0 ? (
            <EmptyState title="No additional folders" description="Add an absolute folder path to allow access." headingLevel={4} isCompact />
          ) : (
            <List aria-label="Additional allowed folders" hasDividers>
              {removableFolders.map((folder) => (
                <ListItem
                  key={folder}
                  label={<Text>{folder}</Text>}
                  data-testid="settings-allowed-folder"
                  endContent={
                    <Button
                      label={`Remove ${folder}`}
                      size="sm"
                      variant="ghost"
                      isDisabled={change.isPending}
                      isLoading={change.isPending && change.variables.action === "remove" && change.variables.folder === folder}
                      onClick={() => change.mutate({ action: "remove", folder })}
                    >
                      Remove
                    </Button>
                  }
                />
              ))}
            </List>
          )}
        </>
      ) : null}
    </VStack>
  );
}
