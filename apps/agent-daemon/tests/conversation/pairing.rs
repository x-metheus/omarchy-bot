use super::{
    BOOTSTRAP_KEY, Daemon, MODEL, Provider, ReplyStream, SETTINGS_TOKEN, http_client,
    provision_settings, settings_command,
};
use reqwest::StatusCode;
use serde_json::{Value, json};

#[tokio::test]
async fn device_access_survives_restart_and_revocation_closes_both_streams() {
    let directory = tempfile::tempdir().unwrap();
    let db = directory.path().join("conversation.sqlite3");
    let mut provider = Provider::start().await;
    provision_settings(&db);
    let start = || {
        let mut command = settings_command(&db, &provider);
        command
            .env("OPENAI_API_KEY", BOOTSTRAP_KEY)
            .env("OMARCHY_AGENT_MODEL", MODEL);
        command
    };
    let daemon = Daemon::launch(start()).await;
    let client = http_client();
    let bots = format!("{}/bots", daemon.url);
    assert_eq!(
        client.get(&bots).send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let code: Value = client
        .post(format!("{}/api/pairing/codes", daemon.url))
        .bearer_auth(SETTINGS_TOKEN)
        .json(&json!({"name":"Fixture desktop"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let exchange = || {
        client
            .post(format!("{}/api/pairing/exchange", daemon.url))
            .json(&json!({"code":code["code"]}))
            .send()
    };
    let (first, second) = tokio::join!(exchange(), exchange());
    let (first, second) = (first.unwrap(), second.unwrap());
    let (accepted, rejected) = if first.status().is_success() {
        (first, second)
    } else {
        (second, first)
    };
    assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);
    let device: Value = accepted.error_for_status().unwrap().json().await.unwrap();
    let token = device["token"].as_str().unwrap();
    let id = device["device"]["id"].as_str().unwrap();
    let created: Value = client
        .post(&bots)
        .bearer_auth(token)
        .json(&json!({"name":"Fixture Bot"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let bot = created["id"].as_str().unwrap();
    assert_eq!(
        client
            .get(format!("{}/api/devices/paired", daemon.url))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    daemon.stop().await;

    let daemon = Daemon::launch(start()).await;
    let bots = format!("{}/bots", daemon.url);
    let url = format!("{bots}/{bot}");
    let list: Value = client
        .get(&bots)
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(list, json!([created]));
    let settings = format!("{}/settings", daemon.url);
    assert_eq!(
        client
            .get(&settings)
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let mut conversation = ReplyStream::new(
        client
            .get(format!("{url}/events"))
            .bearer_auth(token)
            .send()
            .await
            .unwrap(),
    );
    let mut reply = ReplyStream::new(
        client
            .post(format!("{url}/messages"))
            .bearer_auth(token)
            .json(&json!({"text":"Name the reference swatch."}))
            .send()
            .await
            .unwrap(),
    );
    let call = provider.next().await;
    call.text("The reference").await;
    assert_eq!(reply.expect("delta").await, "The reference");
    assert_eq!(conversation.expect_reply("delta").await, "The reference");
    let cursor = conversation.cursor.unwrap();

    let revoke = format!("{}/api/devices/paired/{id}/revoke", daemon.url);
    assert_eq!(
        client
            .post(&revoke)
            .bearer_auth(SETTINGS_TOKEN)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    assert!(reply.next().await.is_none());
    assert!(conversation.next().await.is_none());
    for endpoint in [&url, &settings, &format!("{url}/events")] {
        assert_eq!(
            client
                .get(endpoint)
                .bearer_auth(token)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    let mut operator = ReplyStream::new(
        client
            .get(format!("{url}/events"))
            .bearer_auth(SETTINGS_TOKEN)
            .header("Last-Event-ID", cursor)
            .send()
            .await
            .unwrap(),
    );
    call.text(" is amber.").await;
    call.finish().await;
    assert_eq!(operator.expect_reply("delta").await, " is amber.");
    assert_eq!(
        operator.expect_reply("committed").await["text"],
        "The reference is amber."
    );
    daemon.stop().await;
}
