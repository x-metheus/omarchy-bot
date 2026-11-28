use std::ffi::OsString;

use reqwest::Client;
use serde_json::json;
use tokio::time::timeout;

use super::{
    BOOTSTRAP_KEY, DEADLINE, Daemon, MODEL, ObserverReplies, Provider, ProviderCall, ReplyStream,
    bot_id, chat_reply, http_client, recall_status, transcript,
};

const CATALOG_ID: &str = "BUD-917-X";

fn system_prompt(call: &ProviderCall) -> &str {
    call.body["messages"][0]["content"][0]["text"]
        .as_str()
        .expect("Chat Completions system text block")
}

async fn observation_and_chat(provider: &mut Provider) -> (ProviderCall, ProviderCall) {
    let first = provider.next().await;
    let second = provider.next().await;
    assert_ne!(
        first.is_observation(),
        second.is_observation(),
        "expected one observer request and one chat request"
    );
    if first.is_observation() {
        (first, second)
    } else {
        (second, first)
    }
}

fn transcript_sent_to_observer(call: &ProviderCall) -> &str {
    let [prompt] = call.chat_messages() else {
        panic!("the observer receives one transcript prompt");
    };
    assert_eq!(prompt["role"], "user");
    assert!(call.body["tools"].as_array().is_none_or(Vec::is_empty));
    prompt["content"].as_str().unwrap()
}

async fn record_catalog(
    daemon: &Daemon,
    client: &Client,
    provider: &mut Provider,
    bot: &str,
    label: &str,
) -> String {
    let text = format!(
        "Original catalog label {label}. {}",
        "sample notes ".repeat(780)
    );
    let mut stream = ReplyStream::new(daemon.send(client, bot, &text).await);
    chat_reply(provider.next().await, &mut stream, "Catalog label saved").await;
    text
}

async fn request_with_summary(
    daemon: &Daemon,
    client: &Client,
    provider: &mut Provider,
    bot: &str,
    summary: &str,
) -> (ReplyStream, ProviderCall) {
    timeout(DEADLINE, async {
        loop {
            let mut stream = ReplyStream::new(daemon.send(client, bot, "Continue").await);
            let chat = provider.next().await;
            assert!(
                !chat.is_observation(),
                "a pending observation is single-flight per Bot"
            );
            if system_prompt(&chat).contains(summary) {
                return (stream, chat);
            }
            chat_reply(chat, &mut stream, "Ready").await;
        }
    })
    .await
    .expect("a completed observation reaches a later chat request")
}

#[tokio::test]
async fn a_committed_prefix_is_observed_without_blocking_chat_or_rewriting_history() {
    observe_committed_prefix(None).await;
}

#[tokio::test]
#[ignore = "requires the verified Recall model in OMARCHY_AGENT_RECALL_TEST_MODEL_DIR"]
async fn recall_returns_the_original_after_observation_and_restart() {
    let model = std::env::var_os("OMARCHY_AGENT_RECALL_TEST_MODEL_DIR")
        .expect("provide the pinned Recall model directory");
    observe_committed_prefix(Some(model)).await;
}

async fn observe_committed_prefix(recall_model: Option<OsString>) {
    let mut provider = Provider::start_with_observers(ObserverReplies::Scripted).await;
    let directory = tempfile::tempdir().unwrap();
    let db = directory.path().join("daemon.sqlite3");
    let client = http_client();
    let daemon = Daemon::start(&db, &provider).await;
    let bot = daemon.create(&client).await;
    let bot = bot_id(&bot);
    let oldest = record_catalog(&daemon, &client, &mut provider, bot, CATALOG_ID).await;
    let history = daemon.read(&client, bot).await;

    let recent = "Recent envelope is violet";
    let mut stream = ReplyStream::new(daemon.send(&client, bot, recent).await);
    let (observation, chat) = observation_and_chat(&mut provider).await;
    let observed = transcript_sent_to_observer(&observation);
    let first = &history["messages"][0]["id"];
    let through = &history["messages"][1]["id"];
    assert_eq!(
        observed.split_once("New committed messages:\n").unwrap().1,
        format!(
            "Committed user message {first}:\n{oldest}\n\nCommitted assistant message {through}:\nCatalog label saved\n\n"
        ),
    );
    assert!(!observed.contains(recent));
    chat.assert_messages(&[("user", recent)]);
    chat_reply(chat, &mut stream, "Envelope saved").await;

    let during = "Check the envelope again";
    let mut stream = ReplyStream::new(daemon.send(&client, bot, during).await);
    let chat = provider.next().await;
    chat.assert_messages(&[
        ("user", recent),
        ("assistant", "Envelope saved"),
        ("user", during),
    ]);
    chat_reply(chat, &mut stream, "Checked").await;

    let summary = "Historical catalog observation";
    observation.text(summary).await;
    observation.finish().await;
    let (mut stream, chat) =
        request_with_summary(&daemon, &client, &mut provider, bot, summary).await;
    assert!(system_prompt(&chat).contains(&format!("through committed message {through}.")));
    let request = chat.body["messages"].to_string();
    assert!(request.contains(recent));
    assert!(request.contains("Envelope saved"));
    assert!(!request.contains(CATALOG_ID));
    chat_reply(chat, &mut stream, "Ready").await;

    let displayed = daemon.read(&client, bot).await;
    assert_eq!(displayed["messages"][0], history["messages"][0]);
    assert_eq!(displayed["messages"][1], history["messages"][1]);
    assert_eq!(
        &transcript(&displayed)[..6],
        &[
            ("user", oldest.as_str()),
            ("assistant", "Catalog label saved"),
            ("user", recent),
            ("assistant", "Envelope saved"),
            ("user", during),
            ("assistant", "Checked"),
        ]
    );
    daemon.stop().await;

    let with_recall = recall_model.is_some();
    let daemon = if let Some(path) = recall_model {
        let mut command = Daemon::command(&db, &provider);
        command
            .env("OMARCHY_AGENT_MODEL", MODEL)
            .env("OPENAI_API_KEY", BOOTSTRAP_KEY)
            .env("OMARCHY_AGENT_RECALL_MODEL_DIR", path);
        let daemon = Daemon::launch(command).await;
        recall_status(&client, &daemon, "ready").await;
        daemon
    } else {
        Daemon::start(&db, &provider).await
    };
    assert_eq!(daemon.read(&client, bot).await, displayed);
    let query = format!("Find original catalog label {CATALOG_ID}");
    let mut stream = ReplyStream::new(daemon.send(&client, bot, &query).await);
    let chat = provider.next().await;
    assert!(system_prompt(&chat).contains(summary));
    assert!(system_prompt(&chat).contains(&format!("through committed message {through}.")));
    assert!(
        chat.chat_messages()
            .iter()
            .any(|message| message["content"] == recent)
    );
    let chat = if with_recall {
        chat.tools(&[("find_catalog", "recall", json!({"query": CATALOG_ID}))])
            .await;
        let continued = provider.next().await;
        let tool = continued.last_message();
        assert_eq!(tool["role"], "tool");
        assert_eq!(tool["tool_call_id"], "find_catalog");
        let result: serde_json::Value =
            serde_json::from_str(tool["content"].as_str().unwrap()).unwrap();
        let original = &result["messages"][0];
        assert_eq!(original["bot_id"], bot);
        assert_eq!(original["message_id"], *first);
        let start = original["start_byte"].as_u64().unwrap() as usize;
        let end = original["end_byte"].as_u64().unwrap() as usize;
        assert_eq!(original["text"], &oldest[start..end]);
        assert!(oldest[start..end].contains(CATALOG_ID));
        continued
    } else {
        chat
    };
    chat_reply(chat, &mut stream, "Catalog checked").await;
    daemon.stop().await;
}

#[tokio::test]
async fn bots_observe_independently_and_chat_continues_after_a_failed_observation() {
    let mut provider = Provider::start_with_observers(ObserverReplies::Scripted).await;
    let directory = tempfile::tempdir().unwrap();
    let client = http_client();
    let daemon = Daemon::start(&directory.path().join("daemon.sqlite3"), &provider).await;
    let first = daemon.create(&client).await;
    let second = daemon.create(&client).await;
    let first = bot_id(&first);
    let second = bot_id(&second);
    let original_first = record_catalog(&daemon, &client, &mut provider, first, "opal-517-A").await;
    let original_second =
        record_catalog(&daemon, &client, &mut provider, second, "sage-281-B").await;

    let mut stream = ReplyStream::new(daemon.send(&client, first, "Label the opal tray").await);
    let (failed, chat) = observation_and_chat(&mut provider).await;
    let first_input = transcript_sent_to_observer(&failed).to_owned();
    assert!(first_input.contains(&original_first));
    assert!(!first_input.contains("sage-281-B"));
    chat_reply(chat, &mut stream, "Opal tray labeled").await;

    let mut stream = ReplyStream::new(daemon.send(&client, second, "Label the sage tray").await);
    let (successful, chat) = observation_and_chat(&mut provider).await;
    let second_input = transcript_sent_to_observer(&successful);
    assert!(second_input.contains(&original_second));
    assert!(!second_input.contains("opal-517-A"));
    chat_reply(chat, &mut stream, "Sage tray labeled").await;
    let second_summary = "Historical sage catalog";
    successful.text(second_summary).await;
    successful.finish().await;
    let (mut stream, chat) =
        request_with_summary(&daemon, &client, &mut provider, second, second_summary).await;
    assert!(
        chat.chat_messages()
            .iter()
            .any(|message| message["content"] == "Sage tray labeled")
    );
    assert!(!system_prompt(&chat).contains("opal"));
    chat_reply(chat, &mut stream, "Sage checked").await;

    let partial = "Incomplete opal summary";
    failed.text(partial).await;
    failed.chunk(json!({}), Some("length")).await;
    failed.frame("[DONE]").await;
    drop(failed);
    let retry = timeout(DEADLINE, async {
        let mut retry = None;
        loop {
            let mut stream = ReplyStream::new(daemon.send(&client, first, "Check opal").await);
            let chat = loop {
                let call = provider.next().await;
                if !call.is_observation() {
                    break call;
                }
                assert!(retry.is_none(), "one observer can retry independently");
                retry = Some(call);
            };
            let request = chat.body["messages"].to_string();
            assert!(request.contains("Opal tray labeled"));
            assert!(!request.contains("opal-517-A"));
            assert!(!request.contains(partial));
            assert!(!request.contains(second_summary));
            chat_reply(chat, &mut stream, "Opal checked").await;
            if let Some(retry) = retry {
                return retry;
            }
        }
    })
    .await
    .expect("a later chat request can retry the failed observation");
    assert_eq!(transcript_sent_to_observer(&retry), first_input);
    let first_summary = "Historical opal catalog";
    retry.text(first_summary).await;
    retry.finish().await;
    let (mut stream, chat) =
        request_with_summary(&daemon, &client, &mut provider, first, first_summary).await;
    assert!(!system_prompt(&chat).contains(second_summary));
    chat_reply(chat, &mut stream, "Opal catalog checked").await;
    let conversation = daemon.read(&client, first).await;
    assert_eq!(conversation["messages"][0]["text"], original_first);
    daemon.stop().await;
}

#[tokio::test]
async fn observation_stops_before_interrupted_work_after_restart() {
    const INTERRUPTED: &str = "Check the unfinished swatch";
    let mut provider = Provider::start_with_observers(ObserverReplies::Scripted).await;
    let directory = tempfile::tempdir().unwrap();
    let db = directory.path().join("daemon.sqlite3");
    let client = http_client();
    let daemon = Daemon::start(&db, &provider).await;
    let bot = daemon.create(&client).await;
    let bot = bot_id(&bot);
    let oldest = record_catalog(&daemon, &client, &mut provider, bot, CATALOG_ID).await;

    let interrupted = daemon.send(&client, bot, INTERRUPTED).await;
    let (observation, chat) = observation_and_chat(&mut provider).await;
    chat.assert_messages(&[("user", INTERRUPTED)]);
    daemon.stop().await;
    drop((interrupted, observation, chat));

    let daemon = Daemon::start(&db, &provider).await;
    let later = format!("Later catalog label G7.{}", " sample notes".repeat(780));
    let mut stream = ReplyStream::new(daemon.send(&client, bot, &later).await);
    let (observation, chat) = observation_and_chat(&mut provider).await;
    chat.assert_messages(&[("user", &later)]);
    chat_reply(chat, &mut stream, "G7 recorded").await;
    daemon.stop().await;
    drop(observation);

    let daemon = Daemon::start(&db, &provider).await;
    let history = daemon.read(&client, bot).await;
    assert_eq!(history["messages"][2]["text"], INTERRUPTED);
    let recent = "Check the current catalog";
    let mut stream = ReplyStream::new(daemon.send(&client, bot, recent).await);
    let (observation, chat) = observation_and_chat(&mut provider).await;
    chat.assert_messages(&[("user", recent)]);
    let input = transcript_sent_to_observer(&observation);
    assert!(input.contains(&oldest));
    assert!(input.contains("Catalog label saved"));
    assert!(!input.contains(INTERRUPTED));
    assert!(!input.contains("Later catalog label G7"));
    chat_reply(chat, &mut stream, "Checked").await;

    let summary = "Historical catalog before the interrupted work";
    observation.text(summary).await;
    observation.finish().await;
    let (mut stream, chat) =
        request_with_summary(&daemon, &client, &mut provider, bot, summary).await;
    let through = &history["messages"][1]["id"];
    assert!(system_prompt(&chat).contains(&format!("through committed message {through}.")));
    chat_reply(chat, &mut stream, "Ready").await;
    daemon.stop().await;
}
