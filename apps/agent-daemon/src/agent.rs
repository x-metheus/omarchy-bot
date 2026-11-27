use std::path::Path;

use axum::response::sse::Event;
use bevy_log::LogPlugin;
use rig_core::completion::Message;
use rig_ecs::inbox::{Attachment, MessagePart};
use rig_ecs::retry::RetryPolicy;
use rig_harness::host::launcher::LauncherPlugin;
use rig_harness::host::session::SessionPlugin;
use rig_harness::prelude::*;
use tokio::runtime::Handle;
use tokio::sync::{mpsc, oneshot};

use crate::duties::{self, DutyTurn, SET_DUTIES};
use crate::recall::{RecallScope, TOOL_NAME};
use crate::store::{Conversation as StoredConversation, Role, Store};
use crate::user_memory::{self, FORGET_TOOL, INSPECT_TOOL, MemoryInput, REMEMBER_TOOL};

pub(crate) struct TurnRequest {
    pub(crate) history: StoredConversation,
    pub(crate) message_id: i64,
    pub(crate) model: Connection,
    pub(crate) prompt: String,
    pub(crate) attachments: Vec<Attachment>,
    pub(crate) stream: mpsc::Sender<Event>,
    pub(crate) finished: oneshot::Sender<TurnResult>,
}

pub(crate) struct TurnResult {
    pub(crate) answer: Option<String>,
    pub(crate) duties: Option<String>,
    pub(crate) stream: Option<mpsc::Sender<Event>>,
}

#[derive(Component)]
struct Reply {
    stream: Option<mpsc::Sender<Event>>,
    finished: oneshot::Sender<TurnResult>,
}

#[derive(Resource)]
struct Turns {
    pending: mpsc::UnboundedReceiver<TurnRequest>,
}

pub(crate) fn headless_app(
    pending: mpsc::UnboundedReceiver<TurnRequest>,
    runtime: Handle,
    scratch: &Path,
    store: &Store,
) -> App {
    // Provider diagnostics can include raw response bodies. Keep them inside Rig.

    let mut app = App::new();
    app.insert_resource(TokioRuntime(runtime))
        .insert_resource(RigHome(Home::at(scratch)))
        .add_plugins((
            HeadlessPlugins.build().disable::<LogPlugin>(),
            RigHarnessPlugins
                .build()
                .disable::<LauncherPlugin>()
                .disable::<SessionPlugin>(),
        ))
        // A provider retry could stream a second attempt after deltas from the first.
        .insert_resource(RetryPolicy {
            max_retries: 0,
            ..RetryPolicy::default()
        })
        .insert_resource(Turns { pending })
        .add_systems(PreUpdate, deliver)
        .add_systems(PostUpdate, (stream_deltas, finish_turns).chain());
    user_memory::install(&mut app, store);
    duties::register(&mut app);
    app
}

fn deliver(world: &mut World) {
    world.resource_scope(|world, mut turns: Mut<Turns>| {
        while let Ok(request) = turns.pending.try_recv() {
            let scope = RecallScope {
                bot_id: request.history.bot.id,
                through: request.message_id - 1,
            };
            let mut conversation = Conversation::default();
            for message in request.history.messages {
                conversation.push(match message.role {
                    Role::User => Message::user(message.text),
                    Role::Assistant => Message::assistant(message.text),
                });
            }
            let bot = request.history.bot;
            let agent = spawn_root(
                world,
                (
                    AgentId(bot.id.to_string()),
                    Name::new(bot.name),
                    conversation,
                    request.model,
                    duties::system_prompt(bot.duties.as_deref()),
                    ToolAccess::only([
                        REMEMBER_TOOL,
                        INSPECT_TOOL,
                        FORGET_TOOL,
                        SET_DUTIES,
                        TOOL_NAME,
                    ]),
                    DutyTurn::default(),
                    MemoryInput::new(bot.id, request.message_id, request.prompt.clone()),
                    scope,
                    Reply {
                        stream: Some(request.stream),
                        finished: request.finished,
                    },
                ),
            )
            .id();
            let mut delivery = Deliver::new(agent, request.prompt, DeliveryMode::Queue).literal();
            delivery
                .message
                .parts
                .extend(request.attachments.into_iter().map(MessagePart::Attachment));
            world.trigger(delivery);
        }
    });
}

fn stream_deltas(mut deltas: MessageReader<StreamDelta>, mut replies: Query<&mut Reply>) {
    for delta in deltas.read() {
        let (Some(agent), StreamEvent::Text { text, .. }) = (delta.agent, &delta.event) else {
            continue;
        };
        let Ok(mut reply) = replies.get_mut(agent) else {
            continue;
        };
        let Some(stream) = &reply.stream else {
            continue;
        };
        // Stop streaming to an absent or stalled client. Rig keeps running and
        // the client can read the committed Conversation on a new connection.
        if let Ok(slot) = stream.try_reserve() {
            slot.send(
                Event::default()
                    .event("delta")
                    .json_data(text)
                    .expect("serialize text delta"),
            );
        } else {
            reply.stream = None;
        }
    }
}

fn finish_turns(
    settled: Query<(&ForAgent, &TurnOutcome), Added<Settled>>,
    replies: Query<(), With<Reply>>,
    mut commands: Commands,
) {
    for (&ForAgent(agent), outcome) in &settled {
        if !replies.contains(agent) {
            continue;
        }
        let answer = match outcome {
            TurnOutcome::Answered(Message::Assistant(message)) => {
                let text = message.text();
                (!text.trim().is_empty()).then_some(text)
            }
            _ => None,
        };
        commands
            .entity(agent)
            .queue(move |mut agent: EntityWorldMut| {
                if let Some(reply) = agent.take::<Reply>() {
                    let duties = agent.take::<DutyTurn>().and_then(|turn| turn.replacement);
                    agent.despawn();
                    let _ = reply.finished.send(TurnResult {
                        answer,
                        duties,
                        stream: reply.stream,
                    });
                }
            });
    }
}
