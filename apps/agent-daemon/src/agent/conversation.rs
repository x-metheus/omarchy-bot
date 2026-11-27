use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::response::sse::Event;
use rig_basics::subagents::{MESSAGE, TASK, WAIT};
use rig_core::completion::Message;
use rig_core::effect::EffectId;
use rig_harness::prelude::*;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::api::{ConversationCommand, event};
use crate::store::{Conversation as StoredConversation, Message as StoredMessage, Role};

const DELEGATION_PROMPT: &str = "Use task for independent work that can continue in the background. \
    When you delegate, acknowledge what is underway and end your turn so you can respond to new \
    messages while the subagents work. Their reports arrive here. Respond to the user with the \
    relevant results as they arrive, using earlier reports when they help answer the request.";

pub(crate) struct TurnRequest {
    pub(crate) bot: Uuid,
    pub(crate) history: Option<StoredConversation>,
    pub(crate) message: StoredMessage,
    pub(crate) model: Connection,
    pub(crate) stream: ReplySink,
}

/// A subscriber may fall behind or disconnect without holding up Rig or SQLite.
#[derive(Component)]
pub(crate) struct ReplySink(Option<mpsc::Sender<Event>>);

impl ReplySink {
    pub(crate) fn new(stream: mpsc::Sender<Event>) -> Self {
        Self(Some(stream))
    }

    pub(crate) fn send(&mut self, event: Event) {
        if self
            .0
            .as_ref()
            .is_some_and(|stream| stream.try_send(event).is_err())
        {
            self.0 = None;
        }
    }
}

/// The Bot that owns this root Agent and its Conversation.
#[derive(Component)]
pub(crate) struct BotAgent(pub(crate) Uuid);

/// Durable provenance on an HTTP Inbox delivery and the model and tool calls it informs.
#[derive(Component, Clone, Copy, Debug)]
pub(crate) struct UserMessageSource {
    pub(crate) bot: Uuid,
    pub(crate) message_id: i64,
}

/// Tools explicitly offered to Bot Agents through Rig.
#[derive(Resource)]
pub(crate) struct ConversationTools(pub(crate) Vec<&'static str>);

#[derive(Component, Default)]
struct TurnDelivery {
    streams: Vec<ReplySink>,
    messages: Vec<(MessageId, UserMessageSource)>,
    source: Option<(EffectId, UserMessageSource)>,
}

#[derive(Component)]
struct ModelDelivery {
    subscribers: usize,
}

#[derive(Resource)]
struct Conversations {
    roots: HashMap<Uuid, Entity>,
    pending: mpsc::UnboundedReceiver<TurnRequest>,
    outgoing: mpsc::UnboundedSender<ConversationCommand>,
    settled: Vec<Entity>,
}

pub(super) fn add(
    app: &mut App,
    pending: mpsc::UnboundedReceiver<TurnRequest>,
    outgoing: mpsc::UnboundedSender<ConversationCommand>,
) {
    app.insert_resource(Conversations {
        roots: HashMap::new(),
        pending,
        outgoing,
        settled: Vec::new(),
    })
    .insert_resource(ConversationTools(vec![TASK, MESSAGE, WAIT]))
    .add_observer(on_delivery)
    .add_observer(on_model_request)
    .add_observer(on_tool_request)
    .add_observer(on_settled)
    .add_systems(PreUpdate, deliver)
    .add_systems(PostUpdate, (stream_deltas, finish_turns).chain());
}

fn deliver(world: &mut World) {
    world.resource_scope(|world, mut conversations: Mut<Conversations>| {
        let mut first = HashSet::new();
        while let Ok(request) = conversations.pending.try_recv() {
            let TurnRequest {
                bot,
                history,
                message,
                model,
                stream,
            } = request;
            let agent = if let Some(history) = history {
                let mut conversation = Conversation::default();
                conversation.extend(history.messages.into_iter().map(
                    |message| match message.role {
                        Role::User => Message::user(message.text),
                        Role::Assistant => Message::assistant(message.text),
                    },
                ));
                let tools =
                    ToolAccess::only(world.resource::<ConversationTools>().0.iter().copied());
                let choice = ModelChoice(model.spec.reference());
                let agent = spawn_root(
                    world,
                    (
                        AgentId(bot.to_string()),
                        Name::new(history.bot.name),
                        BotAgent(bot),
                        conversation,
                        model,
                        choice,
                        tools,
                    ),
                )
                .id();
                world.spawn((
                    PromptSection::new(PromptSection::ORDER_ROLE, "delegation", DELEGATION_PROMPT),
                    SectionOf(agent),
                ));
                conversations.roots.insert(bot, agent);
                first.insert(bot);
                agent
            } else {
                let agent = conversations.roots[&bot];
                // Rig can accept several messages into one new Turn in the same frame.
                if world.get::<ActiveTurn>(agent).is_none()
                    && first.insert(bot)
                    && world
                        .get::<Connection>(agent)
                        .is_none_or(|old| !Arc::ptr_eq(&old.spec, &model.spec))
                {
                    let choice = ModelChoice(model.spec.reference());
                    world.entity_mut(agent).insert((model, choice));
                }
                agent
            };
            world.spawn((
                Incoming::new(message.text, DeliveryMode::Steer).literal(),
                ForAgent(agent),
                UserMessageSource {
                    bot,
                    message_id: message.id,
                },
                stream,
            ));
        }
    });
}

fn on_delivery(
    delivered: On<Add<DeliveredIn>>,
    incoming: Query<(&DeliveredIn, &DeliveredAs, &UserMessageSource)>,
    mut commands: Commands,
) {
    let Ok((&DeliveredIn(turn), &DeliveredAs(entry), &source)) = incoming.get(delivered.entity)
    else {
        return;
    };
    let entity = delivered.entity;
    commands.queue(move |world: &mut World| {
        let stream = world.entity_mut(entity).take::<ReplySink>();
        let mut turn = world.entity_mut(turn);
        let mut delivery = turn.entry::<TurnDelivery>().or_default().into_mut();
        debug_assert!(delivery.messages.last().is_none_or(|(_, prev)| {
            prev.bot == source.bot && prev.message_id < source.message_id
        }));
        delivery.messages.push((entry, source));
        delivery.streams.extend(stream);
    });
}

fn on_model_request(
    built: On<Add<ModelRequest>>,
    calls: Query<(&CallOf, &Effect, &ModelRequest), With<TurnCall>>,
    mut turns: Query<&mut TurnDelivery>,
    mut commands: Commands,
) {
    let Ok((&CallOf(turn), effect, request)) = calls.get(built.entity) else {
        return;
    };
    let Ok(mut delivery) = turns.get_mut(turn) else {
        return;
    };
    let source = request.history.as_ref().and_then(|history| {
        delivery
            .messages
            .iter()
            .rev()
            .find_map(|(entry, source)| history.index_of(*entry).map(|_| *source))
    });
    let mut call = commands.entity(built.entity);
    call.insert(ModelDelivery {
        subscribers: delivery.streams.len(),
    });
    delivery.source = source.map(|source| (effect.id(), source));
    if let Some(source) = source {
        call.insert(source);
    }
}

fn on_tool_request(
    added: On<Add<ToolRequest>>,
    calls: Query<(&CallOf, &Effect)>,
    turns: Query<&TurnDelivery>,
    mut commands: Commands,
) {
    let Ok((&CallOf(turn), effect)) = calls.get(added.entity) else {
        return;
    };
    if let Some((id, source)) = turns.get(turn).ok().and_then(|delivery| delivery.source)
        && effect.parent == Some(id)
    {
        commands.entity(added.entity).insert(source);
    }
}

fn on_settled(
    added: On<Add<Settled>>,
    settled: Query<&ForAgent, Or<(With<Turn>, With<ReplySink>)>>,
    roots: Query<(), With<BotAgent>>,
    mut conversations: ResMut<Conversations>,
) {
    if settled
        .get(added.entity)
        .is_ok_and(|&ForAgent(agent)| roots.contains(agent))
    {
        conversations.settled.push(added.entity);
    }
}

fn stream_deltas(
    mut deltas: MessageReader<StreamDelta>,
    calls: Query<(&CallOf, &ModelDelivery)>,
    mut turns: Query<&mut TurnDelivery>,
) {
    for delta in deltas.read() {
        let (StreamEvent::Text { text, .. }, Ok((&CallOf(turn), delivery))) =
            (&delta.event, calls.get(delta.effect))
        else {
            continue;
        };
        let Ok(mut turn) = turns.get_mut(turn) else {
            continue;
        };
        let subscribers = &mut turn.streams[..delivery.subscribers];
        if !subscribers.is_empty() {
            let delta = event("delta", text);
            for subscriber in subscribers {
                subscriber.send(delta.clone());
            }
        }
    }
}

fn finish_turns(world: &mut World) {
    world.resource_scope(|world, mut conversations: Mut<Conversations>| {
        let conversations = &mut *conversations;
        for settled in conversations.settled.drain(..) {
            let Some(&ForAgent(agent)) = world.get::<ForAgent>(settled) else {
                continue;
            };
            let Some(&BotAgent(bot)) = world.get::<BotAgent>(agent) else {
                continue;
            };
            let mut settled = world.entity_mut(settled);
            let answer = match settled.get::<TurnOutcome>() {
                Some(TurnOutcome::Answered(Message::Assistant(message))) => {
                    let text = message.text();
                    (!text.trim().is_empty()).then_some(text)
                }
                _ => None,
            };
            let mut streams = settled
                .take::<TurnDelivery>()
                .map_or_else(Vec::new, |delivery| delivery.streams);
            if let Some(stream) = settled.take::<ReplySink>() {
                streams.push(stream);
            }
            if answer.is_some() || !streams.is_empty() {
                let _ = conversations.outgoing.send(ConversationCommand::Settled {
                    bot,
                    answer,
                    streams,
                });
            }
        }
    });
}
