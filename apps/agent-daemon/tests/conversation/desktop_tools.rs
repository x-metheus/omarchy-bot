use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use tokio::time::timeout;

use super::host_tools::{latest_result, start, tool};
use super::{
    DEADLINE, Daemon, Provider, ReplyStream, SETTINGS_TOKEN, bot_id, chat_reply, http_client,
};

async fn pair(daemon: &Daemon, client: &Client, name: &str) -> String {
    let code: Value = client
        .post(format!("{}/api/pairing/codes", daemon.url))
        .bearer_auth(SETTINGS_TOKEN)
        .json(&json!({"name": name}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let device: Value = client
        .post(format!("{}/api/pairing/exchange", daemon.url))
        .json(&json!({"code": code["code"]}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    device["token"].as_str().unwrap().to_owned()
}

async fn next_tool(events: &mut ReplyStream, operation: &str, status: &str) -> Value {
    let payload = timeout(DEADLINE, async {
        loop {
            let (event, payload) = events.next().await.expect("Conversation stream stays open");
            if event == "tool" {
                return payload;
            }
        }
    })
    .await
    .expect("Conversation reports tool progress");
    assert_eq!(payload["name"], operation, "{payload}");
    assert_eq!(payload["status"], status, "{operation}: {payload}");
    payload["id"].clone()
}

#[tokio::test]
async fn desktop_tools_report_correlated_results_denial_and_disconnect() {
    let directory = tempfile::tempdir().unwrap();
    let mut provider = Provider::start().await;
    let (daemon, work) = start(directory.path(), &provider).await;
    let client = http_client();
    let token = pair(&daemon, &client, "Fixture desktop").await;
    let other = pair(&daemon, &client, "Other desktop").await;
    let url = format!("{}/api/desktop-tools", daemon.url);
    let connect = |token: &str| client.get(&url).bearer_auth(token).send();
    assert_eq!(
        connect(SETTINGS_TOKEN).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let mut desktop = ReplyStream::new(connect(&token).await.unwrap());
    let ready = desktop.expect("ready").await;
    let session = ready["session"].as_str().unwrap();
    let bot = daemon.create(&client).await;
    let bot = bot_id(&bot);
    let mut events = daemon.events(&client, bot, 0).await;
    let send = |token: &str| {
        client
        .post(format!("{}/bots/{bot}/messages", daemon.url))
        .bearer_auth(token)
        .json(&json!({"text": "Write a calibration sample on this desktop.", "desktopSession": session}))
        .send()
    };
    assert_eq!(send(&other).await.unwrap().status(), StatusCode::CONFLICT);
    let mut reply = ReplyStream::new(send(&token).await.unwrap());
    let first = provider.next().await;
    tool(
        first,
        1,
        "write",
        json!({"path":"sample.txt", "content":"calibration\n"}),
    )
    .await;
    let request = desktop.expect("request").await;
    let denial = next_tool(&mut events, "write", "running").await;
    assert_eq!(request["name"], "write");
    assert_eq!(request["arguments"]["path"], "sample.txt");
    let id = request["id"].as_str().unwrap();
    let result = |token: &str| {
        client
            .post(format!("{url}/{session}/{id}"))
            .bearer_auth(token)
            .json(&json!({"status":"denied"}))
            .send()
    };
    assert_eq!(
        result(&other).await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        result(&token).await.unwrap().status(),
        StatusCode::NO_CONTENT
    );
    let call = provider.next().await;
    assert!(latest_result(&call).contains("denied"));
    assert!(!work.join("sample.txt").exists());
    chat_reply(call, &mut reply, "The operation was denied.").await;
    assert_eq!(denial, next_tool(&mut events, "write", "failed").await);

    let mut reply = ReplyStream::new(send(&token).await.unwrap());
    tool(
        provider.next().await,
        2,
        "read",
        json!({"path":"sample.txt"}),
    )
    .await;
    let request = desktop.expect("request").await;
    let id = request["id"].as_str().unwrap();
    let result_url = format!("{url}/{session}/{id}");
    let result = |token: &str| {
        client.post(&result_url).bearer_auth(token)
        .json(&json!({"status":"completed", "output":[{"type":"text", "text":"desktop fixture"}]})).send()
    };
    let authorize = |token: &str| {
        client
            .post(format!("{result_url}/authorize"))
            .bearer_auth(token)
            .send()
    };
    assert_eq!(
        result(&token).await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        authorize(&other).await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        authorize(&token).await.unwrap().status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        authorize(&token).await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        result(&token).await.unwrap().status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        result(&token).await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
    let call = provider.next().await;
    assert_eq!(latest_result(&call), "desktop fixture");
    assert!(
        call.chat_messages()
            .iter()
            .any(|message| message["tool_call_id"] == "call_fixture_2")
    );
    chat_reply(call, &mut reply, "The desktop read completed.").await;
    let read = next_tool(&mut events, "read", "running").await;
    assert_eq!(read, next_tool(&mut events, "read", "completed").await);

    let mut reply = ReplyStream::new(send(&token).await.unwrap());
    tool(
        provider.next().await,
        3,
        "write",
        json!({"path":"sample.txt", "content":"must stay on desktop"}),
    )
    .await;
    desktop.expect("request").await;
    let disconnect = next_tool(&mut events, "write", "running").await;
    drop(desktop);
    let call = provider.next().await;
    assert!(latest_result(&call).contains("desktop disconnected"));
    assert!(!work.join("sample.txt").exists());
    chat_reply(call, &mut reply, "The desktop disconnected.").await;
    assert_eq!(disconnect, next_tool(&mut events, "write", "failed").await);
    assert_eq!(send(&token).await.unwrap().status(), StatusCode::CONFLICT);

    let mut reply = ReplyStream::new(daemon.send(&client, bot, "Write the host sample.").await);
    tool(
        provider.next().await,
        4,
        "write",
        json!({"path":"sample.txt", "content":"host fixture"}),
    )
    .await;
    let call = provider.next().await;
    assert_eq!(
        std::fs::read_to_string(work.join("sample.txt")).unwrap(),
        "host fixture"
    );
    chat_reply(call, &mut reply, "The daemon host write completed.").await;

    let host = next_tool(&mut events, "write", "running").await;
    assert_eq!(host, next_tool(&mut events, "write", "completed").await);
    assert_ne!(host, denial);
    daemon.stop().await;
}
