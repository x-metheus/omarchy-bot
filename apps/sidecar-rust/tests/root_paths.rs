use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{net::TcpListener, process::Command};
use tokio_tungstenite::{accept_async, tungstenite::Message};

async fn absolute_write_through_configured_root(root: &Path) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let destination = root.join("missing/new.txt");
    std::fs::write(
        root.join(".omarchy-bot-local-policy.json"),
        json!({"always":[format!("write:{}",destination.display())],"never":[]}).to_string(),
    )
    .unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_omarchy-bot-sidecar"))
        .env("OMARCHY_BOT_SERVICE_URL", format!("ws://{address}"))
        .env(
            "OMARCHY_BOT_DEVICE_ID",
            "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .env("OMARCHY_BOT_DEVICE_TOKEN", "test-only")
        .env("OMARCHY_BOT_SIDECAR_ROOT", root)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        socket.next().await.unwrap().unwrap();
        socket.send(Message::Text(json!({"type":"local.job","jobId":"absolute","hostname":"paired","botId":"bot","turnId":"turn","action":"write","path":destination,"contents":"accepted"}).to_string().into())).await.unwrap();
        let result: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(std::fs::read_to_string(&destination).unwrap(), "accepted");
        socket.close(None).await.unwrap();
        assert!(child.wait().await.unwrap().success());
    }).await.unwrap();
}
#[cfg(unix)]
#[tokio::test]
async fn absolute_paths_beneath_symlinked_configured_root_are_accepted() {
    let directory = tempfile::tempdir().unwrap();
    let actual = directory.path().join("actual");
    let configured = directory.path().join("configured");
    std::fs::create_dir(&actual).unwrap();
    std::os::unix::fs::symlink(&actual, &configured).unwrap();
    absolute_write_through_configured_root(&configured).await;
}
#[cfg(windows)]
#[tokio::test]
async fn ordinary_windows_absolute_paths_beneath_configured_root_are_accepted() {
    let directory = tempfile::tempdir().unwrap();
    absolute_write_through_configured_root(directory.path()).await;
}

#[cfg(unix)]
#[tokio::test]
async fn root_is_normalized_before_creation_and_policy_persistence() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let directory = tempfile::tempdir().unwrap();
    let base = directory.path().join("base");
    let elsewhere = directory.path().join("elsewhere");
    std::fs::create_dir_all(elsewhere.join("child")).unwrap();
    std::fs::create_dir(&base).unwrap();
    std::os::unix::fs::symlink(elsewhere.join("child"), base.join("link")).unwrap();
    let configured = base.join("link/../new");
    let expected = base.join("new");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_omarchy-bot-sidecar"))
        .env(
            "OMARCHY_BOT_SERVICE_URL",
            format!("ws://{}", listener.local_addr().unwrap()),
        )
        .env(
            "OMARCHY_BOT_DEVICE_ID",
            "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .env("OMARCHY_BOT_DEVICE_TOKEN", "test-only")
        .env("OMARCHY_BOT_SIDECAR_ROOT", &configured)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        socket.next().await.unwrap().unwrap();
        assert!(expected.is_dir(), "startup did not create normalized root");
        assert!(!elsewhere.join("new").exists(), "startup created a physically traversed root");
        socket.send(Message::Text(json!({"type":"local.job","jobId":"root-order","hostname":"paired","botId":"bot","turnId":"turn","action":"write","path":"written.txt","contents":"accepted"}).to_string().into())).await.unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        assert!(lines.next_line().await.unwrap().unwrap().contains("ask"));
        child.stdin.as_mut().unwrap().write_all(b"{\"type\":\"always\",\"jobId\":\"root-order\"}\n").await.unwrap();
        let result: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(std::fs::read_to_string(expected.join("written.txt")).unwrap(), "accepted");
        let policy: Value = serde_json::from_slice(&std::fs::read(expected.join(".omarchy-bot-local-policy.json")).unwrap()).unwrap();
        assert_eq!(policy["always"], json!(["write:written.txt"]));
        socket.close(None).await.unwrap();
        assert!(child.wait().await.unwrap().success());
    }).await.unwrap();
}
