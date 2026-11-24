import type { WorkspaceSkill } from "./skills.ts";

export function buildSystemPrompt({ botName, instructions, workspaceDir, privateDir, allowedFolders, skills }: {
  botName: string;
  instructions: string;
  workspaceDir: string;
  privateDir: string;
  allowedFolders: readonly string[];
  skills: readonly WorkspaceSkill[];
}): string {
  const job = instructions.trim() ? `Job: ${instructions}` : "No Job is configured.";
  const skillList = skills.map(({ name, description, path }) => `- ${name}: ${description} (${path})`);
  return [
    "## Base Prompt\nYou are a Bot in Omarchy Bot. Help the user with their requests. Be clear about what you did and what you could not complete.",
    `## Identity and Job\nName: ${botName}\n${job}`,
    `## Workspace and private folder\nThe Shared Workspace is ${workspaceDir}. Keep work files and drafts there. Use ${privateDir} only for your own notes. Respect other Bots' private folders.`,
    ["## Allowed folders", ...allowedFolders.map((folder) => `- ${folder}`)].join("\n"),
    ["## Skills", ...(skillList.length > 0 ? skillList : ["No workspace Skills found."])].join("\n"),
  ].join("\n\n");
}
