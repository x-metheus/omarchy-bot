use std::fs;
use std::path::{Path, PathBuf};

use reqwest::{Client, Method, StatusCode};
use serde_json::{Value, json};

use super::{
    Daemon, Provider, ProviderCall, ReplyStream, SETTINGS_TOKEN, bot_id, chat_reply, http_client,
    provision_settings, put_settings, settings_command,
};

const TOOLS: [&str; 4] = ["read", "edit", "write", "shell"];

fn workspace(directory: &Path) -> PathBuf {
    let work = directory.join("workspace");
    fs::create_dir(&work).unwrap();
    work
}

async fn start(directory: &Path, provider: &Provider) -> (Daemon, PathBuf) {
    let work = workspace(directory);
    let db = directory.join("conversation.sqlite3");
    provision_settings(&db);
    let mut command = settings_command(&db, provider);
    command
        .env("OMARCHY_AGENT_WORK_DIR", &work)
        .env("OMARCHY_AGENT_MODEL", super::MODEL)
        .env("OPENAI_API_KEY", super::BOOTSTRAP_KEY);
    (Daemon::launch(command).await, work)
}

async fn create_bot(daemon: &Daemon, client: &Client) -> Value {
    let created = client
        .post(format!("{}/bots", daemon.url))
        .bearer_auth(SETTINGS_TOKEN)
        .json(&json!({"name": "Fixture"}))
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::CREATED);
    created.json().await.unwrap()
}

async fn send(daemon: &Daemon, client: &Client, bot: &Value, text: &str) -> ReplyStream {
    ReplyStream::new(
        client
            .post(format!("{}/bots/{}/messages", daemon.url, bot_id(bot)))
            .bearer_auth(SETTINGS_TOKEN)
            .json(&json!({"text": text}))
            .send()
            .await
            .unwrap(),
    )
}

#[tokio::test]
async fn host_tools_require_bearer_on_all_conversation_routes() {
    let directory = tempfile::tempdir().unwrap();
    let mut provider = Provider::start().await;
    let (daemon, _) = start(directory.path(), &provider).await;
    let client = http_client();
    let bot = create_bot(&daemon, &client).await;
    let id = bot_id(&bot);
    let bot_url = format!("{}/bots/{id}", daemon.url);
    for (method, url, body) in [
        (
            Method::POST,
            format!("{}/bots", daemon.url),
            json!({"name": "Other"}),
        ),
        (Method::GET, bot_url.clone(), Value::Null),
        (Method::PATCH, bot_url.clone(), json!({"name": "Other"})),
        (
            Method::POST,
            format!("{bot_url}/messages"),
            json!({"text": "Create a fixture file."}),
        ),
        (
            Method::GET,
            format!("{bot_url}/attachments/{}", uuid::Uuid::nil()),
            Value::Null,
        ),
    ] {
        for token in [None, Some("incorrect-fixture-bearer")] {
            let mut request = client.request(method.clone(), &url).json(&body);
            if let Some(token) = token {
                request = request.bearer_auth(token);
            }
            let response = request.send().await.unwrap();
            assert_eq!(
                response.status(),
                StatusCode::UNAUTHORIZED,
                "{method} {url}"
            );
            assert_eq!(response.headers()["www-authenticate"], "Bearer");
            assert_eq!(
                response.json::<Value>().await.unwrap()["code"],
                "conversation_unauthorized"
            );
        }
    }
    let conversation: Value = client
        .get(bot_url)
        .bearer_auth(SETTINGS_TOKEN)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(conversation["bot"]["name"], "Fixture");
    assert_eq!(conversation["messages"], json!([]));
    assert!(provider.calls.try_recv().is_err());
    daemon.stop().await;
}

#[tokio::test]
async fn host_tools_refuse_startup_without_a_provisioned_bearer() {
    let directory = tempfile::tempdir().unwrap();
    let work = workspace(directory.path());
    let db = directory.path().join("conversation.sqlite3");
    let provider = Provider::start().await;
    let mut command = Daemon::command(&db, &provider);
    command.env("OMARCHY_AGENT_WORK_DIR", &work);
    let output = tokio::time::timeout(super::DEADLINE, command.output())
        .await
        .expect("daemon exits before listening")
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("requires OMARCHY_AGENT_SETTINGS_TOKEN_FILE")
    );
}

async fn tool(call: ProviderCall, index: usize, name: &str, args: Value) {
    call.chunk(
        json!({"role": "assistant", "tool_calls": [{
            "index": 0, "id": format!("call_fixture_{index}"), "type": "function",
            "function": {"name": name, "arguments": args.to_string()}
        }]}),
        None,
    )
    .await;
    call.chunk(json!({}), Some("tool_calls")).await;
    call.frame("[DONE]").await;
}

fn latest_result(call: &ProviderCall) -> &str {
    call.chat_messages()
        .iter()
        .rfind(|message| message["role"] == "tool")
        .and_then(|message| message["content"].as_str())
        .expect("provider receives the latest Rig tool result")
}

#[cfg(unix)]
const SHELL_COMMAND: &str = r#"test -z "${OPENAI_API_KEY+x}" || exit 29; cat result.txt; printf 'stderr-marker\n' >&2; exit 7"#;
#[cfg(windows)]
const SHELL_COMMAND: &str = "if (Test-Path Env:OPENAI_API_KEY) { exit 29 }; Get-Content -Raw -LiteralPath 'result.txt'; [Console]::Error.WriteLine('stderr-marker'); exit 7";
#[cfg(unix)]
const TIMEOUT_COMMAND: &str = "printf 'before-timeout\\n'; sleep 10";
#[cfg(windows)]
const TIMEOUT_COMMAND: &str = "[Console]::WriteLine('before-timeout'); Start-Sleep -Seconds 10";

#[tokio::test]
async fn host_tools_complete_a_confined_file_and_shell_workflow() {
    let directory = tempfile::tempdir().unwrap();
    let mut provider = Provider::start().await;
    let (daemon, work) = start(directory.path(), &provider).await;
    let sample = work.join("sample.txt");
    fs::write(&sample, "initial sample\n").unwrap();
    let outside = directory.path().join("outside.txt");
    let client = http_client();
    let bot = create_bot(&daemon, &client).await;
    let mut reply = send(&daemon, &client, &bot, "Update the calibration samples.").await;
    let first = provider.next().await;
    let offered = first.body["tools"].as_array().unwrap();
    for name in TOOLS {
        assert!(
            offered.iter().any(|tool| tool["function"]["name"] == name),
            "missing {name}"
        );
    }

    tool(first, 1, "read", json!({"path": "sample.txt"})).await;
    let read = provider.next().await;
    assert!(latest_result(&read).contains("initial sample"));
    tool(
        read,
        2,
        "edit",
        json!({"path": "sample.txt", "edits": [
            {"old_text": "initial sample", "new_text": "edited sample"}
        ]}),
    )
    .await;
    let edit = provider.next().await;
    assert_eq!(fs::read_to_string(&sample).unwrap(), "edited sample\n");
    tool(
        edit,
        3,
        "write",
        json!({"path": "sample.txt", "content": "replacement sample\n"}),
    )
    .await;
    let replaced = provider.next().await;
    assert_eq!(fs::read_to_string(&sample).unwrap(), "replacement sample\n");

    fs::write(&sample, "external update\n").unwrap();
    tool(
        replaced,
        4,
        "write",
        json!({"path": "sample.txt", "content": "stale replacement\n"}),
    )
    .await;
    let stale = provider.next().await;
    assert!(latest_result(&stale).contains("changed since"));
    assert_eq!(fs::read_to_string(&sample).unwrap(), "external update\n");
    tool(
        stale,
        5,
        "write",
        json!({"path": "sub/result.txt", "content": "command fixture\n"}),
    )
    .await;
    let created = provider.next().await;
    assert_eq!(
        fs::read_to_string(work.join("sub/result.txt")).unwrap(),
        "command fixture\n"
    );
    tool(
        created,
        6,
        "write",
        json!({"path": "../outside.txt", "content": "unauthorized creation\n"}),
    )
    .await;
    let outside_write = provider.next().await;
    assert!(latest_result(&outside_write).contains("is outside"));
    assert!(!outside.exists());

    tool(
        outside_write,
        7,
        "shell",
        json!({"command": SHELL_COMMAND, "cwd": "sub"}),
    )
    .await;
    let ran = provider.next().await;
    let output = latest_result(&ran);
    for expected in ["command fixture", "stderr-marker", "[exit code 7]"] {
        assert!(
            output.contains(expected),
            "Missing {expected:?} in {output:?}"
        );
    }
    tool(
        ran,
        8,
        "shell",
        json!({"command": SHELL_COMMAND, "cwd": ".."}),
    )
    .await;
    let outside_cwd = provider.next().await;
    assert!(latest_result(&outside_cwd).contains("is outside"));
    tool(
        outside_cwd,
        9,
        "shell",
        json!({"command": TIMEOUT_COMMAND, "timeout_secs": 1}),
    )
    .await;
    let timed_out = provider.next().await;
    let output = latest_result(&timed_out);
    assert!(output.contains("before-timeout"), "{output:?}");
    assert!(output.contains("[timed out after 1s"), "{output:?}");
    chat_reply(timed_out, &mut reply, "Calibration checked.").await;
    daemon.stop().await;
}

#[tokio::test]
async fn host_tools_read_forwards_the_image_as_a_multimodal_result() {
    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    use base64::{Engine, engine::general_purpose::STANDARD};

    let directory = tempfile::tempdir().unwrap();
    let mut provider = Provider::start().await;
    let (daemon, work) = start(directory.path(), &provider).await;
    fs::write(work.join("pixel.png"), STANDARD.decode(PNG).unwrap()).unwrap();
    let client = http_client();
    put_settings(
        &client,
        &daemon,
        json!({
            "provider": "anthropic", "model": "claude-haiku-4-5", "apiKey": super::ANTHROPIC_KEY
        }),
        StatusCode::OK,
    )
    .await;
    let bot = create_bot(&daemon, &client).await;
    let mut reply = send(
        &daemon,
        &client,
        &bot,
        "Find the color of the fixture pixel.",
    )
    .await;
    let call = provider.next().await;
    call.assert_request(
        super::MESSAGES_PATH,
        "claude-haiku-4-5",
        super::ANTHROPIC_KEY,
    );
    assert!(
        call.body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "read")
    );
    for event in [
        json!({"type": "message_start", "message": {"id": "msg_fixture", "type": "message", "role": "assistant", "model": "claude-haiku-4-5", "content": [], "stop_reason": null, "stop_sequence": null, "usage": {"input_tokens": 3, "output_tokens": 1}}}),
        json!({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "toolu_fixture_read", "name": "read", "input": {}}}),
        json!({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": json!({"path": "pixel.png"}).to_string()}}),
        json!({"type": "content_block_stop", "index": 0}),
        json!({"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": null}, "usage": {"output_tokens": 2}}),
        json!({"type": "message_stop"}),
    ] {
        call.frame(event.to_string()).await;
    }
    drop(call);

    let continued = provider.next().await;
    let result = continued.body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|message| message["content"].as_array())
        .flatten()
        .find(|block| block["type"] == "tool_result")
        .expect("Anthropic receives the image read result");
    assert_eq!(result["is_error"], false);
    assert!(result["content"].as_array().unwrap().contains(&json!({
        "type": "image", "source": {"type": "base64", "media_type": "image/png", "data": PNG}
    })));
    continued.messages_reply("Red.").await;
    assert_eq!(reply.expect("delta").await, "Red.");
    assert_eq!(reply.expect("committed").await["text"], "Red.");
    daemon.stop().await;
}
