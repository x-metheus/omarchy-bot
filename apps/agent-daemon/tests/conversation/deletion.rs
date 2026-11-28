use reqwest::StatusCode;
use tokio::time::timeout;

use super::{
    BOOTSTRAP_KEY, DEADLINE, Daemon, MODEL, Provider, ReplyStream, bot_id, chat_reply, http_client,
    json, recall_status,
};

#[tokio::test]
async fn deleting_an_active_bot_closes_its_streams_and_stops_its_subagent() {
    let directory = tempfile::tempdir().unwrap();
    let db = directory.path().join("conversation.sqlite3");
    let mut provider = Provider::start().await;
    let client = http_client();
    let daemon = Daemon::start(&db, &provider).await;
    let bot = daemon.create(&client).await;
    let bot = bot_id(&bot);
    let survivor = daemon.create(&client).await;
    let survivor = bot_id(&survivor);

    let mut active = ReplyStream::new(daemon.send(&client, bot, "Check the first swatch.").await);
    let prompt = "Inspect swatch A.";
    provider
        .next()
        .await
        .tools(&[(
            "delegate",
            "task",
            json!({"description": "Read first swatch", "prompt": prompt}),
        )])
        .await;
    let first = provider.next().await;
    let second = provider.next().await;
    let (root, child) = if first.last_message()["role"] == "tool" {
        (first, second)
    } else {
        (second, first)
    };
    assert!(child.last_message().to_string().contains(prompt));

    let mut queued = ReplyStream::new(daemon.send(&client, bot, "Check the next swatch.").await);
    let history = daemon.read(&client, bot).await;
    let queued_id = history["messages"][1]["id"].as_i64().unwrap();
    root.text("The check is underway.").await;
    assert_eq!(active.expect("delta").await, "The check is underway.");
    let mut events = daemon.events(&client, bot, active.cursor.unwrap()).await;

    let mut other = ReplyStream::new(daemon.send(&client, survivor, "Record violet.").await);
    let other_call = provider.next().await;
    other_call.assert_messages(&[("user", "Record violet.")]);
    let url = format!("{}/bots/{bot}", daemon.url);
    let response = client.delete(&url).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    timeout(DEADLINE, async {
        root.frames.closed().await;
        child.frames.closed().await;
    })
    .await
    .expect("deletion cancels the root and delegated provider calls");
    assert!(active.next().await.is_none(), "active POST stream closes");
    assert!(queued.next().await.is_none(), "queued POST stream closes");
    assert!(events.next().await.is_none(), "Conversation stream closes");
    chat_reply(other_call, &mut other, "Violet recorded.").await;
    let surviving_history = daemon.read(&client, survivor).await;
    assert_eq!(
        client.delete(url).send().await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
    daemon.stop().await;

    let daemon = Daemon::start(&db, &provider).await;
    let url = format!("{}/bots/{bot}", daemon.url);
    for path in [url.clone(), format!("{url}/events")] {
        assert_eq!(
            client.get(path).send().await.unwrap().status(),
            StatusCode::NOT_FOUND
        );
    }
    let retry = client
        .post(format!("{url}/work/{queued_id}/retry"))
        .send()
        .await
        .unwrap();
    assert_eq!(retry.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        daemon.send(&client, bot, "Still there?").await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(daemon.read(&client, survivor).await, surviving_history);
    let mut follow_up = ReplyStream::new(daemon.send(&client, survivor, "Which color?").await);
    let call = provider.next().await;
    call.assert_messages(&[
        ("user", "Record violet."),
        ("assistant", "Violet recorded."),
        ("user", "Which color?"),
    ]);
    chat_reply(call, &mut follow_up, "Violet.").await;
    daemon.stop().await;
}

#[tokio::test]
#[ignore = "requires the verified Recall model in OMARCHY_AGENT_RECALL_TEST_MODEL_DIR"]
async fn deleted_originals_disappear_from_cross_bot_recall_and_stay_gone_after_restart() {
    let model = std::env::var_os("OMARCHY_AGENT_RECALL_TEST_MODEL_DIR")
        .expect("provide the pinned Recall model directory");
    let directory = tempfile::tempdir().unwrap();
    let db = directory.path().join("conversation.sqlite3");
    let mut provider = Provider::start().await;
    let client = http_client();
    let command = |provider: &Provider| {
        let mut command = Daemon::command(&db, provider);
        command
            .env("OMARCHY_AGENT_MODEL", MODEL)
            .env("OPENAI_API_KEY", BOOTSTRAP_KEY)
            .env("OMARCHY_AGENT_RECALL_MODEL_DIR", &model);
        command
    };
    let daemon = Daemon::launch(command(&provider)).await;
    recall_status(&client, &daemon, "ready").await;
    let deleted = daemon.create(&client).await;
    let deleted = bot_id(&deleted);
    let survivor = daemon.create(&client).await;
    let survivor = bot_id(&survivor);
    let reader = daemon.create(&client).await;
    let reader = bot_id(&reader);
    for (bot, text) in [
        (deleted, "Label CAT-1849 was on the old catalog."),
        (survivor, "The replacement catalog uses CAT-1849."),
    ] {
        let mut stream = ReplyStream::new(daemon.send(&client, bot, text).await);
        chat_reply(provider.next().await, &mut stream, "Catalog recorded.").await;
    }

    let before = lookup_reference(&daemon, &client, &mut provider, reader, "catalog-before").await;
    assert_eq!(before.len(), 2);
    let removed = before.iter().find(|hit| hit["bot_id"] == deleted).unwrap();
    let removed_message = removed["message_id"].as_i64().unwrap();
    let kept = before
        .into_iter()
        .find(|hit| hit["bot_id"] == survivor)
        .unwrap();
    let response = client
        .delete(format!("{}/bots/{deleted}", daemon.url))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let after = lookup_reference(&daemon, &client, &mut provider, reader, "catalog-after").await;
    assert_eq!(after, std::slice::from_ref(&kept));
    daemon.stop().await;

    let fixture = rusqlite::Connection::open(&db).unwrap();
    let still_indexed: bool = fixture
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM recall_vectors WHERE message_id = ?1)",
            [removed_message],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!still_indexed, "the deleted original's vector was removed");
    drop(fixture);
    let daemon = Daemon::launch(command(&provider)).await;
    recall_status(&client, &daemon, "ready").await;
    let after_restart =
        lookup_reference(&daemon, &client, &mut provider, reader, "catalog-restarted").await;
    assert_eq!(after_restart, [kept]);
    daemon.stop().await;
}

async fn lookup_reference(
    daemon: &Daemon,
    client: &reqwest::Client,
    provider: &mut Provider,
    reader: &str,
    call_id: &str,
) -> Vec<serde_json::Value> {
    let mut stream = ReplyStream::new(
        daemon
            .send(client, reader, "Which other Bot discussed CAT-1849?")
            .await,
    );
    provider
        .next()
        .await
        .tools(&[(
            call_id,
            "recall",
            json!({"query": "CAT-1849", "scope": "source_bot"}),
        )])
        .await;
    let call = provider.next().await;
    let result = call.last_message();
    assert_eq!(result["tool_call_id"], call_id);
    let mut output: serde_json::Value =
        serde_json::from_str(result["content"].as_str().unwrap()).unwrap();
    chat_reply(call, &mut stream, "Catalog checked.").await;
    let serde_json::Value::Array(matches) = output["messages"].take() else {
        panic!("Recall must return original message matches: {output}");
    };
    matches
}
