use std::convert::Infallible;

use super::{
    BOOTSTRAP_KEY, Daemon, MODEL, OPENAI_KEY, ObserverReplies, Provider, ProviderCall,
    REJECTED_API_KEY, REPLACEMENT_KEY, ReplyStream, SETTINGS_TOKEN, completion, http_client,
    provision_settings, put_settings, settings, settings_command, settings_json,
};
use axum::body::{Body, Bytes};
use axum::extract::{OriginalUri, State};
use axum::http::header::{AUTHORIZATION, LOCATION};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use reqwest::{Client, Method, RequestBuilder};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;

const REASONING_ID: &str = "rs_service_private";
const REASONING_BLOB: &str = "encrypted-service-private-state";
const INFERENCE_ERROR_BODY: &str = "fixture raw upstream inference error";
const TOOL_ITEM_ID: &str = "fc_service_private";
const TOOL_CALL_ID: &str = "call_inspect_memory";

struct ModelsCall {
    path: String,
    headers: HeaderMap,
    reply: oneshot::Sender<Response>,
}

impl ModelsCall {
    fn reply(self, models: &[&str]) {
        let data: Vec<_> = models.iter().map(|id| json!({"id": id})).collect();
        self.reply
            .send(Json(json!({"data": data})).into_response())
            .unwrap();
    }
}

struct Upstream {
    provider: Provider,
    models: mpsc::Receiver<ModelsCall>,
}

impl Upstream {
    async fn start() -> Self {
        let (turns, calls) = mpsc::channel(8);
        let (models, discovery) = mpsc::channel(8);
        let app = Router::new()
            .route("/{service}/responses", post(completion))
            .with_state((turns, ObserverReplies::Scripted))
            .route("/auth-failure/responses", post(responses_failure))
            .route("/rate-limit/responses", post(responses_failure))
            .route("/{service}/models", get(list_models))
            .with_state(models);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            provider: Provider { url, calls, server },
            models: discovery,
        }
    }

    fn base_url(&self, service: &str) -> String {
        format!("{}/{service}", self.provider.url)
    }

    async fn list(&mut self, service: &str, key: Option<&str>) -> ModelsCall {
        let call = timeout(super::DEADLINE, self.models.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(call.path, format!("/{service}/models"));
        assert_auth(&call.headers, key);
        call
    }

    async fn turn(&mut self, service: &str, key: Option<&str>, model: &str) -> ProviderCall {
        let call = self.provider.next().await;
        assert_eq!(call.uri.path(), format!("/{service}/responses"));
        assert_auth(&call.headers, key);
        assert_eq!(call.body["model"], model);
        assert_eq!(call.body["stream"], true);
        call
    }

    fn assert_no_discovery(&mut self) {
        assert!(matches!(
            self.models.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
    }
}

async fn list_models(
    State(models): State<mpsc::Sender<ModelsCall>>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    let (reply, response) = oneshot::channel();
    models
        .send(ModelsCall {
            path: uri.path().to_owned(),
            headers,
            reply,
        })
        .await
        .unwrap();
    response.await.unwrap()
}

fn assert_auth(headers: &HeaderMap, key: Option<&str>) {
    match key {
        Some(key) => assert!(
            headers
                .get(AUTHORIZATION)
                .is_some_and(|value| value == format!("Bearer {key}").as_str())
        ),
        None => assert!(!headers.contains_key(AUTHORIZATION)),
    }
}

async fn responses_failure(
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    assert_auth(&headers, Some(OPENAI_KEY));
    assert_eq!(body["model"], MODEL);
    assert_eq!(body["stream"], true);
    let status = match uri.path() {
        "/auth-failure/responses" => StatusCode::UNAUTHORIZED,
        "/rate-limit/responses" => StatusCode::TOO_MANY_REQUESTS,
        _ => unreachable!("inference failure fixture has a fixed route"),
    };
    (
        status,
        Json(json!({"error": {"message": format!("{INFERENCE_ERROR_BODY} {OPENAI_KEY}")}})),
    )
        .into_response()
}

async fn responses_reply(call: ProviderCall, stream: &mut ReplyStream, text: &str) {
    let item = json!({
        "type": "message", "id": "msg_fixture", "role": "assistant", "status": "completed",
        "content": [{"type": "output_text", "text": text, "annotations": []}]
    });
    let reasoning = json!({"type": "reasoning", "id": REASONING_ID,
        "summary": [], "encrypted_content": REASONING_BLOB});
    for frame in [
        json!({"type": "response.output_item.done", "output_index": 0, "item": reasoning}),
        json!({"type": "response.output_item.added", "output_index": 1, "item": {
            "type": "message", "id": "msg_fixture", "role": "assistant", "content": []
        }}),
        json!({"type": "response.output_text.delta", "output_index": 1, "content_index": 0, "item_id": "msg_fixture", "delta": text}),
        json!({"type": "response.output_item.done", "output_index": 1, "item": item}),
        json!({"type": "response.completed", "response": {
            "id": "resp_fixture", "object": "response", "model": call.body["model"],
            "status": "completed", "output": [reasoning, item],
            "usage": {"input_tokens": 9, "output_tokens": 2, "total_tokens": 11}
        }}),
    ] {
        call.frame(frame.to_string()).await;
    }
    drop(call);
    assert_eq!(stream.expect("delta").await, text);
    assert_eq!(stream.expect("committed").await["text"], text);
    assert!(stream.next().await.is_none());
}

async fn responses_inspect_memory(call: ProviderCall) {
    let tool = json!({"type": "function_call", "id": TOOL_ITEM_ID, "call_id": TOOL_CALL_ID,
        "name": "inspect_user_memory", "arguments": "{}", "status": "completed"});
    for frame in [
        json!({"type": "response.output_item.added", "output_index": 0, "item": {
            "type": "function_call", "id": TOOL_ITEM_ID, "call_id": TOOL_CALL_ID,
            "name": "inspect_user_memory", "arguments": ""
        }}),
        json!({"type": "response.function_call_arguments.delta", "output_index": 0, "delta": "{}"}),
        json!({"type": "response.output_item.done", "output_index": 0, "item": tool}),
        json!({"type": "response.completed", "response": {
            "id": "resp_tool_fixture", "object": "response", "model": call.body["model"],
            "status": "completed", "output": [tool]
        }}),
    ] {
        call.frame(frame.to_string()).await;
    }
}

fn request(client: &Client, daemon: &Daemon, method: Method, path: &str) -> RequestBuilder {
    client.request(method, format!("{}/settings/providers{path}", daemon.url))
}

async fn status(client: &Client, daemon: &Daemon, key: &str) -> Value {
    let response = request(client, daemon, Method::GET, "")
        .bearer_auth(key)
        .send()
        .await
        .unwrap();
    settings_json(response, StatusCode::OK).await
}

async fn paired_device(client: &Client, daemon: &Daemon) -> Value {
    let issued: Value = client
        .post(format!("{}/api/pairing/codes", daemon.url))
        .bearer_auth(SETTINGS_TOKEN)
        .json(&json!({"name": "Fixture desktop"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    client
        .post(format!("{}/api/pairing/exchange", daemon.url))
        .json(&json!({"code": issued["code"]}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap()
}

#[tokio::test]
async fn saves_and_switches_custom_providers_across_restart_and_turns() {
    let mut upstream = Upstream::start().await;
    let directory = tempfile::tempdir().unwrap();
    let db = directory.path().join("settings.sqlite3");
    provision_settings(&db);
    let client = http_client();
    let daemon = Daemon::launch(settings_command(&db, &upstream.provider)).await;
    let device = paired_device(&client, &daemon).await;
    let device_token = device["token"].as_str().unwrap();
    assert_eq!(
        status(&client, &daemon, device_token).await,
        json!({"configurations": [], "currentId": null})
    );

    let first_base = upstream.base_url("first");
    let second_base = upstream.base_url("second");
    let connection = json!({"baseUrl": format!("{first_base}/"), "authentication": "apiKey", "apiKey": OPENAI_KEY});
    let discovery = request(&client, &daemon, Method::POST, "/models").json(&connection);
    let denied = discovery.try_clone().unwrap().send().await.unwrap();
    assert_eq!(
        settings_json(denied, StatusCode::UNAUTHORIZED).await["code"],
        "settings_unauthorized"
    );
    upstream.assert_no_discovery();
    let (response, ()) = tokio::join!(discovery.bearer_auth(device_token).send(), async {
        upstream
            .list("first", Some(OPENAI_KEY))
            .await
            .reply(&[MODEL]);
    });
    assert_eq!(
        settings_json(response.unwrap(), StatusCode::OK).await,
        json!({"models": [MODEL]})
    );

    let mut first = connection;
    first["name"] = json!("First");
    first["model"] = json!(MODEL);
    let save = request(&client, &daemon, Method::POST, "")
        .bearer_auth(device_token)
        .json(&first);
    let (response, ()) = tokio::join!(save.send(), async {
        upstream
            .list("first", Some(OPENAI_KEY))
            .await
            .reply(&[MODEL]);
    });
    let first_saved = settings_json(response.unwrap(), StatusCode::OK).await;
    let first_id = first_saved["currentId"].as_str().unwrap();
    assert_eq!(
        first_saved["configurations"],
        json!([{
            "id": first_id, "name": "First", "baseUrl": first_base,
            "authentication": "apiKey", "hasApiKey": true, "model": MODEL, "revision": 0
        }])
    );
    assert_eq!(
        settings(&client, &daemon).await,
        json!({
            "active": {"provider": "custom", "name": "First", "model": MODEL, "source": "saved"},
            "storedCredentials": {"openai": false, "anthropic": false}, "writable": true
        })
    );

    let first_bot = daemon.create(&client).await;
    let first_bot_id = super::bot_id(&first_bot);
    let mut original =
        ReplyStream::new(daemon.send(&client, first_bot_id, "Remember amber.").await);
    responses_reply(
        upstream.turn("first", Some(OPENAI_KEY), MODEL).await,
        &mut original,
        "Amber remembered.",
    )
    .await;
    let mut held = ReplyStream::new(daemon.send(&client, first_bot_id, "Hold this turn.").await);
    let held_call = upstream.turn("first", Some(OPENAI_KEY), MODEL).await;
    assert!(
        held_call.body["input"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == REASONING_ID),
        "the same provider should receive its native reasoning item"
    );
    let second =
        json!({"name": "Second", "baseUrl": second_base, "authentication": "none", "model": MODEL});
    let save = request(&client, &daemon, Method::POST, "")
        .bearer_auth(SETTINGS_TOKEN)
        .json(&second);
    let (response, ()) = tokio::join!(save.send(), async {
        upstream.list("second", None).await.reply(&[MODEL]);
    });
    let second_saved = settings_json(response.unwrap(), StatusCode::OK).await;
    let second_id = second_saved["configurations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["name"] == "Second")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    assert_ne!(first_id, second_id);
    assert_eq!(second_saved["currentId"], first_id);

    let response = request(
        &client,
        &daemon,
        Method::POST,
        &format!("/{second_id}/activate"),
    )
    .bearer_auth(SETTINGS_TOKEN)
    .send()
    .await
    .unwrap();
    let activated = settings_json(response, StatusCode::OK).await;
    assert_eq!(activated["currentId"], second_id);
    let second_bot = daemon.create(&client).await;
    let mut anonymous = ReplyStream::new(
        daemon
            .send(
                &client,
                super::bot_id(&second_bot),
                "Use the new connection.",
            )
            .await,
    );
    responses_reply(
        upstream.turn("second", None, MODEL).await,
        &mut anonymous,
        "Anonymous reply.",
    )
    .await;
    responses_inspect_memory(held_call).await;
    let continuation = upstream.turn("first", Some(OPENAI_KEY), MODEL).await;
    let input = continuation.body["input"].as_array().unwrap();
    assert!(
        input
            .iter()
            .any(|item| item["id"] == TOOL_ITEM_ID && item["call_id"] == TOOL_CALL_ID)
    );
    assert!(
        input
            .iter()
            .any(|item| item["type"] == "function_call_output" && item["call_id"] == TOOL_CALL_ID)
    );
    responses_reply(continuation, &mut held, "Original reply.").await;
    let mut switched =
        ReplyStream::new(daemon.send(&client, first_bot_id, "What did I say?").await);
    let switched_call = upstream.turn("second", None, MODEL).await;
    let history = switched_call.body["input"].to_string();
    for text in [
        "Remember amber.",
        "Amber remembered.",
        "Hold this turn.",
        "Original reply.",
        "What did I say?",
    ] {
        assert!(history.contains(text), "missing canonical history: {text}");
    }
    let switched_body = switched_call.body.to_string();
    for native in [
        REASONING_ID,
        REASONING_BLOB,
        "msg_fixture",
        "resp_fixture",
        TOOL_ITEM_ID,
    ] {
        assert!(
            !switched_body.contains(native),
            "replayed provider-native state: {native}"
        );
    }
    responses_reply(switched_call, &mut switched, "You said amber.").await;
    daemon.stop().await;
    super::assert_secret_free(&std::fs::read(&db).unwrap());

    let mut command = settings_command(&db, &upstream.provider);
    command.env("OPENAI_API_KEY", BOOTSTRAP_KEY);
    let daemon = Daemon::launch(command).await;
    assert_eq!(status(&client, &daemon, device_token).await, activated);
    assert_eq!(settings(&client, &daemon).await["active"]["name"], "Second");
    let mut resumed = ReplyStream::new(
        daemon
            .send(
                &client,
                super::bot_id(&second_bot),
                "Use the restored connection.",
            )
            .await,
    );
    responses_reply(
        upstream.turn("second", None, MODEL).await,
        &mut resumed,
        "Restored reply.",
    )
    .await;

    let reuse = json!({"id": first_id, "baseUrl": first_base, "authentication": "apiKey"});
    let discovery = request(&client, &daemon, Method::POST, "/models")
        .bearer_auth(device_token)
        .json(&reuse);
    let (response, ()) = tokio::join!(discovery.try_clone().unwrap().send(), async {
        upstream
            .list("first", Some(OPENAI_KEY))
            .await
            .reply(&[MODEL]);
    });
    assert_eq!(
        settings_json(response.unwrap(), StatusCode::OK).await,
        json!({"models": [MODEL]})
    );

    let device_id = device["device"]["id"].as_str().unwrap();
    let revoked = client
        .post(format!(
            "{}/api/devices/paired/{device_id}/revoke",
            daemon.url
        ))
        .bearer_auth(SETTINGS_TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), StatusCode::NO_CONTENT);
    let denied_save = request(&client, &daemon, Method::POST, "")
        .bearer_auth(device_token)
        .json(&first);
    assert_eq!(
        denied_save.send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        discovery.send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    upstream.assert_no_discovery();

    let builtin = put_settings(
        &client,
        &daemon,
        json!({"provider": "openai", "model": MODEL, "apiKey": OPENAI_KEY}),
        StatusCode::OK,
    )
    .await;
    assert_eq!(builtin["active"]["provider"], "openai");
    let inactive = status(&client, &daemon, SETTINGS_TOKEN).await;
    assert_eq!(
        inactive,
        json!({"configurations": activated["configurations"], "currentId": null})
    );
    daemon.stop().await;
}

#[tokio::test]
async fn validates_edits_against_the_exact_connection_and_preserves_committed_settings() {
    let mut upstream = Upstream::start().await;
    let directory = tempfile::tempdir().unwrap();
    let db = directory.path().join("settings.sqlite3");
    provision_settings(&db);
    let client = http_client();
    let log_directory = directory.path().join("logs");
    let mut command = settings_command(&db, &upstream.provider);
    command.env("OMARCHY_AGENT_LOG_DIR", &log_directory);
    let daemon = Daemon::launch(command).await;
    let device = paired_device(&client, &daemon).await;
    let device_token = device["token"].as_str().unwrap();
    let base = upstream.base_url("first");
    let create = request(&client, &daemon, Method::POST, "").bearer_auth(SETTINGS_TOKEN)
        .json(&json!({"name": "Original", "baseUrl": base, "authentication": "apiKey", "model": MODEL, "apiKey": OPENAI_KEY}));
    let (response, ()) = tokio::join!(create.send(), async {
        upstream
            .list("first", Some(OPENAI_KEY))
            .await
            .reply(&[MODEL]);
    });
    let saved = settings_json(response.unwrap(), StatusCode::OK).await;
    let id = saved["currentId"].as_str().unwrap();
    let revision = &saved["configurations"][0]["revision"];
    let edit =
        request(&client, &daemon, Method::PUT, &format!("/{id}")).bearer_auth(SETTINGS_TOKEN);

    for invalid in [
        json!({"baseUrl": upstream.base_url("second"), "authentication": "apiKey"}),
        json!({"baseUrl": "file:///tmp/models", "authentication": "none"}),
    ] {
        let mut invalid = invalid;
        invalid["name"] = json!("Uncommitted");
        invalid["model"] = json!(MODEL);
        invalid["revision"] = revision.clone();
        let rejected = edit
            .try_clone()
            .unwrap()
            .json(&invalid)
            .send()
            .await
            .unwrap();
        settings_json(rejected, StatusCode::BAD_REQUEST).await;
        upstream.assert_no_discovery();
    }

    let discovery = request(&client, &daemon, Method::POST, "/models")
        .bearer_auth(device_token)
        .json(&json!({"id": id, "baseUrl": base, "authentication": "apiKey"}));
    let (response, ()) = tokio::join!(discovery.try_clone().unwrap().send(), async {
        upstream.list("first", Some(OPENAI_KEY)).await.reply(&[]);
    });
    assert_eq!(
        settings_json(response.unwrap(), StatusCode::OK).await,
        json!({"models": []})
    );
    for status in [StatusCode::UNAUTHORIZED, StatusCode::FORBIDDEN] {
        let (response, ()) = tokio::join!(discovery.try_clone().unwrap().send(), async {
            upstream
                .list("first", Some(OPENAI_KEY))
                .await
                .reply
                .send((status, REJECTED_API_KEY).into_response())
                .unwrap();
        });
        assert_eq!(
            settings_json(response.unwrap(), StatusCode::BAD_GATEWAY).await["code"],
            "provider_authentication_failed"
        );
    }
    let (response, ()) = tokio::join!(discovery.try_clone().unwrap().send(), async {
        let chunks = std::iter::once(Bytes::from_static(br#"{"data":[]}"#)).chain(
            std::iter::repeat_n(Bytes::from_static(&[b' '; 64 * 1024]), 128),
        );
        upstream
            .list("first", Some(OPENAI_KEY))
            .await
            .reply
            .send(
                Body::from_stream(tokio_stream::iter(chunks.map(Ok::<_, Infallible>)))
                    .into_response(),
            )
            .unwrap();
    });
    assert_eq!(
        settings_json(response.unwrap(), StatusCode::BAD_GATEWAY).await["code"],
        "provider_model_list_too_large"
    );
    let (response, ()) = tokio::join!(discovery.send(), async {
        upstream
            .list("first", Some(OPENAI_KEY))
            .await
            .reply
            .send(
                (
                    StatusCode::TEMPORARY_REDIRECT,
                    [(LOCATION, format!("{}/models", upstream.base_url("second")))],
                    REJECTED_API_KEY,
                )
                    .into_response(),
            )
            .unwrap();
    });
    assert_eq!(
        settings_json(response.unwrap(), StatusCode::BAD_GATEWAY).await["code"],
        "provider_discovery_failed"
    );
    upstream.assert_no_discovery();

    let mut lost = json!({"name": "Stale", "baseUrl": base, "authentication": "apiKey", "model": "stale-model", "revision": revision});
    let rejected = edit.try_clone().unwrap().json(&lost);
    let (response, ()) = tokio::join!(rejected.send(), async {
        upstream
            .list("first", Some(OPENAI_KEY))
            .await
            .reply(&[MODEL]);
    });
    assert_eq!(
        settings_json(response.unwrap(), StatusCode::BAD_REQUEST).await["code"],
        "invalid_model"
    );
    assert_eq!(status(&client, &daemon, SETTINGS_TOKEN).await, saved);

    let held_bot = daemon.create(&client).await;
    let mut held = ReplyStream::new(
        daemon
            .send(&client, super::bot_id(&held_bot), "Hold during an edit.")
            .await,
    );
    let held_call = upstream.turn("first", Some(OPENAI_KEY), MODEL).await;

    let stale_request = request(&client, &daemon, Method::PUT, &format!("/{id}"))
        .bearer_auth(device_token)
        .json(&lost);
    let stale = tokio::spawn(stale_request.try_clone().unwrap().send());
    let pending = upstream.list("first", Some(OPENAI_KEY)).await;
    lost["name"] = json!("Updated");
    lost["model"] = json!("updated-model");
    lost["apiKey"] = json!(REPLACEMENT_KEY);
    let (response, ()) = tokio::join!(edit.json(&lost).send(), async {
        upstream
            .list("first", Some(REPLACEMENT_KEY))
            .await
            .reply(&["updated-model"]);
    });
    let updated = settings_json(response.unwrap(), StatusCode::OK).await;
    assert_eq!(updated["currentId"], id);
    assert_eq!(updated["configurations"][0]["id"], id);
    assert_eq!(updated["configurations"][0]["name"], "Updated");
    assert_ne!(updated["configurations"][0]["revision"], *revision);
    assert_eq!(
        settings(&client, &daemon).await["active"]["name"],
        "Updated"
    );
    pending.reply(&["stale-model"]);
    let stale = settings_json(stale.await.unwrap().unwrap(), StatusCode::CONFLICT).await;
    assert_eq!(stale["code"], "provider_configuration_changed");

    let stale = stale_request.send().await.unwrap();
    assert_eq!(
        settings_json(stale, StatusCode::CONFLICT).await["code"],
        "provider_configuration_changed"
    );
    upstream.assert_no_discovery();
    assert_eq!(status(&client, &daemon, SETTINGS_TOKEN).await, updated);

    let bot = daemon.create(&client).await;
    let mut reply = ReplyStream::new(
        daemon
            .send(&client, super::bot_id(&bot), "Use the committed edit.")
            .await,
    );
    responses_reply(
        upstream
            .turn("first", Some(REPLACEMENT_KEY), "updated-model")
            .await,
        &mut reply,
        "Updated reply.",
    )
    .await;
    responses_reply(held_call, &mut held, "Pre-edit reply.").await;
    daemon.stop().await;
    let logs = std::fs::read_to_string(log_directory.join("agent-daemon.log")).unwrap();
    assert!(logs.contains("model_count=1"));
    assert!(logs.contains("provider_authentication_failed"));
    assert!(logs.contains("upstream_status=Some(401)"));
    super::assert_secret_free(logs.as_bytes());
    assert!(!logs.contains(device_token));
    assert!(!logs.contains("Hold during an edit."));
    assert!(!logs.contains("Updated reply."));

    rusqlite::Connection::open(&db)
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER reject_provider_edit BEFORE UPDATE ON provider_configurations
         WHEN NEW.name = 'Rollback' BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END;",
        )
        .unwrap();
    let mut command = settings_command(&db, &upstream.provider);
    command.env("OMARCHY_AGENT_LOG_DIR", &log_directory);
    let daemon = Daemon::launch(command).await;
    assert_eq!(status(&client, &daemon, SETTINGS_TOKEN).await, updated);
    let rejected = request(&client, &daemon, Method::PUT, &format!("/{id}")).bearer_auth(SETTINGS_TOKEN)
        .json(&json!({"name": "Rollback", "baseUrl": base, "authentication": "apiKey", "model": "rollback-model", "revision": updated["configurations"][0]["revision"]}));
    let (response, ()) = tokio::join!(rejected.send(), async {
        upstream
            .list("first", Some(REPLACEMENT_KEY))
            .await
            .reply(&["rollback-model"]);
    });
    assert_eq!(
        settings_json(response.unwrap(), StatusCode::INTERNAL_SERVER_ERROR).await["code"],
        "settings_storage_failed"
    );
    assert_eq!(status(&client, &daemon, SETTINGS_TOKEN).await, updated);
    let mut reply = ReplyStream::new(
        daemon
            .send(&client, super::bot_id(&bot), "Check the restored key.")
            .await,
    );
    responses_reply(
        upstream
            .turn("first", Some(REPLACEMENT_KEY), "updated-model")
            .await,
        &mut reply,
        "Restored edit.",
    )
    .await;
    daemon.stop().await;
    let logs = std::fs::read_to_string(log_directory.join("agent-daemon.log")).unwrap();
    assert!(logs.lines().any(
        |line| line.contains("settings_storage_failed") && line.contains("ConstraintViolation")
    ));
    super::assert_secret_free(logs.as_bytes());
    assert!(!logs.contains("fixture storage failure"));
}

#[tokio::test]
async fn custom_provider_keys_cannot_move_to_a_different_id_or_base_url() {
    let mut upstream = Upstream::start().await;
    let directory = tempfile::tempdir().unwrap();
    let db = directory.path().join("settings.sqlite3");
    provision_settings(&db);
    let client = http_client();
    let daemon = Daemon::launch(settings_command(&db, &upstream.provider)).await;
    let create = request(&client, &daemon, Method::POST, "")
        .bearer_auth(SETTINGS_TOKEN)
        .json(
            &json!({"name": "Original", "baseUrl": upstream.base_url("first"),
            "authentication": "apiKey", "model": MODEL, "apiKey": OPENAI_KEY}),
        );
    let (response, ()) = tokio::join!(create.send(), async {
        upstream
            .list("first", Some(OPENAI_KEY))
            .await
            .reply(&[MODEL]);
    });
    settings_json(response.unwrap(), StatusCode::OK).await;
    daemon.stop().await;
    super::assert_secret_free(&std::fs::read(&db).unwrap());

    for (variant, update) in [
        (
            "url",
            "UPDATE provider_configurations SET base_url = base_url || '/other';",
        ),
        (
            "id",
            "UPDATE provider_configurations SET id = zeroblob(16);
                UPDATE current_provider_configuration SET configuration_id = zeroblob(16);",
        ),
    ] {
        let tampered = db.with_extension(variant);
        std::fs::copy(&db, &tampered).unwrap();
        rusqlite::Connection::open(&tampered)
            .unwrap()
            .execute_batch(&format!(
                "PRAGMA foreign_keys = ON; BEGIN; PRAGMA defer_foreign_keys = ON; {update} COMMIT;"
            ))
            .unwrap();
        let output = timeout(
            super::DEADLINE,
            settings_command(&db, &upstream.provider)
                .env("OMARCHY_AGENT_DB", &tampered)
                .output(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        super::assert_secret_free(&output.stderr);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("database_open_failed"));
        assert!(stderr.contains("credential_decrypt_failed"));
    }
    let output = timeout(
        super::DEADLINE,
        settings_command(&db, &upstream.provider)
            .env_remove("OMARCHY_AGENT_MASTER_KEY_FILE")
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("master_key_missing"));
    super::assert_secret_free(&output.stderr);
    upstream.assert_no_discovery();
}

#[tokio::test]
async fn read_only_settings_reject_custom_writes_before_discovery() {
    let mut upstream = Upstream::start().await;
    let directory = tempfile::tempdir().unwrap();
    let db = directory.path().join("settings.sqlite3");
    provision_settings(&db);
    let client = http_client();
    let mut command = settings_command(&db, &upstream.provider);
    command.env_remove("OMARCHY_AGENT_MASTER_KEY_FILE");
    let daemon = Daemon::launch(command).await;
    assert_eq!(settings(&client, &daemon).await["writable"], false);
    let response = request(&client, &daemon, Method::POST, "")
        .bearer_auth(SETTINGS_TOKEN)
        .json(
            &json!({"name": "Read only", "baseUrl": upstream.base_url("first"),
            "authentication": "none", "model": MODEL}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(
        settings_json(response, StatusCode::SERVICE_UNAVAILABLE).await["code"],
        "settings_read_only"
    );
    assert_eq!(
        status(&client, &daemon, SETTINGS_TOKEN).await,
        json!({"configurations": [], "currentId": null})
    );
    upstream.assert_no_discovery();
    daemon.stop().await;
}

#[tokio::test]
async fn custom_inference_failures_log_only_safe_diagnostics() {
    let mut upstream = Upstream::start().await;
    let directory = tempfile::tempdir().unwrap();
    let db = directory.path().join("settings.sqlite3");
    provision_settings(&db);
    let client = http_client();
    let log_directory = directory.path().join("logs");
    let mut command = settings_command(&db, &upstream.provider);
    command.env("OMARCHY_AGENT_LOG_DIR", &log_directory);
    let daemon = Daemon::launch(command).await;

    for service in ["auth-failure", "rate-limit"] {
        let create = request(&client, &daemon, Method::POST, "")
            .bearer_auth(SETTINGS_TOKEN)
            .json(
                &json!({"name": service, "baseUrl": upstream.base_url(service),
                "authentication": "apiKey", "model": MODEL, "apiKey": OPENAI_KEY}),
            );
        let (response, ()) = tokio::join!(create.send(), async {
            upstream
                .list(service, Some(OPENAI_KEY))
                .await
                .reply(&[MODEL]);
        });
        let saved = settings_json(response.unwrap(), StatusCode::OK).await;
        let id = saved["configurations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|config| config["name"] == service)
            .unwrap()["id"]
            .as_str()
            .unwrap();
        let response = request(&client, &daemon, Method::POST, &format!("/{id}/activate"))
            .bearer_auth(SETTINGS_TOKEN)
            .send()
            .await
            .unwrap();
        settings_json(response, StatusCode::OK).await;

        let bot = daemon.create(&client).await;
        let mut reply = ReplyStream::new(
            daemon
                .send(&client, super::bot_id(&bot), "Private inference prompt.")
                .await,
        );
        let failure = reply.expect("error").await;
        assert_eq!(failure["code"], "turn_failed");
        assert!(!failure.to_string().contains(INFERENCE_ERROR_BODY));
        assert!(reply.next().await.is_none());
    }
    daemon.stop().await;

    let logs = std::fs::read_to_string(log_directory.join("agent-daemon.log")).unwrap();
    for (status, code) in [
        (401, "provider_authentication_failed"),
        (429, "provider_rate_limited"),
    ] {
        assert!(
            logs.lines()
                .any(|line| line.contains("Provider inference failed")
                    && line.contains(&format!("upstream_status=Some({status})"))
                    && line.contains(code)
                    && line.contains("duration_ms=")),
            "missing inference diagnostics for HTTP {status}"
        );
    }
    super::assert_secret_free(logs.as_bytes());
    assert!(!logs.contains(INFERENCE_ERROR_BODY));
    assert!(!logs.contains("Private inference prompt."));
}
