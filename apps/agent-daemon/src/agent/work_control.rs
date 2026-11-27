use bevy_ecs::relationship::RelationshipTarget;
use rig_basics::subagents::{Lifecycle, Subtask};
use rig_harness::prelude::{
    ActiveTurn, Add, AgentId, AgentTitle, App, AppToolsExt, Commands, Conversation, Decider,
    Decision, Entity, Has, On, PromptSection, Query, SectionOf, Spawned, StopTurn, ToolCalled,
    ToolExecutionError, ToolOptions, ToolResult, Touches, With,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;

use super::conversation::{BotAgent, ConversationTools, ModelUserInput};

const WORK_STATUS: &str = "work_status";
const STOP_WORK: &str = "stop_work";

const BOT_GUIDANCE: &str = "When the user asks about ongoing work, use work_status and the reports \
    you have received. Say what is running or waiting without interrupting it. If a request to \
    change or stop work could refer to more than one operation, ask which one and leave them \
    running. Send a clear correction with message to the specific Subagent, including every \
    dependent part it must update. Leave independent Subagents working. Acknowledge the change \
    and let the corrected work report back. Treat output based on superseded instructions as \
    obsolete even if it arrives later. Use only current results for the revised answer. When the \
    user explicitly asks to stop a specific operation, use stop_work on its Subagent. Explain \
    any uncertainty about side effects already in flight.";

const SUBAGENT_GUIDANCE: &str = "Follow corrections from your parent Agent before acting on or \
    reporting results. A result from earlier instructions can arrive after a correction. Treat \
    it as obsolete where it conflicts with the correction, redo the affected lookup or work, \
    and update any conclusions that depend on it before you report.";

pub(super) fn install(app: &mut App) {
    app.world_mut()
        .resource_mut::<ConversationTools>()
        .root_only
        .extend([WORK_STATUS, STOP_WORK]);
    app.add_observer(|added: On<Add<BotAgent>>, mut commands: Commands| {
        commands.spawn((guidance(BOT_GUIDANCE), SectionOf(added.entity)));
    })
    .add_observer(|added: On<Add<Subtask>>, mut commands: Commands| {
        commands.spawn((guidance(SUBAGENT_GUIDANCE), SectionOf(added.entity)));
    })
    .add_open_tool(
        WORK_STATUS,
        "List the IDs, titles, and current activity of your ongoing Subagents without affecting them.",
        ToolOptions { footprint: Some(Touches::Independent) },
        work_status,
    )
    .add_open_tool(
        STOP_WORK,
        "Stop one ongoing Subagent and the work it delegated. Use only for an explicit user \
         cancellation that identifies one operation. Ask for clarification if the target is unclear.",
        ToolOptions::default(),
        stop_work,
    );
}

fn guidance(text: &str) -> PromptSection {
    PromptSection::new(PromptSection::ORDER_ROLE + 2, "conversation_work", text)
}

type Tasks<'w, 's> = Query<
    'w,
    's,
    (
        Entity,
        &'static AgentId,
        &'static AgentTitle,
        &'static Lifecycle,
        Has<ActiveTurn>,
    ),
    With<Subtask>,
>;

fn activity(lifecycle: &Lifecycle, active: bool) -> Option<&'static str> {
    match (lifecycle, active) {
        (_, true) | (Lifecycle::Working, false) => Some("running"),
        (Lifecycle::WaitingOn(_), false) => Some("waiting for delegated work"),
        (Lifecycle::Finished(_), false) => None,
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct StatusArgs {}

fn work_status(
    called: On<ToolCalled<StatusArgs>>,
    roots: Query<Option<&Spawned>, With<BotAgent>>,
    tasks: Tasks,
    mut decisions: Query<&mut Decision>,
) {
    let (Ok(children), Ok(mut decision)) =
        (roots.get(called.agent), decisions.get_mut(called.call))
    else {
        return;
    };
    if decision.is_decided() {
        return;
    }
    let work: Vec<_> = children
        .into_iter()
        .flat_map(Spawned::iter)
        .filter_map(|child| {
            let (_, id, title, lifecycle, active) = tasks.get(child).ok()?;
            let state = activity(lifecycle, active)?;
            Some(json!({"agent": id.0, "title": title.0, "state": state}))
        })
        .collect();
    decision.decide(
        Decider::plugin(WORK_STATUS),
        ToolResult::success(json!(work).into()),
    );
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct StopArgs {
    /// The ID from task or work_status for the one operation the user identified.
    agent: String,
    /// An exact quote of the cancellation request from the latest user message.
    evidence: String,
}

fn stop_work(
    called: On<ToolCalled<StopArgs>>,
    roots: Query<(&Conversation, Option<&Spawned>), With<BotAgent>>,
    tasks: Tasks,
    inputs: Query<&ModelUserInput>,
    mut decisions: Query<&mut Decision>,
    mut commands: Commands,
) {
    let (Ok((conversation, children)), Ok(mut decision)) =
        (roots.get(called.agent), decisions.get_mut(called.call))
    else {
        return;
    };
    if decision.is_decided() {
        return;
    }
    let evidence = called.args.evidence.trim();
    let from_user = !evidence.is_empty()
        && inputs
            .get(called.call)
            .ok()
            .and_then(|input| input.text(conversation))
            .is_some_and(|text| text.contains(evidence));
    let wanted = called.args.agent.trim();
    let mut targets = children
        .into_iter()
        .flat_map(Spawned::iter)
        .filter_map(|child| tasks.get(child).ok())
        .filter(|(_, id, ..)| id.0 == wanted || id.short() == wanted);
    let result = match (from_user, targets.next(), targets.next()) {
        (true, Some((target, _, title, lifecycle, active)), None)
            if activity(lifecycle, active).is_some() =>
        {
            commands.trigger(StopTurn::new(target));
            ToolResult::success(
                format!(
                    "Stop requested for {}. Any external action already dispatched may have run.",
                    title.0
                )
                .into(),
            )
        }
        _ => ToolResult::failed(ToolExecutionError::refused(
            "Stopping work requires an exact cancellation quote from the latest user message \
             and one ongoing Subagent ID from this Conversation. Use work_status to check the target.",
        )),
    };
    decision.decide(Decider::plugin(STOP_WORK), result);
}
