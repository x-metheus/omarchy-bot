mod deletion;
mod events;
mod observations;
mod recall_index;
pub(crate) mod work;

pub(crate) use events::ConversationEvent;

use std::path::{self, Path};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use rig_ecs::model::Connection as RigConnection;
use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ValueRef};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use tokio::sync::watch;
use uuid::Uuid;

use crate::agent::conversation::UserMessageSource;
use crate::attachments::{self, Metadata, Stored, Submission};
use crate::settings::{Settings, SettingsStatus, SettingsUpdate, Update};
use crate::user_memory::{self, CurrentMemory, MemoryWrite, Proposal};

pub(crate) use observations::{OBSERVATION_MESSAGE_OVERHEAD, Observation};

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
    pub(crate) id: i64,
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

pub(crate) enum History {
    Restore,
    Live,
}

pub(crate) struct RestoredConversation {
    pub(crate) conversation: Conversation,
    pub(crate) observation: Option<Box<Observation>>,
}

pub(crate) enum Admission {
    BotNotFound,
    AttachmentNotFound,
    Unconfigured,
    Accepted {
        history: Option<RestoredConversation>,
        message_id: i64,
        text: String,
        attachments: Vec<Stored>,
        model: RigConnection,
    },
}

struct Database {
    connection: Connection,
    settings: Settings,
}

#[derive(Clone)]
pub(crate) struct Store(Arc<Mutex<Database>>, CurrentMemory, watch::Sender<u64>);

impl Store {
    pub(crate) fn open(path: &Path) -> Result<Self> {
        let mut connection =
            Connection::open(path::absolute(path)?).context("open SQLite database")?;
        // The running Rig world belongs to the process that owns this database lock.
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
                 CREATE TABLE IF NOT EXISTS observations (
                     bot_id BLOB PRIMARY KEY NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
                     through INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
                     summary TEXT NOT NULL
                 );
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
        deletion::initialize(&connection).context("initialize Conversation deletion")?;
        events::initialize(&connection).context("initialize Conversation event storage")?;
        work::initialize(&connection).context("initialize Conversation work storage")?;
        connection
            .execute_batch("COMMIT")
            .context("commit SQLite schema")?;
        let settings = Settings::load(&connection)?;
        work::restart(&mut connection, settings.connection().is_some())
            .context("recover Conversation work")?;
        let user_memory = CurrentMemory::load(&connection)?;
        Ok(Self(
            Arc::new(Mutex::new(Database {
                connection,
                settings,
            })),
            user_memory,
            watch::Sender::new(0),
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
            let Some(mut conversation) = load_conversation(&db.connection, bot, History::Live)?
            else {
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
        history: History,
    ) -> Result<Admission> {
        let admission = self
            .run(move |db| {
                let transaction = db.connection.transaction()?;
                let history = match history {
                    History::Restore => {
                        let Some(history) = restore_conversation(&transaction, bot)? else {
                            return Ok(Admission::BotNotFound);
                        };
                        Some(history)
                    }
                    History::Live => None,
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
                            let Some(attachment) = attachments::for_bot(&transaction, bot, id)?
                            else {
                                return Ok(Admission::AttachmentNotFound);
                            };
                            attachment
                        }
                    };
                    attachments.push(attachment);
                }
                let message_id = insert_message(&transaction, bot, Role::User, &text)?;
                for (position, attachment) in attachments.iter().enumerate() {
                    attachments::associate(
                        &transaction,
                        message_id,
                        position,
                        attachment.metadata.id,
                    )?;
                }
                work::admit(&transaction, UserMessageSource { bot, message_id })?;
                transaction.commit()?;
                Ok(Admission::Accepted {
                    history,
                    message_id,
                    text,
                    attachments,
                    model,
                })
            })
            .await?;
        if matches!(admission, Admission::Accepted { .. }) {
            self.events_changed();
        }
        Ok(admission)
    }

    pub(crate) async fn commit_reply(
        &self,
        bot: Uuid,
        text: String,
        duties: Option<String>,
        work: work::Settlement,
    ) -> Result<(ConversationEvent, i64)> {
        let committed = self
            .run(move |db| {
                let role = Role::Assistant;
                let transaction = db.connection.transaction()?;
                let id = insert_message(&transaction, bot, role, &text)?;
                if let Some(duties) = duties {
                    transaction.execute(
                        "UPDATE bots SET duties = ?2 WHERE id = ?1",
                        params![bot.as_bytes().as_slice(), duties],
                    )?;
                }
                let message = Message {
                    id,
                    role,
                    text,
                    attachments: Vec::new(),
                };
                let event = events::append(
                    &transaction,
                    bot,
                    "committed",
                    serde_json::to_string(&message)?,
                )?;
                work::settle(&transaction, bot, work, "completed")?;
                transaction.commit()?;
                Ok((event, id))
            })
            .await?;
        self.events_changed();
        Ok(committed)
    }

    pub(crate) fn user_memory(&self) -> &CurrentMemory {
        &self.1
    }

    pub(crate) async fn remember(
        &self,
        source: UserMessageSource,
        proposal: Proposal,
    ) -> Result<MemoryWrite> {
        let current = self.1.clone();
        self.run(move |db| user_memory::remember(&mut db.connection, &current, source, proposal))
            .await
    }

    pub(crate) async fn inspect_memory(&self, key: Option<String>) -> Result<serde_json::Value> {
        self.run(move |db| user_memory::inspect(&db.connection, key.as_deref()))
            .await
    }

    pub(crate) async fn forget_memory(
        &self,
        source: UserMessageSource,
        key: String,
        evidence: String,
    ) -> Result<MemoryWrite> {
        let current = self.1.clone();
        self.run(move |db| {
            user_memory::forget(&mut db.connection, &current, source, &key, &evidence)
        })
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

fn restore_conversation(
    connection: &Connection,
    bot: Uuid,
) -> Result<Option<RestoredConversation>> {
    let Some(conversation) = load_conversation(connection, bot, History::Restore)? else {
        return Ok(None);
    };
    let observation = observations::load(connection, bot)?.map(Box::new);
    Ok(Some(RestoredConversation {
        conversation,
        observation,
    }))
}

fn load_conversation(
    connection: &Connection,
    id: Uuid,
    history: History,
) -> rusqlite::Result<Option<Conversation>> {
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
    // Pending inputs are delivered by Rig once. Interrupted inputs require an explicit retry.
    let mut statement = connection.prepare_cached(
        "SELECT id, role, text FROM messages m WHERE bot_id = ?1 AND (?2 OR NOT EXISTS (
             SELECT 1 FROM conversation_work w
             WHERE w.message_id = m.id AND w.status IN ('queued', 'interrupted')
         )) ORDER BY id",
    )?;
    let messages = statement
        .query_map(params![key, matches!(history, History::Live)], |row| {
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
