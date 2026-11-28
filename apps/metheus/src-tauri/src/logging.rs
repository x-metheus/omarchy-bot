//! App log directory resolution before creating a native runtime.

use std::path::{Path, PathBuf};

pub(super) use metheus_logging::install_panic_hook;

pub(super) fn directory(identifier: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    if let Some(root) = std::env::var_os("METHEUS_SMOKE_DIR") {
        return Some(PathBuf::from(root).join("logs"));
    }
    // Match Tauri's default app_log_dir before the native runtime exists.
    #[cfg(target_os = "macos")]
    return dirs::home_dir().map(|home| home.join("Library/Logs").join(identifier));
    #[cfg(not(target_os = "macos"))]
    dirs::data_local_dir().map(|data| data.join(identifier).join("logs"))
}

pub(super) fn init(directory: Option<&Path>) -> fn() {
    #[cfg(unix)]
    if let Some(directory) = directory {
        use std::os::unix::fs::PermissionsExt;
        // Earlier App versions created this user-specific directory with the process umask.
        if std::fs::symlink_metadata(directory)
            .is_ok_and(|metadata| metadata.is_dir() && metadata.permissions().mode() & 0o077 != 0)
        {
            let _ = std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700));
        }
    }
    let file = directory.map(|path| path.join("metheus.log"));
    let close_file = metheus_logging::init(
        env!("CARGO_CRATE_NAME"),
        metheus_logging::Destination {
            file: file.as_deref(),
            always_stderr: true,
        },
    );
    if directory.is_none() {
        tracing::warn!(
            error_code = "log_directory_unavailable",
            "App log directory unavailable"
        );
    }
    close_file
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn relaunch_reopens_the_app_log_before_the_previous_process_exits() {
        const TEST: &str =
            "logging::tests::relaunch_reopens_the_app_log_before_the_previous_process_exits";
        const LOG_DIRECTORY: &str = "METHEUS_TEST_RELAUNCH_LOG_DIRECTORY";
        const REPLACEMENT: &str = "METHEUS_TEST_RELAUNCH_REPLACEMENT";
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args(["--exact", TEST, "--nocapture"]);

        if let Some(directory) = std::env::var_os(LOG_DIRECTORY) {
            let close_file = init(Some(Path::new(&directory)));
            if std::env::var_os(REPLACEMENT).is_some() {
                tracing::info!("replacement startup");
                return;
            }
            tracing::info!("previous App exit");
            close_file();
            tracing::warn!("previous App stderr after closing its log");
            assert!(command.env(REPLACEMENT, "1").status().unwrap().success());
            return;
        }

        let profile = tempfile::tempdir().unwrap();
        let directory = profile.path().join("logs");
        let output = command
            .env(LOG_DIRECTORY, &directory)
            .env_remove(REPLACEMENT)
            .env("RUST_LOG", "info")
            .output()
            .unwrap();
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(output.status.success(), "{stderr}");
        let records = std::fs::read_to_string(directory.join("metheus.log")).unwrap();
        assert!(records.contains("previous App exit"));
        assert!(records.contains("replacement startup"));
        assert!(stderr.contains("previous App stderr after closing its log"));
        assert!(!records.contains("previous App stderr after closing its log"));
        assert!(!stderr.contains("log_open_failed"));
    }
}
