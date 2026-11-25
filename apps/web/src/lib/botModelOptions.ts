import type { ProviderDto } from "@omarchy-bot/protocol";

export function buildBotModelOptions(providers: readonly Pick<ProviderDto, "id" | "name" | "models">[], currentModel: string | null) {
  const options = new Map([["", { id: "", label: "Service default" }]]);
  const providerIdsByName = new Map<string, Set<string>>();
  for (const provider of providers) {
    if (provider.models.length === 0) continue;
    const ids = providerIdsByName.get(provider.name) ?? new Set<string>();
    ids.add(provider.id);
    providerIdsByName.set(provider.name, ids);
  }

  for (const provider of providers) {
    const providerLabel = (providerIdsByName.get(provider.name)?.size ?? 0) > 1
      ? `${provider.name} (${provider.id})`
      : provider.name;
    for (const model of provider.models) {
      const id = `${provider.id}/${model.id}`;
      if (options.has(id)) continue;
      const modelLabel = model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id;
      options.set(id, { id, label: `${providerLabel} — ${modelLabel}` });
    }
  }

  if (currentModel && !options.has(currentModel)) options.set(currentModel, { id: currentModel, label: currentModel });
  return [...options.values()];
}

export function toBotModelOverride(value: string): string | null {
  return value || null;
}
