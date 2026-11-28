use std::env;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{OriginalUri, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use futures::TryStreamExt;
use reqwest::Client;
use rig_core::conversation::short_id;
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
const SUPERSEDED: &str = "Result superseded by the user's correction.";
const DEADLINE: Duration = Duration::from_secs(90);

struct Gateway {
    client: Client,
    endpoint: String,
    key: String,
    held: mpsc::Sender<ProviderCall>,
    root: OnceLock<String>,
    lookup_parents: Mutex<[Option<String>; 2]>,
    superseded_lookup: AtomicBool,
    exposed_obsolete_lookup: AtomicBool,
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

fn author(text: &str) -> Option<&str> {
    let id = text.strip_prefix("[Output of agent ")?.get(..8)?;
    id.bytes()
        .all(|byte| byte.is_ascii_hexdigit())
        .then_some(id)
}

fn labels(text: &str) -> &'static str {
    if !text.contains("GRN-807") {
        return if text.contains("BLU-159") {
            "corrected"
        } else {
            "neither"
        };
    }
    let lower = text.to_ascii_lowercase();
    let around_label = lower
        .split_terminator(['.', '\n', '!', '?'])
        .filter(|part| part.contains("grn-807"));
    let mut uses = around_label.map(|part| {
        if [
            "superseded",
            "obsolete",
            "ignore",
            "disregard",
            "instead of",
            "not use",
        ]
        .iter()
        .any(|word| part.contains(word))
        {
            "obsolete-described-as-superseded"
        } else if ["current", "verified", "label:", "label is", "label for"]
            .iter()
            .any(|word| part.contains(word))
        {
            "obsolete-presented-as-a-result"
        } else {
            "obsolete-use-undetermined"
        }
    });
    let Some(first) = uses.next() else {
        return "obsolete-use-undetermined";
    };
    if uses.all(|other| other == first) {
        first
    } else {
        "mixed-obsolete-mentions"
    }
}

fn trace_reports(gateway: &Gateway, agent: &str, messages: &[Value]) {
    let parents = gateway
        .lookup_parents
        .lock()
        .expect("fixture lookup identity lock");
    let alder = parents[0].as_deref();
    let birch = parents[1].as_deref();
    let recipient = if agent == "alder" {
        alder
    } else {
        gateway.root.get().map(String::as_str)
    };
    let mut corrected = false;
    for text in messages
        .iter()
        .filter(|message| message["role"] == "user")
        .flat_map(text_parts)
    {
        let Some(sender) = author(text) else {
            continue;
        };
        let now_corrected = agent == "alder"
            && Some(sender) == gateway.root.get().map(String::as_str)
            && text.to_ascii_lowercase().contains("south depot");
        corrected |= now_corrected;
        let superseded = agent == "alder" && corrected && text.contains(SUPERSEDED);
        if superseded {
            gateway.superseded_lookup.store(true, Ordering::Relaxed);
        }
        if corrected && text.contains("GRN-807") {
            gateway
                .exposed_obsolete_lookup
                .store(true, Ordering::Relaxed);
        }
        if now_corrected
            || superseded
            || text.contains("GRN-807")
            || text.contains("BLU-159")
            || (agent == "root" && Some(sender) == birch)
        {
            let kind = if now_corrected {
                "correction"
            } else if superseded {
                "superseded-lookup"
            } else if agent == "alder" {
                "lookup-report"
            } else if Some(sender) == alder {
                "alder-report"
            } else if Some(sender) == birch {
                "birch-report"
            } else {
                "other-report"
            };
            eprintln!(
                "[work-control-live] {kind} sender={sender} recipient={agent}/{} labels={}",
                recipient.unwrap_or("unknown"),
                labels(text)
            );
        }
    }
}

fn asked_north(message: &Value) -> bool {
    message["tool_calls"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|call| {
            call["function"]["name"] == "task"
                && call["function"]["arguments"]
                    .as_str()
                    .and_then(|args| serde_json::from_str::<Value>(args).ok())
                    .is_some_and(|args| args["prompt"] == NORTH)
        })
}

async fn route(
    State(gateway): State<Arc<Gateway>>,
    uri: OriginalUri,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Some([system, brief, continuation @ ..]) = body["messages"].as_array().map(Vec::as_slice)
    {
        let subagent = text_parts(system).any(|text| text.contains("<subagent_role>"));
        if subagent && brief["role"] == "user" {
            if continuation.is_empty()
                && let Some(lookup) = lookup_brief(brief)
            {
                let sender = text_parts(brief)
                    .find_map(author)
                    .expect("lookup brief names its parent");
                if lookup == NORTH || lookup == BIRCH {
                    let mut parents = gateway
                        .lookup_parents
                        .lock()
                        .expect("fixture lookup identity lock");
                    parents[usize::from(lookup == BIRCH)] = Some(sender.to_owned());
                }
                eprintln!("[work-control-live] {lookup} requested by {sender}");
                return completion(
                    State((gateway.held.clone(), ObserverReplies::Scripted)),
                    uri,
                    headers,
                    Json(body),
                )
                .await;
            }
            if continuation.iter().any(asked_north) {
                trace_reports(&gateway, "alder", continuation);
            }
        } else if text_parts(brief).any(|text| text == START) {
            trace_reports(&gateway, "root", continuation);
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
        root: OnceLock::new(),
        lookup_parents: Mutex::new([None, None]),
        superseded_lookup: AtomicBool::new(false),
        exposed_obsolete_lookup: AtomicBool::new(false),
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
    gateway
        .root
        .set(short_id(id).to_owned())
        .expect("one fixture Bot");
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
    eprintln!("[work-control-live] releasing north result after the correction committed");
    reply(north, OBSOLETE).await;
    let south = next_lookup(&mut provider).await;
    assert_eq!(lookup_brief(south.last_message()), Some(SOUTH));
    assert!(
        gateway.superseded_lookup.load(Ordering::Relaxed),
        "the existing Alder Subagent must see the superseded north report after the correction"
    );
    assert!(
        !gateway.exposed_obsolete_lookup.load(Ordering::Relaxed),
        "the obsolete north label must be absent from Alder's corrected model input"
    );
    reply(birch, TALLY).await;
    reply(south, CURRENT).await;

    timeout(DEADLINE, async {
        let mut seen = 0;
        loop {
            let conversation = daemon.read(&client, id).await;
            let messages = conversation["messages"]
                .as_array()
                .expect("Conversation messages");
            let mut complete = false;
            for message in messages.iter().skip(seen) {
                if message["role"] != "assistant" {
                    continue;
                }
                let text = message["text"].as_str().expect("committed assistant text");
                let uses = labels(text);
                if uses != "neither" {
                    eprintln!(
                        "[work-control-live] root-reply sender={} message={} labels={uses}",
                        short_id(id),
                        message["id"]
                    );
                }
                assert!(
                    !text.contains("GRN-807"),
                    "the Bot published the obsolete label ({uses})"
                );
                complete |= text.contains("BLU-159") && text.contains("12");
            }
            if complete {
                return;
            }
            seen = messages.len();
            sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("the Bot committed a reply with the updated label and the independent tally");
    daemon.stop().await;
}
