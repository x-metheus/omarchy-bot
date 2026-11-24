import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listWorkspaceSkills } from "./skills.ts";

function writeSkill(workspace: string, folder: string, content: string): void {
  const directory = path.join(workspace, folder);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "SKILL.md"), content);
}

test("listWorkspaceSkills reads only valid workspace frontmatter and sorts by name", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "bot-skills-"));
  try {
    writeSkill(workspace, ".agents/skills/first-folder", "---\nname: Zeta\ndescription: \"Last: by name\"\nversion: 1\n---\nDiscard this body");
    writeSkill(workspace, ".agents/skills/last-folder", "\uFEFF---\r\n# Comment\r\ndescription: 'Read: labels #1'\r\nname: \"Alpha\"\r\n---\r\nBody");
    writeSkill(workspace, ".agents/skills/folded", "---\nname: Folded\ndescription: >-\n  First line\n  and second line.\n---\nBody");
    writeSkill(workspace, ".agents/skills/folded-default", "---\nname: Folded default\ndescription: >\n  Keep the whole\n  description.\n---\nBody");
    writeSkill(workspace, ".agents/skills/large-body", `---\nname: Large body\ndescription: Small header\n---\n${"body\n".repeat(20_000)}`);
    writeSkill(workspace, ".agents/skills/no-name", "---\ndescription: Missing name\n---\n");
    writeSkill(workspace, ".agents/skills/no-description", "---\nname: Missing description\n---\n");
    writeSkill(workspace, ".agents/skills/blank-description", "---\nname: Blank description\ndescription: '  '\n---\n");
    writeSkill(workspace, ".agents/skills/no-frontmatter", "name: Missing fence\ndescription: No header\n");
    writeSkill(workspace, ".agents/skills/no-closing-fence", "---\nname: Unclosed\ndescription: No closing fence\n");
    writeSkill(workspace, ".pi/skills/pi", "---\nname: Pi skill\ndescription: Ignore Pi\n---\n");
    writeSkill(workspace, ".claude/skills/claude", "---\nname: Claude skill\ndescription: Ignore Claude\n---\n");
    symlinkSync(path.join(workspace, ".pi/skills/pi"), path.join(workspace, ".agents/skills/linked"));
    const linkedFileDir = path.join(workspace, ".agents/skills/linked-file");
    mkdirSync(linkedFileDir);
    symlinkSync(path.join(workspace, ".claude/skills/claude/SKILL.md"), path.join(linkedFileDir, "SKILL.md"));

    expect(listWorkspaceSkills(workspace)).toEqual([
      { name: "Alpha", description: "Read: labels #1", path: ".agents/skills/last-folder/SKILL.md" },
      { name: "Folded", description: "First line and second line.", path: ".agents/skills/folded/SKILL.md" },
      { name: "Folded default", description: "Keep the whole description.", path: ".agents/skills/folded-default/SKILL.md" },
      { name: "Large body", description: "Small header", path: ".agents/skills/large-body/SKILL.md" },
      { name: "Zeta", description: "Last: by name", path: ".agents/skills/first-folder/SKILL.md" },
    ]);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("listWorkspaceSkills reads a frontmatter fence beyond the first chunk", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "bot-skills-"));
  try {
    writeSkill(workspace, ".agents/skills/large-header", `---\nname: Large header\ndescription: Short metadata\n# ${"x".repeat(70_000)}\n---\nBody`);
    writeSkill(workspace, ".agents/skills/oversized-header", `---\nname: Oversized header\ndescription: Outside the read cap\n# ${"x".repeat(1024 * 1024)}\n---\n`);
    expect(listWorkspaceSkills(workspace)).toEqual([
      { name: "Large header", description: "Short metadata", path: ".agents/skills/large-header/SKILL.md" },
    ]);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("listWorkspaceSkills discovers a root Skill without listing its examples", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "bot-skills-"));
  try {
    writeSkill(workspace, ".agents/skills", "---\nname: Root Skill\ndescription: At the Skills root\n---\n");
    writeSkill(workspace, ".agents/skills/examples/child", "---\nname: Example\ndescription: Part of the root Skill\n---\n");
    expect(listWorkspaceSkills(workspace)).toEqual([
      { name: "Root Skill", description: "At the Skills root", path: ".agents/skills/SKILL.md" },
    ]);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("listWorkspaceSkills discovers nested Skills and stops walking inside a Skill", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "bot-skills-"));
  try {
    writeSkill(workspace, ".agents/skills/group/subgroup/skill", "---\nname: Nested\ndescription: A nested Skill\n---\n");
    writeSkill(workspace, ".agents/skills/group/subgroup/skill/examples/child", "---\nname: Example\ndescription: Part of a Skill\n---\n");
    writeSkill(workspace, ".agents/skills/group/invalid", "No frontmatter");
    writeSkill(workspace, ".agents/skills/group/invalid/child", "---\nname: Child\ndescription: Part of a Skill\n---\n");
    symlinkSync(path.join(workspace, ".agents/skills/group/subgroup"), path.join(workspace, ".agents/skills/group/link"));
    expect(listWorkspaceSkills(workspace)).toEqual([
      { name: "Nested", description: "A nested Skill", path: ".agents/skills/group/subgroup/skill/SKILL.md" },
    ]);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("listWorkspaceSkills returns every Skill and its full description", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "bot-skills-"));
  try {
    expect(listWorkspaceSkills(workspace)).toEqual([]);
    for (let index = 200; index >= 0; index--) {
      const name = `skill-${String(index).padStart(3, "0")}`;
      writeSkill(workspace, `.agents/skills/${name}`, `---\nname: ${name}\ndescription: ${"x".repeat(501)}\n---\n`);
    }
    const skills = listWorkspaceSkills(workspace);
    expect(skills).toHaveLength(201);
    expect(skills.at(0)?.name).toBe("skill-000");
    expect(skills.at(-1)?.name).toBe("skill-200");
    expect(skills.every(({ description }) => description === "x".repeat(501))).toBe(true);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});
