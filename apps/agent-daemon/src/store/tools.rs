//! Tool lifecycle events and the durable set that interruption needs to close.

use anyhow::Result;
use rusqlite::{Connection, params};
use serde::Serialize;
use uuid::Uuid;

use super::{Store, events};

#[derive(Clone, Serialize)]
pub(crate) struct ToolProgress {
    pub(crate) id: Uuid,
    pub(crate) name: String,
    pub(crate) status: ToolStatus,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ToolStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

pub(super) fn initialize(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS running_tools (
            id BLOB PRIMARY KEY NOT NULL,
            bot_id BLOB NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            event_id INTEGER NOT NULL REFERENCES conversation_events(id) ON DELETE CASCADE
         );
         INSERT INTO conversation_events (bot_id, name, data)
            SELECT r.bot_id, 'tool', json_set(e.data, '$.status', 'interrupted')
            FROM running_tools AS r JOIN conversation_events AS e ON r.event_id = e.id
            ORDER BY r.event_id;
         DELETE FROM running_tools;",
    )
}

impl Store {
    pub(crate) async fn record_tool(&self, bot: Uuid, event: ToolProgress) -> Result<()> {
        let changed = self
            .run(move |db| {
                let tx = db.connection.transaction()?;
                let running = matches!(event.status, ToolStatus::Running);
                let available = if running {
                    tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM bots WHERE id = ?1)",
                        [bot.as_bytes()],
                        |row| row.get::<_, bool>(0),
                    )?
                } else {
                    tx.execute(
                        "DELETE FROM running_tools WHERE id = ?1",
                        [event.id.as_bytes()],
                    )? != 0
                };
                if !available {
                    return Ok(false);
                }
                let saved = events::append(&tx, bot, "tool", serde_json::to_string(&event)?)?;
                if running {
                    tx.execute(
                        "INSERT INTO running_tools (id, bot_id, event_id) VALUES (?1, ?2, ?3)",
                        params![event.id.as_bytes(), bot.as_bytes(), saved.id],
                    )?;
                }
                tx.commit()?;
                Ok(true)
            })
            .await?;
        if changed {
            self.events_changed();
        }
        Ok(())
    }
}
