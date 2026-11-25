import { validateToolArguments } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ConversationId, type JsonObject } from "@earendil-works/pi-durable";
import type { SecretStore } from "../secrets.ts";

export interface BotSecretAccess {
  store: SecretStore;
  botId(conversationId: ConversationId): string | undefined;
}

function textResult(text: string, isError = false) {
  return { isError, output: [{ type: "text" as const, text }] };
}

const fileStorageWarning = "Warning — No OS keychain is available. This secret is stored in a private plaintext file readable by your user, including commands run by a Bot.";

const secretsTool = {
  name: "secrets",
  description: "Manage this Bot's secrets. Save takes a name, short description, and value. List returns names and descriptions. Delete takes a name. A value supplied to save is part of the conversation history. Use saved secrets in bash as {{secret:name}}.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["save", "list", "delete"] },
      name: { type: "string", pattern: "^[a-z0-9_-]{1,64}$" },
      description: { type: "string" },
      value: { type: "string" },
    },
    required: ["action"],
    additionalProperties: false,
  },
};

export function createSecretsExtension(access: BotSecretAccess) {
  return defineExtension({
    name: "omarchy-secrets",
    tools: [defineTool({
      ...secretsTool,
      prepareArguments(args) {
        // The Harness persists validation errors, and the default error includes the supplied arguments.
        try {
          return validateToolArguments(secretsTool, {
            type: "toolCall", id: "", name: secretsTool.name, arguments: args as JsonObject,
          });
        } catch {
          throw new Error("Invalid secrets arguments.");
        }
      },
      async execute(args, api) {
        const { action, name, description, value } = args as { action: string; name?: string; description?: string; value?: string };
        const botId = access.botId(api.conversationId);
        if (!botId) return textResult("Secrets are only available to Bot conversations.", true);
        const scope = access.store.forBot(botId);
        try {
          switch (action) {
            case "save": {
              if (!name || description === undefined || !value) return textResult("Saving a secret requires a name, description, and value.", true);
              await scope.save(name, description, value);
              const metadata = JSON.stringify({ name, description });
              return textResult(access.store.kind === "file" ? `${metadata}\n${fileStorageWarning}` : metadata);
            }
            case "list":
              return textResult(JSON.stringify(await scope.list()));
            case "delete":
              if (!name) return textResult("Deleting a secret requires a name.", true);
              await scope.delete(name);
              return textResult("Secret deleted.");
            default:
              return textResult("Unknown secrets action.", true);
          }
        } catch {
          return textResult("Unable to complete the secrets operation.", true);
        }
      },
    })],
  });
}
