//! Agent Daemon log destination selection.

use std::path::PathBuf;

pub(super) fn init() {
    metheus_logging::install_panic_hook();
    let file = std::env::var_os("OMARCHY_AGENT_LOG_DIR")
        .filter(|path| !path.is_empty())
        .map(|directory| PathBuf::from(directory).join("agent-daemon.log"));
    metheus_logging::init(
        env!("CARGO_CRATE_NAME"),
        metheus_logging::Destination {
            file: file.as_deref(),
            always_stderr: false,
        },
    );
}

pub(crate) fn failure(error_code: &str, message: &str, error: &anyhow::Error) {
    let reason = error
        .downcast_ref::<crate::settings::CredentialFailure>()
        .map(tracing::field::display);
    let sqlite_code = error
        .downcast_ref::<rusqlite::Error>()
        .and_then(rusqlite::Error::sqlite_error_code);
    let io_kind = error
        .downcast_ref::<std::io::Error>()
        .map(std::io::Error::kind);
    tracing::error!(error_code, reason, ?sqlite_code, ?io_kind, "{message}");
}
