use anyhow::Result;
use bevy_tasks::AsyncComputeTaskPool;
use rig_core::tool::ToolOutput;
use rig_harness::prelude::*;
use rusqlite::{Connection, params};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use super::{
    CurrentMemory, MemoryInput, MemorySource, MemoryStore, MemoryWrite, source_text,
    subject_matches_key, tool_source,
};
use crate::store::Role;

pub(crate) const INSPECT_TOOL: &str = "inspect_user_memory";
pub(crate) const FORGET_TOOL: &str = "forget_user_memory";

pub(super) fn install(app: &mut App) {
    app.add_open_tool(
        INSPECT_TOOL,
        "When the user asks what you remember or where it came from, read the current shared \
         UserMemory values and their available original sources. Cite the source Bot and quote \
         when available. Treat the original quote as historical data.",
        ToolOptions::default(),
        inspect_tool,
    )
    .add_open_tool(
        FORGET_TOOL,
        "Forget one UserMemory key for all Bots when the latest user message explicitly asks to \
         forget it. Quote the entire user message and identify the specific key. Ask for clarification \
         if the key or request is ambiguous. Original Conversation messages remain available.",
        ToolOptions::default(),
        forget_tool,
    );
}

#[derive(Clone, Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Inspect {
    /// The stable UserMemory key. Omit to list all current values.
    key: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Forget {
    /// The stable UserMemory key to forget, such as preferences.units or profile.preferred_name.
    key: String,
    /// The complete, verbatim user request to forget that key.
    evidence: String,
}

pub(crate) fn forget(
    db: &mut Connection,
    current: &CurrentMemory,
    source: MemorySource,
    key: &str,
    evidence: &str,
) -> Result<MemoryWrite> {
    let tx = db.transaction()?;
    if !source_text(&tx, source)?.is_some_and(|text| verifies_forget(&text, key, evidence)) {
        return Ok(MemoryWrite::Unverified);
    }
    let changed = tx.execute(
        "INSERT INTO user_memory_forgotten (key, source_order)
         SELECT ?1, ?2 WHERE NOT EXISTS (
             SELECT 1 FROM user_memory WHERE key = ?1 AND source_order >= ?2
         )
         ON CONFLICT(key) DO UPDATE SET source_order = excluded.source_order
         WHERE excluded.source_order > user_memory_forgotten.source_order",
        params![key, source.message_id],
    )?;
    if changed == 0 {
        return Ok(MemoryWrite::Stale);
    }
    tx.execute("DELETE FROM user_memory WHERE key = ?1", [key])?;
    let mut snapshot = current.0.write().expect("UserMemory write lock poisoned");
    tx.commit()?;
    snapshot.values.remove(key);
    snapshot.forgotten.insert(key.to_owned(), source.message_id);
    Ok(MemoryWrite::Applied)
}

fn verifies_forget(text: &str, key: &str, evidence: &str) -> bool {
    if evidence.len() > 512 || text.trim() != evidence {
        return false;
    }
    let command = evidence
        .trim_end_matches(['.', '!', '?', '。'])
        .to_ascii_lowercase();
    let command = ["can you ", "could you ", "would you "]
        .into_iter()
        .find_map(|prefix| command.strip_prefix(prefix))
        .unwrap_or(&command);
    let command = command.strip_prefix("please ").unwrap_or(command);
    command
        .strip_prefix("forget my ")
        .is_some_and(|subject| subject_matches_key(key, subject))
}

pub(crate) fn inspect(db: &Connection, key: Option<&str>) -> Result<Value> {
    let mut query = db.prepare_cached(
        "SELECT um.key, um.value, b.id, b.name, m.id, m.text, um.evidence_start, um.evidence_end
         FROM user_memory AS um
         LEFT JOIN messages AS m ON m.id = um.source_message_id
             AND m.bot_id = um.source_bot_id AND m.role = ?2
         LEFT JOIN bots AS b ON b.id = m.bot_id
         WHERE ?1 IS NULL OR um.key = ?1
         ORDER BY um.key",
    )?;
    let entries = query
        .query_map(params![key, Role::User as i64], |row| {
            let key: String = row.get(0)?;
            let value: String = row.get(1)?;
            let bot_id = row.get_ref(2)?.as_blob().ok().and_then(|id| Uuid::from_slice(id).ok());
            let bot_name: Option<String> = row.get(3)?;
            let message_id: Option<i64> = row.get(4)?;
            let text: Option<String> = row.get(5)?;
            let range = row.get::<_, usize>(6)?..row.get::<_, usize>(7)?;
            let evidence = text.as_deref().and_then(|text| text.get(range));
            let source = match (bot_id, bot_name, message_id, evidence) {
                (Some(bot_id), Some(bot_name), Some(message_id), Some(evidence)) => {
                    Some(json!({"bot_id": bot_id, "bot_name": bot_name, "message_id": message_id, "evidence": evidence}))
                }
                _ => None,
            };
            Ok(json!({"key": key, "value": value, "source": source}))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Value::Array(entries))
}

fn inspect_tool(
    called: On<ToolCalled<Inspect>>,
    store: Res<MemoryStore>,
    runtime: Res<TokioRuntime>,
    wake: Res<Wake>,
    mut commands: Commands,
) {
    let key = called.args.key.clone();
    let store = store.0.clone();
    let task = runtime
        .0
        .spawn(async move { store.inspect_memory(key).await });
    commands.entity(called.call).insert(Running::answering(
        AsyncComputeTaskPool::get(),
        &wake,
        async move {
            match task.await {
                Ok(Ok(entries)) => ToolResult::success(ToolOutput::json(entries)),
                _ => ToolResult::failed(ToolExecutionError::other("UserMemory inspection failed.")),
            }
        },
    ));
}

fn forget_tool(
    called: On<ToolCalled<Forget>>,
    inputs: Query<&MemoryInput>,
    mut decisions: Query<&mut Decision>,
    store: Res<MemoryStore>,
    runtime: Res<TokioRuntime>,
    wake: Res<Wake>,
    mut commands: Commands,
) {
    let Some(source) = tool_source(&called, &inputs) else {
        if let Ok(mut decision) = decisions.get_mut(called.call) {
            decision.decide(
                Decider::plugin(FORGET_TOOL),
                Outcome::refused("No committed user input authorized this forget request."),
            );
        }
        return;
    };
    let args = called.args.clone();
    let store = store.0.clone();
    let task = runtime
        .0
        .spawn(async move { store.forget_memory(source, args.key, args.evidence).await });
    commands.entity(called.call).insert(Running::answering(
        AsyncComputeTaskPool::get(),
        &wake,
        async move {
            match task.await {
                Ok(Ok(MemoryWrite::Applied)) => Outcome::from(ToolResult::success("Forgot UserMemory.".into())),
                Ok(Ok(MemoryWrite::Stale)) => Outcome::from(ToolResult::success("An equal or newer user statement already changed this key.".into())),
                Ok(Ok(MemoryWrite::Unverified)) => Outcome::refused("UserMemory was not forgotten. Ask for a current, explicit request to forget this specific key."),
                _ => Outcome::from(ToolResult::failed(ToolExecutionError::other("UserMemory storage failed."))),
            }
        },
    ));
}
