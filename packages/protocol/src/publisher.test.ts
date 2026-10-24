import { describe, expect, test } from "bun:test";
import {
  HttpsOrigin, PublisherTokenResponse, SkillsShCatalogEntry, SkillsShCatalogResponse, normaliseCatalog,
} from "./publisher.ts";

const origin = "https://publisher.example";

describe("publisher contract", () => {
  test("accepts one HTTPS origin and drops credentials, paths, and queries", () => {
    expect(HttpsOrigin.parse(origin)).toBe(origin);
    expect(HttpsOrigin.safeParse("http://publisher.example").success).toBe(false);
    expect(HttpsOrigin.safeParse("https://user:secret@publisher.example").success).toBe(false);
    expect(HttpsOrigin.safeParse("https://publisher.example/plugins").success).toBe(false);
    expect(HttpsOrigin.safeParse("https://publisher.example/?q=1").success).toBe(false);
  });

  test("keeps the token-metadata whitelist and ignores fields a daemon does not know", () => {
    const parsed = PublisherTokenResponse.parse({
      access_token: "access", refresh_token: "refresh", expires_in: "3600", scope: "openid email",
      user_id: "user", workspace_id: "workspace", email_domain: "example.invalid", team_id: "team",
      data: { gid: "gid" }, identity: { subject: "subject" }, future_claim: "keep-me-out",
    });
    expect(parsed).toEqual({
      access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: "openid email",
      user_id: "user", workspace_id: "workspace", email_domain: "example.invalid", team_id: "team",
      data: { gid: "gid" }, identity: { subject: "subject" },
    });
    expect("future_claim" in parsed).toBe(false);
    expect(PublisherTokenResponse.safeParse({ access_token: "access", identity: { tid: "tenant" } }).success).toBe(false);
  });

  test("normalises a raw skills.sh page into catalog entries without copying the upstream document", () => {
    const raw = SkillsShCatalogResponse.parse({
      data: [{
        id: "owner/repo/fixture-skill", name: "Fixture Skill", source: "owner/repo", installs: 7,
        skillId: "fixture-skill", sourceUrl: "https://github.com/owner/repo", extra: true,
      }],
      pagination: { page: 0, perPage: 12, total: 40, hasMore: true, next: "ignore" },
    });
    expect(normaliseCatalog(raw)).toEqual({
      skills: [{
        id: "owner/repo/fixture-skill", name: "Fixture Skill", source: "owner/repo",
        sourceType: "github", installUrl: "https://github.com/owner/repo", installs: 7,
      }],
      pagination: { page: 0, perPage: 12, total: 40, hasMore: true },
    });
    const search = SkillsShCatalogResponse.parse({
      data: [{ id: "example.com/well-known", name: "Well Known", source: "example.com" }],
    });
    expect(SkillsShCatalogEntry.parse(search.data[0]).sourceType).toBe("well-known");
  });
});
