use std::path::Path;

use anyhow::{Result, anyhow};
use axum::response::sse::Event;
use bevy_log::LogPlugin;
use rig_core::catalog::ModelSpec;
use rig_core::completion::Message;
use rig_core::operation::Completion;
use rig_core::providers::openai::OpenAI;
use rig_core::providers::registry::ProviderId;
use rig_core::serve::ErasedHandler;
use rig_core::serve::adapters::ModelAdapter;
use rig_ecs::effects::Handler;
use rig_ecs::retry::RetryPolicy;
use rig_harness::host::launcher::LauncherPlugin;
use rig_harness::host::session::SessionPlugin;
use rig_harness::prelude::*;
use tokio::runtime::Handle;
use tokio::sync::{mpsc, oneshot};

use crate::store::{Conversation as StoredConversation, Role};

pub(crate) struct TurnRequest {
    pub(crate) history: StoredConversation,
    pub(crate) prompt: String,
    pub(crate) stream: mpsc::Sender<Event>,
    pub(crate) finished: oneshot::Sender<TurnResult>,
}

pub(crate) struct TurnResult {
    pub(crate) answer: Option<String>,
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
    model: Connection,
}

pub(crate) fn headless_app(
    model: String,
    pending: mpsc::UnboundedReceiver<TurnRequest>,
    runtime: Handle,
    scratch: &Path,
) -> Result<App> {
    // Provider diagnostics can include raw response bodies. Keep them inside Rig.
    let client = OpenAI::from_env().map_err(|_| {
        anyhow!("invalid OpenAI environment; check OPENAI_API_KEY and OPENAI_BASE_URL")
    })?;
    let provider = ProviderId::catalog("openai")
        .ok_or_else(|| anyhow!("Rig OpenAI provider is unavailable"))?;
    let spec = ModelSpec::new(provider, model.clone());
    let handler = ModelAdapter::<Completion>::new(spec.reference(), client.chat(model));
    let model = Connection {
        spec: spec.into(),
        handler: Handler(ErasedHandler::new(handler)),
    };

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
        .insert_resource(Turns { pending, model })
        .add_systems(PreUpdate, deliver)
        .add_systems(PostUpdate, (stream_deltas, finish_turns).chain());
    Ok(app)
}

fn deliver(world: &mut World) {
    world.resource_scope(|world, mut turns: Mut<Turns>| {
        while let Ok(request) = turns.pending.try_recv() {
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
                    turns.model.clone(),
                    ToolAccess::only([]),
                    Reply {
                        stream: Some(request.stream),
                        finished: request.finished,
                    },
                ),
            )
            .id();
            world.trigger(Deliver::new(agent, request.prompt, DeliveryMode::Queue).literal());
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
                    agent.despawn();
                    let _ = reply.finished.send(TurnResult {
                        answer,
                        stream: reply.stream,
                    });
                }
            });
    }
}
