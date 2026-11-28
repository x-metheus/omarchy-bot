//! Rig file and shell tools for an operator-selected workspace on the daemon host.

#[cfg(windows)]
mod windows;

use std::env;
use std::path::PathBuf;

use anyhow::{Context, Result, ensure};
use rig_core::tool::Tool;
use rig_harness::prelude::{App, AppPerCallExt, PerCallShell, Processes, Resource, ToolOptions};
use rig_harness::rig_tools::{Edit, Read, Shell, Write};

use crate::agent::conversation::ConversationTools;

pub(crate) const NAMES: [&str; 4] = [Read::NAME, Edit::NAME, Write::NAME, Shell::NAME];

#[derive(Debug, Resource)]
pub(crate) struct WorkspaceRoot(pub(crate) PathBuf);

impl WorkspaceRoot {
    pub(crate) fn from_env() -> Result<Option<Self>> {
        let Some(path) = env::var_os("OMARCHY_AGENT_WORK_DIR").map(PathBuf::from) else {
            return Ok(None);
        };
        ensure!(
            path.is_absolute(),
            "OMARCHY_AGENT_WORK_DIR must be absolute"
        );
        let path = path
            .canonicalize()
            .context("resolve OMARCHY_AGENT_WORK_DIR")?;
        ensure!(path.is_dir(), "OMARCHY_AGENT_WORK_DIR must be a directory");
        Ok(Some(Self(path)))
    }
}

pub(crate) fn register(app: &mut App, workspace: Option<WorkspaceRoot>) {
    if let Some(workspace) = workspace {
        app.insert_resource(workspace);
    }
    app.add_tool_per_call(Read::default(), ToolOptions::default())
        .add_tool_per_call(Edit::default(), ToolOptions::default())
        .add_tool_per_call(Write::default(), ToolOptions::default());
    let shell = PerCallShell::new(Shell::default(), app.world_mut());
    let processes = app.world().resource::<Processes>();
    processes.set(processes.launcher().without_env([
        "OPENAI_API_KEY",
        "OMARCHY_AGENT_MASTER_KEY_FILE",
        "OMARCHY_AGENT_SETTINGS_TOKEN_FILE",
    ]));
    #[cfg(windows)]
    let shell = windows::WindowsShell(shell);
    app.add_tool_per_call(shell, ToolOptions::default());
    app.world_mut()
        .resource_mut::<ConversationTools>()
        .shared
        .extend(NAMES);
}
