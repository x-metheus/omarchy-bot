use super::{
    CHAT_PATH, Daemon, Provider, ProviderCall, REPLACEMENT_KEY, ReplyStream, bot_id, chat_reply,
    http_client, provision_settings, put_settings, settings_command, transcript,
};
use reqwest::StatusCode;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::time::timeout;

impl ReplyStream {
    pub(super) async fn expect_reply(&mut self, name: &str) -> Value {
        loop {
            let (event, data) = self.next().await.expect("expected a reply event");
            if !matches!(event.as_str(), "work" | "tool") {
                assert_eq!(event, name);
                return data;
            }
        }
    }

    async fn expect_work(&mut self, message: i64, status: &str) -> Value {
        let work = loop {
            let (event, body) = self.next().await.expect("work status event");
            if event == "tool" {
                continue;
            }
            assert_eq!(event, "work");
            break body;
        };
        assert_eq!(work["messageId"], message, "{work}");
        assert_eq!(work["status"], status, "{work}");
        work
    }
}

async fn delegate(provider: &mut Provider, prompt: &str) -> (ProviderCall, ProviderCall) {
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
    (root, child)
}

#[tokio::test]
async fn restart_resumes_queued_work_and_requires_explicit_retry_of_unanswered_work() {
    let mut provider = Provider::start().await;
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("conversation.sqlite3");
    provision_settings(&db);
    let client = http_client();
    let daemon = Daemon::start(&db, &provider).await;
    let bot = daemon.create(&client).await;
    let id = bot_id(&bot);

    let mut completed = ReplyStream::new(daemon.send(&client, id, "Remember teal.").await);
    chat_reply(provider.next().await, &mut completed, "Teal recorded.").await;
    let baseline = completed.cursor.unwrap();

    let active = daemon.send(&client, id, "Check the first swatch.").await;
    let (root, child) = delegate(&mut provider, "Inspect swatch A.").await;
    let args = json!({"agent": root.started_agent()});
    // The independent task gives the fixture a signal after Rig starts processing
    // the reply containing the unanswered wait. Keep both checks blocked.
    root.tools(&[
        ("wait-for-swatch", "wait", args),
        (
            "signal",
            "task",
            json!({"description": "Read spare swatch", "prompt": "Inspect spare swatch."}),
        ),
    ])
    .await;
    let spare = provider.next().await;
    assert!(
        spare
            .last_message()
            .to_string()
            .contains("Inspect spare swatch.")
    );

    let queued = daemon.send(&client, id, "Check the second swatch.").await;
    let before = daemon.read(&client, id).await;
    let active_id = before["messages"][2]["id"].as_i64().unwrap();
    let queued_id = before["messages"][3]["id"].as_i64().unwrap();
    let mut events = daemon.events(&client, id, baseline).await;
    let completed_id = before["messages"][0]["id"].as_i64().unwrap();
    events.expect_work(completed_id, "completed").await;
    events.expect_work(active_id, "queued").await;
    events.expect_work(active_id, "running").await;
    let mut wait_id = None;
    loop {
        let (event, body) = events.next().await.expect("queued work after tool start");
        if event == "tool" && body["name"] == "wait" {
            assert_eq!(body["status"], "running");
            assert_eq!(
                body.as_object().unwrap().len(),
                3,
                "only sanitized tool metadata"
            );
            wait_id = Some(body["id"].clone());
        }
        if event == "work" && body["messageId"] == queued_id {
            assert_eq!(body["status"], "queued");
            break;
        }
    }
    let wait_id = wait_id.expect("running wait tool was journaled");
    let before_restart = events.cursor.unwrap();
    daemon.stop().await;
    drop((active, queued, child, spare, events));

    let daemon = Daemon::launch(settings_command(&db, &provider)).await;
    let mut events = daemon.events(&client, id, before_restart).await;
    loop {
        let (event, body) = events
            .next()
            .await
            .expect("interrupted tool event after restart");
        assert_eq!(event, "tool");
        if body["id"] == wait_id {
            assert_eq!(
                body,
                json!({"id": wait_id, "name": "wait", "status": "interrupted"})
            );
            break;
        }
    }
    events.expect_work(active_id, "interrupted").await;
    assert_eq!(
        events.expect_work(queued_id, "queued").await["reason"],
        "provider_unconfigured"
    );
    assert_eq!(daemon.read(&client, id).await, before);
    put_settings(
        &client,
        &daemon,
        json!({"provider": "openai", "model": "recovery-model", "apiKey": REPLACEMENT_KEY}),
        StatusCode::OK,
    )
    .await;
    let call = provider.next().await;
    call.assert_request(CHAT_PATH, "recovery-model", REPLACEMENT_KEY);
    assert_eq!(
        call.chat_messages(),
        [
            json!({"role": "user", "content": "Remember teal."}),
            json!({"role": "assistant", "content": "Teal recorded."}),
            json!({"role": "user", "content": "Check the second swatch."}),
        ]
    );
    events.expect_work(queued_id, "running").await;
    call.text("Second swatch is violet.").await;
    call.finish().await;
    assert_eq!(events.expect("delta").await, "Second swatch is violet.");
    events.expect("committed").await;
    events.expect_work(queued_id, "completed").await;
    assert!(
        timeout(Duration::from_millis(100), provider.calls.recv())
            .await
            .is_err()
    );

    let retry = format!("{}/bots/{id}/work/{active_id}/retry", daemon.url);
    let retry_request = || {
        client
            .post(&retry)
            .bearer_auth(super::SETTINGS_TOKEN)
            .send()
    };
    let (first, second) = tokio::join!(retry_request(), retry_request());
    let mut statuses = [first.unwrap().status(), second.unwrap().status()];
    statuses.sort_unstable();
    assert_eq!(statuses, [StatusCode::ACCEPTED, StatusCode::CONFLICT]);
    let call = provider.next().await;
    call.assert_request(CHAT_PATH, "recovery-model", REPLACEMENT_KEY);
    assert_eq!(call.last_message()["content"], "Check the first swatch.");
    events.expect_work(active_id, "queued").await;
    events.expect_work(active_id, "running").await;
    call.text("First swatch is amber.").await;
    call.finish().await;
    assert_eq!(events.expect("delta").await, "First swatch is amber.");
    events.expect("committed").await;
    events.expect_work(active_id, "completed").await;
    assert_eq!(
        transcript(&daemon.read(&client, id).await),
        [
            ("user", "Remember teal."),
            ("assistant", "Teal recorded."),
            ("user", "Check the first swatch."),
            ("user", "Check the second swatch."),
            ("assistant", "Second swatch is violet."),
            ("assistant", "First swatch is amber."),
        ]
    );
}

#[tokio::test]
async fn restart_preserves_detached_replies_and_interrupts_unfinished_delegation() {
    let mut provider = Provider::start().await;
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("conversation.sqlite3");
    let client = http_client();
    let daemon = Daemon::start(&db, &provider).await;
    let bot = daemon.create(&client).await;
    let id = bot_id(&bot);

    let mut first = ReplyStream::new(daemon.send(&client, id, "Read the blue sample.").await);
    let (root, child) = delegate(&mut provider, "Read sample A.").await;
    chat_reply(root, &mut first, "The first check is underway.").await;
    let before_report = first.cursor.unwrap();
    let mut events = daemon.events(&client, id, before_report).await;
    let first_id = daemon.read(&client, id).await["messages"][0]["id"]
        .as_i64()
        .unwrap();
    events.expect_work(first_id, "waiting").await;

    child.text("Sample A returned blue.").await;
    child.finish().await;
    let report = provider.next().await;
    assert!(
        report
            .last_message()
            .to_string()
            .contains("Sample A returned blue.")
    );
    report.text("The first sample is blue.").await;
    report.finish().await;
    assert_eq!(events.expect("delta").await, "The first sample is blue.");
    let detached = events.expect("committed").await;
    let detached_cursor = events.cursor;
    events.expect_work(first_id, "completed").await;

    let mut later = ReplyStream::new(daemon.send(&client, id, "Read the yellow sample.").await);
    let (root, child) = delegate(&mut provider, "Read sample B.").await;
    chat_reply(root, &mut later, "The second check is underway.").await;
    let history = daemon.read(&client, id).await;
    let second_id = history["messages"][3]["id"].as_i64().unwrap();
    drop(events);
    daemon.stop().await;
    drop(child);

    let daemon = Daemon::start(&db, &provider).await;
    assert_eq!(daemon.read(&client, id).await, history);
    let mut replay = daemon.events(&client, id, before_report).await;
    replay.expect_work(first_id, "waiting").await;
    assert_eq!(replay.expect("delta").await, "The first sample is blue.");
    assert_eq!(replay.expect("committed").await, detached);
    assert_eq!(replay.cursor, detached_cursor);
    replay.expect_work(first_id, "completed").await;
    replay.expect_work(second_id, "queued").await;
    replay.expect_work(second_id, "running").await;
    assert_eq!(
        replay.expect_reply("delta").await,
        "The second check is underway."
    );
    replay.expect("committed").await;
    replay.expect_work(second_id, "waiting").await;
    replay.expect_work(second_id, "interrupted").await;
    assert!(
        timeout(Duration::from_millis(100), provider.calls.recv())
            .await
            .is_err()
    );

    let retry = format!("{}/bots/{id}/work/{second_id}/retry", daemon.url);
    assert_eq!(
        client.post(&retry).send().await.unwrap().status(),
        StatusCode::ACCEPTED
    );
    let call = provider.next().await;
    assert_eq!(call.last_message()["content"], "Read the yellow sample.");
    call.text("The second sample is yellow.").await;
    call.finish().await;
    assert_eq!(
        replay.expect_reply("delta").await,
        "The second sample is yellow."
    );
    replay.expect("committed").await;
    assert_eq!(
        transcript(&daemon.read(&client, id).await),
        [
            ("user", "Read the blue sample."),
            ("assistant", "The first check is underway."),
            ("assistant", "The first sample is blue."),
            ("user", "Read the yellow sample."),
            ("assistant", "The second check is underway."),
            ("assistant", "The second sample is yellow."),
        ]
    );
}
