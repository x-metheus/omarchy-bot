use anyhow::{Result, ensure};
use rusqlite::params;
use uuid::Uuid;

use super::{Role, Store};
use crate::recall::{DIMENSIONS, Hit, LookupScope, RecallScope, identifiers, passages};

// Bump when any artifact, encoding rule, or vector layout changes. The next
// backfill replaces derived rows from the original Message History.
const INDEX_VERSION: &str = "multilingual-e5-small-xenova-int8-v1";
const RESULT_LIMIT: usize = 5;
const SOURCE_RESULT_LIMIT: usize = 3;
// shortcut: E5 cosine cutoff for source discovery, recalibrate when the model changes
const SOURCE_MIN_SIMILARITY: f32 = 0.8;
const VECTOR_BYTES: usize = DIMENSIONS * size_of::<f32>();

pub(crate) struct PendingMessage {
    pub(crate) id: i64,
    pub(crate) bot: Uuid,
    pub(crate) text: String,
}

impl Store {
    pub(crate) async fn unindexed_messages(
        &self,
        after: i64,
        scope: Option<(RecallScope, LookupScope)>,
    ) -> Result<Vec<PendingMessage>> {
        self.run(move |db| {
            let mut statement = db.connection.prepare_cached(
                "SELECT m.id, m.bot_id, m.text FROM messages AS m
                 LEFT JOIN recall_vectors AS r ON r.message_id = m.id
                 WHERE m.id > ?1 AND (r.revision IS NULL OR r.revision <> ?2)
                 AND (?3 IS NULL OR (m.id <= ?4 AND (m.bot_id = ?3) = ?5))
                 ORDER BY m.id LIMIT 8",
            )?;
            let bot = scope
                .as_ref()
                .map(|(scope, _)| scope.bot_id.as_bytes().as_slice());
            let through = scope.map(|(scope, _)| scope.through);
            let same_bot = scope.map(|(_, lookup)| matches!(lookup, LookupScope::CurrentBot));
            let messages = statement
                .query_map(
                    params![after, INDEX_VERSION, bot, through, same_bot],
                    |row| {
                        Ok(PendingMessage {
                            id: row.get(0)?,
                            bot: Uuid::from_bytes(row.get(1)?),
                            text: row.get(2)?,
                        })
                    },
                )?
                .collect::<rusqlite::Result<_>>()?;
            Ok(messages)
        })
        .await
    }

    pub(crate) async fn save_recall_vectors(&self, rows: Vec<(i64, Uuid, Vec<u8>)>) -> Result<()> {
        self.run(move |db| {
            let transaction = db.connection.transaction()?;
            {
                let mut write = transaction.prepare_cached(
                    "INSERT INTO recall_vectors (message_id, revision, embedding)
                     SELECT id, ?3, ?4 FROM messages WHERE id = ?1 AND bot_id = ?2
                     ON CONFLICT(message_id) DO UPDATE SET
                         revision = excluded.revision, embedding = excluded.embedding",
                )?;
                for (id, bot, bytes) in rows {
                    // The source may disappear while inference runs. A reused id from
                    // another Bot must never take the old embedding.
                    write.execute(params![id, bot.as_bytes().as_slice(), INDEX_VERSION, bytes])?;
                }
            }
            transaction.commit()?;
            Ok(())
        })
        .await
    }

    pub(crate) async fn search_recall(
        &self,
        scope: RecallScope,
        lookup: LookupScope,
        query: String,
        vector: [f32; DIMENSIONS],
    ) -> Result<Vec<Hit>> {
        self.run(move |db| {
            let (sql, limit) = match lookup {
                LookupScope::CurrentBot => (
                    "SELECT m.id, m.role, m.text, r.embedding, m.bot_id, NULL
                     FROM messages AS m JOIN recall_vectors AS r ON r.message_id = m.id
                     WHERE m.bot_id = ?1 AND m.id <= ?2 AND r.revision = ?3",
                    RESULT_LIMIT,
                ),
                LookupScope::SourceBot => (
                    // The loopback daemon serves one owner. Resolve live Bots within this store.
                    "SELECT m.id, m.role, m.text, r.embedding, m.bot_id, source.name
                     FROM messages AS m JOIN recall_vectors AS r ON r.message_id = m.id
                     JOIN bots AS source ON source.id = m.bot_id
                     JOIN bots AS caller ON caller.id = ?1
                     WHERE m.bot_id <> ?1 AND m.id <= ?2 AND r.revision = ?3",
                    SOURCE_RESULT_LIMIT,
                ),
            };
            let mut statement = db.connection.prepare_cached(sql)?;
            let mut rows = statement.query(params![
                scope.bot_id.as_bytes().as_slice(),
                scope.through,
                INDEX_VERSION
            ])?;
            let query_ids: Vec<_> = identifiers(&query).collect();
            // shortcut: a linear scan of in-scope messages, replace it when history slows lookup
            let mut ranked: Vec<(usize, f32, i64, Hit)> = Vec::with_capacity(limit);
            while let Some(row) = rows.next()? {
                let id = row.get(0)?;
                let role: Role = row.get(1)?;
                let text = row.get_ref(2)?.as_str()?;
                let bytes = row.get_ref(3)?.as_blob()?;
                let chunks = bytes.chunks_exact(VECTOR_BYTES);
                let spans = passages(text);
                ensure!(
                    chunks.remainder().is_empty() && chunks.len() == spans.clone().count(),
                    "invalid Recall vector layout for message {id}"
                );
                let best = spans
                    .zip(chunks)
                    .map(|((start, end), bytes)| {
                        let span = &text[start..end];
                        let exact = query_ids
                            .iter()
                            .filter(|query_id| {
                                identifiers(span).any(|id| id.eq_ignore_ascii_case(query_id))
                            })
                            .count();
                        let similarity = bytes
                            .chunks_exact(size_of::<f32>())
                            .zip(vector.iter())
                            .map(|(bytes, query)| {
                                f32::from_le_bytes(
                                    bytes.try_into().expect("four bytes per vector value"),
                                ) * query
                            })
                            .sum::<f32>();
                        (exact, similarity, start, end)
                    })
                    .max_by(|left, right| {
                        left.0
                            .cmp(&right.0)
                            .then_with(|| left.1.total_cmp(&right.1))
                    });
                let Some((exact, similarity, start, end)) = best else {
                    continue;
                };
                if matches!(lookup, LookupScope::SourceBot)
                    && !(exact > 0 || query_ids.is_empty() && similarity >= SOURCE_MIN_SIMILARITY)
                {
                    continue;
                }
                let index = ranked.partition_point(|previous| {
                    previous
                        .0
                        .cmp(&exact)
                        .then_with(|| previous.1.total_cmp(&similarity))
                        .then_with(|| previous.2.cmp(&id))
                        .is_gt()
                });
                if index == limit {
                    continue;
                }
                if ranked.len() == limit {
                    ranked.pop();
                }
                ranked.insert(
                    index,
                    (
                        exact,
                        similarity,
                        id,
                        Hit {
                            bot_id: Uuid::from_bytes(row.get(4)?),
                            message_id: id,
                            bot_name: row.get(5)?,
                            role,
                            text: text[start..end].to_owned(),
                            start_byte: start,
                            end_byte: end,
                        },
                    ),
                );
            }
            Ok(ranked.into_iter().map(|(_, _, _, hit)| hit).collect())
        })
        .await
    }
}
