use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::response::sse::Event;
use rig_basics::subagents::{MESSAGE, SpawnedAgent, TASK, WAIT};
use rig_core::completion::Message;
use rig_core::effect::EffectId;
use rig_harness::prelude::*;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::api::{ConversationCommand, event};
use crate::attachments::Stored as StoredAttachment;
use crate::store::{Conversation as StoredConversation, Role};

const DELEGATION_GUIDANCE: &str = "\n\nWhen you delegate independent work, acknowledge what is \
    underway and end your turn so you can respond to new messages. Share relevant results as \
    reports arrive, using earlier reports when they help answer the request.";

pub(crate) struct TurnRequest {
    pub(crate) bot: Uuid,
    pub(crate) history: Option<StoredConversation>,
    pub(crate) message_id: i64,
    pub(crate) text: String,
    pub(crate) attachments: Vec<StoredAttachment>,
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

/// The authored input's Rig Conversation entry in this model request.
#[derive(Component)]
pub(crate) struct ModelUserInput(pub(crate) MessageId);

/// Tools explicitly offered to Bot Agents through Rig.
#[derive(Resource)]
pub(crate) struct ConversationTools {
    shared: Vec<&'static str>,
    pub(crate) root_only: Vec<&'static str>,
}

struct DeliveredUser {
    id: MessageId,
    source: UserMessageSource,
    original: Entry,
    had_attachments: bool,
}

#[derive(Component, Default)]
pub(crate) struct TurnDelivery {
    streams: Vec<ReplySink>,
    messages: Vec<DeliveredUser>,
    source: Option<(EffectId, UserMessageSource)>,
}

impl TurnDelivery {
    pub(crate) fn first_user(&self) -> Option<UserMessageSource> {
        self.messages.first().map(|user| user.source)
    }
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
    let world = app.world_mut();
    let mut tools = world.query::<&mut ToolDef>();
    if let Some(mut task) = tools
        .iter_mut(world)
        .find(|tool| tool.0.name.as_str() == TASK)
    {
        Arc::make_mut(&mut task.0)
            .description
            .push_str(DELEGATION_GUIDANCE);
    }
    app.insert_resource(Conversations {
        roots: HashMap::new(),
        pending,
        outgoing,
        settled: Vec::new(),
    })
    .insert_resource(ConversationTools {
        shared: vec![TASK, MESSAGE, WAIT],
        root_only: Vec::new(),
    })
    .add_observer(limit_subagent_tools)
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
                message_id,
                text,
                attachments,
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
                let tools = world.resource::<ConversationTools>();
                let tools = ToolAccess::only(tools.shared.iter().chain(&tools.root_only).copied());
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
            let mut incoming = Incoming::new(text, DeliveryMode::Steer).literal();
            let mut stream = stream;
            let connection = world
                .get::<Connection>(agent)
                .expect("a Bot has its admitted connection");
            for attachment in attachments {
                match attachment.into_part(&connection.spec) {
                    Ok(part) => incoming.parts.push(MessagePart::Attachment(part)),
                    Err(warning) => stream.send(event("attachment_warning", warning)),
                }
            }
            world.spawn((
                incoming,
                ForAgent(agent),
                UserMessageSource { bot, message_id },
                stream,
            ));
        }
    });
}

fn limit_subagent_tools(
    added: On<Add<SpawnedAgent>>,
    spawned: Query<&SpawnedAgent>,
    access: Query<&ToolAccess>,
    tools: Res<ConversationTools>,
    mut commands: Commands,
) {
    let Ok(&SpawnedAgent(child)) = spawned.get(added.entity) else {
        return;
    };
    if let Ok(access) = access.get(child) {
        commands
            .entity(child)
            .insert(access.narrow(tools.shared.iter().copied()));
    }
}

fn on_delivery(
    delivered: On<Add<DeliveredIn>>,
    incoming: Query<(&DeliveredIn, &DeliveredAs, &UserMessageSource, &ForAgent)>,
    mut commands: Commands,
) {
    let Ok((&DeliveredIn(turn), &DeliveredAs(entry), &source, &ForAgent(agent))) =
        incoming.get(delivered.entity)
    else {
        return;
    };
    let entity = delivered.entity;
    commands.queue(move |world: &mut World| {
        let stream = world.entity_mut(entity).take::<ReplySink>();
        let conversation = world
            .get::<Conversation>(agent)
            .expect("the addressed Agent owns a Conversation");
        let index = conversation
            .index_of(entry)
            .expect("Rig recorded the delivered entry");
        let mut original = conversation
            .entry(index)
            .expect("the delivered entry is in the Conversation");
        let mut had_attachments = false;
        if let Message::User { content } = &*original.message
            && let [text, _, ..] = content.as_slice()
        {
            original.message = Arc::new(Message::User {
                content: vec![text.clone()],
            });
            had_attachments = true;
        }
        let mut turn = world.entity_mut(turn);
        let mut delivery = turn.entry::<TurnDelivery>().or_default().into_mut();
        debug_assert!(delivery.messages.last().is_none_or(|prev| {
            prev.source.bot == source.bot && prev.source.message_id < source.message_id
        }));
        delivery.messages.push(DeliveredUser {
            id: entry,
            source,
            original,
            had_attachments,
        });
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
            .find(|delivered| history.index_of(delivered.id).is_some())
            .map(|delivered| (delivered.id, delivered.source))
    });
    let mut call = commands.entity(built.entity);
    call.insert(ModelDelivery {
        subscribers: delivery.streams.len(),
    });
    delivery.source = source.map(|(_, source)| (effect.id(), source));
    if let Some((entry, source)) = source {
        call.insert((source, ModelUserInput(entry)));
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

type ReplySettlement = Or<(With<Turn>, With<ReplySink>)>;

fn on_settled(
    added: On<Add<Settled>>,
    settled: Query<&ForAgent, ReplySettlement>,
    mut deliveries: Query<&mut TurnDelivery>,
    mut roots: Query<&mut Conversation, With<BotAgent>>,
    mut conversations: ResMut<Conversations>,
) {
    let Ok(&ForAgent(agent)) = settled.get(added.entity) else {
        return;
    };
    let Ok(mut conversation) = roots.get_mut(agent) else {
        return;
    };
    if let Ok(mut delivery) = deliveries.get_mut(added.entity) {
        // Keep committed inputs after Rig recalls failed text, and retire attachment payloads
        // before a subsequent Turn can reuse this Conversation.
        for user in delivery.messages.drain(..) {
            let range = match conversation.index_of(user.id) {
                Some(index) if user.had_attachments => index..index + 1,
                Some(_) => continue,
                None => {
                    let index = conversation
                        .entries()
                        .position(|entry| entry.id > user.id)
                        .unwrap_or_else(|| conversation.messages().len());
                    index..index
                }
            };
            conversation.restore(range, [user.original], Author::plugin("omarchy-daemon"));
        }
    }
    conversations.settled.push(added.entity);
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
