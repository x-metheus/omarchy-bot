//! Agent Daemon log destination selection.

#[path = "../../logging.rs"]
mod shared;

use std::path::PathBuf;

pub(super) fn init() {
    shared::install_panic_hook();
    let file = std::env::var_os("OMARCHY_AGENT_LOG_DIR")
        .filter(|path| !path.is_empty())
        .map(|directory| PathBuf::from(directory).join("agent-daemon.log"));
    shared::init(
        env!("CARGO_CRATE_NAME"),
        shared::Destination {
            file: file.as_deref(),
            always_stderr: false,
        },
    );
}
