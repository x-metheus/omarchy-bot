use std::env;
use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use rig_core::tool::{Tool, ToolAnnotations, ToolContext, ToolExecutionError};
use rig_harness::prelude::{CallPlace, PerCallShell, PerCallTool};
use rig_harness::rig_tools::process::{Launcher, Process, Spawn};
use rig_harness::rig_tools::workspace::{Contents, Listed, Listing, Stat, Workspace};
use rig_harness::rig_tools::{Shell, ShellArgs};
use serde_json::Value;

#[derive(Clone)]
pub(super) struct WindowsShell(pub(super) PerCallShell);

impl PerCallTool for WindowsShell {
    const LIVE: bool = PerCallShell::LIVE;

    fn at(&self, place: CallPlace) -> Self {
        Self(self.0.at(CallPlace {
            workspace: Arc::new(WindowsWorkspace(place.workspace)),
            ..place
        }))
    }
}

impl Tool for WindowsShell {
    const NAME: &'static str = Shell::NAME;
    type Args = ShellArgs;
    type Output = String;
    type Error = ToolExecutionError;

    fn description(&self) -> String {
        self.0
            .description()
            .replace("`sh -c`", "Windows PowerShell")
    }

    fn parameters(&self) -> Value {
        self.0.parameters()
    }

    fn annotations(&self) -> ToolAnnotations {
        self.0.annotations()
    }

    async fn call(
        &self,
        context: &mut ToolContext,
        args: ShellArgs,
    ) -> Result<String, Self::Error> {
        self.0.call(context, args).await
    }
}

// Rig 0.47.1 hardcodes `sh -c`. Swap the launch here to keep Rig's cwd checks and output handling.
#[derive(Debug)]
struct WindowsWorkspace(Arc<dyn Workspace>);

impl Workspace for WindowsWorkspace {
    fn stat(&self, path: &Path) -> io::Result<Stat> {
        self.0.stat(path)
    }

    fn read(&self, path: &Path, limit: u64) -> io::Result<Contents> {
        self.0.read(path, limit)
    }

    fn write(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        self.0.write(path, bytes)
    }

    fn remove(&self, path: &Path) -> io::Result<()> {
        self.0.remove(path)
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        self.0.rename(from, to)
    }

    fn canonical(&self, path: &Path) -> PathBuf {
        self.0.canonical(path)
    }

    fn files(&self, root: &Path, glob: Option<&str>, listing: Listing) -> io::Result<Listed> {
        self.0.files(root, glob, listing)
    }

    fn spawn(
        &self,
        launcher: &Launcher,
        dir: Option<&Path>,
        program: &OsStr,
        args: &[OsString],
        how: Spawn,
    ) -> io::Result<Process> {
        let [flag, script] = args else {
            return self.0.spawn(launcher, dir, program, args, how);
        };
        let Some(script) = script.to_str().filter(|_| program == "sh" && flag == "-c") else {
            return self.0.spawn(launcher, dir, program, args, how);
        };
        let executable =
            PathBuf::from(env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
                .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let script: Vec<u8> = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n"
            .encode_utf16()
            .chain(script.encode_utf16())
            .flat_map(u16::to_le_bytes)
            .collect();
        let args = [
            "-NoLogo".into(),
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-OutputFormat".into(),
            "Text".into(),
            "-EncodedCommand".into(),
            STANDARD.encode(script).into(),
        ];
        // shortcut: Rig stops PowerShell itself on a timeout, use a Job Object if descendant cancellation is required.
        self.0
            .spawn(launcher, dir, executable.as_os_str(), &args, how)
    }
}
