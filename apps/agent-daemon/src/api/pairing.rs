//! Operator pairing and revocable, per-device authorization.

use std::{collections::HashMap, sync::Arc, time::SystemTime};

use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures::{StreamExt, stream};
use ring::{
    digest::{self, Digest},
    hmac,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use tokio::sync::{Mutex, watch};
use uuid::Uuid;

use super::{ApiError, Daemon, Problem, store_error};
use crate::store::{Device, Store};

const PAIRING_TTL_SECS: u64 = 600;
const DISABLED: ApiError = ApiError(
    StatusCode::UNAUTHORIZED,
    Problem::new("pairing_unavailable", "device pairing is disabled"),
);

#[derive(Clone)]
pub(super) struct Pairing {
    store: Store,
    operator: Option<Digest>,
    sessions: Arc<Mutex<HashMap<Uuid, watch::Sender<()>>>>,
}

#[derive(Clone, Copy)]
pub(super) struct PairedDevice(pub(super) Uuid);

#[derive(Clone, Copy)]
pub(super) enum Access {
    Conversation,
    Settings,
    Device,
    Operator,
}

impl Pairing {
    pub(super) fn new(store: Store, operator: Option<Digest>) -> Self {
        Self {
            store,
            operator,
            sessions: Arc::default(),
        }
    }

    pub(super) fn protect(&self, routes: Router<Daemon>, access: Access) -> Router<Daemon> {
        routes.route_layer(middleware::from_fn_with_state(
            (self.clone(), access),
            authorize,
        ))
    }

    pub(super) fn routes(&self) -> Router<Daemon> {
        self.protect(
            Router::new()
                .route("/api/pairing/codes", post(issue))
                .route("/api/devices/paired", get(devices))
                .route("/api/devices/paired/{id}/revoke", post(revoke)),
            Access::Operator,
        )
        .route("/api/pairing/exchange", post(exchange))
        .route("/health", get(health))
        .route_layer(middleware::from_fn(no_store))
    }
}

async fn authorize(
    State((pairing, access)): State<(Pairing, Access)>,
    mut request: Request,
    next: Next,
) -> Response {
    if pairing.operator.is_none() && matches!(access, Access::Conversation) {
        return next.run(request).await;
    }
    if let Some(provided) = bearer(request.headers()) {
        if !matches!(access, Access::Device)
            && pairing
                .operator
                .is_some_and(|expected| bool::from(expected.as_ref().ct_eq(provided.as_ref())))
        {
            return uncached(next.run(request).await);
        }
        if pairing.operator.is_some() && !matches!(access, Access::Operator) {
            let mut sessions = pairing.sessions.lock().await;
            match pairing.store.authenticate_device(provided).await {
                Ok(Some(device)) => {
                    let mut revoked = sessions
                        .entry(device)
                        .or_insert_with(|| watch::channel(()).0)
                        .subscribe();
                    drop(sessions);
                    request.extensions_mut().insert(PairedDevice(device));
                    let mut response = tokio::select! {
                        biased;
                        _ = revoked.changed() => return denied(access),
                        response = next.run(request) => response,
                    };
                    if response
                        .headers()
                        .get(header::CONTENT_TYPE)
                        .is_some_and(|value| value == "text/event-stream")
                    {
                        let (parts, body) = response.into_parts();
                        response = Response::from_parts(
                            parts,
                            Body::from_stream(stream::unfold(
                                (body.into_data_stream(), revoked),
                                |(mut body, mut revoked)| async move {
                                    tokio::select! {
                                        biased;
                                        _ = revoked.changed() => None,
                                        item = body.next() => item.map(|item| (item, (body, revoked))),
                                    }
                                },
                            )),
                        );
                    }
                    return uncached(response);
                }
                Ok(None) => {}
                Err(error) => return uncached(store_error(error).into_response()),
            }
        }
    }
    denied(access)
}

fn bearer(headers: &HeaderMap) -> Option<Digest> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    scheme.eq_ignore_ascii_case("Bearer").then(|| hash(token))
}

fn denied(access: Access) -> Response {
    let code = match access {
        Access::Conversation => "conversation_unauthorized",
        Access::Settings => "settings_unauthorized",
        Access::Device => "device_unauthorized",
        Access::Operator => "operator_unauthorized",
    };
    let mut response = ApiError(
        StatusCode::UNAUTHORIZED,
        Problem::new(code, "a valid bearer token is required"),
    )
    .into_response();
    response
        .headers_mut()
        .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
    uncached(response)
}

fn uncached(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn no_store(request: Request, next: Next) -> Response {
    uncached(next.run(request).await)
}

#[derive(Deserialize)]
struct HealthQuery {
    challenge: Option<String>,
}

#[derive(Serialize)]
struct Health {
    service: &'static str,
    proof: Option<String>,
}

async fn health(State(daemon): State<Daemon>, Query(query): Query<HealthQuery>) -> Json<Health> {
    let proof = query
        .challenge
        .zip(daemon.pairing.operator)
        .filter(|(challenge, _)| {
            challenge.len() == 64 && challenge.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        .map(|(challenge, key)| {
            let key = hmac::Key::new(hmac::HMAC_SHA256, key.as_ref());
            URL_SAFE_NO_PAD.encode(hmac::sign(&key, challenge.as_bytes()))
        });
    Json(Health {
        service: "omarchy-agent-daemon",
        proof,
    })
}

#[derive(Deserialize)]
struct Name {
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Issued {
    code: String,
    expires_at: u64,
}

async fn issue(
    State(daemon): State<Daemon>,
    Json(input): Json<Name>,
) -> Result<Json<Issued>, ApiError> {
    let name = input.name.trim();
    if name.is_empty() || name.len() > 120 || name.chars().any(char::is_control) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            Problem::new(
                "invalid_device_name",
                "enter a device name of up to 120 bytes",
            ),
        ));
    }
    let code = secret::<16>()?;
    let now = now();
    let expires_at = now + PAIRING_TTL_SECS;
    daemon
        .store
        .issue_pairing_code(hash(&code), name.to_owned(), now, expires_at)
        .await
        .map_err(store_error)?;
    Ok(Json(Issued { code, expires_at }))
}

#[derive(Deserialize)]
struct Exchange {
    code: String,
}

#[derive(Serialize)]
struct Paired {
    token: String,
    device: Device,
}

async fn exchange(
    State(daemon): State<Daemon>,
    Json(input): Json<Exchange>,
) -> Result<Json<Paired>, ApiError> {
    if daemon.pairing.operator.is_none() {
        return Err(DISABLED);
    }
    let token = secret::<32>()?;
    let device = daemon
        .store
        .exchange_pairing_code(hash(input.code.trim()), hash(&token), now())
        .await
        .map_err(store_error)?;
    let device = device.ok_or(ApiError(
        StatusCode::UNAUTHORIZED,
        Problem::new(
            "invalid_pairing_code",
            "the pairing code is invalid or expired",
        ),
    ))?;
    Ok(Json(Paired { token, device }))
}

async fn devices(State(daemon): State<Daemon>) -> Result<Json<Devices>, ApiError> {
    Ok(Json(Devices {
        devices: daemon.store.paired_devices().await.map_err(store_error)?,
    }))
}

async fn revoke(
    State(daemon): State<Daemon>,
    Path(device): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    // Once requested, revocation closes live subscriptions even if the operator disconnects.
    let revoked = tokio::spawn(async move {
        let mut sessions = daemon.pairing.sessions.lock().await;
        let revoked = daemon.store.revoke_device(device, now()).await?;
        daemon.desktops.disconnect_device(device);
        sessions.remove(&device);
        Ok(revoked)
    })
    .await
    .map_err(|error| store_error(error.into()))?
    .map_err(store_error)?;
    if revoked {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError(
            StatusCode::NOT_FOUND,
            Problem::new("device_not_found", "active paired device not found"),
        ))
    }
}

#[derive(Serialize)]
struct Devices {
    devices: Vec<Device>,
}

fn now() -> u64 {
    SystemTime::UNIX_EPOCH
        .elapsed()
        .unwrap_or_default()
        .as_secs()
}

fn hash(secret: &str) -> Digest {
    digest::digest(&digest::SHA256, secret.as_bytes())
}

fn secret<const BYTES: usize>() -> Result<String, ApiError> {
    let mut data = [0; BYTES];
    SystemRandom::new()
        .fill(&mut data)
        .map_err(|_| super::UNAVAILABLE)?;
    Ok(URL_SAFE_NO_PAD.encode(data))
}

pub(super) async fn cors(request: Request, next: Next) -> Response {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .filter(|value| {
            matches!(
                value.as_bytes(),
                b"tauri://localhost"
                    | b"http://tauri.localhost"
                    | b"https://tauri.localhost"
                    | b"http://127.0.0.1:7322"
                    | b"http://localhost:7322"
            )
        })
        .cloned();
    let preflight = request.method() == axum::http::Method::OPTIONS
        && request
            .headers()
            .contains_key(header::ACCESS_CONTROL_REQUEST_METHOD);
    let mut response = if preflight {
        if origin.is_some() {
            StatusCode::NO_CONTENT
        } else {
            StatusCode::FORBIDDEN
        }
        .into_response()
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    headers.append(header::VARY, HeaderValue::from_static("Origin"));
    if let Some(origin) = origin {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        if preflight {
            headers.insert(
                header::ACCESS_CONTROL_ALLOW_METHODS,
                HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE"),
            );
            headers.insert(
                header::ACCESS_CONTROL_ALLOW_HEADERS,
                HeaderValue::from_static("authorization, content-type, last-event-id"),
            );
            headers.insert(
                "access-control-allow-private-network",
                HeaderValue::from_static("true"),
            );
        }
    }
    response
}
