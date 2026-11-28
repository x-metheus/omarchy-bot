import { useEffect, useMemo, useRef, useState, type FormEvent, type JSX } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Typeahead, type SearchableItem, type SearchSource } from "@astryxdesign/core/Typeahead";
import { VStack } from "@astryxdesign/core/VStack";
import { useQuery } from "@tanstack/react-query";
import { CreateProviderBody, UpdateProviderBody, type ProviderDto } from "@omarchy-bot/protocol";
import { api, apiErrorMessage } from "../../lib/api.ts";
import { parseModelIds, providerProtocolLabels } from "../../lib/providerPresentation.ts";
import { getShell } from "../../lib/shell.ts";

const protocols = Object.keys(providerProtocolLabels) as Array<ProviderDto["protocol"]>;

export function ProviderEditor({ initial, onCancel, onSaved }: {
  initial?: ProviderDto;
  onCancel(): void;
  onSaved(): void;
}): JSX.Element {
  const [protocol, setProtocol] = useState<ProviderDto["protocol"]>(initial?.protocol ?? "openai-compatible");
  const [builtin, setBuiltin] = useState<SearchableItem | null>(null);
  const [name, setName] = useState(initial?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const initialModels = initial?.models.map(({ id }) => id).join("\n") ?? "";
  const [models, setModels] = useState(initialModels);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const protocolListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    protocolListRef.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
  }, []);
  const choosingBuiltin = initial === undefined && protocol === "built-in";
  const catalog = useQuery({
    queryKey: ["builtin-providers", getShell().service.baseUrl()],
    queryFn: () => api.builtinProviders(),
    enabled: choosingBuiltin,
    retry: false,
  });
  const searchSource = useMemo<SearchSource>(() => {
    const options = catalog.data?.map(({ id, name }) => ({ id, label: name })) ?? [];
    return {
      search: (query) => {
        const term = query.trim().toLowerCase();
        return options.filter(({ id, label }) => id.toLowerCase().includes(term) || label.toLowerCase().includes(term));
      },
      bootstrap: () => options,
    };
  }, [catalog.data]);
  const title = initial ? "Edit provider" : "Add provider";

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (saving) return;
    setError(undefined);
    const request = initial ? {
      action: "update" as const,
      id: initial.id,
      body: UpdateProviderBody.safeParse({
        ...(key.trim() ? { key } : {}),
        ...(initial.protocol === "built-in" ? {} : {
          ...(name.trim() !== initial.name ? { name } : {}),
          ...(baseUrl.trim() !== (initial.baseUrl ?? "") ? { baseUrl } : {}),
          ...(models !== initialModels ? { models: parseModelIds(models) } : {}),
        }),
      }),
    } : {
      action: "create" as const,
      body: CreateProviderBody.safeParse(protocol === "built-in"
        ? { protocol, id: builtin?.id ?? "", key }
        : { protocol, name, baseUrl, key, models: parseModelIds(models) }),
    };
    if (!request.body.success) {
      setError(request.body.error.issues[0]?.message ?? "Check the provider fields and try again.");
      return;
    }
    setSaving(true);
    try {
      if (request.action === "update") await api.updateProvider(request.id, request.body.data);
      else await api.createProvider(request.body.data);
      setKey("");
      onSaved();
    } catch (failure) {
      setError(apiErrorMessage(failure, "Provider could not be saved."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form aria-label={title} autoComplete="off" noValidate onSubmit={(event) => void submit(event)}>
      <VStack gap={3}>
        <Heading level={4}>{title}</Heading>
        {error ? <Banner role="alert" status="error" title="Provider could not be saved" description={error} /> : null}
        {initial ? (
          <Text color="secondary">{protocol === "built-in" ? `${initial.name} · ` : ""}{providerProtocolLabels[protocol]}</Text>
        ) : (
          <RadioList ref={protocolListRef} label="Protocol" value={protocol} onChange={(value) => {
            const selected = protocols.find((option) => option === value);
            if (!selected) return;
            setProtocol(selected);
            setKey("");
            setError(undefined);
          }} isDisabled={saving} width="100%">
            {protocols.map((option) => <RadioListItem key={option} value={option} label={providerProtocolLabels[option]} />)}
          </RadioList>
        )}
        {choosingBuiltin ? (
          <VStack gap={2}>
            {catalog.isPending ? (
              <EmptyState icon={<Icon icon="clock" size="lg" />} title="Loading built-in providers" headingLevel={5} isCompact />
            ) : catalog.isError ? (
              <>
                <Banner role="alert" status="error" title="Built-in providers couldn’t load" description={apiErrorMessage(catalog.error, "The Service is unavailable.")} />
                <Button label="Retry" variant="secondary" onClick={() => void catalog.refetch()} />
              </>
            ) : catalog.data.length === 0 ? (
              <EmptyState title="No built-in providers available" headingLevel={5} isCompact />
            ) : (
              <Typeahead
                label="Built-in provider"
                placeholder="Search providers"
                width="100%"
                value={builtin}
                onChange={setBuiltin}
                searchSource={searchSource}
                hasEntriesOnFocus
                isRequired
                isDisabled={saving}
              />
            )}
          </VStack>
        ) : null}
        {protocol !== "built-in" ? (
          <>
            <TextInput label="Name" value={name} onChange={setName} width="100%" isRequired isDisabled={saving} hasAutoFocus={initial !== undefined} />
            <TextInput label="Base URL" value={baseUrl} onChange={setBaseUrl} width="100%" isRequired isDisabled={saving} />
          </>
        ) : null}
        <TextInput
          label="API Key"
          type="password"
          value={key}
          onChange={setKey}
          width="100%"
          isRequired={initial === undefined}
          isOptional={initial !== undefined}
          isDisabled={saving}
          hasAutoFocus={initial?.protocol === "built-in"}
          {...(initial?.hasKey ? { description: "Leave blank to keep the saved key" } : {})}
        />
        {initial ? <Text color="secondary">{initial.hasKey ? "Key saved" : "No key saved"}</Text> : null}
        {protocol !== "built-in" ? (
          <TextArea label="Models" description="Enter model IDs separated by commas or new lines." value={models} onChange={setModels} width="100%" isOptional isDisabled={saving} />
        ) : null}
        <HStack gap={1} wrap="wrap">
          <Button label="Save" type="submit" variant="primary" isLoading={saving} isDisabled={choosingBuiltin && !builtin} />
          <Button label="Cancel" variant="ghost" isDisabled={saving} onClick={onCancel} />
        </HStack>
      </VStack>
    </form>
  );
}
