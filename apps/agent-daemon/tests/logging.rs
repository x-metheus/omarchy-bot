use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;

const DEADLINE: Duration = Duration::from_secs(10);
const SECRET: &str = "fixture-secret-in-database-path";

fn daemon(profile: &Path, db: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_metheus-agent-daemon"));
    command
        .kill_on_drop(true)
        .current_dir(profile)
        .env("OMARCHY_AGENT_DB", db)
        .env("OMARCHY_AGENT_PORT", "0")
        .env("RUST_LOG", "trace")
        .env_remove("OPENAI_API_KEY")
        .env_remove("OPENAI_BASE_URL")
        .env_remove("ANTHROPIC_BASE_URL")
        .env_remove("OMARCHY_AGENT_LOG_DIR")
        .env_remove("OMARCHY_AGENT_MASTER_KEY_FILE")
        .env_remove("OMARCHY_AGENT_SETTINGS_TOKEN_FILE")
        .env_remove("OMARCHY_AGENT_WORK_DIR")
        .env_remove("OMARCHY_AGENT_RECALL_MODEL_DIR")
        .env_remove("OMARCHY_AGENT_RECALL_BUNDLE_DIR")
        .env_remove("OMARCHY_AGENT_RECALL_DOWNLOAD")
        .stdin(Stdio::null());
    command
}

#[tokio::test]
async fn standalone_sends_diagnostics_to_stderr_and_only_readiness_to_stdout() {
    let profile = tempfile::tempdir().unwrap();
    let mut child = daemon(profile.path(), &profile.path().join("daemon.sqlite3"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut readiness = String::new();
    tokio::time::timeout(DEADLINE, stdout.read_line(&mut readiness))
        .await
        .unwrap()
        .unwrap();
    let address = readiness
        .trim_end()
        .strip_prefix("LISTENING http://")
        .expect("readiness line");
    assert!(
        address
            .parse::<std::net::SocketAddr>()
            .unwrap()
            .ip()
            .is_loopback()
    );
    child.kill().await.unwrap();
    let output = child.wait_with_output().await.unwrap();
    let mut rest = String::new();
    stdout.read_to_string(&mut rest).await.unwrap();
    assert!(rest.is_empty(), "unexpected stdout after readiness: {rest}");
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("Agent Daemon startup"));
    assert!(stderr.contains("Agent Daemon ready"));
    assert!(!profile.path().join("agent-daemon.log").exists());
}

#[tokio::test]
async fn managed_startup_failure_reaches_its_file_or_stderr_when_file_is_unavailable() {
    let profile = tempfile::tempdir().unwrap();
    let db = profile.path().join(SECRET).join("daemon.sqlite3");
    let logs = profile.path().join("logs");
    let blocked = profile.path().join("blocked-logs");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir(&blocked).unwrap();
        std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    #[cfg(not(unix))]
    std::fs::write(&blocked, []).unwrap();

    let managed = tokio::time::timeout(
        DEADLINE,
        daemon(profile.path(), &db)
            .env("OMARCHY_AGENT_LOG_DIR", &logs)
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(managed.status.code(), Some(1));
    assert!(managed.stdout.is_empty());
    assert!(managed.stderr.is_empty());
    let records = std::fs::read_to_string(logs.join("agent-daemon.log")).unwrap();
    assert!(records.contains("Agent Daemon startup"));
    assert!(records.contains("Agent Daemon startup failed"));
    assert!(records.contains("database_open_failed"));
    assert!(records.contains("CannotOpen"));
    assert!(!records.contains(SECRET));

    let fallback = tokio::time::timeout(
        DEADLINE,
        daemon(profile.path(), &db)
            .env("OMARCHY_AGENT_LOG_DIR", &blocked)
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(fallback.status.code(), Some(1));
    assert!(fallback.stdout.is_empty());
    let stderr = String::from_utf8(fallback.stderr).unwrap();
    assert!(stderr.contains("log_open_failed") && stderr.contains("database_open_failed"));
    assert!(!stderr.contains(SECRET));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&blocked).unwrap().permissions().mode() & 0o777,
            0o755
        );
        assert!(!blocked.join("agent-daemon.log").exists());
    }
}

#[tokio::test]
async fn bind_failure_logs_the_io_kind() {
    let profile = tempfile::tempdir().unwrap();
    let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let output = tokio::time::timeout(
        DEADLINE,
        daemon(profile.path(), &profile.path().join("daemon.sqlite3"))
            .env(
                "OMARCHY_AGENT_PORT",
                socket.local_addr().unwrap().port().to_string(),
            )
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr
            .lines()
            .any(|line| line.contains("http_bind_failed") && line.contains("AddrInUse"))
    );
}
