//! Durable work state for each authored input. Rig execution and credentials are process-local.

use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use uuid::Uuid;

use super::{Admission, ConversationEvent, Store, events, restore_conversation};
use crate::agent::conversation::UserMessageSource;
use crate::attachments;

#[derive(Default)]
pub(crate) struct Settlement {
    pub(crate) started: Vec<i64>,
    pub(crate) undelivered: Option<i64>,
    pub(crate) reports: Vec<Report>,
}

pub(crate) struct Report {
    pub(crate) request: String,
    pub(crate) agent: String,
}

pub(crate) enum Retry {
    Queued,
    NotInterrupted,
    NotFound,
}

pub(super) fn initialize(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS conversation_work (
             message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
             status TEXT NOT NULL CHECK (status IN (
                 'queued', 'running', 'waiting', 'completed', 'failed', 'interrupted'
             ))
         );
         CREATE TABLE IF NOT EXISTS conversation_delegations (
             id INTEGER PRIMARY KEY,
             bot_id BLOB NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
             agent TEXT NOT NULL,
             request TEXT NOT NULL,
             message_id INTEGER NOT NULL REFERENCES conversation_work(message_id) ON DELETE CASCADE,
             UNIQUE (bot_id, request)
         );
         CREATE INDEX IF NOT EXISTS conversation_delegations_by_work
             ON conversation_delegations(message_id);",
    )
}

fn status_event(
    db: &Connection,
    source: UserMessageSource,
    status: &str,
    configured: bool,
) -> Result<()> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct WorkStatus<'a> {
        message_id: i64,
        status: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<&'static str>,
    }
    let data = serde_json::to_string(&WorkStatus {
        message_id: source.message_id,
        status,
        reason: (status == "queued" && !configured).then_some("provider_unconfigured"),
    })?;
    events::append(db, source.bot, "work", data)?;
    Ok(())
}

pub(super) fn admit(db: &Connection, source: UserMessageSource) -> Result<()> {
    db.execute(
        "INSERT INTO conversation_work (message_id, status) VALUES (?1, 'queued')",
        [source.message_id],
    )?;
    status_event(db, source, "queued", true)
}

pub(super) fn restart(db: &mut Connection, configured: bool) -> Result<()> {
    let tx = db.transaction()?;
    let select = |condition| -> Result<Vec<UserMessageSource>> {
        let mut query = tx.prepare_cached(
            "SELECT m.bot_id, w.message_id FROM conversation_work w
             JOIN messages m ON m.id = w.message_id WHERE w.status = ?1 ORDER BY w.message_id",
        )?;
        Ok(query
            .query_map([condition], read_source)?
            .collect::<rusqlite::Result<_>>()?)
    };
    for status in ["running", "waiting"] {
        for source in select(status)? {
            tx.execute(
                "UPDATE conversation_work SET status = 'interrupted' WHERE message_id = ?1",
                [source.message_id],
            )?;
            status_event(&tx, source, "interrupted", configured)?;
        }
    }
    tx.execute("DELETE FROM conversation_delegations", [])?;
    if !configured {
        for source in select("queued")? {
            status_event(&tx, source, "queued", false)?;
        }
    }
    tx.commit()?;
    Ok(())
}

fn read_source(row: &rusqlite::Row<'_>) -> rusqlite::Result<UserMessageSource> {
    Ok(UserMessageSource {
        bot: Uuid::from_bytes(row.get(0)?),
        message_id: row.get(1)?,
    })
}

impl Store {
    pub(crate) fn report_source(
        &self,
        bot: Uuid,
        report: &Report,
    ) -> Result<Option<UserMessageSource>> {
        let db = self.0.lock().expect("SQLite connection lock poisoned");
        let message_id = db.connection.query_row(
            "SELECT message_id FROM conversation_delegations WHERE bot_id = ?1 AND request = ?2",
            params![bot.as_bytes(), report.request],
            |row| row.get(0),
        ).optional()?;
        Ok(message_id.map(|message_id| UserMessageSource { bot, message_id }))
    }

    pub(crate) async fn consume_report(&self, bot: Uuid, report: Report) -> Result<()> {
        self.run(move |db| {
            let tx = db.connection.transaction()?;
            settle(
                &tx,
                bot,
                Settlement {
                    reports: vec![report],
                    ..Settlement::default()
                },
                "failed",
            )?;
            tx.commit()?;
            Ok(())
        })
        .await?;
        self.events_changed();
        Ok(())
    }

    pub(crate) async fn recovery_queue(&self) -> Result<Vec<UserMessageSource>> {
        self.run(|db| {
            let mut query = db.connection.prepare_cached(
                "SELECT m.bot_id, w.message_id FROM conversation_work w
                 JOIN messages m ON m.id = w.message_id
                 WHERE w.status = 'queued' ORDER BY w.message_id",
            )?;
            Ok(query
                .query_map([], read_source)?
                .collect::<rusqlite::Result<_>>()?)
        })
        .await
    }

    pub(crate) fn load_queued(
        &self,
        source: UserMessageSource,
        history: super::History,
    ) -> Result<Option<Admission>> {
        let db = self.0.lock().expect("SQLite connection lock poisoned");
        let Some(model) = db.settings.connection() else {
            return Ok(None);
        };
        let history = match history {
            super::History::Restore => {
                Some(restore_conversation(&db.connection, source.bot)?.context("load queued Bot")?)
            }
            super::History::Live => None,
        };
        let text = db.connection.query_row(
            "SELECT m.text FROM messages m JOIN conversation_work w ON w.message_id = m.id
             WHERE m.bot_id = ?1 AND w.message_id = ?2 AND w.status = 'queued'",
            params![source.bot.as_bytes(), source.message_id],
            |row| row.get(0),
        )?;
        Ok(Some(Admission::Accepted {
            history,
            message_id: source.message_id,
            text,
            attachments: attachments::for_message(&db.connection, source.message_id)?,
            model,
        }))
    }

    pub(crate) async fn retry(&self, source: UserMessageSource) -> Result<Retry> {
        let retry = self
            .run(move |db| {
                let tx = db.connection.transaction()?;
                let status: Option<String> = tx.query_row(
                "SELECT w.status FROM conversation_work w JOIN messages m ON m.id = w.message_id
                 WHERE m.bot_id = ?1 AND w.message_id = ?2",
                params![source.bot.as_bytes(), source.message_id],
                |row| row.get(0),
            ).optional()?;
                match status.as_deref() {
                    None => return Ok(Retry::NotFound),
                    Some("interrupted") => {}
                    Some(_) => return Ok(Retry::NotInterrupted),
                }
                tx.execute(
                    "UPDATE conversation_work SET status = 'queued' WHERE message_id = ?1",
                    [source.message_id],
                )?;
                status_event(&tx, source, "queued", db.settings.connection().is_some())?;
                tx.commit()?;
                Ok(Retry::Queued)
            })
            .await?;
        if matches!(retry, Retry::Queued) {
            self.events_changed();
        }
        Ok(retry)
    }

    pub(crate) async fn start_work(&self, sources: Vec<UserMessageSource>) -> Result<()> {
        self.run(move |db| {
            let tx = db.connection.transaction()?;
            for source in sources {
                let changed = tx.execute(
                    "UPDATE conversation_work SET status = 'running'
                     WHERE message_id = ?1 AND status = 'queued'",
                    [source.message_id],
                )?;
                ensure!(changed == 1, "work {} is not queued", source.message_id);
                status_event(&tx, source, "running", true)?;
            }
            tx.commit()?;
            Ok(())
        })
        .await?;
        self.events_changed();
        Ok(())
    }

    pub(crate) async fn add_delegation(
        &self,
        source: UserMessageSource,
        report: Report,
    ) -> Result<()> {
        self.run(move |db| {
            db.connection.execute(
                "INSERT INTO conversation_delegations (bot_id, agent, request, message_id)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    source.bot.as_bytes(),
                    report.agent,
                    report.request,
                    source.message_id
                ],
            )?;
            Ok(())
        })
        .await
    }

    pub(crate) async fn fail_work(
        &self,
        bot: Uuid,
        work: Settlement,
        problem: impl Serialize,
    ) -> Result<ConversationEvent> {
        let problem = serde_json::to_string(&problem)?;
        let event = self
            .run(move |db| {
                let tx = db.connection.transaction()?;
                let event = events::append(&tx, bot, "error", problem)?;
                settle(&tx, bot, work, "failed")?;
                tx.commit()?;
                Ok(event)
            })
            .await?;
        self.events_changed();
        Ok(event)
    }
}

pub(super) fn settle(
    db: &Connection,
    bot: Uuid,
    mut work: Settlement,
    terminal: &str,
) -> Result<()> {
    let mut affected_reports = Vec::new();
    for report in work.reports {
        // Rig's Report answers the named request and older requests to that Agent.
        let mut remove = db.prepare_cached(
            "DELETE FROM conversation_delegations WHERE bot_id = ?1 AND agent = ?2 AND id <= (
                 SELECT id FROM conversation_delegations WHERE bot_id = ?1 AND request = ?3
             ) RETURNING message_id",
        )?;
        for id in remove.query_map(
            params![bot.as_bytes(), report.agent, report.request],
            |row| row.get::<_, i64>(0),
        )? {
            affected_reports.push(id?);
        }
    }
    work.started.append(&mut affected_reports);
    work.started.sort_unstable();
    work.started.dedup();
    for id in work.started {
        let state: Option<String> = db
            .query_row(
                "UPDATE conversation_work SET status = CASE
                 WHEN EXISTS (SELECT 1 FROM conversation_delegations WHERE message_id = ?1)
                 THEN 'waiting' ELSE ?2 END
             WHERE message_id = ?1 AND status IN ('running', 'waiting') RETURNING status",
                params![id, terminal],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(state) = state {
            status_event(
                db,
                UserMessageSource {
                    bot,
                    message_id: id,
                },
                &state,
                true,
            )?;
        }
    }
    if let Some(id) = work.undelivered {
        let changed = db.execute(
            "UPDATE conversation_work SET status = 'failed' WHERE message_id = ?1 AND status = 'queued'",
            [id],
        )?;
        if changed == 1 {
            status_event(
                db,
                UserMessageSource {
                    bot,
                    message_id: id,
                },
                "failed",
                true,
            )?;
        }
    }
    Ok(())
}
