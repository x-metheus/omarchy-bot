use crate::{
    execute::{Output, Result},
    protocol::truncate,
};
use std::{io, path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command, sync::watch};

const GROUP_LEADER: &str = "trap '' HUP TERM\nsh -c 'while read -r _; do :; done' <&0 >/dev/null 2>&1 &\ntrap - HUP TERM\nexec sh -c \"$1\" </dev/null";

fn signal(group: i32, signal: i32) -> io::Result<bool> {
    if unsafe { libc::kill(-group, signal) } == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(false)
    } else {
        Err(error)
    }
}
async fn wait_group(group: i32, duration: Duration) -> io::Result<bool> {
    let deadline = tokio::time::Instant::now() + duration;
    while signal(group, 0)? {
        if tokio::time::Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    Ok(true)
}
async fn terminate(group: i32) -> io::Result<()> {
    if !signal(group, libc::SIGTERM)? {
        return Ok(());
    }
    if !wait_group(group, Duration::from_millis(200)).await? {
        signal(group, libc::SIGKILL)?;
        wait_group(group, Duration::from_secs(2)).await?;
    }
    Ok(())
}
async fn capture(mut stream: impl tokio::io::AsyncRead + Unpin) -> io::Result<String> {
    let mut output = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let count = stream.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        let retain = count.min(32768_usize.saturating_sub(output.len()));
        output.extend_from_slice(&buffer[..retain]);
    }
    Ok(String::from_utf8_lossy(&output).into_owned())
}
pub async fn run(command: &str, root: &Path, mut cancel: watch::Receiver<bool>) -> Result {
    if *cancel.borrow() {
        return Err("Local Sidecar job aborted".into());
    }
    let mut child = Command::new("/bin/sh")
        .args(["-c", GROUP_LEADER, "sh", command])
        .current_dir(root)
        .env_remove("OMARCHY_BOT_DEVICE_TOKEN")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|e| e.to_string())?;
    let group = child.id().unwrap() as i32;
    let anchor = child.stdin.take();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let outcome = {
        let completed = async {
            let (stdout, stderr, status) =
                tokio::try_join!(capture(stdout), capture(stderr), child.wait())?;
            Ok::<_, io::Error>(Output {
                text: truncate(&format!("{stdout}{stderr}"), 8192),
                exit_code: Some(status.code().unwrap_or(
                    128 + std::os::unix::process::ExitStatusExt::signal(&status).unwrap_or(0),
                ) as i64),
            })
        };
        tokio::select! {
            result = completed => result.map_err(|e| e.to_string()),
            _ = cancel.wait_for(|cancelled| *cancelled) => Err("Local Sidecar job aborted".into()),
        }
    };
    if outcome.is_err() || *cancel.borrow() {
        terminate(group).await.map_err(|e| e.to_string())?;
        child.wait().await.map_err(|e| e.to_string())?;
    }
    drop(anchor);
    outcome
}
