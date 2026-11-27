use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};

use axum::response::sse::Event;
use rig_basics::subagents::{MESSAGE, SpawnedAgent, TASK, WAIT};
use rig_core::completion::Message;
use rig_core::effect::EffectId;
use rig_harness::prelude::*;
use tokio::sync::mpsc;
use uuid::Uuid;

use super::recovery::{DeliveredReports, Journal};
use crate::api::ConversationCommand;
use crate::attachments::Stored as StoredAttachment;
use crate::duties::{self, DutyTurn};
use crate::host_tools::WorkspaceRoot;
use crate::store::{
    Admission, Conversation as StoredConversation, History, Role, work::Settlement,
};

const DELEGATION_GUIDANCE: &str = "\n\nWhen you delegate independent work, acknowledge what is \
    underway and end your turn so you can respond to new messages. Share relevant results as \
    reports arrive, using earlier reports when they help answer the request.";

pub(crate) enum AgentCommand {
    Message(TurnRequest),
    Recover(UserMessageSource),
    Duties { bot: Uuid, prompt: SystemPrompt },
}

pub(crate) struct TurnRequest {
    pub(crate) bot: Uuid,
    pub(crate) history: Option<StoredConversation>,
    pub(crate) message_id: i64,
    pub(crate) text: String,
    pub(crate) attachments: Vec<StoredAttachment>,
    pub(crate) model: Connection,
    pub(crate) stream: Option<ReplySink>,
}

/// A subscriber may fall behind or disconnect without holding up Rig or SQLite.
#[derive(Clone, Component)]
pub(crate) struct ReplySink(Arc<Mutex<Option<mpsc::Sender<Event>>>>);

impl ReplySink {
    pub(crate) fn new(stream: mpsc::Sender<Event>) -> Self {
        Self(Arc::new(Mutex::new(Some(stream))))
    }

    pub(crate) fn send(&self, event: Event) {
        let mut stream = self.0.lock().expect("reply sink lock poisoned");
        if stream
            .as_ref()
            .is_some_and(|sender| sender.try_send(event).is_err())
        {
            *stream = None;
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
#[derive(Component, Clone, Copy)]
pub(crate) struct ModelUserInput(pub(crate) MessageId);

impl ModelUserInput {
    pub(crate) fn text(self, history: &rig_core::conversation::Conversation) -> Option<&str> {
        let message = history.messages().get(history.index_of(self.0)?)?;
        let Message::User { content } = &**message else {
            return None;
        };
        let UserContent::Text(text) = content.first()? else {
            return None;
        };
        Some(&text.text)
    }
}

/// Tools explicitly offered to Bot Agents through Rig.
#[derive(Resource)]
pub(crate) struct ConversationTools {
    pub(crate) shared: Vec<&'static str>,
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
    started: usize,
    source: Option<(EffectId, UserMessageSource, ModelUserInput)>,
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
    pending: mpsc::UnboundedReceiver<AgentCommand>,
    deferred: VecDeque<AgentCommand>,
    outgoing: mpsc::UnboundedSender<ConversationCommand>,
    settled: Vec<(Entity, Vec<i64>)>,
}

pub(super) fn add(
    app: &mut App,
    pending: mpsc::UnboundedReceiver<AgentCommand>,
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
        deferred: VecDeque::new(),
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
        while let Ok(command) = conversations.pending.try_recv() {
            conversations.deferred.push_back(command);
        }
        let mut blocked = HashSet::new();
        let mut first = HashSet::new();
        for _ in 0..conversations.deferred.len() {
            let command = conversations
                .deferred
                .pop_front()
                .expect("deferred command");
            let request = match command {
                AgentCommand::Message(request) => {
                    if blocked.contains(&request.bot) {
                        conversations
                            .deferred
                            .push_back(AgentCommand::Message(request));
                        continue;
                    }
                    request
                }
                AgentCommand::Recover(source) => {
                    let root = conversations.roots.get(&source.bot).copied();
                    if !blocked.insert(source.bot)
                        || first.contains(&source.bot)
                        || root.is_some_and(|root| world.get::<ActiveTurn>(root).is_some())
                    {
                        conversations
                            .deferred
                            .push_back(AgentCommand::Recover(source));
                        continue;
                    }
                    let history = if root.is_some() {
                        History::Live
                    } else {
                        History::Restore
                    };
                    match world
                        .resource::<Journal>()
                        .store
                        .load_queued(source, history)
                    {
                        Ok(Some(Admission::Accepted {
                            history,
                            message_id,
                            text,
                            attachments,
                            model,
                        })) => TurnRequest {
                            bot: source.bot,
                            history,
                            message_id,
                            text,
                            attachments,
                            model,
                            stream: None,
                        },
                        Ok(None) => {
                            conversations
                                .deferred
                                .push_back(AgentCommand::Recover(source));
                            continue;
                        }
                        Ok(Some(_)) => unreachable!("queued work was already admitted"),
                        Err(error) => {
                            eprintln!("could not load queued Conversation work: {error:#}");
                            world.write_message(rig_harness::AppExit::error());
                            return;
                        }
                    }
                }
                AgentCommand::Duties { bot, prompt } => {
                    if let Some(&agent) = conversations.roots.get(&bot) {
                        world.entity_mut(agent).insert(prompt);
                    }
                    continue;
                }
            };
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
                let work_dir = world
                    .get_resource::<WorkspaceRoot>()
                    .map(|workspace| WorkDir(workspace.0.clone()));
                let mut agent = spawn_root(
                    world,
                    (
                        AgentId(bot.to_string()),
                        Name::new(history.bot.name),
                        duties::system_prompt(history.bot.duties.as_deref()),
                        BotAgent(bot),
                        conversation,
                        model,
                        choice,
                        tools,
                    ),
                );
                if let Some(dir) = work_dir {
                    agent.insert(dir);
                }
                let agent = agent.id();
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
            let connection = world
                .get::<Connection>(agent)
                .expect("a Bot has its admitted connection");
            for attachment in attachments {
                match attachment.into_part(&connection.spec) {
                    Ok(part) => incoming.parts.push(MessagePart::Attachment(part)),
                    Err(warning) => {
                        let _ = conversations.outgoing.send(ConversationCommand::Event {
                            bot,
                            name: "attachment_warning",
                            data: serde_json::to_value(warning)
                                .expect("serialize attachment warning"),
                            streams: stream.iter().cloned().collect(),
                        });
                    }
                }
            }
            let mut delivery = world.spawn((
                incoming,
                ForAgent(agent),
                UserMessageSource { bot, message_id },
            ));
            if let Some(stream) = stream {
                delivery.insert(stream);
            }
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
        turn.insert_if_new(DutyTurn::default());
    });
}

fn on_model_request(
    built: On<Add<ModelRequest>>,
    calls: Query<(&CallOf, &Effect, &ModelRequest), With<TurnCall>>,
    mut turns: Query<&mut TurnDelivery>,
    journal: Res<Journal>,
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
    if delivery.started < delivery.messages.len() {
        let sources = delivery.messages[delivery.started..]
            .iter()
            .map(|user| user.source)
            .collect();
        if !journal.start(sources) {
            call.try_insert_if_new(Outcome::refused("work could not be stored"));
            return;
        }
        delivery.started = delivery.messages.len();
    }
    call.insert(ModelDelivery {
        subscribers: delivery.streams.len(),
    });
    delivery.source = source.map(|(entry, source)| (effect.id(), source, ModelUserInput(entry)));
    if let Some((_, source, input)) = delivery.source {
        call.insert((source, input));
    }
}

fn on_tool_request(
    added: On<Add<ToolRequest>>,
    calls: Query<(&CallOf, &Effect, &ForAgent, &ToolRequest, &InReply)>,
    turns: Query<&TurnDelivery>,
    reports: Query<&DeliveredReports>,
    roots: Query<&BotAgent>,
    mut journal: ResMut<Journal>,
    mut commands: Commands,
) {
    let Ok((&CallOf(turn), effect, &ForAgent(agent), tool, place)) = calls.get(added.entity) else {
        return;
    };
    let input = turns
        .get(turn)
        .ok()
        .and_then(|delivery| delivery.source)
        .filter(|(id, ..)| effect.parent == Some(*id));
    let mut call = commands.entity(added.entity);
    if let Some((_, source, input)) = input {
        call.insert((source, input));
    }
    if let Ok(bot) = roots.get(agent)
        && let Some(origin) = journal.prepare_delegation(
            input.map(|(_, source, _)| source),
            reports.get(turn).ok(),
            bot.0,
            tool,
            place,
        )
    {
        call.insert(origin);
    }
}

type ReplySettlement = Or<(With<Turn>, (With<Incoming>, With<UserMessageSource>))>;

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
    let mut started = Vec::new();
    if let Ok(mut delivery) = deliveries.get_mut(added.entity) {
        started.extend(
            delivery.messages[..delivery.started]
                .iter()
                .map(|user| user.source.message_id),
        );
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
    conversations.settled.push((added.entity, started));
}

fn stream_deltas(
    mut deltas: MessageReader<StreamDelta>,
    calls: Query<(&CallOf, &ForAgent, Option<&ModelDelivery>), With<TurnCall>>,
    roots: Query<&BotAgent>,
    turns: Query<&TurnDelivery>,
    conversations: Res<Conversations>,
) {
    for delta in deltas.read() {
        let (StreamEvent::Text { text, .. }, Ok((&CallOf(turn), &ForAgent(agent), delivery))) =
            (&delta.event, calls.get(delta.effect))
        else {
            continue;
        };
        let Ok(&BotAgent(bot)) = roots.get(agent) else {
            continue;
        };
        let streams = delivery
            .and_then(|delivery| {
                turns
                    .get(turn)
                    .ok()
                    .map(|turn| turn.streams[..delivery.subscribers].to_vec())
            })
            .unwrap_or_default();
        let _ = conversations.outgoing.send(ConversationCommand::Event {
            bot,
            name: "delta",
            data: serde_json::Value::String(text.clone()),
            streams,
        });
    }
}

fn finish_turns(world: &mut World) {
    world.resource_scope(|world, mut conversations: Mut<Conversations>| {
        let conversations = &mut *conversations;
        for (settled, started) in conversations.settled.drain(..) {
            let Some(&ForAgent(agent)) = world.get::<ForAgent>(settled) else {
                continue;
            };
            let Some(&BotAgent(bot)) = world.get::<BotAgent>(agent) else {
                continue;
            };
            let undelivered = if world.get::<DeliveredIn>(settled).is_none() {
                world
                    .get::<UserMessageSource>(settled)
                    .map(|source| source.message_id)
            } else {
                None
            };
            let mut settled = world.entity_mut(settled);
            let answer = match settled.get::<TurnOutcome>() {
                Some(TurnOutcome::Answered(Message::Assistant(message))) => {
                    let text = message.text();
                    (!text.trim().is_empty()).then_some(text)
                }
                _ => None,
            };
            let duties = settled.take::<DutyTurn>().and_then(|turn| turn.replacement);
            let mut streams = settled
                .take::<TurnDelivery>()
                .map_or_else(Vec::new, |delivery| delivery.streams);
            if let Some(stream) = settled.take::<ReplySink>() {
                streams.push(stream);
            }
            let reports = settled
                .take::<DeliveredReports>()
                .map_or_else(Vec::new, |reports| reports.0);
            if answer.is_some()
                || !streams.is_empty()
                || !started.is_empty()
                || undelivered.is_some()
                || !reports.is_empty()
            {
                let _ = conversations.outgoing.send(ConversationCommand::Settled {
                    bot,
                    answer,
                    duties,
                    work: Settlement {
                        started,
                        undelivered,
                        reports,
                    },
                    streams,
                });
            }
        }
    });
}
