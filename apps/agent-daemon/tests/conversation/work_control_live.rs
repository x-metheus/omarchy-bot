use std::env;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{OriginalUri, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use futures::TryStreamExt;
use reqwest::Client;
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::time::{sleep, timeout};

use super::super::{
    BOOTSTRAP_KEY, Daemon, ObserverReplies, Provider, ProviderCall, ReplyStream, bot_id, completion,
};
use super::reply;

const NORTH: &str = "Fixture lookup: Alder north depot.";
const SOUTH: &str = "Fixture lookup: Alder south depot.";
const BIRCH: &str = "Fixture lookup: Birch tally.";
const START: &str = "Delegate two independent parcel checks, one Subagent for each parcel. Check \
    Alder in the north depot and get the Birch tally. A parcel Subagent obtains its result by \
    starting a separate lookup task and waiting for that task's report. The lookup task brief must \
    be exactly one of: `Fixture lookup: Alder north depot.`, `Fixture lookup: Alder south depot.`, \
    or `Fixture lookup: Birch tally.` Pass these directions to the parcel Subagents. Acknowledge \
    both checks while they run. In the final report give Alder's verified label and Birch's tally.";
const CORRECTION: &str =
    "Actually, look up Alder in the south depot instead. Keep the Birch tally going.";
const OBSOLETE: &str = "Alder north depot label: GRN-807.";
const CURRENT: &str = "Alder south depot label: BLU-159.";
const TALLY: &str = "Birch tally: 12.";
const DEADLINE: Duration = Duration::from_secs(90);

struct Gateway {
    client: Client,
    endpoint: String,
    key: String,
    held: mpsc::Sender<ProviderCall>,
    delivered_correction: AtomicBool,
}

fn text_parts(message: &Value) -> impl Iterator<Item = &str> {
    let content = &message["content"];
    content.as_str().into_iter().chain(
        content
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|part| part["text"].as_str()),
    )
}

fn lookup_brief(message: &Value) -> Option<&str> {
    let line = text_parts(message).next()?.lines().last()?.trim();
    [NORTH, SOUTH, BIRCH].contains(&line).then_some(line)
}

async fn route(
    State(gateway): State<Arc<Gateway>>,
    uri: OriginalUri,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Some([system, brief, continuation @ ..]) = body["messages"].as_array().map(Vec::as_slice)
        && text_parts(system).any(|text| text.contains("<subagent_role>"))
        && brief["role"] == "user"
    {
        if continuation.is_empty() && lookup_brief(brief).is_some() {
            return completion(
                State((gateway.held.clone(), ObserverReplies::Scripted)),
                uri,
                headers,
                Json(body),
            )
            .await;
        }
        if text_parts(brief).any(|text| text.to_ascii_lowercase().contains("alder")) {
            let parts = continuation
                .iter()
                .filter(|message| message["role"] == "user")
                .flat_map(text_parts);
            let mut corrected = false;
            for text in parts {
                if text.contains(OBSOLETE) && corrected {
                    gateway.delivered_correction.store(true, Ordering::Relaxed);
                    break;
                }
                corrected |= text.starts_with("[Output of agent ")
                    && text.to_ascii_lowercase().contains("south depot");
            }
        }
    }

    // Forward real model SSE unchanged. Sanitize errors before returning to the daemon.
    match gateway
        .client
        .post(&gateway.endpoint)
        .bearer_auth(&gateway.key)
        .json(&body)
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => (
            [("content-type", "text/event-stream")],
            Body::from_stream(
                response
                    .bytes_stream()
                    .map_err(|_| std::io::Error::other("model stream failed")),
            ),
        )
            .into_response(),
        Ok(response) => {
            eprintln!("live model returned HTTP {}", response.status().as_u16());
            StatusCode::BAD_GATEWAY.into_response()
        }
        Err(_) => {
            eprintln!("live model transport failed");
            StatusCode::BAD_GATEWAY.into_response()
        }
    }
}

async fn next_lookup(provider: &mut Provider) -> ProviderCall {
    timeout(DEADLINE, provider.calls.recv())
        .await
        .expect("the real model started the requested parcel lookup")
        .expect("the loopback relay is running")
}

async fn committed(stream: &mut ReplyStream) {
    loop {
        match stream
            .next()
            .await
            .expect("Turn produced a terminal event")
            .0
            .as_str()
        {
            "committed" => return,
            "delta" => (),
            event => panic!("unexpected live Turn event {event}"),
        }
    }
}

#[tokio::test]
#[ignore = "requires explicit authorization and OpenAI-compatible model credentials"]
async fn a_live_model_reports_only_the_corrected_label() {
    let base = env::var("OPENAI_BASE_URL").expect("set the authorized Chat Completions API root");
    let key = env::var("OPENAI_API_KEY").expect("set the authorized model credential");
    let model = env::var("OMARCHY_AGENT_MODEL").expect("set the authorized chat model ID");
    let (held, calls) = mpsc::channel(8);
    let client = Client::builder()
        .no_proxy()
        .timeout(DEADLINE)
        .build()
        .unwrap();
    let gateway = Arc::new(Gateway {
        client: Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(DEADLINE)
            .build()
            .unwrap(),
        endpoint: format!("{}/chat/completions", base.trim_end_matches('/')),
        key,
        held,
        delivered_correction: AtomicBool::new(false),
    });
    let app = Router::new()
        .route("/v1/chat/completions", post(route))
        .with_state(Arc::clone(&gateway));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut provider = Provider { url, calls, server };
    let directory = tempfile::tempdir().unwrap();
    let mut command = Daemon::command(&directory.path().join("conversation.sqlite3"), &provider);
    command
        .env("OPENAI_API_KEY", BOOTSTRAP_KEY)
        .env("OMARCHY_AGENT_MODEL", model);
    let daemon = Daemon::launch(command).await;
    let bot = daemon.create(&client).await;
    let id = bot_id(&bot);
    let mut start = ReplyStream::new(daemon.send(&client, id, START).await);
    let first = next_lookup(&mut provider).await;
    let second = next_lookup(&mut provider).await;
    let (north, birch) = if lookup_brief(first.last_message()) == Some(NORTH) {
        (first, second)
    } else {
        (second, first)
    };
    assert_eq!(lookup_brief(north.last_message()), Some(NORTH));
    assert_eq!(lookup_brief(birch.last_message()), Some(BIRCH));
    committed(&mut start).await;

    let mut correction = ReplyStream::new(daemon.send(&client, id, CORRECTION).await);
    committed(&mut correction).await;
    reply(north, OBSOLETE).await;
    let south = next_lookup(&mut provider).await;
    assert_eq!(lookup_brief(south.last_message()), Some(SOUTH));
    assert!(
        gateway.delivered_correction.load(Ordering::Relaxed),
        "the existing Alder Subagent must see the correction followed by the obsolete result"
    );
    reply(birch, TALLY).await;
    reply(south, CURRENT).await;

    timeout(DEADLINE, async {
        loop {
            let conversation = daemon.read(&client, id).await;
            for (role, text) in super::transcript(&conversation) {
                if role == "assistant" {
                    assert!(
                        !text.contains("GRN-807"),
                        "the Bot published the obsolete label"
                    );
                    if text.contains("BLU-159") && text.contains("12") {
                        return;
                    }
                }
            }
            sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("the Bot committed a reply with the updated label and the independent tally");
    daemon.stop().await;
}
