#![cfg(unix)]
use omarchy_bot_sidecar::{
    execute,
    protocol::{Job, Os},
};
use serde_json::json;
use std::time::Duration;
use tokio::sync::watch;

#[tokio::test]
async fn cancellation_reaches_descendants_after_the_original_shell_exits() {
    let root = tempfile::tempdir().unwrap();
    let job: Job = serde_json::from_value(json!({"jobId":"orphan","hostname":"paired","botId":"bot","turnId":"turn","action":"run","command":"sh -c 'trap \"\" HUP TERM; echo $$ > descendant.pid; while [ ! -f release ]; do sleep 0.05; done; printf survived > marker.txt' & exit 0"})).unwrap();
    let (stop, cancel) = watch::channel(false);
    let pending = tokio::spawn(execute::execute(job, root.path().into(), Os::Linux, cancel));
    tokio::time::timeout(Duration::from_secs(5), async {
        while !root.path().join("descendant.pid").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let pid: i32 = std::fs::read_to_string(root.path().join("descendant.pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
    stop.send_replace(true);
    assert!(tokio::time::timeout(Duration::from_secs(5), pending)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    let status = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let state = String::from_utf8_lossy(&status.stdout);
    assert!(
        state.trim().is_empty() || state.trim().starts_with(['Z', 'X']),
        "descendant still running: {state}"
    );
    std::fs::write(root.path().join("release"), "").unwrap();
    assert!(!root.path().join("marker.txt").exists());
}
