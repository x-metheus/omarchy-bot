#![cfg(windows)]
use omarchy_bot_sidecar::{
    execute,
    protocol::{Job, Os},
};
use serde_json::json;
use std::{
    os::windows::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
};
use tokio::sync::watch;
use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;

fn short_path(path: &Path) -> PathBuf {
    let input: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut output = vec![0u16; 32768];
    let length =
        unsafe { GetShortPathNameW(input.as_ptr(), output.as_mut_ptr(), output.len() as u32) };
    assert!(
        length > 0 && (length as usize) < output.len(),
        "NTFS short-name expansion unavailable"
    );
    PathBuf::from(std::ffi::OsString::from_wide(&output[..length as usize]))
}

#[tokio::test]
async fn ntfs_aliases_refuse_existing_secrets_and_missing_write_descendants() {
    let root = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(root.path()).unwrap();
    let store = root.join("AppData/Roaming/Microsoft/Credentials");
    std::fs::create_dir_all(&store).unwrap();
    std::fs::write(store.join("secret.txt"), "secret").unwrap();
    let short = short_path(&store);
    assert_ne!(
        short.file_name().unwrap().to_string_lossy().to_lowercase(),
        "credentials",
        "test requires witnessed NTFS alias"
    );
    let (_, cancel) = watch::channel(false);
    let relative = format!(
        "AppData/Roaming/Microsoft/{}",
        short.file_name().unwrap().to_string_lossy()
    );
    for (action, suffix) in [("read", "secret.txt"), ("write", "missing/new.txt")] {
        let job: Job = serde_json::from_value(json!({"jobId":"alias","hostname":"paired","botId":"bot","turnId":"turn","action":action,"path":format!("{relative}/{suffix}"),"contents":"overwrite"})).unwrap();
        assert_eq!(
            execute::execute(job, root.clone(), Os::Windows, cancel.clone())
                .await
                .unwrap_err(),
            "Local Sidecar refuses credential directories"
        );
    }
    assert_eq!(
        std::fs::read_to_string(store.join("secret.txt")).unwrap(),
        "secret"
    );
    assert!(!store.join("missing").exists());
}

#[tokio::test]
async fn search_under_short_root_returns_relative_hits_and_refuses_secrets() {
    let directory = tempfile::Builder::new()
        .prefix("sidecar-search-workspace-")
        .tempdir()
        .unwrap();
    let root = std::fs::canonicalize(directory.path()).unwrap();
    let short = short_path(&root);
    assert_ne!(
        short.file_name().unwrap().to_string_lossy().to_lowercase(),
        root.file_name().unwrap().to_string_lossy().to_lowercase(),
        "test requires witnessed NTFS alias"
    );
    for path in [
        "nested/file.txt",
        ".ssh/key",
        "AppData/Roaming/Microsoft/Credentials/secret.txt",
    ] {
        let file = root.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, "needle").unwrap();
    }
    let (_, cancel) = watch::channel(false);
    let job: Job = serde_json::from_value(json!({"jobId":"search-alias","hostname":"paired","botId":"bot","turnId":"turn","action":"search","query":"needle"})).unwrap();
    assert_eq!(
        execute::execute(job, short.clone(), Os::Windows, cancel.clone())
            .await
            .unwrap()
            .text,
        "nested\\file.txt: needle"
    );
    let job: Job = serde_json::from_value(json!({"jobId":"search-secret","hostname":"paired","botId":"bot","turnId":"turn","action":"search","query":"needle","path":"AppData/Roaming/Microsoft/Credentials"})).unwrap();
    assert_eq!(
        execute::execute(job, short, Os::Windows, cancel)
            .await
            .unwrap_err(),
        "Local Sidecar refuses credential directories"
    );
}
