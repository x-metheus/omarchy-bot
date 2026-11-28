//! Forward the owning Bot's Rig tool lifecycle without tool request or result data.

use std::collections::HashMap;

use rig_core::effect::{Answered, Disposition, EffectId};
use rig_harness::prelude::*;
use tokio::sync::mpsc;
use uuid::Uuid;

use super::conversation::BotAgent;
use crate::api::ConversationCommand;
use crate::store::{ToolProgress, ToolStatus};

#[derive(Resource)]
pub(super) struct Progress {
    outgoing: mpsc::UnboundedSender<ConversationCommand>,
    active: HashMap<EffectId, (Uuid, ToolProgress)>,
}

pub(super) fn add(app: &mut App, outgoing: mpsc::UnboundedSender<ConversationCommand>) {
    app.insert_resource(Progress {
        outgoing,
        active: HashMap::new(),
    })
    .add_observer(started);
}

fn started(
    started: On<Add<Started>>,
    calls: Query<(&Effect, &ForAgent, &ToolRequest)>,
    agents: Query<(Option<&BotAgent>, Option<&SpawnedBy>)>,
    mut progress: ResMut<Progress>,
) {
    let Ok((effect, &ForAgent(mut agent), request)) = calls.get(started.entity) else {
        return;
    };
    let bot = loop {
        match agents.get(agent) {
            Ok((Some(bot), _)) => break bot.0,
            Ok((None, Some(parent))) => agent = parent.parent(),
            _ => return,
        }
    };
    let event = ToolProgress {
        id: Uuid::new_v4(),
        name: request.call.function.name.to_string(),
        status: ToolStatus::Running,
    };
    let _ = progress.outgoing.send(ConversationCommand::Tool {
        bot,
        event: event.clone(),
    });
    progress.active.insert(effect.id(), (bot, event));
}

pub(super) fn settled(mut records: MessageReader<EffectRecorded>, mut progress: ResMut<Progress>) {
    for EffectRecorded(record) in records.read() {
        let Some((bot, mut event)) = progress.active.remove(&record.id) else {
            continue;
        };
        event.status = match record.disposition {
            Disposition::Cancelled
            | Disposition::Superseded
            | Disposition::AnsweredWhileRunning => ToolStatus::Cancelled,
            _ => match record.reviewed.as_ref().unwrap_or(&record.outcome) {
                Ok(Answered::ToolResult { result }) if !result.is_error() => ToolStatus::Completed,
                _ => ToolStatus::Failed,
            },
        };
        let _ = progress
            .outgoing
            .send(ConversationCommand::Tool { bot, event });
    }
}
