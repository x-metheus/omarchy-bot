use omarchy_bot_sidecar::{
    handler::Handler,
    protocol::{ClientFrame, DecisionLine, Job, Os},
};
use serde_json::json;
use tokio::sync::mpsc;
fn job(id: &str) -> Job {
    serde_json::from_value(json!({"jobId":id,"hostname":"paired","botId":"bot","turnId":"turn","action":"write","path":"approved.txt","contents":"approved"})).unwrap()
}
fn decision(kind: &str, id: &str) -> DecisionLine {
    serde_json::from_value(json!({"type":kind,"jobId":id})).unwrap()
}
#[tokio::test]
async fn remembered_approval_and_refusal_survive_restart() {
    let root = tempfile::tempdir().unwrap();
    let (send, mut results) = mpsc::unbounded_channel();
    let mut first = Handler::new(root.path().into(), Os::Linux, send.clone());
    first.job(job("first"));
    first.decide(decision("always", "first")).unwrap();
    first.completed().await.unwrap();
    assert!(matches!(
        results.recv().await,
        Some(ClientFrame::Result { ok: true, .. })
    ));
    let mut restarted = Handler::new(root.path().into(), Os::Linux, send.clone());
    restarted.job(job("remembered"));
    assert!(restarted.has_running());
    restarted.completed().await.unwrap();
    assert!(matches!(
        results.recv().await,
        Some(ClientFrame::Result { ok: true, .. })
    ));
    assert_eq!(
        std::fs::read_to_string(root.path().join("approved.txt")).unwrap(),
        "approved"
    );
    std::fs::remove_file(root.path().join("approved.txt")).unwrap();
    std::fs::write(
        root.path().join(".omarchy-bot-local-policy.json"),
        r#"{"always":[],"never":[]}"#,
    )
    .unwrap();
    let mut refusal = Handler::new(root.path().into(), Os::Linux, send.clone());
    refusal.job(job("never"));
    refusal.decide(decision("never", "never")).unwrap();
    assert!(matches!(
        results.recv().await,
        Some(ClientFrame::Result { ok: false, .. })
    ));
    let mut restarted = Handler::new(root.path().into(), Os::Linux, send);
    restarted.job(job("refused"));
    assert!(matches!(
        results.recv().await,
        Some(ClientFrame::Result { ok: false, .. })
    ));
    assert!(!restarted.has_running());
    assert!(!root.path().join("approved.txt").exists());
}
#[tokio::test]
async fn cancelled_approval_cannot_write_or_reply() {
    let root = tempfile::tempdir().unwrap();
    let (send, mut results) = mpsc::unbounded_channel();
    let mut handler = Handler::new(root.path().into(), Os::Linux, send);
    handler.job(job("cancelled"));
    handler.cancel("cancelled".into());
    handler.decide(decision("allow-once", "cancelled")).unwrap();
    handler.close().await.unwrap();
    assert!(!root.path().join("approved.txt").exists());
    assert!(results.try_recv().is_err());
}
