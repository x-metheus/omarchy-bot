import type { Database } from "bun:sqlite";

export function getSetting(db: Database, key: string): string | null {
  return db.query<{ value: string }, [string]>("SELECT value FROM service_settings WHERE key = ?").get(key)?.value ?? null;
}

export function setSetting(db: Database, key: string, value: string): void {
  db.query("INSERT INTO service_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function deleteSetting(db: Database, key: string): void {
  db.query("DELETE FROM service_settings WHERE key = ?").run(key);
}
