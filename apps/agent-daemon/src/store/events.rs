//! Ordered Conversation events in the same database as Message History.

use anyhow::Result;
use rusqlite::{Connection, params};
use serde::Serialize;
use tokio::sync::watch;
use uuid::Uuid;

use super::Store;

pub(crate) struct ConversationEvent {
    pub(crate) id: i64,
    pub(crate) name: String,
    pub(crate) data: String,
}

pub(super) fn initialize(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS conversation_events (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             bot_id BLOB NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
             name TEXT NOT NULL,
             data TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS conversation_events_by_bot ON conversation_events(bot_id, id);",
    )
}

pub(super) fn append(
    db: &Connection,
    bot: Uuid,
    name: &str,
    data: String,
) -> Result<ConversationEvent> {
    let id = db.query_row(
        "INSERT INTO conversation_events (bot_id, name, data) VALUES (?1, ?2, ?3) RETURNING id",
        params![bot.as_bytes(), name, data],
        |row| row.get(0),
    )?;
    Ok(ConversationEvent {
        id,
        name: name.to_owned(),
        data,
    })
}

impl Store {
    pub(crate) fn watch_events(&self) -> watch::Receiver<u64> {
        self.2.subscribe()
    }

    pub(super) fn events_changed(&self) {
        self.2.send_modify(|_| {});
    }

    pub(crate) async fn bot_exists(&self, bot: Uuid) -> Result<bool> {
        self.run(move |db| {
            Ok(db.connection.query_row(
                "SELECT EXISTS (SELECT 1 FROM bots WHERE id = ?1)",
                [bot.as_bytes()],
                |row| row.get(0),
            )?)
        })
        .await
    }

    pub(crate) async fn events_after(
        &self,
        bot: Uuid,
        after: i64,
    ) -> Result<Vec<ConversationEvent>> {
        self.run(move |db| {
            let mut select = db.connection.prepare_cached(
                "SELECT id, name, data FROM conversation_events
                 WHERE bot_id = ?1 AND id > ?2 ORDER BY id LIMIT 128",
            )?;
            Ok(select
                .query_map(params![bot.as_bytes(), after], |row| {
                    Ok(ConversationEvent {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        data: row.get(2)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?)
        })
        .await
    }

    pub(crate) async fn record_event(
        &self,
        bot: Uuid,
        name: &'static str,
        data: impl Serialize,
    ) -> Result<ConversationEvent> {
        let data = serde_json::to_string(&data)?;
        let event = self
            .run(move |db| append(&db.connection, bot, name, data))
            .await?;
        self.events_changed();
        Ok(event)
    }
}
