use super::{Daemon, Provider, ProviderCall, ReplyStream, bot_id, chat_reply, http_client, json};

#[tokio::test]
async fn user_memory_is_shared_across_bots_and_survives_restart() {
    let mut provider = Provider::start().await;
    let directory = tempfile::tempdir().unwrap();
    let db = directory.path().join("memory.sqlite3");
    let client = http_client();
    let daemon = Daemon::start(&db, &provider).await;
    let writer = daemon.create(&client).await;
    let reader = daemon.create(&client).await;
    let statement = "Please call me Mira.";
    let mut stream = ReplyStream::new(daemon.send(&client, bot_id(&writer), statement).await);
    let call = provider.next().await;
    assert!(
        call.body["tools"].as_array().is_some_and(|tools| tools
            .iter()
            .any(|tool| tool["function"]["name"] == "remember_user_memory")),
        "the Bot can propose verified UserMemory writes; model={}, tools={}",
        call.body["model"],
        call.body["tools"]
    );
    propose(call, "profile.preferred_name", "Mira", statement).await;
    let continued = provider.next().await;
    assert_tool_result(&continued, "Saved UserMemory.");
    assert!(system_prompt(&continued).contains("Mira"));
    chat_reply(continued, &mut stream, "Saved.").await;
    daemon.stop().await;

    let daemon = Daemon::start(&db, &provider).await;
    let mut stream = ReplyStream::new(daemon.send(&client, bot_id(&reader), "Hello.").await);
    let call = provider.next().await;
    assert!(system_prompt(&call).contains("Mira"));
    chat_reply(call, &mut stream, "Hello, Mira.").await;
    let conversation = daemon.read(&client, bot_id(&reader)).await;
    assert_eq!(
        super::transcript(&conversation),
        [("user", "Hello."), ("assistant", "Hello, Mira.")]
    );
    daemon.stop().await;
}

#[tokio::test]
async fn user_memory_inspection_cites_the_current_source_across_bots() {
    let mut provider = Provider::start().await;
    let directory = tempfile::tempdir().unwrap();
    let client = http_client();
    let daemon = Daemon::start(&directory.path().join("memory.sqlite3"), &provider).await;
    let writer = daemon.create(&client).await;
    let reader = daemon.create(&client).await;
    let writer = bot_id(&writer);
    let reader = bot_id(&reader);
    let key = "preferences.units";
    let original = "Always use imperial units.";
    let correction = "Change my units preference to metric.";

    let mut stream = ReplyStream::new(daemon.send(&client, writer, original).await);
    propose(provider.next().await, key, "imperial", original).await;
    chat_reply(provider.next().await, &mut stream, "Saved.").await;

    let mut stream = ReplyStream::new(daemon.send(&client, reader, correction).await);
    propose(provider.next().await, key, "metric", correction).await;
    let continued = provider.next().await;
    assert_tool_result(&continued, "Saved UserMemory.");
    chat_reply(continued, &mut stream, "Updated.").await;
    let source = daemon.read(&client, reader).await;

    let mut stream = ReplyStream::new(
        daemon
            .send(
                &client,
                writer,
                "What do you remember about my units preference?",
            )
            .await,
    );
    let call = provider.next().await;
    assert!(
        call.body["tools"]
            .to_string()
            .contains("inspect_user_memory")
    );
    tool_call(call, "inspect_user_memory", json!({"key": key})).await;
    let continued = provider.next().await;
    assert_eq!(
        inspection(&continued),
        json!([{
            "key": key,
            "value": "metric",
            "source": {
                "bot_id": reader,
                "bot_name": "Lumen",
                "message_id": source["messages"][0]["id"],
                "evidence": correction,
            },
        }])
    );
    chat_reply(
        continued,
        &mut stream,
        "You asked for metric units in Lumen.",
    )
    .await;
    assert_eq!(
        daemon.read(&client, writer).await["messages"][0]["text"],
        original
    );
    daemon.stop().await;
}

#[tokio::test]
async fn user_memory_forgetting_survives_delayed_writes_and_restart() {
    let mut provider = Provider::start().await;
    let directory = tempfile::tempdir().unwrap();
    let db = directory.path().join("memory.sqlite3");
    let client = http_client();
    let daemon = Daemon::start(&db, &provider).await;
    let writer = daemon.create(&client).await;
    let reader = daemon.create(&client).await;
    let clearer = daemon.create(&client).await;
    let writer = bot_id(&writer);
    let reader = bot_id(&reader);
    let clearer = bot_id(&clearer);
    let key = "profile.preferred_name";
    let original = "Call me Élodie.";
    let delayed = "Call me Rowan.";
    let clear = "Could you forget my preferred name?";

    let mut stream = ReplyStream::new(daemon.send(&client, writer, original).await);
    propose(provider.next().await, key, "Élodie", original).await;
    chat_reply(provider.next().await, &mut stream, "Saved Élodie.").await;

    let mut delayed_reply = ReplyStream::new(daemon.send(&client, reader, delayed).await);
    let held = provider.next().await;
    let mut stream = ReplyStream::new(daemon.send(&client, clearer, clear).await);
    let call = provider.next().await;
    assert!(
        call.body["tools"]
            .to_string()
            .contains("forget_user_memory")
    );
    assert!(system_prompt(&call).contains("Élodie"));
    forget(call, key, clear).await;
    let continued = provider.next().await;
    assert_tool_result(&continued, "Forgot UserMemory.");
    let clear_order = daemon.read(&client, clearer).await["messages"][0]["id"]
        .as_i64()
        .unwrap();
    let marker = json!({key: clear_order}).to_string();
    assert!(system_prompt(&continued).contains(&marker));
    assert!(!system_prompt(&continued).contains("Élodie"));
    chat_reply(continued, &mut stream, "I forgot your preferred name.").await;

    propose_all(held, &[(key, "Rowan", delayed), (key, "Rowan", delayed)]).await;
    let continued = provider.next().await;
    assert_eq!(
        continued.body["messages"]
            .to_string()
            .matches("An equal or newer user statement")
            .count(),
        2
    );
    assert!(system_prompt(&continued).contains(&marker));
    assert!(!system_prompt(&continued).contains("Rowan"));
    chat_reply(
        continued,
        &mut delayed_reply,
        "The newer change took precedence.",
    )
    .await;
    daemon.stop().await;

    let daemon = Daemon::start(&db, &provider).await;
    let history = daemon.read(&client, writer).await;
    assert_eq!(history["messages"][0]["text"], original);
    assert_eq!(history["messages"][1]["text"], "Saved Élodie.");
    let mut stream = ReplyStream::new(
        daemon
            .send(&client, writer, "What do you remember about me?")
            .await,
    );
    let call = provider.next().await;
    let context = system_prompt(&call);
    assert!(context.contains(&marker));
    assert!(context.contains("historical"));
    assert!(!context.contains("Élodie"));
    propose(call, key, "Élodie", original).await;
    let continued = provider.next().await;
    assert_tool_result(&continued, "UserMemory was not written");
    tool_call(continued, "inspect_user_memory", json!({})).await;
    let continued = provider.next().await;
    assert_eq!(inspection(&continued), json!([]));
    chat_reply(continued, &mut stream, "I have no current UserMemory.").await;

    let mut delayed_clear = ReplyStream::new(daemon.send(&client, clearer, clear).await);
    let held = provider.next().await;
    let later = "Please call me Dana.";
    let mut stream = ReplyStream::new(daemon.send(&client, reader, later).await);
    propose(provider.next().await, key, "Dana", later).await;
    let continued = provider.next().await;
    assert_tool_result(&continued, "Saved UserMemory.");
    assert!(system_prompt(&continued).contains("Dana"));
    assert!(!system_prompt(&continued).contains(&marker));
    chat_reply(continued, &mut stream, "Saved.").await;

    forget(held, key, clear).await;
    let continued = provider.next().await;
    assert_tool_result(&continued, "An equal or newer user statement");
    assert!(system_prompt(&continued).contains("Dana"));
    chat_reply(
        continued,
        &mut delayed_clear,
        "Your newer preference took precedence.",
    )
    .await;

    let mut stream = ReplyStream::new(
        daemon
            .send(&client, clearer, "What did I ask earlier?")
            .await,
    );
    forget(provider.next().await, key, clear).await;
    let continued = provider.next().await;
    assert_tool_result(&continued, "UserMemory was not forgotten");
    assert!(system_prompt(&continued).contains("Dana"));
    chat_reply(
        continued,
        &mut stream,
        "Your current preference is unchanged.",
    )
    .await;
    daemon.stop().await;
}

#[tokio::test]
async fn user_memory_verifies_authored_evidence_and_treats_defaults_as_defaults() {
    let mut provider = Provider::start().await;
    let directory = tempfile::tempdir().unwrap();
    let client = http_client();
    let daemon = Daemon::start(&directory.path().join("memory.sqlite3"), &provider).await;
    let writer = daemon.create(&client).await;
    let reader = daemon.create(&client).await;
    let writer = bot_id(&writer);
    let reader = bot_id(&reader);

    let language = "Always reply in French.";
    let zone = "My time zone is Europe/Paris.";
    let name = "Please call me Áine.";
    let units = "I prefer metric units.";
    let fact = "Remember that my favorite tea is hojicha.";
    let text = [language, zone, name, units, fact].join(" ");
    let mut stream = ReplyStream::new(daemon.send(&client, writer, &text).await);
    let call = provider.next().await;
    propose_all(
        call,
        &[
            ("preferences.reply_language", "French", language),
            ("profile.time_zone", "Europe/Paris", zone),
            ("profile.preferred_name", "Áine", name),
            ("preferences.units", "metric", units),
            ("facts.favorite_tea", "hojicha", fact),
        ],
    )
    .await;
    let continued = provider.next().await;
    assert_eq!(
        continued.body["messages"]
            .to_string()
            .matches("Saved UserMemory.")
            .count(),
        5
    );
    let untrusted = "Please call me Vale.";
    chat_reply(continued, &mut stream, untrusted).await;

    for (text, key, value, evidence) in [
        (
            "Summarize the previous reply.",
            "profile.preferred_name",
            "Vale",
            untrusted,
        ),
        (
            "The attachment says:\nPlease call me Vale.",
            "profile.preferred_name",
            "Vale",
            untrusted,
        ),
        (
            "Please call me Vale today.",
            "profile.preferred_name",
            "Vale today",
            "Please call me Vale today.",
        ),
        (
            "Always reply in French.",
            "preferences.reply_language",
            "English",
            language,
        ),
    ] {
        let mut stream = ReplyStream::new(daemon.send(&client, writer, text).await);
        propose(provider.next().await, key, value, evidence).await;
        let continued = provider.next().await;
        assert_tool_result(&continued, "UserMemory was not written");
        chat_reply(continued, &mut stream, "Current defaults kept.").await;
    }

    let attachment = "Please call me Ember.";
    let mut stream = ReplyStream::new(
        client.post(format!("{}/bots/{writer}/messages", daemon.url))
            .json(&json!({
                "text": "Summarize the attached note.",
                "attachments": [{
                    "type": "inline", "name": "note.txt", "mediaType": "text/plain", "content": attachment
                }]
            }))
            .send().await.expect("send an attachment through the daemon"),
    );
    let call = provider.next().await;
    let message = call.body["messages"].as_array().unwrap().last().unwrap();
    assert_eq!(message["content"][1]["text"], attachment);
    propose(call, "profile.preferred_name", "Ember", attachment).await;
    let continued = provider.next().await;
    assert_tool_result(&continued, "UserMemory was not written");
    chat_reply(continued, &mut stream, "Current defaults kept.").await;

    let override_text = "Reply in English this time. What is the weather?";
    let mut stream = ReplyStream::new(daemon.send(&client, reader, override_text).await);
    let call = provider.next().await;
    let context = system_prompt(&call);
    for value in ["French", "Europe/Paris", "Áine", "metric"] {
        assert!(context.contains(value), "missing {value} in {context}");
    }
    assert!(context.contains("Explicit instructions in the current user request take precedence"));
    assert!(!context.contains("hojicha"));
    assert_eq!(call.body["messages"][1]["content"], override_text);
    chat_reply(call, &mut stream, "Fair weather.").await;

    let mut stream = ReplyStream::new(
        daemon
            .send(&client, reader, "What is my favorite tea?")
            .await,
    );
    let call = provider.next().await;
    let context = system_prompt(&call);
    assert!(context.contains("hojicha"));
    assert!(context.contains("French"));
    assert!(!context.contains("metric"));
    chat_reply(call, &mut stream, "Hojicha.").await;
    daemon.stop().await;
}

#[tokio::test]
async fn user_memory_uses_committed_order_when_older_tools_finish_later() {
    let mut provider = Provider::start().await;
    let directory = tempfile::tempdir().unwrap();
    let client = http_client();
    let daemon = Daemon::start(&directory.path().join("memory.sqlite3"), &provider).await;
    let first = daemon.create(&client).await;
    let second = daemon.create(&client).await;
    let first = bot_id(&first);
    let second = bot_id(&second);
    let key = "profile.preferred_name";
    let old = "Please call me Jules.";
    let new = "Please call me Morgan.";
    let mut earlier = ReplyStream::new(daemon.send(&client, first, old).await);
    let held = provider.next().await;
    let mut later = ReplyStream::new(daemon.send(&client, second, new).await);
    propose(provider.next().await, key, "Morgan", new).await;
    let continued = provider.next().await;
    assert_tool_result(&continued, "Saved UserMemory.");
    chat_reply(continued, &mut later, "Saved.").await;

    propose_all(held, &[(key, "Jules", old), (key, "Jules", old)]).await;
    let continued = provider.next().await;
    assert_eq!(
        continued.body["messages"]
            .to_string()
            .matches("An equal or newer user statement")
            .count(),
        2
    );
    assert!(system_prompt(&continued).contains("Morgan"));
    assert!(!system_prompt(&continued).contains("Jules"));
    chat_reply(continued, &mut earlier, "Already updated.").await;
    daemon.stop().await;
}

#[tokio::test]
async fn user_memory_source_order_survives_existing_history_and_deletion() {
    let mut provider = Provider::start().await;
    let directory = tempfile::tempdir().unwrap();
    let db = directory.path().join("memory.sqlite3");
    let legacy_bot = uuid::Uuid::new_v4();
    {
        let legacy = rusqlite::Connection::open(&db).unwrap();
        legacy.execute_batch(
            "CREATE TABLE bots (id BLOB PRIMARY KEY NOT NULL, name TEXT NOT NULL);
             CREATE TABLE messages (id INTEGER PRIMARY KEY, bot_id BLOB NOT NULL REFERENCES bots(id),
                 role INTEGER NOT NULL CHECK (role IN (0, 1)), text TEXT NOT NULL);"
        ).unwrap();
        legacy
            .execute(
                "INSERT INTO bots VALUES (?1, 'Legacy Bot')",
                [legacy_bot.as_bytes()],
            )
            .unwrap();
        legacy
            .execute(
                "INSERT INTO messages VALUES (73, ?1, 0, 'Original message.')",
                [legacy_bot.as_bytes()],
            )
            .unwrap();
    }
    let client = http_client();
    let daemon = Daemon::start(&db, &provider).await;
    let old_history = daemon.read(&client, &legacy_bot.to_string()).await;
    assert_eq!(old_history["messages"][0]["id"], 73);

    let writer = daemon.create(&client).await;
    let statement = "Please call me Rowan.";
    let mut stream = ReplyStream::new(daemon.send(&client, bot_id(&writer), statement).await);
    propose(
        provider.next().await,
        "profile.preferred_name",
        "Rowan",
        statement,
    )
    .await;
    chat_reply(provider.next().await, &mut stream, "Saved.").await;
    let clear = "Forget my time zone.";
    let mut stream = ReplyStream::new(daemon.send(&client, bot_id(&writer), clear).await);
    forget(provider.next().await, "profile.time_zone", clear).await;
    let call = provider.next().await;
    assert_tool_result(&call, "Forgot UserMemory.");
    chat_reply(call, &mut stream, "Forgotten.").await;
    let history = daemon.read(&client, bot_id(&writer)).await;
    let forget_order = history["messages"][2]["id"].as_i64().unwrap();
    let last_id = history["messages"][3]["id"].as_i64().unwrap();
    assert!(history["messages"][0]["id"].as_i64().unwrap() > 73);
    let url = format!("{}/bots/{}", daemon.url, bot_id(&writer));
    let deleted = client.delete(&url).send().await.unwrap();
    assert_eq!(deleted.status(), reqwest::StatusCode::NO_CONTENT);
    let missing = client.get(&url).send().await.unwrap();
    assert_eq!(missing.status(), reqwest::StatusCode::NOT_FOUND);
    assert_eq!(
        missing.json::<serde_json::Value>().await.unwrap()["code"],
        "bot_not_found"
    );
    daemon.stop().await;

    let daemon = Daemon::start(&db, &provider).await;
    let restarted = client
        .get(format!("{}/bots/{}", daemon.url, bot_id(&writer)))
        .send()
        .await
        .unwrap();
    assert_eq!(restarted.status(), reqwest::StatusCode::NOT_FOUND);
    let reader = daemon.create(&client).await;
    let mut stream = ReplyStream::new(daemon.send(&client, bot_id(&reader), "Hello.").await);
    let call = provider.next().await;
    assert!(system_prompt(&call).contains("Rowan"));
    assert!(system_prompt(&call).contains(&json!({"profile.time_zone": forget_order}).to_string()));
    tool_call(
        call,
        "inspect_user_memory",
        json!({"key": "profile.preferred_name"}),
    )
    .await;
    let continued = provider.next().await;
    assert_eq!(
        inspection(&continued),
        json!([{
            "key": "profile.preferred_name", "value": "Rowan", "source": null,
        }])
    );
    chat_reply(
        continued,
        &mut stream,
        "I remember Rowan. Its original source is unavailable.",
    )
    .await;
    let history = daemon.read(&client, bot_id(&reader)).await;
    assert!(history["messages"][0]["id"].as_i64().unwrap() > last_id);
    daemon.stop().await;
}

#[tokio::test]
async fn a_shared_turn_verifies_memory_against_the_input_delivered_to_its_model_call() {
    let mut provider = Provider::start().await;
    let directory = tempfile::tempdir().unwrap();
    let client = http_client();
    let daemon = Daemon::start(&directory.path().join("memory.sqlite3"), &provider).await;
    let bot = daemon.create(&client).await;
    let id = bot_id(&bot);
    let (earlier, later) = ("Please call me Cedar.", "Please call me Indigo.");
    let mut first = ReplyStream::new(daemon.send(&client, id, earlier).await);
    let call = provider.next().await;
    call.text("Let me check.").await;
    assert_eq!(first.expect("delta").await, "Let me check.");
    let mut second = ReplyStream::new(daemon.send(&client, id, later).await);
    call.finish().await;

    let call = provider.next().await;
    assert_eq!(call.last_message()["content"], later);
    propose_all(
        call,
        &[
            ("profile.preferred_name", "Cedar", earlier),
            ("profile.preferred_name", "Indigo", later),
        ],
    )
    .await;
    let call = provider.next().await;
    assert_tool_result(&call, "UserMemory was not written");
    assert_tool_result(&call, "Saved UserMemory.");
    assert!(system_prompt(&call).contains("Indigo"));
    chat_reply(call, &mut second, "Saved Indigo.").await;
    assert_eq!(first.expect("delta").await, "Saved Indigo.");
    assert_eq!(first.expect("committed").await["text"], "Saved Indigo.");
}

async fn propose(call: ProviderCall, key: &str, value: &str, evidence: &str) {
    propose_all(call, &[(key, value, evidence)]).await;
}

async fn propose_all(call: ProviderCall, proposals: &[(&str, &str, &str)]) {
    let calls: Vec<_> = proposals.iter().enumerate().map(|(index, (key, value, evidence))| {
        json!({
            "index": index,
            "id": format!("call_memory_{index}"),
            "type": "function",
            "function": {
                "name": "remember_user_memory",
                "arguments": json!({"key": key, "value": value, "evidence": evidence}).to_string()
            }
        })
    }).collect();
    call.chunk(json!({"role": "assistant", "tool_calls": calls}), None)
        .await;
    call.chunk(json!({}), Some("tool_calls")).await;
    call.frame("[DONE]").await;
}

async fn tool_call(call: ProviderCall, name: &str, args: serde_json::Value) {
    call.chunk(
        json!({"role": "assistant", "tool_calls": [{
            "index": 0,
            "id": "call_memory_operation",
            "type": "function",
            "function": {"name": name, "arguments": args.to_string()},
        }]}),
        None,
    )
    .await;
    call.chunk(json!({}), Some("tool_calls")).await;
    call.frame("[DONE]").await;
}

async fn forget(call: ProviderCall, key: &str, evidence: &str) {
    tool_call(
        call,
        "forget_user_memory",
        json!({"key": key, "evidence": evidence}),
    )
    .await;
}

fn inspection(call: &ProviderCall) -> serde_json::Value {
    let result = call.body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "tool")
        .expect("Rig returns an inspection result");
    serde_json::from_str(result["content"].as_str().expect("inspect result text"))
        .expect("inspect result is JSON")
}

fn assert_tool_result(call: &ProviderCall, expected: &str) {
    assert!(
        call.body["messages"]
            .as_array()
            .is_some_and(
                |messages| messages.iter().any(|message| message["role"] == "tool"
                    && message["content"].to_string().contains(expected))
            ),
        "Rig should return {expected:?} in its tool result: {}",
        call.body["messages"]
    );
}

fn system_prompt(call: &ProviderCall) -> &str {
    call.body["messages"]
        .as_array()
        .and_then(|messages| messages.iter().find(|message| message["role"] == "system"))
        .and_then(|message| message["content"][0]["text"].as_str())
        .unwrap_or_default()
}
