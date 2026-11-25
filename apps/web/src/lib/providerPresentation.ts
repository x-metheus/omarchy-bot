import type { ProviderDto } from "@omarchy-bot/protocol";

export const providerProtocolLabels: Record<ProviderDto["protocol"], string> = {
  "openai-compatible": "OpenAI-compatible",
  "anthropic-messages": "Anthropic Messages",
  "built-in": "Built-in pi-ai",
};

export function parseModelIds(value: string): string[] {
  return [...new Set(value.split(/[,\r\n]/).map((id) => id.trim()).filter(Boolean))];
}

export function providerSummaryLabel({ protocol, models, hasKey }: Pick<ProviderDto, "protocol" | "models" | "hasKey">): string {
  const modelCount = models.length;
  return `${providerProtocolLabels[protocol]} · ${modelCount} ${modelCount === 1 ? "model" : "models"} · ${hasKey ? "Key saved" : "No key saved"}`;
}
