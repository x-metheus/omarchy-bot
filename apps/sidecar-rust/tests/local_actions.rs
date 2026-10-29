use omarchy_bot_sidecar::{
    execute,
    protocol::{Job, Os},
};
use serde_json::json;
use tokio::sync::watch;

fn job(action: &str, fields: serde_json::Value) -> Job {
    let mut value = json!({"jobId":"boundary","hostname":"paired","botId":"bot","turnId":"turn","action":action});
    value
        .as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    serde_json::from_value(value).unwrap()
}
#[tokio::test]
async fn file_actions_confine_refuse_secrets_and_bound_results() {
    let root = tempfile::tempdir().unwrap();
    let (_, cancel) = watch::channel(false);
    let write = execute::execute(
        job(
            "write",
            json!({"path":"nested/file.txt","contents":"needle\nsecond"}),
        ),
        root.path().into(),
        Os::Linux,
        cancel.clone(),
    )
    .await;
    assert_eq!(write.unwrap().text, "wrote nested/file.txt");
    assert_eq!(
        execute::execute(
            job("read", json!({"path":"nested/file.txt"})),
            root.path().into(),
            Os::Linux,
            cancel.clone()
        )
        .await
        .unwrap()
        .text,
        "needle\nsecond"
    );
    assert_eq!(
        execute::execute(
            job("search", json!({"query":"needle"})),
            root.path().into(),
            Os::Linux,
            cancel.clone()
        )
        .await
        .unwrap()
        .text,
        format!(
            "{}: needle",
            std::path::Path::new("nested").join("file.txt").display()
        )
    );
    let inbound = job(
        "transfer",
        json!({"path":"workspace/source.txt","destination":"received.txt","direction":"from-workspace","contents":"copied bytes"}),
    );
    assert_eq!(
        execute::execute(inbound, root.path().into(), Os::Linux, cancel.clone())
            .await
            .unwrap()
            .text,
        "copied to received.txt"
    );
    let outbound = job(
        "transfer",
        json!({"path":"received.txt","destination":"workspace/copy.txt","direction":"to-workspace"}),
    );
    assert_eq!(
        execute::execute(outbound, root.path().into(), Os::Linux, cancel.clone())
            .await
            .unwrap()
            .text,
        "copied bytes"
    );
    for path in ["../escape", ".ssh/key", "nested/.config/key"] {
        assert!(execute::execute(
            job("write", json!({"path":path,"contents":"secret"})),
            root.path().into(),
            Os::Linux,
            cancel.clone()
        )
        .await
        .is_err());
    }
    std::fs::write(root.path().join("large.txt"), "x".repeat(16385)).unwrap();
    assert_eq!(
        execute::execute(
            job("read", json!({"path":"large.txt"})),
            root.path().into(),
            Os::Linux,
            cancel.clone()
        )
        .await
        .unwrap()
        .text
        .len(),
        8192
    );
    assert_eq!(
        execute::execute(
            job(
                "transfer",
                json!({"path":"large.txt","destination":"copy.txt","direction":"to-workspace"})
            ),
            root.path().into(),
            Os::Linux,
            cancel
        )
        .await
        .unwrap_err(),
        "transfer exceeds the 16384 character result frame"
    );
}
#[tokio::test]
async fn platform_secret_paths_and_compositor_actions_fail_closed() {
    let root = tempfile::tempdir().unwrap();
    let (_, cancel) = watch::channel(false);
    for (os, path) in [
        (Os::Macos, "library/keychains/new"),
        (Os::Windows, "appdata/local/microsoft/credentials/new"),
    ] {
        assert_eq!(
            execute::execute(
                job("write", json!({"path":path})),
                root.path().into(),
                os,
                cancel.clone()
            )
            .await
            .unwrap_err(),
            "Local Sidecar refuses credential directories"
        );
    }
    assert_eq!(
        execute::execute(
            job("run", json!({"command":"echo SWAYSOCK"})),
            root.path().into(),
            Os::Linux,
            cancel
        )
        .await
        .unwrap_err(),
        "Local Sidecar rejects screenshot, pointer, and Host compositor actions"
    );
}
