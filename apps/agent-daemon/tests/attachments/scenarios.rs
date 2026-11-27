use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use reqwest::{Client, Response, StatusCode};
use serde_json::{Value, json};
use uuid::Uuid;

use super::{Daemon, Provider, ReplyStream, bot_id, chat_reply, http_client};

const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const TEXT: &str = "Calibration sample: cobalt.";
const VISION_MODEL: &str = "gpt-4.1-mini";

async fn start(db: &Path, provider: &Provider, model: &str) -> Daemon {
    let mut command = Daemon::command(db, provider);
    command
        .env("OMARCHY_AGENT_MODEL", model)
        .env("OPENAI_API_KEY", super::BOOTSTRAP_KEY);
    Daemon::launch(command).await
}

async fn send(daemon: &Daemon, client: &Client, bot: &str, message: Value) -> Response {
    client
        .post(format!("{}/bots/{bot}/messages", daemon.url))
        .json(&message)
        .send()
        .await
        .expect("submit message with attachments")
}

async fn download(daemon: &Daemon, client: &Client, bot: &str, attachment: &str) -> Response {
    client
        .get(format!(
            "{}/bots/{bot}/attachments/{attachment}",
            daemon.url
        ))
        .send()
        .await
        .expect("read Conversation attachment")
}

#[tokio::test]
async fn forwards_text_and_image_through_chat_completions() {
    let directory = tempfile::tempdir().unwrap();
    let db = directory.path().join("conversation.sqlite3");
    let client = http_client();
    let mut provider = Provider::start().await;
    let daemon = start(&db, &provider, VISION_MODEL).await;
    let bot = daemon.create(&client).await;
    let mut stream = ReplyStream::new(
        send(
            &daemon,
            &client,
            bot_id(&bot),
            json!({"text": "What are the sample and pixel colors?", "attachments": [
                {"type": "inline", "name": "sample.txt", "mediaType": "text/plain", "content": TEXT},
                {"type": "inline", "name": "pixel.png", "mediaType": "image/png", "content": PNG}
            ]}),
        )
        .await,
    );
    let call = provider.next().await;
    call.assert_request(super::CHAT_PATH, VISION_MODEL, super::BOOTSTRAP_KEY);
    let message = &call.chat_messages()[0];
    assert_eq!(message["role"], "user");
    assert_eq!(
        message["content"][0],
        json!({"type": "text", "text": "What are the sample and pixel colors?"})
    );
    assert_eq!(message["content"][1], json!({"type": "text", "text": TEXT}));
    assert_eq!(message["content"][2]["type"], "image_url");
    assert_eq!(
        message["content"][2]["image_url"]["url"],
        format!("data:image/png;base64,{PNG}")
    );
    chat_reply(call, &mut stream, "Cobalt and red").await;
    daemon.stop().await;
}

#[tokio::test]
async fn restores_attachment_ownership_and_reuses_only_authorized_references() {
    let directory = tempfile::tempdir().unwrap();
    let db = directory.path().join("conversation.sqlite3");
    let client = http_client();
    let mut provider = Provider::start().await;
    let daemon = start(&db, &provider, VISION_MODEL).await;
    let bot = daemon.create(&client).await;
    let bot = bot_id(&bot);
    let other = daemon.create(&client).await;
    let other = bot_id(&other);
    let mut stream = ReplyStream::new(send(&daemon, &client, bot, json!({
        "text": "Keep these samples available.", "attachments": [
            {"type": "inline", "name": "sample.txt", "mediaType": "text/plain", "content": TEXT},
            {"type": "inline", "name": "pixel.png", "mediaType": "image/png", "content": PNG}
        ]
    })).await);
    chat_reply(provider.next().await, &mut stream, "Stored").await;
    let before_restart = daemon.read(&client, bot).await;
    daemon.stop().await;

    let daemon = start(&db, &provider, VISION_MODEL).await;
    let restored = daemon.read(&client, bot).await;
    assert_eq!(restored, before_restart);
    let first = &restored["messages"][0];
    assert_eq!(first["text"], "Keep these samples available.");
    let attachments = first["attachments"].as_array().unwrap();
    assert_eq!(attachments.len(), 2);
    for (attachment, name, media_type) in [
        (&attachments[0], "sample.txt", "text/plain"),
        (&attachments[1], "pixel.png", "image/png"),
    ] {
        assert_eq!(attachment["name"], name);
        assert_eq!(attachment["mediaType"], media_type);
        assert_eq!(attachment["available"], true);
        assert!(attachment.get("content").is_none());
    }
    let sample = attachments[0]["id"].as_str().unwrap();
    let image = attachments[1]["id"].as_str().unwrap();
    assert!(restored["messages"][1].get("attachments").is_none());

    let response = download(&daemon, &client, bot, sample).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()["content-type"],
        "text/plain; charset=utf-8"
    );
    assert_eq!(response.text().await.unwrap(), TEXT);
    let response = download(&daemon, &client, bot, image).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "image/png");
    assert_eq!(
        &response.bytes().await.unwrap()[..],
        STANDARD.decode(PNG).unwrap()
    );

    let unknown = Uuid::new_v4().to_string();
    for (target, id) in [(other, image), (bot, unknown.as_str())] {
        let response = download(&daemon, &client, target, id).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response.json::<Value>().await.unwrap()["code"],
            "attachment_not_found"
        );
        let response = send(&daemon, &client, target, json!({
            "text": "Reject the entire submission.", "attachments": [
                {"type": "inline", "name": "unused.txt", "mediaType": "text/plain", "content": "unused"},
                {"type": "reference", "id": id}
            ]
        })).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response.json::<Value>().await.unwrap()["code"],
            "attachment_not_found"
        );
    }
    let response = send(&daemon, &client, bot, json!({
        "text": "Reject a malformed ID.", "attachments": [{"type": "reference", "id": "not-a-uuid"}]
    })).await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(daemon.read(&client, bot).await, restored);
    assert_eq!(daemon.read(&client, other).await["messages"], json!([]));

    let mut stream = ReplyStream::new(
        send(
            &daemon,
            &client,
            bot,
            json!({
                "text": "Use the same samples again.", "attachments": [
                    {"type": "reference", "id": image}, {"type": "reference", "id": sample}
                ]
            }),
        )
        .await,
    );
    let call = provider.next().await;
    let messages = call.chat_messages();
    assert_eq!(messages[0]["content"], "Keep these samples available.");
    let parts = messages.last().unwrap()["content"].as_array().unwrap();
    assert_eq!(
        parts[1]["image_url"]["url"],
        format!("data:image/png;base64,{PNG}")
    );
    assert_eq!(parts[2], json!({"type": "text", "text": TEXT}));
    chat_reply(call, &mut stream, "Used again").await;
    assert_eq!(
        daemon.read(&client, bot).await["messages"][2]["attachments"],
        json!([attachments[1], attachments[0]])
    );
    daemon.stop().await;
}

#[tokio::test]
async fn warns_about_unavailable_and_unsupported_attachments_and_keeps_the_message() {
    let directory = tempfile::tempdir().unwrap();
    let db = directory.path().join("conversation.sqlite3");
    let client = http_client();
    let mut provider = Provider::start().await;
    let daemon = start(&db, &provider, "gpt-3.5-turbo").await;
    let bot = daemon.create(&client).await;
    let bot = bot_id(&bot);
    let text = "  Explain the failed samples.  ";
    let mut stream = ReplyStream::new(send(&daemon, &client, bot, json!({
        "text": text, "attachments": [
            {"type": "inline", "name": "pixel.png", "mediaType": "image/png", "content": PNG},
            {"type": "inline", "name": "missing.txt", "mediaType": "text/plain"},
            {"type": "inline", "name": "bad.png", "mediaType": "image/png", "content": "bm90IGFuIGltYWdl"},
            {"type": "inline", "name": "bad.pdf", "mediaType": "application/pdf", "content": "not suitable"},
            {"type": "inline", "name": "sample.txt", "mediaType": "text/plain", "content": TEXT}
        ]
    })).await);
    let message = &daemon.read(&client, bot).await["messages"][0];
    assert_eq!(message["text"], text);
    for (index, (code, available)) in [
        ("attachment_model_unsupported", true),
        ("attachment_unavailable", false),
        ("attachment_unavailable", false),
        ("attachment_format_unsupported", false),
    ]
    .into_iter()
    .enumerate()
    {
        let warning = stream.expect("attachment_warning").await;
        assert_eq!(warning["code"], code);
        assert_eq!(warning["attachmentId"], message["attachments"][index]["id"]);
        assert_eq!(message["attachments"][index]["available"], available);
    }
    let call = provider.next().await;
    assert_eq!(
        call.chat_messages()[0]["content"],
        json!([
            {"type": "text", "text": text.trim()}, {"type": "text", "text": TEXT}
        ])
    );
    chat_reply(call, &mut stream, "The text sample is cobalt").await;

    let missing = message["attachments"][1]["id"].as_str().unwrap();
    let response = download(&daemon, &client, bot, missing).await;
    assert_eq!(response.status(), StatusCode::GONE);
    assert_eq!(
        response.json::<Value>().await.unwrap()["code"],
        "attachment_unavailable"
    );
    daemon.stop().await;
}

#[tokio::test]
async fn forwards_text_and_image_through_an_unlisted_messages_alias() {
    let directory = tempfile::tempdir().unwrap();
    let db = directory.path().join("conversation.sqlite3");
    let client = http_client();
    let mut provider = Provider::start().await;
    super::provision_settings(&db);
    let daemon = Daemon::launch(super::settings_command(&db, &provider)).await;
    super::put_settings(
        &client,
        &daemon,
        json!({
            "provider": "anthropic", "model": super::MESSAGES_MODEL, "apiKey": super::ANTHROPIC_KEY
        }),
        StatusCode::OK,
    )
    .await;
    let bot = daemon.create(&client).await;
    let mut stream = ReplyStream::new(send(&daemon, &client, bot_id(&bot), json!({
        "text": "What are the sample and pixel colors?", "attachments": [
            {"type": "inline", "name": "sample.txt", "mediaType": "text/plain", "content": TEXT},
            {"type": "inline", "name": "pixel.png", "mediaType": "image/png", "content": PNG}
        ]
    })).await);
    let call = provider.next().await;
    call.assert_request(
        super::MESSAGES_PATH,
        super::MESSAGES_MODEL,
        super::ANTHROPIC_KEY,
    );
    assert_eq!(
        call.body["messages"][0],
        json!({"role": "user", "content": [
            {"type": "text", "text": "What are the sample and pixel colors?"},
            {"type": "text", "text": TEXT},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": PNG}}
        ]})
    );
    call.messages_reply("Cobalt and red").await;
    assert_eq!(stream.expect("delta").await, "Cobalt and red");
    assert_eq!(stream.expect("committed").await["text"], "Cobalt and red");
    assert!(stream.next().await.is_none());
    daemon.stop().await;
}
