#[path = "attachments/scenarios.rs"]
mod attachments;
#[path = "duties/scenarios.rs"]
mod duties;

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use axum::extract::{OriginalUri, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::sse::Event;
use axum::response::{IntoResponse, Response as FixtureResponse, Sse};
use axum::routing::post;
use axum::{Json, Router};
use reqwest::{Client, Response};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::net::TcpListener;
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_stream::wrappers::ReceiverStream;

#[path = "conversation/host_tools.rs"]
mod host_tools;
#[path = "conversation/recovery.rs"]
mod recovery;
#[path = "conversation/source_recall.rs"]
mod source_recall;
#[path = "conversation/user_memory.rs"]
mod user_memory;

const DEADLINE: Duration = Duration::from_secs(15);
const MODEL: &str = "scripted-model";

struct Daemon {
    child: Child,
    url: String,
    stdout: JoinHandle<Vec<u8>>,
    stderr: JoinHandle<Vec<u8>>,
}

impl Daemon {
    fn command(db: &Path, provider: &Provider) -> Command {
        let directory = db
            .parent()
            .expect("test database has a temporary directory");
        let mut command = Command::new(env!("CARGO_BIN_EXE_omarchy-agent-daemon"));
        command
            .env("OMARCHY_AGENT_DB", db)
            .env("OMARCHY_AGENT_PORT", "0")
            .env_remove("OMARCHY_AGENT_MODEL")
            .env_remove("OPENAI_API_KEY")
            .env_remove("OMARCHY_AGENT_MASTER_KEY_FILE")
            .env_remove("OMARCHY_AGENT_SETTINGS_TOKEN_FILE")
            .env_remove("OMARCHY_AGENT_RECALL_MODEL_DIR")
            .env_remove("OMARCHY_AGENT_WORK_DIR")
            .env("OPENAI_BASE_URL", format!("{}/v1", provider.url))
            .env("ANTHROPIC_BASE_URL", &provider.url)
            .env("NO_PROXY", "127.0.0.1")
            .env("TMPDIR", directory)
            .env("TMP", directory)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command
    }

    async fn start(db: &Path, provider: &Provider) -> Self {
        let mut command = Self::command(db, provider);
        command
            .env("OMARCHY_AGENT_MODEL", MODEL)
            .env("OPENAI_API_KEY", BOOTSTRAP_KEY);
        Self::launch(command).await
    }

    async fn launch(mut command: Command) -> Self {
        let mut child = command.spawn().expect("start Agent Daemon binary");
        let mut stderr = child.stderr.take().expect("daemon stderr is piped");
        let stderr = tokio::spawn(async move {
            let mut logs = Vec::new();
            stderr
                .read_to_end(&mut logs)
                .await
                .expect("read daemon stderr");
            logs
        });
        let mut stdout = BufReader::new(child.stdout.take().expect("daemon stdout is piped"));
        let mut line = String::new();
        let received = timeout(DEADLINE, stdout.read_line(&mut line))
            .await
            .expect("daemon startup timed out")
            .expect("read daemon startup line");
        if received == 0 {
            let logs = stderr.await.expect("collect daemon stderr");
            assert_secret_free(&logs);
            panic!(
                "daemon exited before binding: {}",
                String::from_utf8_lossy(&logs)
            );
        }
        assert_secret_free(line.as_bytes());
        let url = line
            .trim_end()
            .strip_prefix("LISTENING ")
            .expect("daemon reported a bound address")
            .to_owned();
        let stdout = tokio::spawn(async move {
            let mut logs = Vec::new();
            stdout
                .read_to_end(&mut logs)
                .await
                .expect("read daemon stdout");
            logs
        });
        Self {
            child,
            url,
            stdout,
            stderr,
        }
    }

    async fn stop(mut self) {
        self.child.kill().await.expect("stop daemon process");
        assert_secret_free(&self.stdout.await.expect("collect daemon stdout"));
        assert_secret_free(&self.stderr.await.expect("collect daemon stderr"));
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

    async fn events(&self, client: &Client, bot: &str, after: i64) -> ReplyStream {
        let response = client
            .get(format!("{}/bots/{bot}/events", self.url))
            .header("Last-Event-ID", after)
            .send()
            .await
            .expect("subscribe to Conversation events");
        ReplyStream::new(response)
    }
}

type ProviderFrame = Result<Event, std::convert::Infallible>;

struct ProviderCall {
    body: Value,
    uri: Uri,
    headers: HeaderMap,
    frames: mpsc::Sender<ProviderFrame>,
}

impl ProviderCall {
    fn assert_request(&self, path: &str, model: &str, key: &str) {
        assert_eq!(self.uri.path(), path);
        assert_eq!(self.body["stream"], true);
        assert_eq!(self.body["model"], model);
        assert_secret_free(self.body.to_string().as_bytes());
        if path == "/v1/messages" {
            assert!(
                self.headers["x-api-key"] == key,
                "Anthropic credential changed or missing"
            );
            assert_eq!(self.headers["anthropic-version"], "2023-06-01");
            assert!(!self.headers.contains_key("authorization"));
        } else {
            assert!(
                self.headers["authorization"] == format!("Bearer {key}"),
                "OpenAI credential changed or missing"
            );
            assert!(!self.headers.contains_key("x-api-key"));
        }
    }

    fn chat_messages(&self) -> &[Value] {
        let messages = self.body["messages"]
            .as_array()
            .expect("Chat Completions messages");
        assert_eq!(messages[0]["role"], "system");
        &messages[1..]
    }

    fn assert_messages(&self, expected: &[(&str, &str)]) {
        assert_eq!(self.body["stream"], true);
        assert_eq!(self.body["model"], MODEL);
        let messages: Vec<_> = self
            .chat_messages()
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
            "model": self.body["model"],
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

    async fn tools(self, calls: &[(&str, &str, Value)]) {
        let calls: Vec<_> = (0..)
            .zip(calls)
            .map(|(index, (id, name, args))| {
                json!({
                    "index": index, "id": id, "type": "function",
                    "function": { "name": name, "arguments": args.to_string() }
                })
            })
            .collect();
        self.chunk(json!({ "role": "assistant", "tool_calls": calls }), None)
            .await;
        self.chunk(json!({}), Some("tool_calls")).await;
        self.frame("[DONE]").await;
    }

    fn last_message(&self) -> &Value {
        self.body["messages"].as_array().unwrap().last().unwrap()
    }

    fn started_agent(&self) -> &str {
        self.last_message()["content"]
            .as_str()
            .and_then(|text| text.split('`').nth(1))
            .expect("Rig task returned an Agent ID")
    }

    async fn messages_reply(self, text: &str) {
        let frames = [
            json!({"type": "message_start", "message": {
                "id": "msg_fixture", "type": "message", "role": "assistant", "model": self.body["model"],
                "content": [], "stop_reason": null, "stop_sequence": null,
                "usage": {"input_tokens": 3, "output_tokens": 1}
            }}),
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}}),
            json!({"type": "content_block_stop", "index": 0}),
            json!({"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": null}, "usage": {"output_tokens": 2}}),
            json!({"type": "message_stop"}),
        ];
        for frame in frames {
            self.frame(frame.to_string()).await;
        }
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
            .route("/v1/messages", post(completion))
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
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> FixtureResponse {
    let bearer = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let rejected = bearer == Some(REJECTED_API_KEY)
        || headers
            .get("x-api-key")
            .is_some_and(|value| value == REJECTED_API_KEY);
    let (frames, rx) = mpsc::channel(8);
    calls
        .send(ProviderCall {
            body,
            uri,
            headers,
            frames,
        })
        .await
        .unwrap();
    if rejected {
        let error = json!({
            "type": "error",
            "error": {"type": "authentication_error", "message": format!("invalid credential {REJECTED_API_KEY}")}
        });
        return (StatusCode::UNAUTHORIZED, Json(error)).into_response();
    }
    Sse::new(ReceiverStream::new(rx)).into_response()
}

struct ReplyStream {
    response: Response,
    buffer: Vec<u8>,
    cursor: Option<i64>,
}

impl ReplyStream {
    fn new(response: Response) -> Self {
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "text/event-stream");
        Self {
            response,
            buffer: Vec::new(),
            cursor: None,
        }
    }

    async fn next(&mut self) -> Option<(String, Value)> {
        loop {
            if let Some(end) = self.buffer.windows(2).position(|bytes| bytes == b"\n\n") {
                let frame: Vec<u8> = self.buffer.drain(..end + 2).collect();
                let frame = std::str::from_utf8(&frame).expect("SSE frame is UTF-8");
                if frame.starts_with(':') {
                    continue;
                }
                self.cursor = frame
                    .lines()
                    .find_map(|line| line.strip_prefix("id: "))
                    .map(|id| id.parse().expect("SSE id is a numeric cursor"));
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
            assert_secret_free(&self.buffer);
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
async fn recall_is_unavailable_without_model_artifacts_and_chat_still_commits() {
    let mut provider = Provider::start().await;
    let directory = tempfile::tempdir().unwrap();
    let mut command = Daemon::command(&directory.path().join("daemon.sqlite3"), &provider);
    command
        .env("OMARCHY_AGENT_MODEL", MODEL)
        .env("OPENAI_API_KEY", BOOTSTRAP_KEY)
        .env(
            "OMARCHY_AGENT_RECALL_MODEL_DIR",
            directory.path().join("missing-model"),
        );
    let daemon = Daemon::launch(command).await;
    let client = http_client();
    let bot = daemon.create(&client).await;
    let mut stream = ReplyStream::new(daemon.send(&client, bot_id(&bot), "Say hello").await);
    chat_reply(provider.next().await, &mut stream, "Hello").await;

    let status = recall_status(&client, &daemon, "unavailable").await;
    assert_eq!(status["reason"], "model_missing");
    daemon.stop().await;
}

async fn recall_status(client: &Client, daemon: &Daemon, expected: &str) -> Value {
    timeout(DEADLINE, async {
        loop {
            let status: Value = client
                .get(format!("{}/recall/status", daemon.url))
                .send()
                .await
                .expect("request Recall availability")
                .error_for_status()
                .expect("Recall availability is reported independently of chat")
                .json()
                .await
                .expect("read Recall status");
            if status["status"] != "loading" {
                assert_eq!(status["status"], expected, "Recall status: {status}");
                return status;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Recall finished loading before the deadline")
}

#[tokio::test]
#[ignore = "requires the verified Recall model in OMARCHY_AGENT_RECALL_TEST_MODEL_DIR"]
async fn recall_returns_original_messages_from_the_calling_bot_after_restart() {
    let model_dir = std::env::var_os("OMARCHY_AGENT_RECALL_TEST_MODEL_DIR")
        .expect("provide the pinned Recall model directory");
    let mut provider = Provider::start().await;
    let directory = tempfile::tempdir().unwrap();
    let db = directory.path().join("daemon.sqlite3");
    let client = http_client();
    let daemon = Daemon::start(&db, &provider).await;
    let bot = daemon.create(&client).await;
    let bot = bot_id(&bot);
    let other = daemon.create(&client).await;
    let fixture: Value = serde_json::from_str(include_str!("fixtures/recall.json")).unwrap();
    let messages = fixture["messages"].as_array().unwrap();
    let original = messages[0].as_str().unwrap();
    let exact = format!(
        "{}\n{}",
        "植物研究のメモ。\n".repeat(70),
        messages[4].as_str().unwrap()
    );
    let mixed = messages[10].as_str().unwrap();
    for (owner, text) in [
        (bot, original),
        (bot, messages[15].as_str().unwrap()),
        (bot, &exact),
        (bot, messages[8].as_str().unwrap()),
        (bot, mixed),
        (bot_id(&other), original),
        (bot_id(&other), messages[4].as_str().unwrap()),
    ] {
        let mut reply = ReplyStream::new(daemon.send(&client, owner, text).await);
        chat_reply(provider.next().await, &mut reply, "Recorded").await;
    }
    let history = daemon.read(&client, bot).await;
    daemon.stop().await;

    let mut command = Daemon::command(&db, &provider);
    command
        .env("OMARCHY_AGENT_MODEL", MODEL)
        .env("OPENAI_API_KEY", BOOTSTRAP_KEY)
        .env("OMARCHY_AGENT_RECALL_MODEL_DIR", model_dir);
    let daemon = Daemon::launch(command).await;
    recall_status(&client, &daemon, "ready").await;
    let query = fixture["queries"][1]["text"].as_str().unwrap();
    let mut reply = ReplyStream::new(daemon.send(&client, bot, query).await);
    let call = provider.next().await;
    assert!(
        call.body["tools"].as_array().is_some_and(|tools| {
            tools
                .iter()
                .any(|tool| tool["function"]["name"] == "recall")
        }),
        "Recall available to the Agent: {}",
        call.body["tools"]
    );
    let cases = [
        ("call_recall", query, &history["messages"][0], original),
        (
            "call_exact",
            fixture["queries"][8]["text"].as_str().unwrap(),
            &history["messages"][4],
            messages[4].as_str().unwrap(),
        ),
        (
            "call_mixed",
            fixture["queries"][12]["text"].as_str().unwrap(),
            &history["messages"][8],
            mixed,
        ),
    ];
    let tool_calls: Vec<_> = cases
        .iter()
        .enumerate()
        .map(|(index, (id, query, ..))| {
            json!({
                "index": index, "id": id, "type": "function", "function": {
                    "name": "recall", "arguments": json!({ "query": query }).to_string()
                }
            })
        })
        .collect();
    call.chunk(
        json!({ "role": "assistant", "tool_calls": tool_calls }),
        None,
    )
    .await;
    call.chunk(json!({}), Some("tool_calls")).await;
    call.frame("[DONE]").await;
    let continuation = provider.next().await;
    for (id, lookup, source, expected_text) in cases {
        let result = continuation.body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|message| message["role"] == "tool" && message["tool_call_id"] == id)
            .expect("each Recall output reached the same Turn");
        let result: Value = serde_json::from_str(result["content"].as_str().unwrap())
            .expect("Recall output is JSON");
        assert_eq!(result["historical"], true);
        let hits = result["messages"]
            .as_array()
            .expect("Recall returns a message list");
        let first = hits.first().expect("the original message was found");
        assert_eq!(
            first["message_id"], source["id"],
            "expected first hit for {lookup}: {hits:?}"
        );
        assert_eq!(first["role"], "user");
        assert!(hits.iter().all(|hit| hit["bot_id"] == bot));
        assert!(hits.iter().all(|hit| hit["text"] != query));
        let start = first["start_byte"].as_u64().unwrap() as usize;
        let end = first["end_byte"].as_u64().unwrap() as usize;
        let original = source["text"].as_str().unwrap();
        assert_eq!(first["text"], &original[start..end]);
        assert!(original[start..end].contains(expected_text));
        if id == "call_exact" {
            assert!(
                start > 0,
                "Recall found an identifier later in a long message"
            );
        }
    }
    chat_reply(continuation, &mut reply, "The bill was due June 14").await;
    daemon.stop().await;
}

#[tokio::test]
async fn a_bot_streams_replies_and_keeps_one_conversation_across_restart() {
    let mut provider = Provider::start().await;
    let directory = tempfile::tempdir().unwrap();
    let db = directory.path().join("conversation.sqlite3");
    let client = http_client();
    provision_settings(&db);
    let daemon = Daemon::launch({
        let mut command = settings_command(&db, &provider);
        command
            .env_remove("OMARCHY_AGENT_MASTER_KEY_FILE")
            .env("OMARCHY_AGENT_MODEL", MODEL)
            .env("OPENAI_API_KEY", BOOTSTRAP_KEY);
        command
    })
    .await;
    let bootstrap = json!({
        "active": {"provider": "openai", "model": MODEL, "source": "environment"},
        "storedCredentials": {"openai": false, "anthropic": false},
        "writable": false
    });
    assert_eq!(settings(&client, &daemon).await, bootstrap);
    let failed = put_settings(
        &client,
        &daemon,
        json!({"provider": "openai", "model": "other-model", "apiKey": OPENAI_KEY}),
        StatusCode::SERVICE_UNAVAILABLE,
    )
    .await;
    assert_eq!(failed["code"], "settings_read_only");
    assert_eq!(settings(&client, &daemon).await, bootstrap);
    let bot = daemon.create(&client).await;
    let id = bot_id(&bot);
    assert_eq!(bot["name"], "Lumen");
    assert_eq!(
        daemon.read(&client, id).await,
        json!({ "bot": bot, "messages": [] })
    );

    let mut stream = ReplyStream::new(daemon.send(&client, id, "Remember amber.").await);
    let call = provider.next().await;
    call.assert_request(CHAT_PATH, MODEL, BOOTSTRAP_KEY);
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
async fn a_disconnected_stream_keeps_its_turn_and_accepts_an_overlap() {
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
    let before = stream.cursor.unwrap_or(0);
    drop(stream);

    let mut later = ReplyStream::new(daemon.send(&client, id, "One more thought.").await);
    let mut other = ReplyStream::new(daemon.send(&client, id, "And another.").await);
    assert_eq!(
        transcript(&daemon.read(&client, id).await),
        [
            ("user", "Keep working."),
            ("user", "One more thought."),
            ("user", "And another.")
        ]
    );

    call.text("here.").await;
    call.finish().await;
    let mut resumed = daemon.events(&client, id, before).await;
    assert!(before > 0, "the POST stream supplies a reconnect cursor");
    assert_eq!(resumed.expect_reply("delta").await, "here.");
    assert!(resumed.cursor.unwrap() > before);
    let call = provider.next().await;
    call.text("I read your messages.").await;
    call.finish().await;
    assert_eq!(later.expect("delta").await, "I read your messages.");
    assert_eq!(other.expect("delta").await, "I read your messages.");
    let committed = later.expect("committed").await;
    assert_eq!(resumed.expect_reply("delta").await, "I read your messages.");
    assert_eq!(resumed.expect_reply("committed").await, committed);
    assert_eq!(resumed.cursor, later.cursor);
    assert_eq!(other.expect("committed").await, committed);
    assert!(other.next().await.is_none());
    assert!(later.next().await.is_none());
    let history = daemon.read(&client, id).await;
    assert_eq!(
        transcript(&history),
        [
            ("user", "Keep working."),
            ("user", "One more thought."),
            ("user", "And another."),
            ("assistant", "I read your messages.")
        ]
    );
    assert_eq!(history["messages"][3], committed);
}

#[tokio::test]
async fn independent_subagents_report_to_the_same_conversation_after_a_new_request() {
    let mut provider = Provider::start().await;
    let directory = tempfile::tempdir().unwrap();
    let client = http_client();
    let daemon = Daemon::start(&directory.path().join("conversation.sqlite3"), &provider).await;
    let bot = daemon.create(&client).await;
    let id = bot_id(&bot);
    let other_bot = daemon.create(&client).await;
    let mut started = ReplyStream::new(daemon.send(&client, id, "Check both tiles.").await);
    let call = provider.next().await;
    call.tools(&[
        (
            "t1",
            "task",
            json!({"description": "Check first tile", "prompt": "Inspect tile A."}),
        ),
        (
            "t2",
            "task",
            json!({"description": "Check second tile", "prompt": "Inspect tile B."}),
        ),
    ])
    .await;

    let (mut root, mut first, mut second) = (None, None, None);
    for _ in 0..3 {
        let call = provider.next().await;
        let last = call.last_message();
        let slot = if last["role"] == "tool" {
            &mut root
        } else if last.to_string().contains("Inspect tile A.") {
            &mut first
        } else {
            assert!(last.to_string().contains("Inspect tile B."), "{last}");
            &mut second
        };
        assert!(slot.replace(call).is_none(), "duplicate scripted call");
    }

    // Each operation blocks in Rig's wait tool. The fixture holds the separate
    // reader's output until after the unrelated request has completed.
    let mut readers = Vec::new();
    for (child, tile) in [(first.unwrap(), "A"), (second.unwrap(), "B")] {
        let prompt = format!("Read swatch {tile}.");
        child
            .tools(&[(
                "read",
                "task",
                json!({"description": "Read swatch", "prompt": prompt}),
            )])
            .await;
        let one = provider.next().await;
        let two = provider.next().await;
        let (continued, reader) = if one.last_message()["role"] == "tool" {
            (one, two)
        } else {
            (two, one)
        };
        assert!(reader.last_message().to_string().contains(&prompt));
        let args = json!({"agent": continued.started_agent()});
        continued.tools(&[("hold", "wait", args)]).await;
        readers.push(reader);
    }
    chat_reply(root.unwrap(), &mut started, "Both checks are underway.").await;
    assert!(started.next().await.is_none());

    let mut unrelated = ReplyStream::new(daemon.send(&client, id, "What is 3 times 4?").await);
    let call = provider.next().await;
    assert_eq!(call.last_message()["content"], "What is 3 times 4?");
    chat_reply(call, &mut unrelated, "12").await;
    assert!(unrelated.next().await.is_none());

    for (reader, (result, report, reply)) in readers.into_iter().zip([
        (
            "swatch-green",
            "Tile A is green.",
            "The first tile is green.",
        ),
        (
            "swatch-violet",
            "Tile B is violet.",
            "Tile A is green and tile B is violet.",
        ),
    ]) {
        reader.text(result).await;
        reader.finish().await;
        let child = provider.next().await;
        assert!(child.last_message().to_string().contains(result));
        child.text(report).await;
        child.finish().await;
        let root = provider.next().await;
        assert!(root.last_message().to_string().contains(report));
        if result == "swatch-violet" {
            assert!(
                root.body["messages"]
                    .to_string()
                    .contains("Tile A is green.")
            );
        }
        root.text(reply).await;
        root.finish().await;
    }

    let history = timeout(DEADLINE, async {
        loop {
            let conversation = daemon.read(&client, id).await;
            if conversation["messages"].as_array().unwrap().len() >= 6 {
                break conversation;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("both detached reports reached the original Conversation");
    assert_eq!(history["bot"], bot);
    assert_eq!(
        transcript(&history),
        [
            ("user", "Check both tiles."),
            ("assistant", "Both checks are underway."),
            ("user", "What is 3 times 4?"),
            ("assistant", "12"),
            ("assistant", "The first tile is green."),
            ("assistant", "Tile A is green and tile B is violet.")
        ]
    );
    assert_eq!(
        daemon.read(&client, bot_id(&other_bot)).await["messages"],
        json!([])
    );
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

const SETTINGS_TOKEN: &str = "fixture-local-settings-bearer";
const BOOTSTRAP_KEY: &str = "fixture-openai-bootstrap-credential";
const OPENAI_KEY: &str = "fixture-openai-initial-credential";
const REPLACEMENT_KEY: &str = "fixture-openai-replacement-credential";
const ANTHROPIC_KEY: &str = "fixture-anthropic-credential";
const REJECTED_API_KEY: &str = "fixture-upstream-rejected-credential";
const ROLLBACK_KEY: &str = "fixture-rollback-credential";
const CHAT_PATH: &str = "/v1/chat/completions";
const MESSAGES_PATH: &str = "/v1/messages";
const MESSAGES_MODEL: &str = "gateway/messages-model";

fn assert_secret_free(bytes: &[u8]) {
    for key in [
        SETTINGS_TOKEN,
        BOOTSTRAP_KEY,
        OPENAI_KEY,
        REPLACEMENT_KEY,
        ANTHROPIC_KEY,
        REJECTED_API_KEY,
        ROLLBACK_KEY,
    ] {
        assert!(
            !bytes
                .windows(key.len())
                .any(|window| window == key.as_bytes()),
            "daemon leaked a fixture credential"
        );
    }
}

fn provision_settings(db: &Path) {
    std::fs::write(db.with_extension("key"), [17_u8; 32]).unwrap();
    std::fs::write(db.with_extension("token"), format!("{SETTINGS_TOKEN}\n")).unwrap();
}

fn settings_command(db: &Path, provider: &Provider) -> Command {
    let mut command = Daemon::command(db, provider);
    command
        .env("OMARCHY_AGENT_MASTER_KEY_FILE", db.with_extension("key"))
        .env(
            "OMARCHY_AGENT_SETTINGS_TOKEN_FILE",
            db.with_extension("token"),
        )
        .env("RUST_LOG", "trace");
    command
}

async fn settings_json(response: Response, status: StatusCode) -> Value {
    assert_eq!(response.status(), status);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let bytes = response.bytes().await.unwrap();
    assert_secret_free(&bytes);
    serde_json::from_slice(&bytes).unwrap()
}

async fn settings(client: &Client, daemon: &Daemon) -> Value {
    let response = client
        .get(format!("{}/settings", daemon.url))
        .bearer_auth(SETTINGS_TOKEN)
        .send()
        .await
        .unwrap();
    settings_json(response, StatusCode::OK).await
}

async fn put_settings(client: &Client, daemon: &Daemon, input: Value, status: StatusCode) -> Value {
    let response = client
        .put(format!("{}/settings", daemon.url))
        .bearer_auth(SETTINGS_TOKEN)
        .json(&input)
        .send()
        .await
        .unwrap();
    settings_json(response, status).await
}

async fn chat_reply(call: ProviderCall, stream: &mut ReplyStream, reply: &str) {
    call.text(reply).await;
    call.finish().await;
    assert_eq!(stream.expect("delta").await, reply);
    assert_eq!(stream.expect("committed").await["text"], reply);
    assert!(stream.next().await.is_none());
}

#[tokio::test]
async fn settings_select_rotate_switch_and_restore_provider_credentials() {
    let mut provider = Provider::start().await;
    let directory = tempfile::tempdir().unwrap();
    let db = directory.path().join("settings.sqlite3");
    provision_settings(&db);
    let client = http_client();
    let daemon = Daemon::launch(settings_command(&db, &provider)).await;
    let url = format!("{}/settings", daemon.url);
    let unauthorized_read = client
        .get(&url)
        .bearer_auth("wrong-token")
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized_read.headers()["www-authenticate"], "Bearer");
    assert_eq!(
        settings_json(unauthorized_read, StatusCode::UNAUTHORIZED).await["code"],
        "settings_unauthorized"
    );
    let unauthorized_write = client
        .put(&url)
        .header("content-type", "application/json")
        .body(format!("{{\"apiKey\":\"{OPENAI_KEY}\","))
        .send()
        .await
        .unwrap();
    settings_json(unauthorized_write, StatusCode::UNAUTHORIZED).await;
    assert_eq!(
        settings(&client, &daemon).await,
        json!({
            "active": null, "storedCredentials": {"openai": false, "anthropic": false}, "writable": true
        })
    );

    let bot = daemon.create(&client).await;
    let id = bot_id(&bot);
    let response = daemon.send(&client, id, "Before setup.").await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        response.json::<Value>().await.unwrap()["code"],
        "provider_unconfigured"
    );
    assert!(transcript(&daemon.read(&client, id).await).is_empty());
    let configured = put_settings(
        &client,
        &daemon,
        json!({
            "provider": "openai", "model": MODEL, "apiKey": OPENAI_KEY
        }),
        StatusCode::OK,
    )
    .await;
    assert_eq!(
        configured,
        json!({
            "active": {"provider": "openai", "model": MODEL, "source": "saved"},
            "storedCredentials": {"openai": true, "anthropic": false}, "writable": true
        })
    );

    for invalid in [
        json!({"provider": "openai", "model": " \n", "apiKey": ROLLBACK_KEY}),
        json!({"provider": "openai", "model": "other-model", "apiKey": "invalid\nheader"}),
        json!({"provider": "openai", "model": "other-model", "apiKey": null}),
        json!({"provider": "openai", "model": "other-model", "apiKey": ROLLBACK_KEY, "baseUrl": "http://elsewhere.invalid"}),
        json!({"provider": ROLLBACK_KEY, "model": "other-model", "apiKey": REPLACEMENT_KEY}),
        json!({"provider": "anthropic", "model": MESSAGES_MODEL}),
    ] {
        let response = client
            .put(&url)
            .bearer_auth(SETTINGS_TOKEN)
            .json(&invalid)
            .send()
            .await
            .unwrap();
        let status = response.status();
        assert!(matches!(
            status,
            StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY
        ));
        settings_json(response, status).await;
        assert_eq!(settings(&client, &daemon).await, configured);
    }

    let mut first = ReplyStream::new(daemon.send(&client, id, "Remember amber.").await);
    let first_call = provider.next().await;
    first_call.assert_request(CHAT_PATH, MODEL, OPENAI_KEY);
    first_call.assert_messages(&[("user", "Remember amber.")]);
    put_settings(
        &client,
        &daemon,
        json!({
            "provider": "openai", "model": MODEL, "apiKey": REPLACEMENT_KEY
        }),
        StatusCode::OK,
    )
    .await;
    let rotated_bot = daemon.create(&client).await;
    let mut rotated = ReplyStream::new(
        daemon
            .send(&client, bot_id(&rotated_bot), "Say hello.")
            .await,
    );
    let rotated_call = provider.next().await;
    rotated_call.assert_request(CHAT_PATH, MODEL, REPLACEMENT_KEY);
    chat_reply(rotated_call, &mut rotated, "Hello.").await;
    chat_reply(first_call, &mut first, "Amber remembered.").await;

    let switched = put_settings(
        &client,
        &daemon,
        json!({
            "provider": "anthropic", "model": MESSAGES_MODEL, "apiKey": ANTHROPIC_KEY
        }),
        StatusCode::OK,
    )
    .await;
    assert_eq!(
        switched["storedCredentials"],
        json!({"openai": true, "anthropic": true})
    );
    let mut messages = ReplyStream::new(daemon.send(&client, id, "Which color?").await);
    let call = provider.next().await;
    call.assert_request(MESSAGES_PATH, MESSAGES_MODEL, ANTHROPIC_KEY);
    assert!(
        call.body["max_tokens"]
            .as_u64()
            .is_some_and(|tokens| tokens > 0)
    );
    assert_eq!(
        call.body["messages"],
        json!([
            {"role": "user", "content": [{"type": "text", "text": "Remember amber."}]},
            {"role": "assistant", "content": [{"type": "text", "text": "Amber remembered."}]},
            {"role": "user", "content": [{"type": "text", "text": "Which color?"}]}
        ])
    );
    call.messages_reply("Amber.").await;
    assert_eq!(messages.expect("delta").await, "Amber.");
    assert_eq!(messages.expect("committed").await["text"], "Amber.");
    let history = daemon.read(&client, id).await;
    daemon.stop().await;
    assert_secret_free(&std::fs::read(&db).unwrap());

    let mut command = settings_command(&db, &provider);
    command
        .env("OPENAI_API_KEY", BOOTSTRAP_KEY)
        .env("OMARCHY_AGENT_MODEL", "bootstrap-model");
    let daemon = Daemon::launch(command).await;
    assert_eq!(settings(&client, &daemon).await, switched);
    assert_eq!(daemon.read(&client, id).await, history);
    let mut resumed = ReplyStream::new(daemon.send(&client, id, "Say it again.").await);
    let call = provider.next().await;
    call.assert_request(MESSAGES_PATH, MESSAGES_MODEL, ANTHROPIC_KEY);
    call.messages_reply("Amber again.").await;
    assert_eq!(resumed.expect("delta").await, "Amber again.");
    assert_eq!(resumed.expect("committed").await["text"], "Amber again.");

    let restored = put_settings(
        &client,
        &daemon,
        json!({"provider": "openai", "model": "second-chat-model"}),
        StatusCode::OK,
    )
    .await;
    assert_eq!(
        restored["active"],
        json!({"provider": "openai", "model": "second-chat-model", "source": "saved"})
    );
    let mut chat = ReplyStream::new(daemon.send(&client, id, "Say goodbye.").await);
    let call = provider.next().await;
    call.assert_request(CHAT_PATH, "second-chat-model", REPLACEMENT_KEY);
    chat_reply(call, &mut chat, "Goodbye.").await;

    for (provider_name, path, model) in [
        ("openai", CHAT_PATH, MODEL),
        ("anthropic", MESSAGES_PATH, MESSAGES_MODEL),
    ] {
        put_settings(
            &client,
            &daemon,
            json!({"provider": provider_name, "model": model, "apiKey": REJECTED_API_KEY}),
            StatusCode::OK,
        )
        .await;
        let mut rejected = ReplyStream::new(daemon.send(&client, id, "Check upstream auth.").await);
        provider
            .next()
            .await
            .assert_request(path, model, REJECTED_API_KEY);
        assert_eq!(rejected.expect("error").await["code"], "turn_failed");
        assert!(rejected.next().await.is_none());
    }
    let history = daemon.read(&client, id).await;
    assert_secret_free(history.to_string().as_bytes());
    assert_eq!(
        transcript(&history).last(),
        Some(&("user", "Check upstream auth."))
    );
    daemon.stop().await;
    assert_secret_free(&std::fs::read(&db).unwrap());
}

#[tokio::test]
async fn settings_migrate_an_existing_conversation_and_roll_back_storage_failure() {
    let mut provider = Provider::start().await;
    let directory = tempfile::tempdir().unwrap();
    let db = directory.path().join("legacy.sqlite3");
    let bot = uuid::Uuid::new_v4();
    let id = bot.to_string();
    {
        let legacy = rusqlite::Connection::open(&db).unwrap();
        legacy.execute_batch(
            "CREATE TABLE bots (id BLOB PRIMARY KEY NOT NULL, name TEXT NOT NULL);
             CREATE TABLE messages (id INTEGER PRIMARY KEY, bot_id BLOB NOT NULL REFERENCES bots(id),
                 role INTEGER NOT NULL CHECK (role IN (0, 1)), text TEXT NOT NULL);
             CREATE INDEX messages_by_bot ON messages(bot_id, id);"
        ).unwrap();
        legacy
            .execute(
                "INSERT INTO bots VALUES (?1, 'Legacy Bot')",
                [bot.as_bytes().as_slice()],
            )
            .unwrap();
        legacy.execute("INSERT INTO messages VALUES (1, ?1, 0, 'Remember saffron.'), (2, ?1, 1, 'Saffron remembered.')", [bot.as_bytes().as_slice()]).unwrap();
    }
    provision_settings(&db);
    let client = http_client();
    let daemon = Daemon::launch(settings_command(&db, &provider)).await;
    let saved = put_settings(
        &client,
        &daemon,
        json!({"provider": "openai", "model": MODEL, "apiKey": OPENAI_KEY}),
        StatusCode::OK,
    )
    .await;
    let conversation = daemon.read(&client, &id).await;
    assert_eq!(
        transcript(&conversation),
        [
            ("user", "Remember saffron."),
            ("assistant", "Saffron remembered.")
        ]
    );
    daemon.stop().await;

    let wrong_key = db.with_extension("wrong-key");
    std::fs::write(&wrong_key, [21_u8; 32]).unwrap();
    let output = timeout(
        DEADLINE,
        settings_command(&db, &provider)
            .env("OMARCHY_AGENT_MASTER_KEY_FILE", wrong_key)
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_secret_free(&output.stderr);
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("cannot decrypt stored provider credential")
    );

    {
        let connection = rusqlite::Connection::open(&db).unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER reject_selection BEFORE UPDATE ON model_settings
             BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END;",
            )
            .unwrap();
    }
    let daemon = Daemon::launch(settings_command(&db, &provider)).await;
    assert_eq!(daemon.read(&client, &id).await, conversation);
    let failed = put_settings(
        &client,
        &daemon,
        json!({
            "provider": "openai", "model": "rollback-model", "apiKey": ROLLBACK_KEY
        }),
        StatusCode::INTERNAL_SERVER_ERROR,
    )
    .await;
    assert_eq!(failed["code"], "settings_storage_failed");
    assert_eq!(settings(&client, &daemon).await, saved);
    let probe = daemon.create(&client).await;
    let mut reply = ReplyStream::new(
        daemon
            .send(&client, bot_id(&probe), "Still configured?")
            .await,
    );
    let call = provider.next().await;
    call.assert_request(CHAT_PATH, MODEL, OPENAI_KEY);
    chat_reply(call, &mut reply, "Still configured.").await;
    daemon.stop().await;

    let daemon = Daemon::launch(settings_command(&db, &provider)).await;
    assert_eq!(settings(&client, &daemon).await, saved);
    let mut stream = ReplyStream::new(daemon.send(&client, &id, "Which spice?").await);
    let call = provider.next().await;
    call.assert_request(CHAT_PATH, MODEL, OPENAI_KEY);
    call.assert_messages(&[
        ("user", "Remember saffron."),
        ("assistant", "Saffron remembered."),
        ("user", "Which spice?"),
    ]);
    chat_reply(call, &mut stream, "Saffron.").await;
    daemon.stop().await;
}
