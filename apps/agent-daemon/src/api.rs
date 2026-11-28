mod desktop;
mod events;
mod pairing;
mod providers;

use std::collections::HashSet;
use std::convert::Infallible;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::middleware;
use axum::response::sse::Event;
use axum::response::{IntoResponse, Response, Sse};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use rig_core::conversation::MessageId;
use rig_harness::prelude::Wake;
use ring::digest::Digest;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};
use tokio_stream::StreamExt;
use tokio_stream::wrappers::ReceiverStream;
use uuid::Uuid;

use crate::agent::conversation::UserMessageSource;
use crate::agent::{AgentCommand, ReplySink, TurnRequest};
use crate::attachments::{Input as AttachmentInput, MAX_ATTACHMENTS, Submission};
use crate::desktop_tools::{Desktops, Target};
use crate::duties;
use crate::recall::{Availability, Recall};
use crate::settings::providers::{Error as ProviderError, Mutation, Status as ProviderStatus};
use crate::settings::{SettingsStatus, SettingsUpdate, Update};
use crate::store::work::{Report, Retry, Settlement};
use crate::store::{Admission, Bot, Conversation, History, Store, ToolProgress};

use pairing::{Access, PairedDevice, Pairing};

#[derive(Clone)]
struct Daemon {
    store: Store,
    conversations: mpsc::UnboundedSender<ConversationCommand>,
    recall: Recall,
    desktops: Desktops,
    pairing: Pairing,
}

pub(crate) fn router(
    store: Store,
    conversations: mpsc::UnboundedSender<ConversationCommand>,
    settings_token: Option<Digest>,
    recall: Recall,
    desktops: Desktops,
) -> Router {
    let pairing = Pairing::new(store.clone(), settings_token);
    let conversations_router = Router::new()
        .route("/bots", get(list_bots).post(create_bot))
        .route(
            "/bots/{bot}",
            get(read_bot).patch(rename_bot).delete(delete_bot),
        )
        .route("/bots/{bot}/messages", post(send_message))
        .route("/bots/{bot}/work/{message}/retry", post(retry_work))
        .route("/bots/{bot}/events", get(events::read))
        .route("/bots/{bot}/attachments/{id}", get(read_attachment))
        .route("/recall/status", get(recall_status));
    let settings_router =
        providers::routes().route("/settings", get(read_settings).put(write_settings));
    pairing
        .protect(conversations_router, Access::Conversation)
        .merge(pairing.protect(settings_router, Access::Settings))
        .merge(pairing.protect(desktop::routes(), Access::Device))
        .merge(pairing.routes())
        .layer(middleware::from_fn(pairing::cors))
        .with_state(Daemon {
            store,
            conversations,
            recall,
            desktops,
            pairing,
        })
}

async fn recall_status(State(daemon): State<Daemon>) -> Json<Availability> {
    Json(daemon.recall.availability())
}

async fn read_settings(State(daemon): State<Daemon>) -> Result<Json<SettingsStatus>, ApiError> {
    daemon
        .store
        .settings()
        .await
        .map(Json)
        .map_err(|error| settings_storage_error(&error))
}

async fn write_settings(
    State(daemon): State<Daemon>,
    input: Result<Json<SettingsUpdate>, JsonRejection>,
) -> Result<Json<SettingsStatus>, ApiError> {
    // JSON rejection details can contain submitted values.
    let Json(input) = input.map_err(|error| {
        ApiError(
            error.status(),
            Problem::new(
                "invalid_settings",
                "expected a Settings JSON object with provider, model, and optional apiKey",
            ),
        )
    })?;
    let (reply, result) = oneshot::channel();
    daemon
        .conversations
        .send(ConversationCommand::Settings { input, reply })
        .map_err(|_| SETTINGS_STORAGE_FAILED)?;
    match result
        .await
        .map_err(|_| SETTINGS_STORAGE_FAILED)?
        .map_err(|error| settings_storage_error(&error))?
    {
        Update::Saved(status) => Ok(Json(status)),
        Update::InvalidModel => Err(ApiError(
            StatusCode::BAD_REQUEST,
            Problem::new(
                "invalid_model",
                "model must be nonempty with no surrounding whitespace or control characters",
            ),
        )),
        Update::InvalidKey => Err(ApiError(
            StatusCode::BAD_REQUEST,
            Problem::new(
                "invalid_api_key",
                "apiKey must be nonempty printable ASCII without whitespace",
            ),
        )),
        Update::CredentialRequired => Err(ApiError(
            StatusCode::BAD_REQUEST,
            Problem::new("credential_required", "supply apiKey for this provider"),
        )),
        Update::MasterKeyRequired => Err(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            Problem::new(
                "settings_read_only",
                "the daemon requires a master key file to save Settings",
            ),
        )),
    }
}

#[derive(Deserialize)]
struct BotName {
    name: String,
}

impl BotName {
    fn into_name(self) -> Result<String, ApiError> {
        let name = self.name.trim();
        if name.is_empty() {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                Problem::new("empty_name", "Bot name must be nonempty"),
            ));
        }
        if name.len() == self.name.len() {
            Ok(self.name)
        } else {
            Ok(name.to_owned())
        }
    }
}

async fn list_bots(State(daemon): State<Daemon>) -> Result<Json<Vec<Bot>>, ApiError> {
    Ok(Json(daemon.store.list_bots().await.map_err(store_error)?))
}

async fn create_bot(
    State(daemon): State<Daemon>,
    Json(input): Json<BotName>,
) -> Result<(StatusCode, Json<Bot>), ApiError> {
    let bot = daemon
        .store
        .create_bot(input.into_name()?)
        .await
        .map_err(store_error)?;
    Ok((StatusCode::CREATED, Json(bot)))
}

async fn rename_bot(
    State(daemon): State<Daemon>,
    Path(bot): Path<Uuid>,
    Json(input): Json<BotName>,
) -> Result<Json<Bot>, ApiError> {
    daemon
        .store
        .rename_bot(bot, input.into_name()?)
        .await
        .map_err(store_error)?
        .map(Json)
        .ok_or(BOT_NOT_FOUND)
}

async fn read_bot(
    State(daemon): State<Daemon>,
    Path(bot): Path<Uuid>,
) -> Result<Json<Conversation>, ApiError> {
    daemon
        .store
        .conversation(bot)
        .await
        .map_err(store_error)?
        .map(Json)
        .ok_or(BOT_NOT_FOUND)
}

async fn delete_bot(
    State(daemon): State<Daemon>,
    Path(bot): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let (reply, result) = oneshot::channel();
    daemon
        .conversations
        .send(ConversationCommand::DeleteBot { bot, reply })
        .map_err(|_| UNAVAILABLE)?;
    if result.await.map_err(|_| UNAVAILABLE)?? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(BOT_NOT_FOUND)
    }
}

async fn read_attachment(
    State(daemon): State<Daemon>,
    Path((bot, id)): Path<(Uuid, Uuid)>,
) -> Result<impl IntoResponse, ApiError> {
    let attachment = daemon
        .store
        .attachment(bot, id)
        .await
        .map_err(store_error)?
        .ok_or(ATTACHMENT_NOT_FOUND)?;
    let content = attachment.content.ok_or(ApiError(
        StatusCode::GONE,
        Problem::new(
            "attachment_unavailable",
            "attachment content is unavailable",
        ),
    ))?;
    let media_type = match attachment.metadata.media_type.as_str() {
        "text/plain" => "text/plain; charset=utf-8",
        media_type => media_type,
    };
    Ok((
        [
            (header::CONTENT_TYPE, media_type),
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        content,
    )
        .into_response())
}

#[derive(Deserialize)]
struct SendMessage {
    text: String,
    #[serde(default)]
    attachments: Vec<AttachmentInput>,
    #[serde(rename = "desktopSession")]
    desktop_session: Option<Uuid>,
}

async fn send_message(
    State(daemon): State<Daemon>,
    Path(bot): Path<Uuid>,
    device: Option<Extension<PairedDevice>>,
    input: Result<Json<SendMessage>, JsonRejection>,
) -> Result<impl IntoResponse, ApiError> {
    let Json(input) = input.map_err(|error| {
        ApiError(
            error.status(),
            Problem::new(
                "invalid_message",
                "expected message JSON with valid attachment entries",
            ),
        )
    })?;
    if input.text.trim().is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            Problem::new("empty_message", "message text must be nonempty"),
        ));
    }
    if input.attachments.len() > MAX_ATTACHMENTS
        || !input
            .attachments
            .iter()
            .all(AttachmentInput::valid_metadata)
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            Problem::new(
                "invalid_attachments",
                "expected at most eight attachments with valid metadata",
            ),
        ));
    }
    let SendMessage {
        text,
        attachments,
        desktop_session,
    } = input;
    let desktop = if let Some(session) = desktop_session {
        Some(
            device
                .and_then(|Extension(device)| daemon.desktops.target(device.0, session))
                .ok_or(desktop::UNAVAILABLE)?,
        )
    } else {
        None
    };
    let submissions = if attachments.is_empty() {
        Vec::new()
    } else {
        tokio::task::spawn_blocking(move || {
            attachments
                .into_iter()
                .map(AttachmentInput::prepare)
                .collect()
        })
        .await
        .map_err(|_| UNAVAILABLE)?
    };
    let (events, stream) = mpsc::channel(64);
    let (accepted, admission) = oneshot::channel();
    daemon
        .conversations
        .send(ConversationCommand::Message {
            bot,
            text,
            submissions,
            desktop,
            stream: ReplySink::new(events),
            accepted,
        })
        .map_err(|_| UNAVAILABLE)?;
    admission.await.map_err(|_| UNAVAILABLE)??;
    Ok(Sse::new(
        ReceiverStream::new(stream).map(Ok::<_, Infallible>),
    ))
}

async fn retry_work(
    State(daemon): State<Daemon>,
    Path((bot, message_id)): Path<(Uuid, i64)>,
) -> Result<StatusCode, ApiError> {
    let (reply, result) = oneshot::channel();
    daemon
        .conversations
        .send(ConversationCommand::Retry {
            source: UserMessageSource { bot, message_id },
            reply,
        })
        .map_err(|_| UNAVAILABLE)?;
    result.await.map_err(|_| UNAVAILABLE)?
}

pub(crate) enum ConversationCommand {
    DeleteBot {
        bot: Uuid,
        reply: oneshot::Sender<Result<bool, ApiError>>,
    },
    DeleteBotData {
        bot: Uuid,
        committed: std::sync::mpsc::SyncSender<Result<bool, ApiError>>,
    },
    Settings {
        input: SettingsUpdate,
        reply: oneshot::Sender<anyhow::Result<Update>>,
    },
    ProviderSettings {
        mutation: Mutation,
        reply: oneshot::Sender<Result<ProviderStatus, ProviderError>>,
    },
    Retry {
        source: UserMessageSource,
        reply: oneshot::Sender<Result<StatusCode, ApiError>>,
    },
    Started {
        sources: Vec<UserMessageSource>,
        committed: std::sync::mpsc::SyncSender<bool>,
    },
    Delegated {
        source: UserMessageSource,
        report: Report,
        committed: std::sync::mpsc::SyncSender<bool>,
    },
    ConsumedReport {
        bot: Uuid,
        report: Report,
    },
    Message {
        bot: Uuid,
        text: String,
        submissions: Vec<Submission>,
        desktop: Option<Target>,
        stream: ReplySink,
        accepted: oneshot::Sender<Result<(), ApiError>>,
    },
    Tool {
        bot: Uuid,
        event: ToolProgress,
    },
    Event {
        bot: Uuid,
        name: &'static str,
        data: serde_json::Value,
        streams: Vec<ReplySink>,
    },
    Settled {
        bot: Uuid,
        answer: Option<String>,
        reply: Option<MessageId>,
        duties: Option<String>,
        work: Settlement,
        streams: Vec<ReplySink>,
    },
}

pub(crate) async fn run_conversations(
    store: Store,
    turns: mpsc::UnboundedSender<AgentCommand>,
    wake: Wake,
    mut commands: mpsc::UnboundedReceiver<ConversationCommand>,
    recall: Recall,
) {
    let mut live = HashSet::new();
    let queued = match store.recovery_queue().await {
        Ok(queued) => queued,
        Err(error) => {
            store_error(error);
            return;
        }
    };
    for source in queued {
        live.insert(source.bot);
        if turns.send(AgentCommand::Recover(source)).is_err() {
            return;
        }
    }
    wake.wake();
    // Keep SQLite admission and reply commits in order with their runtime handoff.
    while let Some(command) = commands.recv().await {
        match command {
            ConversationCommand::DeleteBot { bot, reply } => {
                if turns.send(AgentCommand::DeleteBot { bot, reply }).is_ok() {
                    wake.wake();
                }
            }
            ConversationCommand::DeleteBotData { bot, committed } => {
                let result = store.delete_bot(bot).await.map_err(store_error);
                if matches!(result, Ok(true)) {
                    live.remove(&bot);
                }
                let _ = committed.send(result);
            }
            ConversationCommand::Settings { input, reply } => {
                let update = store.update_settings(input).await;
                if matches!(update, Ok(Update::Saved(_))) {
                    wake.wake();
                }
                let _ = reply.send(update);
            }
            ConversationCommand::ProviderSettings { mutation, reply } => {
                let update = store.mutate_provider(mutation).await;
                if update.is_ok() {
                    wake.wake();
                }
                let _ = reply.send(update);
            }
            ConversationCommand::Retry { source, reply } => {
                let result = match store.retry(source).await {
                    Ok(Retry::Queued) => turns
                        .send(AgentCommand::Recover(source))
                        .map_err(|_| UNAVAILABLE)
                        .map(|()| {
                            live.insert(source.bot);
                            wake.wake();
                            StatusCode::ACCEPTED
                        }),
                    Ok(Retry::NotFound) => Err(ApiError(
                        StatusCode::NOT_FOUND,
                        Problem::new("work_not_found", "Conversation work not found"),
                    )),
                    Ok(Retry::NotInterrupted) => Err(ApiError(
                        StatusCode::CONFLICT,
                        Problem::new(
                            "work_not_interrupted",
                            "only interrupted work can be retried",
                        ),
                    )),
                    Err(error) => Err(store_error(error)),
                };
                let _ = reply.send(result);
            }
            ConversationCommand::Started { sources, committed } => {
                let result = store.start_work(sources).await.map_err(store_error);
                let _ = committed.send(result.is_ok());
            }
            ConversationCommand::Delegated {
                source,
                report,
                committed,
            } => {
                let result = store
                    .add_delegation(source, report)
                    .await
                    .map_err(store_error);
                let _ = committed.send(result.is_ok());
            }
            ConversationCommand::ConsumedReport { bot, report } => {
                let _ = store.consume_report(bot, report).await.map_err(store_error);
            }
            ConversationCommand::Message {
                bot,
                text,
                submissions,
                desktop,
                stream,
                accepted,
            } => {
                let history = if live.contains(&bot) {
                    History::Live
                } else {
                    History::Restore
                };
                let admission = match store
                    .accept_message(bot, text, submissions, desktop, history)
                    .await
                {
                    Ok(Admission::Accepted {
                        history,
                        message_id,
                        text,
                        attachments,
                        desktop,
                        model,
                    }) => {
                        recall.history_changed();
                        turns
                            .send(AgentCommand::Message(TurnRequest {
                                bot,
                                history,
                                message_id,
                                text,
                                attachments,
                                desktop,
                                model,
                                stream: Some(stream),
                            }))
                            .map_err(|_| UNAVAILABLE)
                            .map(|()| {
                                live.insert(bot);
                                wake.wake();
                            })
                    }
                    Ok(Admission::BotNotFound) => Err(BOT_NOT_FOUND),
                    Ok(Admission::AttachmentNotFound) => Err(ATTACHMENT_NOT_FOUND),
                    Ok(Admission::Unconfigured) => Err(UNCONFIGURED),
                    Err(error) => Err(store_error(error)),
                };
                let _ = accepted.send(admission);
            }
            ConversationCommand::Tool { bot, event } => {
                let _ = store.record_tool(bot, event).await.map_err(store_error);
            }
            ConversationCommand::Event {
                bot,
                name,
                data,
                streams,
            } => {
                let event = match store.record_event(bot, name, data).await {
                    Ok(record) => record.sse(),
                    Err(error) => event("error", store_error(error).1),
                };
                for stream in streams {
                    stream.send(event.clone());
                }
            }
            ConversationCommand::Settled {
                bot,
                answer,
                reply,
                duties,
                work,
                streams,
            } => {
                let terminal = match answer {
                    Some(text) => {
                        let prompt = duties
                            .as_deref()
                            .map(|text| duties::system_prompt(Some(text)));
                        match store.commit_reply(bot, text, duties, work).await {
                            Ok((record, message_id)) => {
                                let _ = turns.send(AgentCommand::ReplyCommitted {
                                    bot,
                                    entry: reply,
                                    message_id,
                                    prompt,
                                });
                                recall.history_changed();
                                record.sse()
                            }
                            Err(error) => event("error", store_error(error).1),
                        }
                    }
                    None => {
                        let problem = Problem::new(
                            "turn_failed",
                            "Rig did not complete a text reply; check the model and provider configuration",
                        );
                        tracing::warn!(code = problem.code, "Agent Turn did not complete a reply");
                        match store.fail_work(bot, work, problem).await {
                            Ok(record) => record.sse(),
                            Err(error) => event("error", store_error(error).1),
                        }
                    }
                };
                for stream in streams {
                    stream.send(terminal.clone());
                }
                wake.wake();
            }
        }
    }
}

fn event(name: &'static str, value: impl Serialize) -> Event {
    Event::default()
        .event(name)
        .json_data(value)
        .expect("serialize reply event")
}

#[derive(Clone, Copy, Serialize)]
struct Problem {
    code: &'static str,
    message: &'static str,
}

impl Problem {
    const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
}

pub(crate) struct ApiError(StatusCode, Problem);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(self.1)).into_response()
    }
}

const BOT_NOT_FOUND: ApiError = ApiError(
    StatusCode::NOT_FOUND,
    Problem::new("bot_not_found", "Bot not found"),
);
const ATTACHMENT_NOT_FOUND: ApiError = ApiError(
    StatusCode::NOT_FOUND,
    Problem::new(
        "attachment_not_found",
        "attachment is unavailable to this Conversation",
    ),
);
pub(crate) const UNAVAILABLE: ApiError = ApiError(
    StatusCode::SERVICE_UNAVAILABLE,
    Problem::new("agent_unavailable", "the Rig runtime is unavailable"),
);
const UNCONFIGURED: ApiError = ApiError(
    StatusCode::SERVICE_UNAVAILABLE,
    Problem::new(
        "provider_unconfigured",
        "configure a provider credential and model in daemon Settings before sending messages",
    ),
);
const SETTINGS_STORAGE_FAILED: ApiError = ApiError(
    StatusCode::INTERNAL_SERVER_ERROR,
    Problem::new(
        "settings_storage_failed",
        "daemon Settings could not be stored or read",
    ),
);

fn settings_storage_error(error: &anyhow::Error) -> ApiError {
    crate::logging::failure(
        "settings_storage_failed",
        "Settings storage operation failed",
        error,
    );
    SETTINGS_STORAGE_FAILED
}

fn store_error(_: anyhow::Error) -> ApiError {
    tracing::error!(code = "storage_failed", "Conversation storage operation failed");
    ApiError(
        StatusCode::INTERNAL_SERVER_ERROR,
        Problem::new(
            "storage_failed",
            "the Conversation could not be stored or read",
        ),
    )
}
