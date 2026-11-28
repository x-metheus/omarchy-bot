//! Settings routes for custom Responses provider configurations.

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::Serialize;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::settings::providers::{DiscoveryInput, Error, Mutation, SaveInput, Status, discover};

use super::{
    ApiError, ConversationCommand, Daemon, Problem, SETTINGS_STORAGE_FAILED, settings_storage_error,
};

pub(super) fn routes() -> Router<Daemon> {
    Router::new()
        .route("/settings/providers", get(read).post(create))
        .route("/settings/providers/models", post(models))
        .route("/settings/providers/{id}", put(edit))
        .route("/settings/providers/{id}/activate", post(activate))
}

async fn read(State(daemon): State<Daemon>) -> Result<Json<Status>, ApiError> {
    Ok(Json(daemon.store.provider_status().await?))
}

async fn create(
    State(daemon): State<Daemon>,
    input: Result<Json<SaveInput>, JsonRejection>,
) -> Result<Json<Status>, ApiError> {
    save(daemon, None, input).await
}

async fn edit(
    State(daemon): State<Daemon>,
    Path(id): Path<Uuid>,
    input: Result<Json<SaveInput>, JsonRejection>,
) -> Result<Json<Status>, ApiError> {
    save(daemon, Some(id), input).await
}

async fn save(
    daemon: Daemon,
    id: Option<Uuid>,
    input: Result<Json<SaveInput>, JsonRejection>,
) -> Result<Json<Status>, ApiError> {
    let prepared = daemon
        .store
        .prepare_provider_save(id, settings_input(input)?)
        .await?;
    let mutation = prepared.validate().await?;
    mutate(&daemon, mutation).await
}

async fn activate(
    State(daemon): State<Daemon>,
    Path(id): Path<Uuid>,
) -> Result<Json<Status>, ApiError> {
    mutate(&daemon, Mutation::Activate(id)).await
}

async fn mutate(daemon: &Daemon, mutation: Mutation) -> Result<Json<Status>, ApiError> {
    let (reply, result) = oneshot::channel();
    daemon
        .conversations
        .send(ConversationCommand::ProviderSettings { mutation, reply })
        .map_err(|_| SETTINGS_STORAGE_FAILED)?;
    Ok(Json(result.await.map_err(|_| SETTINGS_STORAGE_FAILED)??))
}

#[derive(Serialize)]
struct Models {
    models: Vec<String>,
}

async fn models(
    State(daemon): State<Daemon>,
    input: Result<Json<DiscoveryInput>, JsonRejection>,
) -> Result<Json<Models>, ApiError> {
    let client = daemon
        .store
        .prepare_provider_discovery(settings_input(input)?)
        .await?;
    Ok(Json(Models {
        models: discover(&client).await?,
    }))
}

fn settings_input<T>(input: Result<Json<T>, JsonRejection>) -> Result<T, ApiError> {
    input.map(|Json(value)| value).map_err(|error| {
        ApiError(
            error.status(),
            Problem::new("invalid_settings", "expected valid Provider Settings JSON"),
        )
    })
}

impl From<Error> for ApiError {
    fn from(error: Error) -> Self {
        let (status, code, message) = match error {
            Error::Storage(error) => return settings_storage_error(&error),
            Error::ReadOnly => (
                StatusCode::SERVICE_UNAVAILABLE,
                "settings_read_only",
                "the daemon requires a master key file to save Settings or use a stored credential",
            ),
            Error::NotFound => (
                StatusCode::NOT_FOUND,
                "provider_configuration_not_found",
                "Provider Configuration not found",
            ),
            Error::Changed => (
                StatusCode::CONFLICT,
                "provider_configuration_changed",
                "the Provider Configuration has changed; reload it and try again",
            ),
            Error::InvalidRevision => (
                StatusCode::BAD_REQUEST,
                "invalid_revision",
                "include the saved configuration revision when editing and omit it when creating",
            ),
            Error::InvalidName => (
                StatusCode::BAD_REQUEST,
                "invalid_name",
                "name must be nonempty and contain no control characters",
            ),
            Error::InvalidBaseUrl => (
                StatusCode::BAD_REQUEST,
                "invalid_base_url",
                "baseUrl must be an absolute HTTP(S) URL without credentials, query, or fragment",
            ),
            Error::InvalidKey => (
                StatusCode::BAD_REQUEST,
                "invalid_api_key",
                "apiKey must be nonempty printable ASCII without whitespace",
            ),
            Error::CredentialRequired => (
                StatusCode::BAD_REQUEST,
                "credential_required",
                "supply apiKey for this Provider Configuration and Base URL",
            ),
            Error::UnexpectedKey => (
                StatusCode::BAD_REQUEST,
                "invalid_api_key",
                "omit apiKey when using no authentication",
            ),
            Error::InvalidModel => (
                StatusCode::BAD_REQUEST,
                "invalid_model",
                "model must be nonempty with no surrounding whitespace or control characters",
            ),
            Error::ModelUnavailable => (
                StatusCode::BAD_REQUEST,
                "invalid_model",
                "the provider did not list the selected model",
            ),
            Error::DiscoveryFailed => (
                StatusCode::BAD_GATEWAY,
                "provider_discovery_failed",
                "the custom provider could not list models",
            ),
            Error::ModelListTooLarge => (
                StatusCode::BAD_GATEWAY,
                "provider_model_list_too_large",
                "the custom provider returned a model list larger than 8 MiB",
            ),
            Error::AuthenticationFailed => (
                StatusCode::BAD_GATEWAY,
                "provider_authentication_failed",
                "the custom provider rejected authentication",
            ),
            Error::DiscoveryTimeout => (
                StatusCode::GATEWAY_TIMEOUT,
                "provider_discovery_timeout",
                "the custom provider timed out while listing models",
            ),
        };
        ApiError(status, Problem::new(code, message))
    }
}
