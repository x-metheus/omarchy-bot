use std::collections::HashSet;
use std::convert::Infallible;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::sse::Event;
use axum::response::{IntoResponse, Response, Sse};
use axum::routing::{get, post};
use axum::{Json, Router};
use rig_harness::prelude::Wake;
use ring::digest::{self, Digest};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use tokio::sync::{mpsc, oneshot};
use tokio_stream::StreamExt;
use tokio_stream::wrappers::ReceiverStream;
use uuid::Uuid;

use crate::agent::{ReplySink, TurnRequest};
use crate::settings::{SettingsStatus, SettingsUpdate, Update};
use crate::store::{Admission, Bot, Conversation, History, Store};

#[derive(Clone)]
struct Daemon {
    store: Store,
    conversations: mpsc::UnboundedSender<ConversationCommand>,
}

pub(crate) fn router(
    store: Store,
    conversations: mpsc::UnboundedSender<ConversationCommand>,
    settings_token: Option<Digest>,
) -> Router {
    Router::new()
        .route("/bots", post(create_bot))
        .route("/bots/{bot}", get(read_bot))
        .route("/bots/{bot}/messages", post(send_message))
        .merge(
            Router::new()
                .route("/settings", get(read_settings).put(write_settings))
                .route_layer(middleware::from_fn_with_state(
                    settings_token,
                    authorize_settings,
                )),
        )
        .with_state(Daemon {
            store,
            conversations,
        })
}

async fn authorize_settings(
    State(expected): State<Option<Digest>>,
    request: Request,
    next: Next,
) -> Response {
    let bearer = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("Bearer"))
        .map(|(_, token)| token);
    let authorized = expected.zip(bearer).is_some_and(|(expected, token)| {
        let provided = digest::digest(&digest::SHA256, token.as_bytes());
        bool::from(expected.as_ref().ct_eq(provided.as_ref()))
    });
    let mut response = if authorized {
        next.run(request).await
    } else {
        let mut response = ApiError(
            StatusCode::UNAUTHORIZED,
            Problem::new(
                "settings_unauthorized",
                "a valid Settings bearer token is required",
            ),
        )
        .into_response();
        response
            .headers_mut()
            .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        response
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn read_settings(State(daemon): State<Daemon>) -> Result<Json<SettingsStatus>, ApiError> {
    daemon
        .store
        .settings()
        .await
        .map(Json)
        .map_err(|_| SETTINGS_STORAGE_FAILED)
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
    match daemon
        .store
        .update_settings(input)
        .await
        .map_err(|_| SETTINGS_STORAGE_FAILED)?
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
struct CreateBot {
    name: String,
}

async fn create_bot(
    State(daemon): State<Daemon>,
    Json(input): Json<CreateBot>,
) -> Result<(StatusCode, Json<Bot>), ApiError> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            Problem::new("empty_name", "Bot name must be nonempty"),
        ));
    }
    let bot = daemon
        .store
        .create_bot(name.to_owned())
        .await
        .map_err(store_error)?;
    Ok((StatusCode::CREATED, Json(bot)))
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

#[derive(Deserialize)]
struct SendMessage {
    text: String,
}

async fn send_message(
    State(daemon): State<Daemon>,
    Path(bot): Path<Uuid>,
    Json(input): Json<SendMessage>,
) -> Result<impl IntoResponse, ApiError> {
    if input.text.trim().is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            Problem::new("empty_message", "message text must be nonempty"),
        ));
    }
    let (events, stream) = mpsc::channel(64);
    let (accepted, admission) = oneshot::channel();
    daemon
        .conversations
        .send(ConversationCommand::Message {
            bot,
            text: input.text,
            stream: ReplySink::new(events),
            accepted,
        })
        .map_err(|_| UNAVAILABLE)?;
    admission.await.map_err(|_| UNAVAILABLE)??;
    Ok(Sse::new(
        ReceiverStream::new(stream).map(Ok::<_, Infallible>),
    ))
}

pub(crate) enum ConversationCommand {
    Message {
        bot: Uuid,
        text: String,
        stream: ReplySink,
        accepted: oneshot::Sender<Result<(), ApiError>>,
    },
    Settled {
        bot: Uuid,
        answer: Option<String>,
        streams: Vec<ReplySink>,
    },
}

pub(crate) async fn run_conversations(
    store: Store,
    turns: mpsc::UnboundedSender<TurnRequest>,
    wake: Wake,
    mut commands: mpsc::UnboundedReceiver<ConversationCommand>,
) {
    let mut live = HashSet::new();
    // Keep SQLite admission and reply commits in order with their runtime handoff.
    while let Some(command) = commands.recv().await {
        match command {
            ConversationCommand::Message {
                bot,
                text,
                stream,
                accepted,
            } => {
                let history = if live.contains(&bot) {
                    History::Live
                } else {
                    History::Restore
                };
                let admission = match store.accept_message(bot, text, history).await {
                    Ok(Admission::Accepted {
                        history,
                        message,
                        model,
                    }) => turns
                        .send(TurnRequest {
                            bot,
                            history,
                            message,
                            model,
                            stream,
                        })
                        .map_err(|_| UNAVAILABLE)
                        .map(|()| {
                            live.insert(bot);
                            wake.wake();
                        }),
                    Ok(Admission::BotNotFound) => Err(BOT_NOT_FOUND),
                    Ok(Admission::Unconfigured) => Err(UNCONFIGURED),
                    Err(error) => Err(store_error(error)),
                };
                let _ = accepted.send(admission);
            }
            ConversationCommand::Settled {
                bot,
                answer,
                streams,
            } => {
                let terminal = match answer {
                    Some(text) => match store.commit_reply(bot, text).await {
                        Ok(message) => event("committed", message),
                        Err(error) => event("error", store_error(error).1),
                    },
                    None => event(
                        "error",
                        Problem::new(
                            "turn_failed",
                            "Rig did not complete a text reply; check the model and provider configuration",
                        ),
                    ),
                };
                for mut stream in streams {
                    stream.send(terminal.clone());
                }
            }
        }
    }
}

pub(crate) fn event(name: &'static str, value: impl Serialize) -> Event {
    Event::default()
        .event(name)
        .json_data(value)
        .expect("serialize reply event")
}

#[derive(Serialize)]
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
const UNAVAILABLE: ApiError = ApiError(
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

fn store_error(error: anyhow::Error) -> ApiError {
    eprintln!("SQLite operation failed: {error:#}");
    ApiError(
        StatusCode::INTERNAL_SERVER_ERROR,
        Problem::new(
            "storage_failed",
            "the Conversation could not be stored or read",
        ),
    )
}
