#![cfg(windows)]
use omarchy_bot_sidecar::{
    execute,
    protocol::{Job, Os},
};
use serde_json::json;
use std::{
    os::windows::ffi::{OsStrExt, OsStringExt},
    path::PathBuf,
};
use tokio::sync::watch;
use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;

#[tokio::test]
async fn ntfs_aliases_refuse_existing_secrets_and_missing_write_descendants() {
    let root = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(root.path()).unwrap();
    let store = root.join("AppData/Roaming/Microsoft/Credentials");
    std::fs::create_dir_all(&store).unwrap();
    std::fs::write(store.join("secret.txt"), "secret").unwrap();
    let input: Vec<u16> = store.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut output = vec![0u16; 32768];
    let length =
        unsafe { GetShortPathNameW(input.as_ptr(), output.as_mut_ptr(), output.len() as u32) };
    assert!(
        length > 0 && (length as usize) < output.len(),
        "NTFS short-name expansion unavailable"
    );
    let short = PathBuf::from(std::ffi::OsString::from_wide(&output[..length as usize]));
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
