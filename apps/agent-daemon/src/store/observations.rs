use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

use super::{Message, Store};

// Room for the committed ID, role and delimiters in the observer's transcript.
pub(crate) const OBSERVATION_MESSAGE_OVERHEAD: usize = 64;

#[derive(Clone)]
pub(crate) struct Observation {
    pub(crate) through: i64,
    pub(crate) text: String,
}

pub(super) fn load(connection: &Connection, bot: Uuid) -> Result<Option<Observation>> {
    Ok(connection
        .query_row(
            "SELECT through, summary FROM observations WHERE bot_id = ?1",
            [bot.as_bytes().as_slice()],
            |row| {
                Ok(Observation {
                    through: row.get(0)?,
                    text: row.get(1)?,
                })
            },
        )
        .optional()?)
}

impl Store {
    pub(crate) async fn observation_batch(
        &self,
        bot: Uuid,
        after: i64,
        through: i64,
        capacity: usize,
    ) -> Result<Vec<Message>> {
        self.run(move |db| {
            let mut statement = db.connection.prepare_cached(
                "SELECT id, role, text FROM messages
                 WHERE bot_id = ?1 AND id > ?2 AND id <= ?3 ORDER BY id",
            )?;
            let mut rows = statement.query(params![bot.as_bytes().as_slice(), after, through])?;
            let mut batch = Vec::new();
            let mut used = 0;
            while let Some(row) = rows.next()? {
                let size = row.get_ref(2)?.as_bytes()?.len() + OBSERVATION_MESSAGE_OVERHEAD;
                if used + size > capacity && !batch.is_empty() {
                    break;
                }
                batch.push(Message {
                    id: row.get(0)?,
                    role: row.get(1)?,
                    text: row.get(2)?,
                    attachments: Vec::new(),
                });
                used += size;
                if used >= capacity {
                    break;
                }
            }
            Ok(batch)
        })
        .await
    }

    pub(crate) async fn save_observation(
        &self,
        bot: Uuid,
        expected: i64,
        observation: Observation,
    ) -> Result<Option<Observation>> {
        self.run(move |db| {
            let written = db.connection.execute(
                "INSERT INTO observations (bot_id, through, summary)
                 SELECT ?1, ?2, ?3
                 WHERE EXISTS (SELECT 1 FROM messages WHERE bot_id = ?1 AND id = ?2)
                   AND coalesce((SELECT through FROM observations WHERE bot_id = ?1), 0) = ?4
                 ON CONFLICT(bot_id) DO UPDATE SET through = excluded.through, summary = excluded.summary",
                params![bot.as_bytes().as_slice(), observation.through, observation.text, expected],
            )?;
            Ok((written != 0).then_some(observation))
        })
        .await
    }
}
