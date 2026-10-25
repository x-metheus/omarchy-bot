import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";

/** No 0/O/1/I: a pairing code is read aloud and typed by hand. */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;
const TOKEN_BYTES = 32;
const DEVICE_ID_BYTES = 8;
const DEFAULT_TTL_MS = 600_000;
/** A zero digest of token width, so a missing device costs one comparison too. */
const DUMMY_HASH = "0".repeat(64);

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export interface PairedDeviceDto {
  id: string;
  name: string;
  createdAt: string;
  revokedAt: string | null;
}

/** Paired Devices and outstanding pairing codes. Only hashes of secrets are stored. */
export class PairingService {
  constructor(private readonly db: Database) {}

  /**
   * Ensure the mode-0600 Service Host secret and return it. Any local account
   * can reach loopback, so code minting requires this file, not the peer address.
   */
  ensureHostSecret(stateDir: string): string {
    const file = path.join(stateDir, "pairing-host-secret");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(stateDir, 0o700);
    } catch {
      /* a pre-existing dir we cannot chmod still fails closed if the file is unwritable */
    }
    try {
      const existing = readFileSync(file, "utf8").trim();
      if (existing !== "") return existing;
    } catch {
      /* first boot */
    }
    const secret = randomBytes(32).toString("hex");
    writeFileSync(file, `${secret}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    return secret;
  }

  /** Constant-time check of the Service Host secret. A miss is not cheaper than a hit. */
  hostSecretMatches(presented: string | null, secret: string): boolean {
    const presentedHash = Buffer.from(sha256(presented ?? ""), "utf8");
    const secretHash = Buffer.from(sha256(secret), "utf8");
    return timingSafeEqual(presentedHash, secretHash);
  }

  /** Read per issue so a tighter TTL needs no restart. */
  #ttlMs(): number {
    const raw = Number(process.env.OMARCHY_BOT_PAIRING_TTL_MS ?? DEFAULT_TTL_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
  }

  #dropExpiredCodes(now: Date): void {
    this.db.query("DELETE FROM pairing_codes WHERE expires_at <= ?").run(now.toISOString());
  }

  issueCode(name: string, now: Date = new Date()): { code: string; url: string; expiresAt: string } {
    // 32 symbols divide 256 evenly, so the byte map carries no modulo bias.
    const code = Array.from(
      randomBytes(CODE_LENGTH),
      (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]!,
    ).join("");
    const expiresAt = new Date(now.getTime() + this.#ttlMs()).toISOString();
    this.#dropExpiredCodes(now);
    this.db
      .query("INSERT INTO pairing_codes (code_hash, name, expires_at) VALUES (?, ?, ?)")
      .run(sha256(code), name, expiresAt);
    return { code, url: `/pair?code=${code}`, expiresAt };
  }

  exchange(
    code: string,
    name?: string,
    now: Date = new Date(),
  ): { token: string; device: { id: string; name: string } } | null {
    this.#dropExpiredCodes(now);
    const codeHash = sha256(code);
    const token = randomBytes(TOKEN_BYTES).toString("hex");
    const id = `paired_${randomBytes(DEVICE_ID_BYTES).toString("hex")}`;
    const createdAt = now.toISOString();
    const issuedName = this.db.transaction((): string | null => {
      const row = this.db.query("SELECT name FROM pairing_codes WHERE code_hash = ?").get(codeHash) as { name: string } | null;
      if (row === null) return null;
      const deleted = this.db.query("DELETE FROM pairing_codes WHERE code_hash = ?").run(codeHash);
      if (deleted.changes !== 1) return null;
      const deviceName = name?.trim() || row.name;
      this.db
        .query("INSERT INTO paired_devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
        .run(id, deviceName, sha256(token), createdAt);
      return deviceName;
    })();
    return issuedName === null ? null : { token, device: { id, name: issuedName } };
  }

  /**
   * Hash first, then compare equal-length digests. Every live hash is compared,
   * so a hit is not cheaper than a miss and match position does not leak.
   */
  authenticate(presented: string | null): { id: string } | null {
    const presentedHash = Buffer.from(sha256(presented ?? ""), "utf8");
    const rows = this.db
      .query("SELECT id, token_hash FROM paired_devices WHERE revoked_at IS NULL")
      .all() as Array<{ id: string; token_hash: string }>;
    const candidates = rows.length === 0 ? [{ id: null as string | null, token_hash: DUMMY_HASH }] : rows;
    let found: string | null = null;
    for (const candidate of candidates) {
      const matches = timingSafeEqual(presentedHash, Buffer.from(candidate.token_hash, "utf8"));
      if (matches && found === null) found = candidate.id;
    }
    return found === null ? null : { id: found };
  }

  /** True while the Paired Device exists and has not been revoked. */
  isActive(id: string): boolean {
    return this.db.query("SELECT 1 FROM paired_devices WHERE id = ? AND revoked_at IS NULL").get(id) !== null;
  }

  list(): PairedDeviceDto[] {
    const rows = this.db
      .query("SELECT id, name, created_at, revoked_at FROM paired_devices ORDER BY created_at DESC")
      .all() as Array<{ id: string; name: string; created_at: string; revoked_at: string | null }>;
    return rows.map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at, revokedAt: row.revoked_at }));
  }

  revoke(id: string): boolean {
    if (this.db.query("SELECT 1 FROM paired_devices WHERE id = ?").get(id) === null) return false;
    this.db
      .query("UPDATE paired_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(new Date().toISOString(), id);
    return true;
  }
}
