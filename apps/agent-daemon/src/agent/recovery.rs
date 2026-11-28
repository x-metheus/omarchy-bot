//! Rig lifecycle signals for work that survives only as durable state on restart.

use std::collections::HashMap;
use std::sync::mpsc as sync;

use rig_basics::subagents::{MESSAGE, Report as RigReport, SpawnedAgent, TASK};
use rig_harness::AppExit;
use rig_harness::prelude::*;
use tokio::sync::mpsc;
use uuid::Uuid;

use super::conversation::{BotAgent, UserMessageSource};
use super::redirect::REDIRECT_WORK;
use crate::api::ConversationCommand;
use crate::store::{Store, work::Report};

#[derive(Resource)]
pub(super) struct Journal {
    pub(super) store: Store,
    outgoing: mpsc::UnboundedSender<ConversationCommand>,
    messages: HashMap<String, UserMessageSource>,
}

#[derive(Component)]
pub(super) struct Delegation {
    source: UserMessageSource,
    request: String,
}

#[derive(Component, Default)]
pub(super) struct DeliveredReports(pub(super) Vec<Report>);

pub(super) fn register(
    app: &mut App,
    store: &Store,
    outgoing: mpsc::UnboundedSender<ConversationCommand>,
) {
    app.insert_resource(Journal {
        store: store.clone(),
        outgoing,
        messages: HashMap::new(),
    })
    .add_observer(on_spawned)
    .add_observer(on_message)
    .add_observer(on_tool_settled)
    .add_observer(on_report);
}

impl Journal {
    pub(super) fn discard_bot(&mut self, bot: Uuid) {
        self.messages.retain(|_, source| source.bot != bot);
    }

    // Wait for the Conversation writer before Rig can enter Start for these inputs.
    pub(super) fn start(&self, sources: Vec<UserMessageSource>) -> bool {
        let (committed, result) = sync::sync_channel(1);
        self.outgoing
            .send(ConversationCommand::Started { sources, committed })
            .is_ok()
            && result.recv().unwrap_or(false)
    }

    fn delegate(&self, source: UserMessageSource, request: String, agent: String) -> bool {
        let (committed, result) = sync::sync_channel(1);
        self.outgoing
            .send(ConversationCommand::Delegated {
                source,
                report: Report { request, agent },
                committed,
            })
            .is_ok()
            && result.recv().unwrap_or(false)
    }

    pub(super) fn prepare_delegation(
        &mut self,
        source: Option<UserMessageSource>,
        reports: Option<&DeliveredReports>,
        bot: Uuid,
        tool: &ToolRequest,
        place: &InReply,
    ) -> Option<Delegation> {
        let name = tool.call.function.name.as_str();
        if !matches!(name, TASK | MESSAGE | REDIRECT_WORK) {
            return None;
        }
        let source = source.or_else(|| {
            let report = reports?.0.last()?;
            match self.store.report_source(bot, report) {
                Ok(source) => source,
                Err(_) => {
                    tracing::error!(
                        code = "delegation_provenance_failed",
                        "Could not read delegation provenance"
                    );
                    None
                }
            }
        })?;
        // This is the request identifier used by SubagentsPlugin::task and ::message.
        let request = format!("{bot}:{}", place.at().wire());
        if matches!(name, MESSAGE | REDIRECT_WORK) {
            self.messages.insert(request.clone(), source);
        }
        Some(Delegation { source, request })
    }
}

fn on_spawned(
    added: On<Add<SpawnedAgent>>,
    spawns: Query<(&ChildOf, &SpawnedAgent)>,
    origins: Query<&Delegation>,
    agents: Query<&AgentId>,
    journal: Res<Journal>,
    mut commands: Commands,
) {
    let Ok((parent, &SpawnedAgent(child))) = spawns.get(added.entity) else {
        return;
    };
    let (Ok(origin), Ok(agent)) = (origins.get(parent.parent()), agents.get(child)) else {
        return;
    };
    if !journal.delegate(origin.source, origin.request.clone(), agent.0.clone()) {
        commands.write_message(AppExit::error());
    }
}

fn on_message(
    added: On<Add<Incoming>>,
    incoming: Query<(&Incoming, &ForAgent)>,
    agents: Query<&AgentId, Without<BotAgent>>,
    mut journal: ResMut<Journal>,
    mut commands: Commands,
) {
    let Ok((message, &ForAgent(target))) = incoming.get(added.entity) else {
        return;
    };
    let (Some(request), Ok(agent)) = (&message.author.request, agents.get(target)) else {
        return;
    };
    if let Some(source) = journal.messages.remove(&request.0)
        && !journal.delegate(source, request.0.clone(), agent.0.clone())
    {
        commands
            .entity(added.entity)
            .try_insert_if_new(Outcome::refused("work could not be stored"));
        commands.write_message(AppExit::error());
    }
}

fn on_tool_settled(
    added: On<Add<Settled>>,
    calls: Query<&Delegation>,
    mut journal: ResMut<Journal>,
) {
    if let Ok(origin) = calls.get(added.entity) {
        journal.messages.remove(&origin.request);
    }
}

fn on_report(
    delivered: On<Add<DeliveredAs>>,
    reports: Query<(&Incoming, &ForAgent, Option<&DeliveredIn>), With<RigReport>>,
    roots: Query<&BotAgent>,
    journal: Res<Journal>,
    mut commands: Commands,
) {
    let Ok((incoming, &ForAgent(root), turn)) = reports.get(delivered.entity) else {
        return;
    };
    let (Some(agent), Some(request), Ok(&BotAgent(bot))) = (
        &incoming.author.from,
        &incoming.author.request,
        roots.get(root),
    ) else {
        return;
    };
    let report = Report {
        request: request.0.clone(),
        agent: agent.clone(),
    };
    if let Some(&DeliveredIn(turn)) = turn {
        commands
            .entity(turn)
            .entry::<DeliveredReports>()
            .or_default()
            .and_modify(|mut reports| reports.0.push(report));
    } else {
        let _ = journal
            .outgoing
            .send(ConversationCommand::ConsumedReport { bot, report });
    }
}
