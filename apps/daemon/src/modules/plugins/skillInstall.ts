import { rm } from "node:fs/promises";
import path from "node:path";
import { redactToolErrorSummary } from "@omarchy-bot/agent-contract";
import type { CatalogSkillDetailDto, InstalledSkillDto, InstallSkillBody } from "@omarchy-bot/protocol";
import { HttpError } from "../bots/bots.ts";
import { materializeSkill, materializeSkillSource } from "./skillInstaller.ts";
import type { NativeSkills } from "./nativeSkills.ts";

export interface SkillHost {
  rootDir: string;
  skills: NativeSkills;
  stopping(): boolean;
  detail(id: string): Promise<CatalogSkillDetailDto>;
  persist(changed?: boolean): void;
  clearNative(): void;
  legacyDirectories(): string[];
  accounts(): { id: string; providerId: string; enabledServices: string[] }[];
  updateService(id: string, serviceId: string): Promise<void>;
}

/** Independent Skill install, enable, remove, and update. Service bundles stay on the host. */
export class SkillInstalls {
  #installing = new Map<string, Promise<InstalledSkillDto>>();
  #update: Promise<void> | undefined;

  constructor(private readonly host: SkillHost) {}

  pending(): Iterable<Promise<InstalledSkillDto>> {
    return this.#installing.values();
  }

  install(input: string | InstallSkillBody): Promise<InstalledSkillDto> {
    if (typeof input !== "string" && "source" in input) return this.#source(input);
    const id = typeof input === "string" ? input : input.id;
    const pending = this.#installing.get(id);
    if (pending) return pending;
    const previous = this.host.skills.list().find((skill) => skill.id === id);
    if (previous?.origin === "service") throw new HttpError(409, "Update this Skill through its owning Service bundle");
    if (previous && (previous.id.startsWith("source_") || previous.origin === "default")) {
      return this.#source({ source: previous.installUrl, ...(previous.skillPath === undefined ? {} : { skillPath: previous.skillPath }) }, previous.id);
    }
    const operation = (async () => {
      const detail = await this.host.detail(id);
      const installed = await materializeSkill(detail, path.join(this.host.rootDir, "skills"));
      try {
        if (this.host.stopping() || (previous && !this.host.skills.list().some((skill) => skill.id === id))) throw new HttpError(409, "Skill was removed or plugin runtime stopped during installation");
        const skill = this.host.skills.install(detail, installed);
        this.host.clearNative();
        this.host.persist(true);
        return skill;
      } finally { await this.#removeUnused(installed.directory); }
    })().catch((error) => {
      this.host.skills.markError(id, redactToolErrorSummary(error instanceof Error ? error.message : error));
      throw error;
    }).finally(() => { this.#installing.delete(id); });
    this.#installing.set(id, operation);
    return operation;
  }

  #source(input: Exclude<InstallSkillBody, { id: string }>, existingId?: string): Promise<InstalledSkillDto> {
    const key = existingId ?? `source:${JSON.stringify(input)}`;
    const pending = this.#installing.get(key);
    if (pending) return pending;
    const operation = (async () => {
      const source = await materializeSkillSource(input, path.join(this.host.rootDir, "skills"));
      try {
        if (this.host.stopping() || (existingId && !this.host.skills.list().some((skill) => skill.id === existingId))) throw new HttpError(409, "Skill was removed or plugin runtime stopped during installation");
        const catalog = existingId ? { ...source.catalog, id: existingId } : source.catalog;
        const installed = this.host.skills.install(catalog, source);
        this.host.clearNative();
        this.host.persist(true);
        return installed;
      } finally { await this.#removeUnused(source.directory); }
    })().catch((error) => {
      if (existingId) this.host.skills.markError(existingId, redactToolErrorSummary(error instanceof Error ? error.message : error));
      throw error;
    }).finally(() => { this.#installing.delete(key); });
    this.#installing.set(key, operation);
    return operation;
  }

  update(): Promise<void> {
    this.#update ??= (async () => {
      const failures: string[] = [];
      for (const skill of this.host.skills.list().filter((entry) => entry.enabled && entry.sourceType !== "local" && entry.origin !== "service")) {
        if (this.host.stopping()) break;
        try { await this.install(skill.id); } catch { failures.push(skill.name); }
      }
      const updated = new Set<string>();
      for (const account of this.host.accounts()) for (const serviceId of account.enabledServices) {
        const key = `${account.providerId}/${serviceId}`;
        if (this.host.stopping() || updated.has(key)) continue;
        updated.add(key);
        try { await this.host.updateService(account.id, serviceId); } catch { failures.push(key); }
      }
      if (failures.length) throw new HttpError(502, `Could not update: ${failures.join(", ")}. Existing installed versions are retained.`);
    })().finally(() => { this.#update = undefined; });
    return this.#update;
  }

  enable(id: string, enabled: boolean): void {
    this.host.skills.enable(id, enabled);
    this.host.clearNative();
    this.host.persist(true);
  }

  remove(id: string): void {
    this.host.skills.remove(id);
    this.host.clearNative();
    this.host.persist(true);
  }

  async removeUnused(directory: string): Promise<void> {
    await this.#removeUnused(directory);
  }

  async #removeUnused(directory: string): Promise<void> {
    if (this.host.legacyDirectories().includes(directory)) return;
    const relative = path.relative(path.join(this.host.rootDir, "skills"), directory);
    if (/^[0-9a-f]{64}$/.test(relative)) await rm(directory, { recursive: true, force: true });
  }
}
