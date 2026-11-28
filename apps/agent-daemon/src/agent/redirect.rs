use std::collections::HashMap;
use std::sync::Arc;

use bevy_ecs::relationship::RelationshipTarget;
use rig_basics::subagents::{Awaiting, MESSAGE, Request, TASK, WAIT};
use rig_core::message::{Message, ToolResultContent};
use rig_harness::prelude::*;
use schemars::JsonSchema;
use serde::Deserialize;

use super::conversation::{BotAgent, ConversationTools, ModelUserInput};
use super::work_control::{Tasks, authored_evidence};

pub(super) const REDIRECT_WORK: &str = "redirect_work";
const SUPERSEDED: &str = "Result superseded by the user's correction.";

pub(super) fn install(app: &mut App) {
    app.world_mut()
        .resource_mut::<ConversationTools>()
        .root_only
        .push(REDIRECT_WORK);
    app.add_open_tool(
        REDIRECT_WORK,
        "Send a correction to one of your Subagents. Use only when the latest user message \
         clearly identifies the operation to change. Earlier results for the affected work \
         are superseded. Use message for ordinary communication without a correction.",
        ToolOptions::default(),
        redirect,
    )
    .add_observer(record_delivery)
    .add_systems(AgentPass, mask_superseded.in_set(PrepareSystems::Edit));
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct RedirectArgs {
    /// The single affected Subagent's ID from task or work_status.
    agent: String,
    /// The correction, with enough context for the Subagent to redo affected work.
    text: String,
    /// An exact quote of the change requested in the latest user message.
    evidence: String,
}

#[derive(Component)]
struct Correction;

#[derive(Component, Default)]
struct Revisions {
    // The entry that changed this operation. Earlier calls belong to its original instructions.
    received: Option<MessageId>,
    // An older report from this particular Subagent cannot answer its revised request.
    sent: HashMap<String, CallRef>,
}

fn redirect(
    called: On<ToolCalled<RedirectArgs>>,
    roots: Query<(&Conversation, &Spawned), With<BotAgent>>,
    tasks: Tasks,
    calls: Query<(&ModelUserInput, &InReply)>,
    mut decisions: Query<&mut Decision>,
    mut commands: Commands,
) {
    let Ok(mut decision) = decisions.get_mut(called.call) else {
        return;
    };
    if decision.is_decided() {
        return;
    }
    let text = called.args.text.trim();
    let target = || {
        let (conversation, children) = roots.get(called.agent).ok()?;
        let (input, place) = calls.get(called.call).ok()?;
        if text.is_empty() || !authored_evidence(*input, conversation, &called.args.evidence) {
            return None;
        }
        let wanted = called.args.agent.trim();
        let mut matches = children
            .iter()
            .filter_map(|child| tasks.get(child).ok())
            .filter(|(_, id, ..)| id.0 == wanted || id.short() == wanted);
        let (entity, id, title, _, busy) = matches.next()?;
        matches
            .next()
            .is_none()
            .then_some((entity, id, title, busy, place.at()))
    };
    let result = if let Some((target, id, title, busy, at)) = target() {
        // Use the same request identity and report contract as SubagentsPlugin::message.
        let request = RequestId(format!("{}:{}", called.agent_id.0, at.wire()));
        let asked = Request {
            id: request.clone(),
            to: id.clone(),
        };
        let mut caller = commands.entity(called.agent);
        caller
            .entry::<Awaiting>()
            .or_default()
            .and_modify(|mut open| open.0.push(asked));
        let id = id.0.clone();
        caller
            .entry::<Revisions>()
            .or_default()
            .and_modify(move |mut revisions| {
                let previous = revisions.sent.entry(id).or_insert(at);
                *previous = (*previous).max(at);
            });
        if !busy {
            commands.entity(target).insert(EffectParent(called.effect));
        }
        let author = Author::agent(called.agent_id.clone(), Some(request));
        commands.spawn((
            Incoming::new(text, DeliveryMode::Steer).with_author(author),
            ForAgent(target),
            Effect::with_parent_id(Some(called.effect)),
            Correction,
        ));
        ToolResult::success(format!("Correction sent to {} for its next step.", title.0).into())
    } else {
        ToolResult::failed(ToolExecutionError::refused(
            "A correction requires an exact quote from the latest user message and one Subagent ID \
             from this Conversation.",
        ))
    };
    decision.decide(Decider::plugin(REDIRECT_WORK), result);
}

fn record_delivery(
    delivered: On<Add<DeliveredAs>>,
    corrections: Query<(&DeliveredAs, &ForAgent), With<Correction>>,
    mut commands: Commands,
) {
    if let Ok((&DeliveredAs(entry), &ForAgent(target))) = corrections.get(delivered.entity) {
        commands
            .entity(target)
            .entry::<Revisions>()
            .or_default()
            .and_modify(move |mut revisions| {
                revisions.received = revisions.received.max(Some(entry));
            });
    }
}

fn report_request<'a>(author: &'a Author, recipient: &AgentId) -> Option<(&'a str, CallRef)> {
    if author.kind != AuthorKind::Agent {
        return None;
    }
    let (owner, at) = author.request.as_ref()?.0.split_once(':')?;
    if owner != recipient.0 {
        return None;
    }
    let (reply, index) = at.split_once('/')?;
    Some((
        author.from.as_deref()?,
        CallRef {
            reply: reply.parse().ok()?,
            index: index.parse().ok()?,
        },
    ))
}

type NewTurnCall = (Added<Admitted>, With<TurnCall>);

fn mask_superseded(
    mut requests: Query<(&ForAgent, &mut ModelRequest), NewTurnCall>,
    agents: Query<(&AgentId, &Revisions)>,
) {
    for (&ForAgent(agent), mut request) in &mut requests {
        let (Ok((recipient, revisions)), Some(history)) = (agents.get(agent), &mut request.history)
        else {
            continue;
        };
        let mut prior_call = false;
        let mut edits = Vec::new();
        for entry in history.entries() {
            let content = match entry.message {
                Message::Assistant(_) => {
                    prior_call = revisions
                        .received
                        .is_some_and(|correction| entry.id < correction);
                    continue;
                }
                Message::User { content } => content,
                _ => continue,
            };
            let report = entry
                .author
                .and_then(|author| report_request(author, recipient));
            let obsolete_report = report.is_some_and(|(sender, at)| {
                revisions
                    .received
                    .is_some_and(|correction| at.reply < correction)
                    || revisions
                        .sent
                        .get(sender)
                        .is_some_and(|cutoff| at < *cutoff)
            });
            let replacement = if obsolete_report {
                let header = entry.author.and_then(Author::header).unwrap_or_default();
                Some((Message::user(format!("{header}\n{SUPERSEDED}")), false))
            } else if prior_call && content.iter().any(stale_tool_result) {
                let mut content = content.clone();
                for item in &mut content {
                    if stale_tool_result(item)
                        && let UserContent::ToolResult(result) = item
                    {
                        result.content = vec![ToolResultContent::text(SUPERSEDED)];
                        result.is_error = true;
                    }
                }
                Some((Message::User { content }, true))
            } else {
                None
            };
            if let Some((replacement, clear_facts)) = replacement
                && let Some(mut revised) = history.entry(entry.index)
            {
                revised.message = Arc::new(replacement);
                if clear_facts {
                    revised.facts = Default::default();
                }
                edits.push((entry.index, revised));
            }
        }
        for (index, entry) in edits {
            history.restore(index..index + 1, [entry], Author::plugin(REDIRECT_WORK));
        }
    }
}

fn stale_tool_result(content: &UserContent) -> bool {
    matches!(content, UserContent::ToolResult(result)
        if !matches!(result.name.as_str(), TASK | MESSAGE | WAIT))
}
