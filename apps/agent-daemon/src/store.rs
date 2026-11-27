mod recall_index;

use std::path::{self, Path};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use rig_ecs::model::Connection as RigConnection;
use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ValueRef};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use uuid::Uuid;

use crate::attachments::{self, Metadata, Stored, Submission};
use crate::settings::{Settings, SettingsStatus, SettingsUpdate, Update};
use crate::user_memory::{self, CurrentMemory, MemorySource, Proposal, Remembered};

#[derive(Serialize)]
pub(crate) struct Bot {
    pub(crate) id: Uuid,
    pub(crate) name: String,
    pub(crate) duties: Option<String>,
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
    #[serde(skip_serializing_if = "Vec::is_empty")]
    attachments: Vec<Metadata>,
}

#[derive(Clone, Copy, Debug, Serialize)]
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

pub(crate) enum Admission {
    BotNotFound,
    AttachmentNotFound,
    Unconfigured,
    Accepted {
        history: Conversation,
        message_id: i64,
        prompt: String,
        attachments: Vec<Stored>,
        model: RigConnection,
    },
}

struct Database {
    connection: Connection,
    settings: Settings,
}

#[derive(Clone)]
pub(crate) struct Store(Arc<Mutex<Database>>, CurrentMemory);

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
                     name TEXT NOT NULL,
                     duties TEXT
                 );
                 CREATE TABLE IF NOT EXISTS messages (
                     id INTEGER PRIMARY KEY,
                     bot_id BLOB NOT NULL REFERENCES bots(id),
                     role INTEGER NOT NULL CHECK (role IN (0, 1)),
                     text TEXT NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS messages_by_bot ON messages(bot_id, id);
                 CREATE TABLE IF NOT EXISTS recall_vectors (
                     message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
                     revision TEXT NOT NULL,
                     embedding BLOB NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS message_order (
                     one INTEGER PRIMARY KEY CHECK (one = 1),
                     high_water INTEGER NOT NULL
                 );
                 INSERT OR IGNORE INTO message_order
                     SELECT 1, coalesce(max(id), 0) FROM messages;
                 CREATE TRIGGER IF NOT EXISTS advance_message_order AFTER INSERT ON messages
                 BEGIN
                     UPDATE message_order SET high_water = max(high_water, NEW.id) WHERE one = 1;
                 END;
                 CREATE TABLE IF NOT EXISTS attachments (
                     id BLOB PRIMARY KEY NOT NULL,
                     name TEXT NOT NULL,
                     media_type TEXT NOT NULL,
                     content BLOB
                 );
                 CREATE TABLE IF NOT EXISTS message_attachments (
                     message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
                     position INTEGER NOT NULL,
                     attachment_id BLOB NOT NULL REFERENCES attachments(id),
                     PRIMARY KEY (message_id, position)
                 );
                 CREATE INDEX IF NOT EXISTS message_attachments_by_attachment
                     ON message_attachments(attachment_id);
                 CREATE TABLE IF NOT EXISTS provider_credentials (
                     provider TEXT PRIMARY KEY NOT NULL CHECK (provider IN ('openai', 'anthropic')),
                     sealed_key BLOB NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS model_settings (
                     id INTEGER PRIMARY KEY CHECK (id = 1),
                     provider TEXT NOT NULL REFERENCES provider_credentials(provider),
                     model TEXT NOT NULL
                 );",
            )
            .context("initialize SQLite database and acquire its daemon lock")?;
        let has_duties = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('bots') WHERE name = 'duties')",
                [],
                |row| row.get::<_, bool>(0),
            )
            .context("inspect Bot profile schema")?;
        if !has_duties {
            connection
                .execute("ALTER TABLE bots ADD COLUMN duties TEXT", [])
                .context("add duties to existing Bot profiles")?;
        }
        connection
            .execute_batch("COMMIT")
            .context("commit SQLite schema")?;
        let settings = Settings::load(&connection)?;
        let user_memory = CurrentMemory::load(&connection)?;
        Ok(Self(
            Arc::new(Mutex::new(Database {
                connection,
                settings,
            })),
            user_memory,
        ))
    }

    pub(crate) async fn settings(&self) -> Result<SettingsStatus> {
        self.run(|db| Ok(db.settings.status())).await
    }

    pub(crate) async fn update_settings(&self, update: SettingsUpdate) -> Result<Update> {
        self.run(move |db| db.settings.update(&mut db.connection, update))
            .await
    }

    pub(crate) async fn create_bot(&self, name: String) -> Result<Bot> {
        self.run(move |db| {
            let id = Uuid::new_v4();
            db.connection.execute(
                "INSERT INTO bots (id, name) VALUES (?1, ?2)",
                params![id.as_bytes().as_slice(), name],
            )?;
            Ok(Bot {
                id,
                name,
                duties: None,
            })
        })
        .await
    }

    pub(crate) async fn rename_bot(&self, id: Uuid, name: String) -> Result<Option<Bot>> {
        self.run(move |db| {
            let duties = db.connection.query_row(
                "UPDATE bots SET name = ?2 WHERE id = ?1 RETURNING duties",
                params![id.as_bytes().as_slice(), name],
                |row| row.get(0),
            );
            Ok(duties.optional()?.map(|duties| Bot { id, name, duties }))
        })
        .await
    }

    pub(crate) async fn conversation(&self, bot: Uuid) -> Result<Option<Conversation>> {
        self.run(move |db| {
            let Some(mut conversation) = load_conversation(&db.connection, bot)? else {
                return Ok(None);
            };
            let mut messages = conversation.messages.iter_mut().peekable();
            attachments::visit_conversation(&db.connection, bot, |message_id, attachment| {
                while messages
                    .next_if(|message| message.id < message_id)
                    .is_some()
                {}
                if let Some(message) = messages
                    .peek_mut()
                    .filter(|message| message.id == message_id)
                {
                    message.attachments.push(attachment);
                }
            })?;
            Ok(Some(conversation))
        })
        .await
    }

    pub(crate) async fn attachment(&self, bot: Uuid, id: Uuid) -> Result<Option<Stored>> {
        self.run(move |db| Ok(attachments::for_bot(&db.connection, bot, id)?))
            .await
    }

    pub(crate) async fn accept_message(
        &self,
        bot: Uuid,
        text: String,
        submissions: Vec<Submission>,
    ) -> Result<Admission> {
        self.run(move |db| {
            let transaction = db.connection.transaction()?;
            let Some(history) = load_conversation(&transaction, bot)? else {
                return Ok(Admission::BotNotFound);
            };
            // Settings writes use this same lock and publish only after commit.
            let Some(model) = db.settings.connection() else {
                return Ok(Admission::Unconfigured);
            };
            // Resolve against committed history before inserting any associations for this message.
            let mut attachments = Vec::with_capacity(submissions.len());
            for submission in submissions {
                let attachment = match submission {
                    Submission::Inline(attachment) => {
                        attachments::insert(&transaction, &attachment)?;
                        attachment
                    }
                    Submission::Reference(id) => {
                        let Some(attachment) = attachments::for_bot(&transaction, bot, id)? else {
                            return Ok(Admission::AttachmentNotFound);
                        };
                        attachment
                    }
                };
                attachments.push(attachment);
            }
            let message_id = insert_message(&transaction, bot, Role::User, &text)?;
            for (position, attachment) in attachments.iter().enumerate() {
                attachments::associate(&transaction, message_id, position, attachment.metadata.id)?;
            }
            transaction.commit()?;
            Ok(Admission::Accepted {
                history,
                message_id,
                prompt: text,
                attachments,
                model,
            })
        })
        .await
    }

    pub(crate) async fn commit_reply(
        &self,
        bot: Uuid,
        text: String,
        duties: Option<String>,
    ) -> Result<Message> {
        self.run(move |db| {
            let role = Role::Assistant;
            let transaction = db.connection.transaction()?;
            let id = insert_message(&transaction, bot, role, &text)?;
            if let Some(duties) = duties {
                transaction.execute(
                    "UPDATE bots SET duties = ?2 WHERE id = ?1",
                    params![bot.as_bytes().as_slice(), duties],
                )?;
            }
            transaction.commit()?;
            Ok(Message {
                id,
                role,
                text,
                attachments: Vec::new(),
            })
        })
        .await
    }

    pub(crate) fn user_memory(&self) -> &CurrentMemory {
        &self.1
    }

    pub(crate) async fn remember(
        &self,
        source: MemorySource,
        proposal: Proposal,
    ) -> Result<Remembered> {
        let current = self.1.clone();
        self.run(move |db| user_memory::remember(&mut db.connection, &current, source, proposal))
            .await
    }

    async fn run<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut Database) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let db = self.0.clone();
        tokio::task::spawn_blocking(move || {
            operation(&mut db.lock().expect("SQLite connection lock poisoned"))
        })
        .await?
    }
}

fn load_conversation(connection: &Connection, id: Uuid) -> rusqlite::Result<Option<Conversation>> {
    let key = id.as_bytes().as_slice();
    let Some((name, duties)) = connection
        .query_row(
            "SELECT name, duties FROM bots WHERE id = ?1",
            [key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
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
                attachments: Vec::new(),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some(Conversation {
        bot: Bot { id, name, duties },
        messages,
    }))
}

fn insert_message(
    connection: &Connection,
    bot: Uuid,
    role: Role,
    text: &str,
) -> rusqlite::Result<i64> {
    connection.query_row(
        "INSERT INTO messages (id, bot_id, role, text)
         VALUES ((SELECT high_water + 1 FROM message_order WHERE one = 1), ?1, ?2, ?3)
         RETURNING id",
        params![bot.as_bytes().as_slice(), role as i64, text],
        |row| row.get(0),
    )
}
