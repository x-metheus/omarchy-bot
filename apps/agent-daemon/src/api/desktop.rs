//! Paired desktop transport. A connection ID is only valid for its own device.

use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{delete, get, post};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use uuid::Uuid;

use super::pairing::PairedDevice;
use super::{ApiError, Daemon, Problem};
use crate::desktop_tools::Execution;

pub(super) const UNAVAILABLE: ApiError = ApiError(
    StatusCode::CONFLICT,
    Problem::new(
        "desktop_unavailable",
        "The selected desktop is unavailable. Choose its working directory again.",
    ),
);

pub(super) fn routes() -> Router<Daemon> {
    Router::new()
        .route("/api/desktop-tools", get(connect))
        .route("/api/desktop-tools/{session}", delete(disconnect))
        .route(
            "/api/desktop-tools/{session}/{call}/authorize",
            post(authorize),
        )
        .route(
            "/api/desktop-tools/{session}/{call}",
            post(result).layer(DefaultBodyLimit::max(6 * 1024 * 1024)),
        )
}

#[derive(Deserialize)]
struct Selection {
    file: Option<String>,
}

async fn connect(
    State(daemon): State<Daemon>,
    Extension(PairedDevice(device)): Extension<PairedDevice>,
    Query(selection): Query<Selection>,
) -> impl IntoResponse {
    daemon.desktops.connect(
        device,
        selection
            .file
            .filter(|file| !file.is_empty() && file.len() <= 1024),
    )
}

async fn disconnect(
    State(daemon): State<Daemon>,
    Extension(PairedDevice(device)): Extension<PairedDevice>,
    Path(session): Path<Uuid>,
) -> StatusCode {
    status(daemon.desktops.disconnect(device, session))
}

async fn authorize(
    State(daemon): State<Daemon>,
    Extension(PairedDevice(device)): Extension<PairedDevice>,
    Path((session, call)): Path<(Uuid, Uuid)>,
) -> StatusCode {
    status(daemon.desktops.authorize(device, session, call))
}

async fn result(
    State(daemon): State<Daemon>,
    Extension(PairedDevice(device)): Extension<PairedDevice>,
    Path((session, call)): Path<(Uuid, Uuid)>,
    Json(execution): Json<Execution>,
) -> StatusCode {
    status(daemon.desktops.result(device, session, call, execution))
}

fn status(found: bool) -> StatusCode {
    if found {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
}
