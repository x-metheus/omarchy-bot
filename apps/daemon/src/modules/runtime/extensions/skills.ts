import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, type Dirent } from "node:fs";
import path from "node:path";
import { skillFrontmatter } from "../../plugins/skillInstaller.ts";

const SKILLS_PATH = ".agents/skills";
const SKILL_FRONTMATTER_CHUNK_BYTES = 64 * 1024;
const MAX_SKILL_FRONTMATTER_BYTES = 1024 * 1024;

export interface WorkspaceSkill {
  name: string;
  description: string;
  path: string;
}

function readSkill(workspaceDir: string, relativePath: string, buffer: Buffer): WorkspaceSkill | undefined {
  try {
    const file = openSync(path.join(workspaceDir, relativePath), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(file);
      if (!stat.isFile() || (stat.mode & 0o444) === 0) return;

      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunkSize = Math.min(SKILL_FRONTMATTER_CHUNK_BYTES, buffer.length - bytesRead);
        const count = readSync(file, buffer, bytesRead, chunkSize, null);
        bytesRead += count;
        const atEnd = count === 0 || bytesRead === stat.size;
        const contents = buffer.toString("utf8", 0, bytesRead);
        const fence = (atEnd ? /\n---(?:\r?\n|$)/ : /\n---\r?\n/).exec(contents);
        if (fence) {
          const header = contents.slice(0, fence.index + fence[0].length);
          return { ...skillFrontmatter(header), path: relativePath };
        }
        if (atEnd) return;
      }
    } finally {
      closeSync(file);
    }
  } catch {
    return;
  }
}

function readDirectory(dir: string): Dirent[] {
  try {
    return lstatSync(dir).isDirectory() ? readdirSync(dir, { withFileTypes: true }) : [];
  } catch {
    return [];
  }
}

export function listWorkspaceSkills(workspaceDir: string): WorkspaceSkill[] {
  const skillsDir = path.join(workspaceDir, SKILLS_PATH);
  try {
    if (!lstatSync(path.dirname(skillsDir)).isDirectory()) return [];
  } catch {
    return [];
  }

  const pending = [SKILLS_PATH];
  const skills: WorkspaceSkill[] = [];
  const buffer = Buffer.alloc(MAX_SKILL_FRONTMATTER_BYTES);
  for (let folder = pending.pop(); folder !== undefined; folder = pending.pop()) {
    const entries = readDirectory(path.join(workspaceDir, folder));
    if (entries.some((entry) => entry.name === "SKILL.md" && entry.isFile())) {
      const skill = readSkill(workspaceDir, path.posix.join(folder, "SKILL.md"), buffer);
      if (skill) skills.push(skill);
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push(path.posix.join(folder, entry.name));
    }
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
}
