//! Durable pairing codes and device credentials, stored as SHA-256 digests.

use anyhow::Result;
use ring::digest::Digest;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use uuid::Uuid;

use super::Store;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Device {
    pub(crate) id: Uuid,
    pub(crate) name: String,
    pub(crate) created_at: u64,
    pub(crate) revoked_at: Option<u64>,
}

pub(super) fn initialize(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS device_pairing_codes (
            digest BLOB PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            expires_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS paired_devices (
            id BLOB PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            digest BLOB UNIQUE NOT NULL,
            created_at INTEGER NOT NULL,
            revoked_at INTEGER
         );",
    )
}

fn device_id(row: &Row<'_>) -> rusqlite::Result<Uuid> {
    Ok(Uuid::from_bytes(row.get(0)?))
}

impl Store {
    pub(crate) async fn issue_pairing_code(
        &self,
        digest: Digest,
        name: String,
        now: u64,
        expires_at: u64,
    ) -> Result<()> {
        self.run(move |db| {
            let tx = db.connection.transaction()?;
            tx.execute(
                "DELETE FROM device_pairing_codes WHERE expires_at <= ?1",
                [now],
            )?;
            tx.execute(
                "INSERT INTO device_pairing_codes (digest, name, expires_at) VALUES (?1, ?2, ?3)",
                params![digest.as_ref(), name, expires_at],
            )?;
            Ok(tx.commit()?)
        })
        .await
    }

    pub(crate) async fn exchange_pairing_code(
        &self,
        code: Digest,
        token: Digest,
        now: u64,
    ) -> Result<Option<Device>> {
        self.run(move |db| {
            let tx = db.connection.transaction()?;
            let Some(name) = tx.query_row(
                "DELETE FROM device_pairing_codes WHERE digest = ?1 AND expires_at > ?2 RETURNING name",
                params![code.as_ref(), now], |row| row.get::<_, String>(0),
            ).optional()? else { return Ok(None) };
            let id = Uuid::new_v4();
            tx.execute(
                "INSERT INTO paired_devices (id, name, digest, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![id.as_bytes(), name, token.as_ref(), now],
            )?;
            tx.commit()?;
            Ok(Some(Device { id, name, created_at: now, revoked_at: None }))
        }).await
    }

    pub(crate) async fn authenticate_device(&self, digest: Digest) -> Result<Option<Uuid>> {
        self.run(move |db| {
            Ok(db
                .connection
                .query_row(
                    "SELECT id FROM paired_devices WHERE digest = ?1 AND revoked_at IS NULL",
                    [digest.as_ref()],
                    device_id,
                )
                .optional()?)
        })
        .await
    }

    pub(crate) async fn paired_devices(&self) -> Result<Vec<Device>> {
        self.run(move |db| {
            let mut statement = db.connection.prepare_cached(
                "SELECT id, name, created_at, revoked_at FROM paired_devices ORDER BY created_at DESC, id"
            )?;
            Ok(statement.query_map([], |row| Ok(Device {
                id: device_id(row)?, name: row.get(1)?, created_at: row.get(2)?, revoked_at: row.get(3)?,
            }))?.collect::<rusqlite::Result<_>>()?)
        }).await
    }

    pub(crate) async fn revoke_device(&self, device: Uuid, now: u64) -> Result<bool> {
        self.run(move |db| {
            Ok(db.connection.execute(
                "UPDATE paired_devices SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL",
                params![device.as_bytes(), now],
            )? != 0)
        })
        .await
    }
}
