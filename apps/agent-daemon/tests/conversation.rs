use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Sse;
use axum::response::sse::Event;
use axum::routing::post;
use axum::{Json, Router};
use reqwest::{Client, Response};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpListener;
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_stream::wrappers::ReceiverStream;

const DEADLINE: Duration = Duration::from_secs(15);
const MODEL: &str = "scripted-model";

struct Daemon {
    child: Child,
    url: String,
}

impl Daemon {
    async fn start(db: &Path, provider: &Provider) -> Self {
        let directory = db
            .parent()
            .expect("test database has a temporary directory");
        let mut child = Command::new(env!("CARGO_BIN_EXE_omarchy-agent-daemon"))
            .env("OMARCHY_AGENT_DB", db)
            .env("OMARCHY_AGENT_PORT", "0")
            .env("OMARCHY_AGENT_MODEL", MODEL)
            .env("OPENAI_API_KEY", "fixture-token")
            .env("OPENAI_BASE_URL", format!("{}/v1", provider.url))
            .env("NO_PROXY", "127.0.0.1")
            .env("TMPDIR", directory)
            .env("TMP", directory)
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("start Agent Daemon binary");
        let mut stdout = BufReader::new(child.stdout.take().expect("daemon stdout is piped"));
        let mut line = String::new();
        timeout(DEADLINE, stdout.read_line(&mut line))
            .await
            .expect("daemon startup timed out")
            .expect("read daemon startup line");
        let url = line
            .trim_end()
            .strip_prefix("LISTENING ")
            .expect("daemon reported a bound address")
            .to_owned();
        Self { child, url }
    }

    async fn stop(mut self) {
        self.child.kill().await.expect("stop daemon process");
    }

    async fn create(&self, client: &Client) -> Value {
        let response = client
            .post(format!("{}/bots", self.url))
            .json(&json!({ "name": "Lumen" }))
            .send()
            .await
            .expect("create Bot");
        assert_eq!(response.status(), StatusCode::CREATED);
        response.json().await.expect("read created Bot")
    }

    async fn read(&self, client: &Client, bot: &str) -> Value {
        client
            .get(format!("{}/bots/{bot}", self.url))
            .send()
            .await
            .expect("open Bot Conversation")
            .error_for_status()
            .expect("Bot exists")
            .json()
            .await
            .expect("read Bot Conversation")
    }

    async fn send(&self, client: &Client, bot: &str, text: &str) -> Response {
        client
            .post(format!("{}/bots/{bot}/messages", self.url))
            .json(&json!({ "text": text }))
            .send()
            .await
            .expect("send Conversation message")
    }
}

type ProviderFrame = Result<Event, std::convert::Infallible>;

struct ProviderCall {
    body: Value,
    frames: mpsc::Sender<ProviderFrame>,
}

impl ProviderCall {
    fn assert_messages(&self, expected: &[(&str, &str)]) {
        assert_eq!(self.body["stream"], true);
        assert_eq!(self.body["model"], MODEL);
        let messages: Vec<_> = self.body["messages"]
            .as_array()
            .expect("Chat Completions messages")
            .iter()
            .map(|message| {
                (
                    message["role"].as_str().unwrap(),
                    message["content"].as_str().unwrap(),
                )
            })
            .collect();
        assert_eq!(messages, expected);
    }

    async fn chunk(&self, delta: Value, finish: Option<&str>) {
        let chunk = json!({
            "id": "chatcmpl-fixture",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": MODEL,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]
        });
        self.frame(chunk.to_string()).await;
    }

    async fn text(&self, text: &str) {
        self.chunk(json!({ "role": "assistant", "content": text }), None)
            .await;
    }

    async fn finish(self) {
        self.chunk(json!({}), Some("stop")).await;
        self.frame("[DONE]").await;
    }

    async fn frame(&self, data: impl AsRef<str>) {
        self.frames
            .send(Ok(Event::default().data(data)))
            .await
            .expect("Rig consumes provider events");
    }
}

struct Provider {
    url: String,
    calls: mpsc::Receiver<ProviderCall>,
    server: JoinHandle<()>,
}

impl Provider {
    async fn start() -> Self {
        let (tx, calls) = mpsc::channel(8);
        let app = Router::new()
            .route("/v1/chat/completions", post(completion))
            .with_state(tx);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind scripted provider");
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve provider");
        });
        Self { url, calls, server }
    }

    async fn next(&mut self) -> ProviderCall {
        timeout(DEADLINE, self.calls.recv())
            .await
            .expect("daemon reached the scripted provider")
            .expect("provider is running")
    }
}

impl Drop for Provider {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn completion(
    State(calls): State<mpsc::Sender<ProviderCall>>,
    Json(body): Json<Value>,
) -> Sse<ReceiverStream<ProviderFrame>> {
    let (frames, rx) = mpsc::channel(8);
    calls.send(ProviderCall { body, frames }).await.unwrap();
    Sse::new(ReceiverStream::new(rx))
}

struct ReplyStream {
    response: Response,
    buffer: Vec<u8>,
}

impl ReplyStream {
    fn new(response: Response) -> Self {
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "text/event-stream");
        Self {
            response,
            buffer: Vec::new(),
        }
    }

    async fn next(&mut self) -> Option<(String, Value)> {
        loop {
            if let Some(end) = self.buffer.windows(2).position(|bytes| bytes == b"\n\n") {
                let frame: Vec<u8> = self.buffer.drain(..end + 2).collect();
                let frame = std::str::from_utf8(&frame).expect("SSE frame is UTF-8");
                let event = frame
                    .lines()
                    .find_map(|line| line.strip_prefix("event: "))
                    .unwrap();
                let data = frame
                    .lines()
                    .find_map(|line| line.strip_prefix("data: "))
                    .unwrap();
                return Some((
                    event.to_owned(),
                    serde_json::from_str(data).expect("SSE data is JSON"),
                ));
            }
            let Some(chunk) = self.response.chunk().await.expect("read daemon SSE body") else {
                assert!(self.buffer.is_empty(), "incomplete SSE frame");
                return None;
            };
            self.buffer.extend_from_slice(&chunk);
        }
    }

    async fn expect(&mut self, event: &str) -> Value {
        let (name, body) = self.next().await.expect("expected another reply event");
        assert_eq!(name, event);
        body
    }
}

fn http_client() -> Client {
    Client::builder()
        .no_proxy()
        .timeout(DEADLINE)
        .build()
        .unwrap()
}

fn bot_id(bot: &Value) -> &str {
    bot["id"].as_str().expect("Bot has a stable ID")
}

fn transcript(conversation: &Value) -> Vec<(&str, &str)> {
    conversation["messages"]
        .as_array()
        .expect("ordered Conversation messages")
        .iter()
        .map(|message| {
            (
                message["role"].as_str().unwrap(),
                message["text"].as_str().unwrap(),
            )
        })
        .collect()
}

#[tokio::test]
async fn a_bot_streams_replies_and_keeps_one_conversation_across_restart() {
    let mut provider = Provider::start().await;
    let directory = tempfile::tempdir().unwrap();
    let db = directory.path().join("conversation.sqlite3");
    let client = http_client();
    let daemon = Daemon::start(&db, &provider).await;
    let bot = daemon.create(&client).await;
    let id = bot_id(&bot);
    assert_eq!(bot["name"], "Lumen");
    assert_eq!(
        daemon.read(&client, id).await,
        json!({ "bot": bot, "messages": [] })
    );

    let mut stream = ReplyStream::new(daemon.send(&client, id, "Remember amber.").await);
    let call = provider.next().await;
    call.assert_messages(&[("user", "Remember amber.")]);
    call.text("Got ").await;
    assert_eq!(stream.expect("delta").await, "Got ");
    call.text("it: amber.").await;
    assert_eq!(stream.expect("delta").await, "it: amber.");
    call.finish().await;
    let committed = stream.expect("committed").await;
    assert_eq!(committed["text"], "Got it: amber.");
    assert!(stream.next().await.is_none());
    let history = daemon.read(&client, id).await;
    assert_eq!(
        transcript(&history),
        [("user", "Remember amber."), ("assistant", "Got it: amber.")]
    );
    assert_eq!(history["messages"][1], committed);

    let mut stream = ReplyStream::new(daemon.send(&client, id, "Which color?").await);
    let call = provider.next().await;
    call.assert_messages(&[
        ("user", "Remember amber."),
        ("assistant", "Got it: amber."),
        ("user", "Which color?"),
    ]);
    call.text("Amber.").await;
    call.finish().await;
    assert_eq!(stream.expect("delta").await, "Amber.");
    assert_eq!(stream.expect("committed").await["text"], "Amber.");
    let history = daemon.read(&client, id).await;
    assert_eq!(
        transcript(&history),
        [
            ("user", "Remember amber."),
            ("assistant", "Got it: amber."),
            ("user", "Which color?"),
            ("assistant", "Amber."),
        ]
    );
    daemon.stop().await;

    let daemon = Daemon::start(&db, &provider).await;
    assert_eq!(daemon.read(&client, id).await, history);
    let mut stream = ReplyStream::new(daemon.send(&client, id, "Use it in a sentence.").await);
    let call = provider.next().await;
    call.assert_messages(&[
        ("user", "Remember amber."),
        ("assistant", "Got it: amber."),
        ("user", "Which color?"),
        ("assistant", "Amber."),
        ("user", "Use it in a sentence."),
    ]);
    call.text("The lamp glowed amber.").await;
    call.finish().await;
    assert_eq!(stream.expect("delta").await, "The lamp glowed amber.");
    assert_eq!(
        stream.expect("committed").await["text"],
        "The lamp glowed amber."
    );
}

#[tokio::test]
async fn a_disconnected_stream_keeps_its_turn_and_rejects_an_overlap() {
    let mut provider = Provider::start().await;
    let directory = tempfile::tempdir().unwrap();
    let client = http_client();
    let daemon = Daemon::start(&directory.path().join("conversation.sqlite3"), &provider).await;
    let bot = daemon.create(&client).await;
    let id = bot_id(&bot);
    let mut stream = ReplyStream::new(daemon.send(&client, id, "Keep working.").await);
    let call = provider.next().await;
    call.text("Still ").await;
    assert_eq!(stream.expect("delta").await, "Still ");
    drop(stream);

    let overlapping = daemon.send(&client, id, "Should be rejected.").await;
    assert_eq!(overlapping.status(), StatusCode::CONFLICT);
    assert_eq!(
        overlapping.json::<Value>().await.unwrap()["code"],
        "turn_in_progress"
    );
    assert_eq!(
        transcript(&daemon.read(&client, id).await),
        [("user", "Keep working.")]
    );

    call.text("here.").await;
    call.finish().await;
    timeout(DEADLINE, async {
        loop {
            let history = daemon.read(&client, id).await;
            if transcript(&history) == [("user", "Keep working."), ("assistant", "Still here.")] {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("disconnected reply commits to the same Conversation");
}

#[tokio::test]
async fn an_incomplete_provider_reply_never_commits() {
    let mut provider = Provider::start().await;
    let directory = tempfile::tempdir().unwrap();
    let client = http_client();
    let daemon = Daemon::start(&directory.path().join("conversation.sqlite3"), &provider).await;
    let bot = daemon.create(&client).await;
    let id = bot_id(&bot);
    let mut stream = ReplyStream::new(daemon.send(&client, id, "Say hello.").await);
    let call = provider.next().await;
    call.text("Unfinished").await;
    assert_eq!(stream.expect("delta").await, "Unfinished");
    drop(call);

    assert_eq!(stream.expect("error").await["code"], "turn_failed");
    assert!(stream.next().await.is_none());
    assert_eq!(
        transcript(&daemon.read(&client, id).await),
        [("user", "Say hello.")]
    );

    let mut stream = ReplyStream::new(daemon.send(&client, id, "Say goodbye.").await);
    let call = provider.next().await;
    call.text("Goodbye.").await;
    call.finish().await;
    assert_eq!(stream.expect("delta").await, "Goodbye.");
    assert_eq!(stream.expect("committed").await["text"], "Goodbye.");
}
