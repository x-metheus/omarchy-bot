import { expect, test } from "bun:test";
import { buildSystemPrompt } from "./prompt.ts";

const input = {
  botName: "Release Bot",
  instructions: "Publish release notes.",
  workspaceDir: "/workspace",
  privateDir: "/workspace/bots/bot_1",
  allowedFolders: ["/workspace", "/downloads"],
  skills: [{ name: "Releases", description: "How to publish a release", path: ".agents/skills/releases/SKILL.md" }],
};

test("buildSystemPrompt renders the five app sections in order", () => {
  const prompt = buildSystemPrompt(input);
  expect(prompt.match(/^## .+$/gm)).toEqual([
    "## Base Prompt", "## Identity and Job", "## Workspace and private folder", "## Allowed folders", "## Skills",
  ]);
  expect(prompt).toContain("Release Bot");
  expect(prompt).toContain("Publish release notes.");
  expect(prompt).toContain("/workspace/bots/bot_1");
  expect(prompt).toContain("## Allowed folders\n- /workspace\n- /downloads");
  expect(prompt).toContain("Releases");
  expect(prompt).toContain("How to publish a release");
  expect(prompt).toContain(".agents/skills/releases/SKILL.md");
  expect(prompt).not.toContain("Workspace AGENTS sentinel");
});

test("buildSystemPrompt identifies the Bot when the Job is empty", () => {
  const prompt = buildSystemPrompt({ ...input, instructions: " \n", skills: [] });
  expect(prompt).toContain("## Identity and Job\nName: Release Bot\nNo Job is configured.");
  expect(prompt).toContain("## Skills\nNo workspace Skills found.");
});
