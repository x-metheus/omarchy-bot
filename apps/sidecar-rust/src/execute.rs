use crate::protocol::{truncate, utf16_len, Action, Direction, Job, Os, RESULT_MAX};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::LazyLock,
};
use tokio::sync::watch;

#[derive(Debug)]
pub struct Output {
    pub text: String,
    pub exit_code: Option<i64>,
}
pub type Result = std::result::Result<Output, String>;
static COMPOSITOR: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)\bscreenshot\b|\bpointer\b|SWAYSOCK|WAYLAND_DISPLAY").unwrap()
});
const COMMON: &[&str] = &[".ssh", ".gnupg", ".aws", ".config"];
const MAC: &[&str] = &[
    "Library/Keychains",
    "Library/Accounts",
    "Library/Application Support/com.apple.TCC",
];
const WINDOWS: &[&str] = &[
    "AppData/Local/Microsoft/Credentials",
    "AppData/Roaming/Microsoft/Credentials",
    "AppData/Local/Microsoft/Protect",
    "AppData/Roaming/Microsoft/Protect",
    "AppData/Local/Microsoft/Vault",
    "AppData/Roaming/Microsoft/Vault",
    "AppData/Local/Microsoft/Crypto",
    "AppData/Roaming/Microsoft/Crypto",
];

pub fn normalize(path: &Path) -> PathBuf {
    let mut resolved = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            other => resolved.push(other.as_os_str()),
        }
    }
    resolved
}
pub fn confined(target: &str, root: &Path) -> std::result::Result<PathBuf, String> {
    let target = target.trim();
    if target.is_empty() || target == "/" {
        return Err("path must be explicit".into());
    }
    let resolved = normalize(&root.join(target));
    if !resolved.starts_with(root) {
        return Err(format!("path escapes {}", root.display()));
    }
    Ok(resolved)
}
fn secret(target: &Path, root: &Path, os: Os) -> bool {
    let relative = target
        .strip_prefix(root)
        .unwrap_or(target)
        .to_string_lossy()
        .replace('\\', "/");
    let mut candidate = format!("/{relative}/");
    if os != Os::Linux {
        candidate.make_ascii_lowercase();
    }
    COMMON
        .iter()
        .chain(
            match os {
                Os::Macos => MAC,
                Os::Windows => WINDOWS,
                Os::Linux => &[],
            }
            .iter(),
        )
        .any(|secret| {
            let secret = if os == Os::Linux {
                secret.to_string()
            } else {
                secret.to_ascii_lowercase()
            };
            candidate.contains(&format!("/{secret}/"))
        })
}
fn refused(target: &Path, root: &Path, os: Os) -> std::result::Result<bool, String> {
    if secret(target, root, os) {
        return Ok(true);
    }
    #[cfg(windows)]
    if os == Os::Windows {
        return Ok(secret(
            &crate::windows::long_path(target)?,
            &crate::windows::long_path(root)?,
            os,
        ));
    }
    Ok(false)
}
fn read(path: &Path) -> std::result::Result<String, String> {
    fs::read(path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .map_err(|e| e.to_string())
}
fn write(path: &Path, contents: &str) -> std::result::Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, contents).map_err(|e| e.to_string())
}
fn search(query: &str, root: &Path, start: &Path, os: Os) -> std::result::Result<String, String> {
    fn walk(dir: &Path, root: &Path, query: &str, os: Os, hits: &mut Vec<String>) {
        if hits.len() >= 32 {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = entries.filter_map(|entry| entry.ok()).collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if hits.len() >= 32 {
                return;
            }
            let full = entry.path();
            if refused(&full, root, os).unwrap_or(true) {
                continue;
            }
            let Ok(metadata) = fs::metadata(&full) else {
                continue;
            };
            if metadata.is_dir() {
                walk(&full, root, query, os, hits);
                continue;
            }
            let Ok(body) = read(&full) else {
                continue;
            };
            if !full.to_string_lossy().contains(query) && !body.contains(query) {
                continue;
            }
            let relative = full.strip_prefix(root).unwrap_or(&full);
            let line = body
                .split('\n')
                .find(|line| line.contains(query))
                .unwrap_or("");
            hits.push(format!("{}: {}", relative.display(), truncate(line, 160)));
        }
    }
    if refused(start, root, os)? {
        return Err("Local Sidecar refuses credential directories".into());
    }
    let mut hits = Vec::new();
    walk(start, root, query, os, &mut hits);
    Ok(truncate(&hits.join("\n"), 8192))
}
pub async fn execute(job: Job, root: PathBuf, os: Os, cancel: watch::Receiver<bool>) -> Result {
    if *cancel.borrow() {
        return Err("Local Sidecar job aborted".into());
    }
    let local_path =
        if job.action == Action::Transfer && job.direction == Some(Direction::FromWorkspace) {
            &job.destination
        } else {
            &job.path
        };
    if let Some(path) = local_path {
        if refused(&confined(path, &root)?, &root, os)? {
            return Err("Local Sidecar refuses credential directories".into());
        }
    }
    if COMPOSITOR.is_match(&format!(
        "{} {}",
        job.command.as_deref().unwrap_or(""),
        job.path.as_deref().unwrap_or("")
    )) {
        return Err(
            "Local Sidecar rejects screenshot, pointer, and Host compositor actions".into(),
        );
    }
    if job.action == Action::Run {
        #[cfg(unix)]
        return crate::posix::run(job.command.as_deref().unwrap(), &root, cancel).await;
        #[cfg(windows)]
        return crate::windows::run(job.command.as_deref().unwrap(), &root, cancel).await;
    }
    let text = match job.action {
        Action::Search => {
            let query = job.query.as_deref().unwrap();
            if query == "/" || job.path.as_deref() == Some("/") {
                return Err("Local Sidecar search cannot scan /".into());
            }
            let start = confined(job.path.as_deref().unwrap_or("."), &root)?;
            #[cfg(windows)]
            let start = crate::windows::long_path(&start)?;
            search(query, &root, &start, os)?
        }
        Action::Read => truncate(
            &read(&confined(job.path.as_deref().unwrap(), &root)?)?,
            8192,
        ),
        Action::Write => {
            let path = job.path.as_deref().unwrap();
            write(
                &confined(path, &root)?,
                job.contents.as_deref().unwrap_or(""),
            )?;
            format!("wrote {path}")
        }
        Action::Transfer if job.direction == Some(Direction::FromWorkspace) => {
            let destination = job.destination.as_deref().unwrap();
            write(
                &confined(destination, &root)?,
                job.contents.as_deref().unwrap_or(""),
            )?;
            format!("copied to {destination}")
        }
        Action::Transfer => {
            let text = read(&confined(job.path.as_deref().unwrap(), &root)?)?;
            if utf16_len(&text) > RESULT_MAX {
                return Err(format!(
                    "transfer exceeds the {RESULT_MAX} character result frame"
                ));
            }
            text
        }
        Action::Run => unreachable!(),
    };
    Ok(Output {
        text,
        exit_code: None,
    })
}
