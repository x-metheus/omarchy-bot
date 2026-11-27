//! Per-Bot SSE replay. SQLite remains the source of truth when subscribers fall behind.

use std::convert::Infallible;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive};
use axum::response::{IntoResponse, Sse};
use futures::stream;
use uuid::Uuid;

use super::{ApiError, BOT_NOT_FOUND, Daemon, Problem, store_error};
use crate::store::ConversationEvent;

pub(super) async fn read(
    State(daemon): State<Daemon>,
    Path(bot): Path<Uuid>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    let after = match headers.get("Last-Event-ID") {
        None => 0,
        Some(value) => value
            .to_str()
            .ok()
            .and_then(|value| value.parse::<i64>().ok())
            .filter(|id| *id >= 0)
            .ok_or(ApiError(
                StatusCode::BAD_REQUEST,
                Problem::new("invalid_event_cursor", "expected a nonnegative SSE event ID"),
            ))?,
    };
    let store = daemon.store;
    // Subscribe before reading SQLite so a commit at the end of replay wakes the stream.
    let changes = store.watch_events();
    if !store.bot_exists(bot).await.map_err(store_error)? {
        return Err(BOT_NOT_FOUND);
    }
    let page = Vec::<ConversationEvent>::new().into_iter();
    let events = stream::unfold(
        (store, changes, after, page),
        move |(store, mut changes, mut after, mut page)| async move {
            loop {
                if let Some(event) = page.next() {
                    after = event.id;
                    return Some((Ok::<_, Infallible>(event.sse()), (store, changes, after, page)));
                }
                match store.events_after(bot, after).await {
                    Ok(events) if events.is_empty() => changes.changed().await.ok()?,
                    Ok(events) => page = events.into_iter(),
                    Err(error) => {
                        store_error(error);
                        return None;
                    }
                }
            }
        },
    );
    Ok(Sse::new(events).keep_alive(KeepAlive::default()))
}

impl ConversationEvent {
    pub(super) fn sse(self) -> Event {
        Event::default()
            .id(self.id.to_string())
            .event(self.name)
            .data(self.data)
    }
}
