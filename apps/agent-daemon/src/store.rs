use std::path::{self, Path};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ValueRef};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use uuid::Uuid;

#[derive(Serialize)]
pub(crate) struct Bot {
    pub(crate) id: Uuid,
    pub(crate) name: String,
}

#[derive(Serialize)]
pub(crate) struct Conversation {
    pub(crate) bot: Bot,
    pub(crate) messages: Vec<Message>,
}

#[derive(Serialize)]
pub(crate) struct Message {
    id: i64,
    pub(crate) role: Role,
    pub(crate) text: String,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Role {
    User = 0,
    Assistant = 1,
}

impl FromSql for Role {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        match value.as_i64()? {
            0 => Ok(Self::User),
            1 => Ok(Self::Assistant),
            value => Err(FromSqlError::OutOfRange(value)),
        }
    }
}

#[derive(Clone)]
pub(crate) struct Store(Arc<Mutex<Connection>>);

impl Store {
    pub(crate) fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open(path::absolute(path)?).context("open SQLite database")?;
        // Keep the database locked for the lifetime of the daemon. Turn admission
        // is in memory, so there must be one writer process per database.
        connection
            .execute_batch(
                "PRAGMA locking_mode = EXCLUSIVE;
                 PRAGMA foreign_keys = ON;
                 PRAGMA synchronous = FULL;
                 BEGIN EXCLUSIVE;
                 CREATE TABLE IF NOT EXISTS bots (
                     id BLOB PRIMARY KEY NOT NULL,
                     name TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS messages (
                     id INTEGER PRIMARY KEY,
                     bot_id BLOB NOT NULL REFERENCES bots(id),
                     role INTEGER NOT NULL CHECK (role IN (0, 1)),
                     text TEXT NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS messages_by_bot ON messages(bot_id, id);
                 COMMIT;",
            )
            .context("initialize SQLite database and acquire its daemon lock")?;
        Ok(Self(Arc::new(Mutex::new(connection))))
    }

    pub(crate) async fn create_bot(&self, name: String) -> Result<Bot> {
        self.run(move |connection| {
            let id = Uuid::new_v4();
            connection.execute(
                "INSERT INTO bots (id, name) VALUES (?1, ?2)",
                params![id.as_bytes().as_slice(), name],
            )?;
            Ok(Bot { id, name })
        })
        .await
    }

    pub(crate) async fn conversation(&self, bot: Uuid) -> Result<Option<Conversation>> {
        self.run(move |connection| load_conversation(connection, bot))
            .await
    }

    pub(crate) async fn accept_message(
        &self,
        bot: Uuid,
        text: String,
    ) -> Result<Option<(Conversation, String)>> {
        self.run(move |connection| {
            let transaction = connection.transaction()?;
            let Some(history) = load_conversation(&transaction, bot)? else {
                return Ok(None);
            };
            insert_message(&transaction, bot, Role::User, &text)?;
            transaction.commit()?;
            Ok(Some((history, text)))
        })
        .await
    }

    pub(crate) async fn commit_reply(&self, bot: Uuid, text: String) -> Result<Message> {
        self.run(move |connection| {
            let role = Role::Assistant;
            let id = insert_message(connection, bot, role, &text)?;
            Ok(Message { id, role, text })
        })
        .await
    }

    async fn run<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
    ) -> Result<T> {
        let connection = self.0.clone();
        Ok(tokio::task::spawn_blocking(move || {
            operation(&mut connection.lock().expect("SQLite connection lock poisoned"))
        })
        .await??)
    }
}

fn load_conversation(connection: &Connection, id: Uuid) -> rusqlite::Result<Option<Conversation>> {
    let key = id.as_bytes().as_slice();
    let Some(name) = connection
        .query_row("SELECT name FROM bots WHERE id = ?1", [key], |row| {
            row.get(0)
        })
        .optional()?
    else {
        return Ok(None);
    };
    let mut statement = connection
        .prepare_cached("SELECT id, role, text FROM messages WHERE bot_id = ?1 ORDER BY id")?;
    let messages = statement
        .query_map([key], |row| {
            Ok(Message {
                id: row.get(0)?,
                role: row.get(1)?,
                text: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some(Conversation {
        bot: Bot { id, name },
        messages,
    }))
}

fn insert_message(
    connection: &Connection,
    bot: Uuid,
    role: Role,
    text: &str,
) -> rusqlite::Result<i64> {
    connection.execute(
        "INSERT INTO messages (bot_id, role, text) VALUES (?1, ?2, ?3)",
        params![bot.as_bytes().as_slice(), role as i64, text],
    )?;
    Ok(connection.last_insert_rowid())
}
