use std::collections::HashSet;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::sse::Event;
use axum::response::{IntoResponse, Response, Sse};
use axum::routing::{get, post};
use axum::{Json, Router};
use rig_harness::prelude::Wake;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};
use tokio_stream::StreamExt;
use tokio_stream::wrappers::ReceiverStream;
use uuid::Uuid;

use crate::agent::TurnRequest;
use crate::store::{Bot, Conversation, Store};

#[derive(Clone)]
struct Daemon {
    store: Store,
    turns: mpsc::UnboundedSender<TurnRequest>,
    wake: Wake,
    active: Arc<Mutex<HashSet<Uuid>>>,
}

pub(crate) fn router(
    store: Store,
    turns: mpsc::UnboundedSender<TurnRequest>,
    wake: Wake,
) -> Router {
    Router::new()
        .route("/bots", post(create_bot))
        .route("/bots/{bot}", get(read_bot))
        .route("/bots/{bot}/messages", post(send_message))
        .with_state(Daemon {
            store,
            turns,
            wake,
            active: Arc::default(),
        })
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
    let guard = ActiveTurn::acquire(&daemon.active, bot)?;
    let (events, stream) = mpsc::channel(64);
    let (accepted, admission) = oneshot::channel();
    tokio::spawn(run_turn(daemon, guard, input.text, events, accepted));
    admission.await.map_err(|_| UNAVAILABLE)??;
    Ok(Sse::new(
        ReceiverStream::new(stream).map(Ok::<_, Infallible>),
    ))
}

async fn run_turn(
    daemon: Daemon,
    guard: ActiveTurn,
    text: String,
    stream: mpsc::Sender<Event>,
    accepted: oneshot::Sender<Result<(), ApiError>>,
) {
    let bot = guard.bot;
    let history = daemon.store.accept_message(bot, text).await;
    let (history, prompt) = match history {
        Ok(Some(history)) => history,
        other => {
            let error = match other {
                Err(error) => store_error(error),
                _ => BOT_NOT_FOUND,
            };
            drop(guard);
            let _ = accepted.send(Err(error));
            return;
        }
    };
    let (finished, result) = oneshot::channel();
    if daemon
        .turns
        .send(TurnRequest {
            history,
            prompt,
            stream,
            finished,
        })
        .is_err()
    {
        drop(guard);
        let _ = accepted.send(Err(UNAVAILABLE));
        return;
    }
    daemon.wake.wake();
    let _ = accepted.send(Ok(()));

    let Ok(result) = result.await else { return };
    let terminal = match result.answer {
        Some(text) => match daemon.store.commit_reply(bot, text).await {
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
    // A client can send its next message as soon as it observes a terminal event.
    drop(guard);
    if let Some(stream) = result.stream {
        let _ = stream.send(terminal).await;
    }
}

fn event(name: &'static str, value: impl Serialize) -> Event {
    Event::default()
        .event(name)
        .json_data(value)
        .expect("serialize reply event")
}

struct ActiveTurn {
    active: Arc<Mutex<HashSet<Uuid>>>,
    bot: Uuid,
}

impl ActiveTurn {
    fn acquire(active: &Arc<Mutex<HashSet<Uuid>>>, bot: Uuid) -> Result<Self, ApiError> {
        if !active
            .lock()
            .expect("turn admission lock poisoned")
            .insert(bot)
        {
            return Err(ApiError(
                StatusCode::CONFLICT,
                Problem::new(
                    "turn_in_progress",
                    "this Bot already has a Turn in progress",
                ),
            ));
        }
        Ok(Self {
            active: active.clone(),
            bot,
        })
    }
}

impl Drop for ActiveTurn {
    fn drop(&mut self) {
        self.active
            .lock()
            .expect("turn admission lock poisoned")
            .remove(&self.bot);
    }
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

struct ApiError(StatusCode, Problem);

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
