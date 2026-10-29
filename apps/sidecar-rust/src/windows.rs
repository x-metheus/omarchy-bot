use crate::{
    execute::{Output, Result},
    protocol::truncate,
    windows_output::decode,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    fs, io,
    mem::{size_of, zeroed},
    os::windows::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{io::AsyncWriteExt, process::Command, sync::watch};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    Storage::FileSystem::GetLongPathNameW,
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
            JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE},
    },
};

const BOOTSTRAP: &str = r#"$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$payload = [Console]::In.ReadLine()
if ($null -eq $payload) { exit 1 }
$script:completion = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))
$command = try { [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($payload)) } catch { Write-Error $_; exit 1 }
$ast = [Management.Automation.Language.Parser]::ParseInput($command, [ref]$null, [ref]$null)
$block = $ast.EndBlock
if ($null -eq $block) { $block = $ast.ProcessBlock }
if ($null -eq $block) { $block = $ast.BeginBlock }
$trailer = [Environment]::NewLine + @'
$succeeded = $?
$code = 0
if ($LASTEXITCODE) { $code = $LASTEXITCODE } elseif (!$succeeded) { $code = 1 }
[IO.File]::WriteAllText($script:completion, '')
exit $code
'@ + [Environment]::NewLine
if ($null -eq $block) { $command += [Environment]::NewLine + 'end {' + $trailer + '}' }
elseif ($block.Unnamed) { $command += $trailer }
else { $command = $command.Insert($block.Extent.EndOffset - 1, $trailer) }
& ([ScriptBlock]::Create($command))
$succeeded = $?
$code = 0
if ($LASTEXITCODE) { $code = $LASTEXITCODE } elseif (!$succeeded) { $code = 1 }
[IO.File]::WriteAllText($script:completion, '')
exit $code"#;
fn encoded(text: &str) -> String {
    STANDARD.encode(
        text.encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    )
}
fn failure(operation: &str) -> String {
    format!("{operation} failed ({})", io::Error::last_os_error())
}
// Store the owned handle as an integer so the asynchronous executor can move between threads.
struct JobObject(usize);
impl JobObject {
    fn handle(&self) -> HANDLE {
        self.0 as HANDLE
    }
    fn limits(&self, flags: u32) -> std::result::Result<(), String> {
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = flags;
        if unsafe {
            SetInformationJobObject(
                self.handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(failure("SetInformationJobObject"));
        }
        Ok(())
    }
    fn active(&self) -> std::result::Result<u32, String> {
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
        if unsafe {
            QueryInformationJobObject(
                self.handle(),
                JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(failure("QueryInformationJobObject"));
        }
        Ok(accounting.ActiveProcesses)
    }
}
impl Drop for JobObject {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle());
        }
    }
}

pub fn long_path(path: &Path) -> std::result::Result<PathBuf, String> {
    let mut target = path.to_path_buf();
    let mut missing = Vec::new();
    loop {
        let input: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        let size = unsafe { GetLongPathNameW(input.as_ptr(), std::ptr::null_mut(), 0) };
        if size > 0 {
            let mut output = vec![0; size as usize];
            let length = unsafe { GetLongPathNameW(input.as_ptr(), output.as_mut_ptr(), size) };
            if length == 0 || length >= size {
                return Err(failure("GetLongPathNameW"));
            }
            let mut result =
                PathBuf::from(std::ffi::OsString::from_wide(&output[..length as usize]));
            for suffix in missing.into_iter().rev() {
                result.push(suffix);
            }
            return Ok(result);
        }
        if !matches!(io::Error::last_os_error().raw_os_error(), Some(2 | 3)) {
            return Err(failure("GetLongPathNameW"));
        }
        let name = target
            .file_name()
            .ok_or_else(|| failure("GetLongPathNameW"))?
            .to_os_string();
        if !target.pop() {
            return Err(failure("GetLongPathNameW"));
        }
        missing.push(name);
    }
}
pub async fn run(command: &str, root: &Path, mut cancel: watch::Receiver<bool>) -> Result {
    if *cancel.borrow() {
        return Err("Local Sidecar job aborted".into());
    }
    let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if handle.is_null() {
        return Err(failure("CreateJobObjectW"));
    }
    let job = JobObject(handle as usize);
    job.limits(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)?;
    let capture = tempfile::Builder::new()
        .prefix("sidecar-windows-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let completion = capture.path().join("completed");
    let stdout = capture.path().join("stdout");
    let stderr = capture.path().join("stderr");
    let executable =
        PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut child = Command::new(executable)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-OutputFormat",
            "Text",
            "-EncodedCommand",
            &encoded(BOOTSTRAP),
        ])
        .current_dir(root)
        .env_remove("OMARCHY_BOT_DEVICE_TOKEN")
        .stdin(Stdio::piped())
        .stdout(fs::File::create(&stdout).map_err(|e| e.to_string())?)
        .stderr(fs::File::create(&stderr).map_err(|e| e.to_string())?)
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let process = unsafe {
        OpenProcess(
            PROCESS_SET_QUOTA | PROCESS_TERMINATE,
            0,
            child.id().unwrap(),
        )
    };
    if process.is_null() {
        return Err(failure("OpenProcess"));
    }
    let assigned = unsafe { AssignProcessToJobObject(job.handle(), process) };
    unsafe {
        CloseHandle(process);
    }
    if assigned == 0 {
        return Err(failure("AssignProcessToJobObject"));
    }
    if *cancel.borrow() {
        drop(job);
        child.wait().await.map_err(|e| e.to_string())?;
        return Err("Local Sidecar job aborted".into());
    }
    let outcome = {
        let completed = async {
            let mut input = child.stdin.take().unwrap();
            input
                .write_all(
                    format!(
                        "{}\n{}\n",
                        encoded(command),
                        encoded(&completion.to_string_lossy())
                    )
                    .as_bytes(),
                )
                .await
                .map_err(|e| e.to_string())?;
            drop(input);
            let status = child.wait().await.map_err(|e| e.to_string())?;
            if !completion.exists() {
                while job.active()? != 0 {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }
            let stdout = fs::read(&stdout).map_err(|e| e.to_string())?;
            let stderr = fs::read(&stderr).map_err(|e| e.to_string())?;
            let text = truncate(
                &format!(
                    "{}{}",
                    String::from_utf8_lossy(&stdout),
                    decode(&String::from_utf8_lossy(&stderr))
                ),
                8192,
            );
            Ok(Output {
                text,
                exit_code: Some(status.code().unwrap_or(1) as i64),
            })
        };
        tokio::select! { result = completed => result, _ = cancel.wait_for(|cancelled| *cancelled) => Err("Local Sidecar job aborted".into()) }
    };
    if outcome.is_ok() && !*cancel.borrow() {
        job.limits(0)?;
    }
    drop(job);
    if outcome.is_err() {
        child.wait().await.map_err(|e| e.to_string())?;
    }
    outcome
}
