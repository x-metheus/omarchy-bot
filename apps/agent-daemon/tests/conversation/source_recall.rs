use axum::http::StatusCode;
use reqwest::Client;
use serde_json::Value;

use super::{
    BOOTSTRAP_KEY, Daemon, MODEL, Provider, ReplyStream, bot_id, chat_reply, http_client, json,
    recall_status, transcript,
};

#[tokio::test]
#[ignore = "requires the verified Recall model in OMARCHY_AGENT_RECALL_TEST_MODEL_DIR"]
async fn source_bot_recall_returns_matching_originals_in_the_current_conversation() {
    let model_dir = std::env::var_os("OMARCHY_AGENT_RECALL_TEST_MODEL_DIR")
        .expect("provide the pinned Recall model directory");
    let mut provider = Provider::start().await;
    let directory = tempfile::tempdir().expect("create disposable daemon directory");
    let mut command = Daemon::command(&directory.path().join("daemon.sqlite3"), &provider);
    command
        .env("OMARCHY_AGENT_MODEL", MODEL)
        .env("OPENAI_API_KEY", BOOTSTRAP_KEY)
        .env("OMARCHY_AGENT_RECALL_MODEL_DIR", model_dir);
    let daemon = Daemon::launch(command).await;
    let client = http_client();
    let current = daemon.create(&client).await;
    let current_id = bot_id(&current);
    let source = create_named(&daemon, &client, "Studio").await;
    let source_id = bot_id(&source);
    let other = create_named(&daemon, &client, "Gallery").await;
    let other_id = bot_id(&other);
    recall_status(&client, &daemon, "ready").await;

    let current_text = "I have a package reference LP-832-A.";
    let original = "The ceramic lamp order LP-832-A is ready for pickup.";
    let original_reply = "Pick up ceramic lamp LP-832-A at the studio on Friday.";
    let decoy = "Pick up the ceramic lamp order LP-832-B on Saturday.";
    for (id, text, answer) in [
        (current_id, current_text, "Recorded the reference."),
        (source_id, original, original_reply),
        (other_id, decoy, "Recorded the pickup date."),
    ] {
        let mut reply = ReplyStream::new(daemon.send(&client, id, text).await);
        chat_reply(provider.next().await, &mut reply, answer).await;
    }
    let source_history = daemon.read(&client, source_id).await;
    let question = "Which other Bot did I discuss the lamp order LP-832-A with?";
    let mut reply = ReplyStream::new(daemon.send(&client, current_id, question).await);
    let call = provider.next().await;
    call.assert_messages(&[
        ("user", current_text),
        ("assistant", "Recorded the reference."),
        ("user", question),
    ]);
    let later = "The ceramic lamp order LP-832-A now has a new pickup time.";
    let mut other_reply = ReplyStream::new(daemon.send(&client, other_id, later).await);
    chat_reply(
        provider.next().await,
        &mut other_reply,
        "Recorded the change.",
    )
    .await;
    let other_history = daemon.read(&client, other_id).await;

    let queries = [
        ("call_default", json!({"query": "LP-832-A"})),
        (
            "call_source",
            json!({"query": "LP-832-A", "scope": "source_bot"}),
        ),
        (
            "call_semantic",
            json!({"query": "collect a ceramic lamp at the studio on Friday", "scope": "source_bot"}),
        ),
        (
            "call_absent",
            json!({"query": "LP-832-Z", "scope": "source_bot"}),
        ),
        (
            "call_unrelated",
            json!({"query": "whale migration in the north Atlantic", "scope": "source_bot"}),
        ),
    ];
    let calls: Vec<_> = queries
        .iter()
        .enumerate()
        .map(|(index, (id, args))| {
            json!({"index": index, "id": id, "type": "function", "function": {
                "name": "recall", "arguments": args.to_string(),
            }})
        })
        .collect();
    call.chunk(json!({"role": "assistant", "tool_calls": calls}), None)
        .await;
    call.chunk(json!({}), Some("tool_calls")).await;
    call.frame("[DONE]").await;
    let continuation = provider.next().await;
    let messages = continuation.body["messages"]
        .as_array()
        .expect("continued Chat Completions messages");
    let result = |call_id| {
        let output = messages
            .iter()
            .find(|message| message["role"] == "tool" && message["tool_call_id"] == call_id)
            .expect("Recall output reached the same Turn");
        let output: Value = serde_json::from_str(output["content"].as_str().unwrap())
            .unwrap_or_else(|_| panic!("expected Recall JSON for {call_id}: {output}"));
        assert_eq!(output["historical"], true);
        output["messages"]
            .as_array()
            .expect("Recall returns a message list")
            .clone()
    };
    let ordinary = result("call_default");
    assert_eq!(ordinary[0]["text"], current_text);
    assert!(ordinary.iter().all(|hit| hit["bot_id"] == current_id));

    let scoped = result("call_source");
    assert_eq!(scoped.len(), 2, "only matching originals: {scoped:?}");
    for source_message in source_history["messages"].as_array().unwrap() {
        let hit = scoped
            .iter()
            .find(|hit| hit["message_id"] == source_message["id"])
            .expect("original message has a source reference");
        let text = source_message["text"].as_str().unwrap();
        assert_eq!(hit["bot_id"], source_id);
        assert_eq!(hit["bot_name"], "Studio");
        assert_eq!(hit["role"], source_message["role"]);
        assert_eq!(hit["text"], text);
        assert_eq!(hit["start_byte"], 0);
        assert_eq!(hit["end_byte"], text.len());
    }
    let semantic = result("call_semantic");
    assert_eq!(semantic[0]["bot_id"], source_id, "{semantic:?}");
    assert_eq!(semantic[0]["text"], original_reply);
    assert!(result("call_absent").is_empty());
    assert!(result("call_unrelated").is_empty());

    let answer = "You discussed LP-832-A with Studio. Pickup is on Friday.";
    chat_reply(continuation, &mut reply, answer).await;
    let persisted = daemon.read(&client, current_id).await;
    assert_eq!(persisted["bot"], current);
    assert_eq!(
        transcript(&persisted),
        [
            ("user", current_text),
            ("assistant", "Recorded the reference."),
            ("user", question),
            ("assistant", answer),
        ]
    );
    assert_eq!(daemon.read(&client, source_id).await, source_history);
    assert_eq!(daemon.read(&client, other_id).await, other_history);
    daemon.stop().await;
}

async fn create_named(daemon: &Daemon, client: &Client, name: &str) -> Value {
    let response = client
        .post(format!("{}/bots", daemon.url))
        .json(&json!({"name": name}))
        .send()
        .await
        .expect("create named Bot");
    assert_eq!(response.status(), StatusCode::CREATED);
    response.json().await.expect("read created Bot")
}
