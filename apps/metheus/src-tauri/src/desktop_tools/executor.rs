//! Rig tools over paths relative to a workspace chosen in the native app.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use rig_core::tool::{decode_args, Tool, ToolContext, ToolExecutionError, ToolOutput};
use rig_tools::process::{Launcher, Process, Spawn};
use rig_tools::workspace::{Contents, Listed, Listing, Local, Root, Stat, Workspace};
use rig_tools::{Edit, EditArgs, Read, ReadArgs, Seen, Shell, ShellArgs, Write, WriteArgs};
use serde::Deserialize;
use serde_json::Value;

const SHELL_TIMEOUT_SECS: u64 = 120;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Name {
    Read,
    Edit,
    Write,
    Shell,
}

pub(super) enum Operation {
    Read(ReadArgs),
    Edit(EditArgs),
    Write(WriteArgs),
    Shell(ShellArgs),
}

impl Name {
    pub(super) fn decode(
        self,
        arguments: &Value,
        file: Option<&str>,
    ) -> Result<Operation, &'static str> {
        let operation = match self {
            Self::Read => decode_args(arguments).map(Operation::Read),
            Self::Edit => decode_args(arguments).map(Operation::Edit),
            Self::Write => decode_args(arguments).map(Operation::Write),
            Self::Shell => decode_args(arguments).map(Operation::Shell),
        }
        .map_err(|_| "Invalid desktop tool arguments.")?;
        let path = match &operation {
            Operation::Read(args) => Some(args.path.as_str()),
            Operation::Edit(args) => Some(args.path.as_str()),
            Operation::Write(args) => Some(args.path.as_str()),
            Operation::Shell(args) => args.cwd.as_deref(),
        };
        if path.is_some_and(|path| !relative(Path::new(path))) {
            return Err("Use a path relative to the selected desktop directory.");
        }
        if let Some(file) = file {
            if matches!(operation, Operation::Shell(_))
                || path.map(Path::new) != Some(Path::new(file))
            {
                return Err("This desktop selection allows file tools for the selected file only.");
            }
        }
        Ok(operation)
    }

    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Read => "Read a file",
            Self::Edit => "Edit a file",
            Self::Write => "Write a file",
            Self::Shell => "Run a shell command",
        }
    }
}

impl Operation {
    pub(super) async fn execute(
        self,
        directory: Arc<Path>,
        seen: Seen,
    ) -> Result<ToolOutput, ToolExecutionError> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let _lease = Lease(cancelled.clone());
        let workspace = Arc::new(DesktopWorkspace {
            directory,
            cancelled,
        });
        let root = Root::from(workspace.clone() as Arc<dyn Workspace>);
        let mut context = ToolContext::new();
        match self {
            Self::Read(args) => Read { root, seen }.call(&mut context, args).await,
            Self::Edit(args) => Edit { root, seen }
                .call(&mut context, args)
                .await
                .map(ToolOutput::text),
            Self::Write(args) => Write { root, seen }
                .call(&mut context, args)
                .await
                .map(ToolOutput::text),
            Self::Shell(mut args) => {
                args.timeout_secs = Some(
                    args.timeout_secs
                        .unwrap_or(SHELL_TIMEOUT_SECS)
                        .min(SHELL_TIMEOUT_SECS),
                );
                let shell = Shell {
                    workspace,
                    launcher: Launcher::default().in_dir(".").without_env([
                        "OMARCHY_BOT_DEVICE_TOKEN",
                        "OPENAI_API_KEY",
                        "ANTHROPIC_API_KEY",
                        "OMARCHY_AGENT_MASTER_KEY_FILE",
                        "OMARCHY_AGENT_SETTINGS_TOKEN_FILE",
                    ]),
                    ..Shell::default()
                };
                shell.call(&mut context, args).await.map(ToolOutput::text)
            }
        }
    }
}

struct Lease(Arc<AtomicBool>);

impl Drop for Lease {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

#[derive(Debug)]
struct DesktopWorkspace {
    directory: Arc<Path>,
    cancelled: Arc<AtomicBool>,
}

fn relative(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path.components().all(|component| match component {
            Component::CurDir => true,
            Component::Normal(name) => !cfg!(windows) || !name.to_string_lossy().contains(':'),
            _ => false,
        })
}

impl DesktopWorkspace {
    fn resolve(&self, path: &Path) -> io::Result<PathBuf> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "desktop operation cancelled",
            ));
        }
        if !relative(path) || fs::canonicalize(&self.directory)? != *self.directory {
            return Err(permission_denied());
        }
        let mut scoped = self.directory.to_path_buf();
        for part in path.components() {
            if let Component::Normal(part) = part {
                scoped.push(part);
                match fs::symlink_metadata(&scoped) {
                    Ok(metadata) if metadata.is_symlink() => return Err(permission_denied()),
                    Ok(_) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
            }
        }
        Ok(scoped)
    }
}

fn permission_denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "path is outside the selected desktop directory or uses a symbolic link",
    )
}

impl Workspace for DesktopWorkspace {
    fn canonical(&self, path: &Path) -> PathBuf {
        // Keep approval paths and model-visible labels relative to the desktop-only root.
        path.components().collect()
    }

    fn stat(&self, path: &Path) -> io::Result<Stat> {
        Local.stat(&self.resolve(path)?)
    }

    fn read(&self, path: &Path, limit: u64) -> io::Result<Contents> {
        Local.read(&self.resolve(path)?, limit)
    }

    fn write_if(
        &self,
        path: &Path,
        bytes: &[u8],
        held: Option<&rig_core::tool::ContentHash>,
    ) -> io::Result<Option<Contents>> {
        Local.write_if(&self.resolve(path)?, bytes, held)
    }

    fn write(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        Local.write(&self.resolve(path)?, bytes)
    }

    fn remove(&self, _: &Path) -> io::Result<()> {
        Err(permission_denied())
    }

    fn rename(&self, _: &Path, _: &Path) -> io::Result<()> {
        Err(permission_denied())
    }

    fn files(&self, _: &Path, _: Option<&str>, _: Listing) -> io::Result<Listed> {
        Err(permission_denied())
    }

    fn spawn(
        &self,
        launcher: &Launcher,
        dir: Option<&Path>,
        program: &OsStr,
        args: &[OsString],
        how: Spawn,
    ) -> io::Result<Process> {
        let dir = self.resolve(dir.unwrap_or_else(|| Path::new(".")))?;
        #[cfg(unix)]
        return Local.spawn(launcher, Some(&dir), program, args, how);
        #[cfg(windows)]
        {
            use base64::{engine::general_purpose::STANDARD, Engine};

            let [flag, script] = args else {
                return Err(permission_denied());
            };
            let script = script
                .to_str()
                .filter(|_| program == "sh" && flag == "-c")
                .ok_or_else(permission_denied)?;
            let executable = PathBuf::from(
                std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()),
            )
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
                "-EncodedCommand".into(),
                STANDARD.encode(script).into(),
            ];
            // shortcut: Rig stops PowerShell itself, use a Job Object for descendant cancellation on Windows.
            Local.spawn(launcher, Some(&dir), executable.as_os_str(), &args, how)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn selected_file_tools_keep_the_local_path_private_and_protect_unseen_versions() {
        let fixture = tempfile::tempdir().expect("create a disposable desktop workspace");
        let root = fixture
            .path()
            .canonicalize()
            .expect("resolve the selected directory");
        let directory: Arc<Path> = root.as_path().into();
        let path = root.join("sample.txt");
        fs::write(&path, "initial sample\n").expect("write the fixture sample");
        let seen = Seen::default();
        let read = Name::Read
            .decode(&json!({"path": "sample.txt"}), Some("sample.txt"))
            .expect("allow read of the selected file");
        let output = read
            .execute(directory.clone(), seen.clone())
            .await
            .expect("read the sample");
        let text = output.as_text().expect("read returns text");
        assert!(text.contains("initial sample"));
        assert!(!text.contains(root.to_string_lossy().as_ref()));
        assert!(Name::Read
            .decode(&json!({"path": "other.txt"}), Some("sample.txt"))
            .is_err());
        assert!(Name::Shell
            .decode(&json!({"command": "printf sample"}), Some("sample.txt"))
            .is_err());
        assert!(Name::Write
            .decode(
                &json!({"path": "../sample.txt", "content": "outside"}),
                None
            )
            .is_err());

        fs::write(&path, "changed after read\n").expect("update the fixture sample");
        let write = Name::Write
            .decode(
                &json!({"path": "sample.txt", "content": "replacement"}),
                Some("sample.txt"),
            )
            .expect("the write is scoped to the selected file");
        assert!(write.execute(directory, seen).await.is_err());
        assert_eq!(
            fs::read_to_string(path).expect("read the preserved sample"),
            "changed after read\n"
        );
    }
}
