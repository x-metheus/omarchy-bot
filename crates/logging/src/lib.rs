//! Shared synchronous log output for the App and Agent Daemon.

use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::sync::Mutex;

use rolling_file::{BasicRollingFileAppender, RollingConditionBasic};
use tracing_subscriber::filter::{self, EnvFilter, FilterExt};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::{Layer, SubscriberExt};

const ROTATION_BYTES: u64 = 5 * 1024 * 1024;
const ARCHIVES: usize = 3;

/// Select a private log file and whether to mirror file output to stderr.
#[derive(Debug, Clone, Copy)]
pub struct Destination<'a> {
    /// Active log file path. Without a writable file, output goes to stderr.
    pub file: Option<&'a Path>,
    /// Also write each record to stderr when the file is writable.
    pub always_stderr: bool,
}

/// Install the process hook before startup can panic with an unsanitized payload.
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|panic| {
        if !tracing::dispatcher::has_been_set() {
            let _ = writeln!(io::stderr(), "panic during log initialization");
        } else if let Some(location) = panic.location() {
            tracing::error!(file = location.file(), line = location.line(), "panic");
        } else {
            tracing::error!("panic");
        }
    }));
}

/// Install the process subscriber and return a callback that closes its file writer.
///
/// `target` is the application crate's tracing target prefix. Dependency events
/// are excluded even when the log level is raised.
///
/// # Panics
///
/// Panics if the process already has a global tracing subscriber.
pub fn init(target: &'static str, destination: Destination<'_>) -> fn() {
    static FILE: Mutex<Option<RollingLog>> = Mutex::new(None);

    let file = destination
        .file
        .map(|path| RollingLog::open(path, ROTATION_BYTES));
    let file_error = file
        .as_ref()
        .and_then(|result| result.as_ref().err())
        .map(io::Error::kind);
    *FILE.lock().expect("runtime log lock poisoned") = file.and_then(Result::ok);
    let output = Output {
        file: &FILE,
        always_stderr: destination.always_stderr,
    };
    let rust_log = std::env::var(EnvFilter::DEFAULT_ENV).unwrap_or_default();
    let filter = EnvFilter::builder()
        .with_regex(false)
        .parse(format!("info,{rust_log}"))
        .unwrap_or_else(|_| EnvFilter::new("info"));
    let first_party = filter::filter_fn(move |metadata| {
        let name = metadata.target();
        name == module_path!()
            || name == target
            || name
                .strip_prefix(target)
                .is_some_and(|suffix| suffix.starts_with("::"))
    });
    let subscriber = tracing_subscriber::registry().with(
        tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(output)
            .with_filter(first_party.and(filter)),
    );
    tracing::subscriber::set_global_default(subscriber)
        .expect("install process log subscriber once");
    if let Some(kind) = file_error {
        tracing::warn!(
            error_code = "log_open_failed",
            ?kind,
            "runtime log file unavailable"
        );
    }
    || *FILE.lock().expect("runtime log lock poisoned") = None
}

struct Output {
    file: &'static Mutex<Option<RollingLog>>,
    always_stderr: bool,
}

impl<'a> MakeWriter<'a> for Output {
    type Writer = &'a Self;

    fn make_writer(&'a self) -> Self::Writer {
        self
    }
}

impl Write for &Output {
    fn write(&mut self, record: &[u8]) -> io::Result<usize> {
        let mut file = self.file.lock().expect("runtime log lock poisoned");
        if let Some(log) = file.as_mut() {
            if log.write_record(record).is_ok() {
                if !self.always_stderr {
                    return Ok(record.len());
                }
            } else {
                *file = None;
                let _ = writeln!(
                    io::stderr(),
                    "runtime log file unavailable (log_write_failed)"
                );
            }
        }
        io::stderr().lock().write_all(record)?;
        Ok(record.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct RollingLog {
    appender: BasicRollingFileAppender,
    lock: File,
    bytes: u64,
    threshold: u64,
}

impl RollingLog {
    fn open(path: &Path, threshold: u64) -> io::Result<Self> {
        let directory = path.parent().ok_or(io::ErrorKind::InvalidInput)?;
        private_directory(directory)?;
        let lock_path = path.with_extension("log.lock");
        existing_file_size(&lock_path)?;
        let lock = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)?;
        lock.try_lock().map_err(io::Error::from)?;
        let bytes = existing_file_size(path)?;
        let appender = BasicRollingFileAppender::new_with_buffer_capacity(
            path,
            RollingConditionBasic::new(),
            ARCHIVES,
            0,
        )?;
        Ok(Self {
            appender,
            lock,
            bytes,
            threshold,
        })
    }

    fn write_record(&mut self, record: &[u8]) -> io::Result<()> {
        // The fmt layer hands the writer one complete record per write_all call.
        let len = record.len() as u64;
        if self.bytes != 0 && self.bytes.saturating_add(len) > self.threshold {
            // Explicit rollover propagates failures without rolling-file's raw stderr warning.
            self.appender.rollover()?;
            self.bytes = 0;
        }
        self.appender.write_all(record)?;
        self.bytes += len;
        Ok(())
    }
}

impl Drop for RollingLog {
    fn drop(&mut self) {
        // A child between fork and exec can still hold a copy of the lock descriptor.
        let _ = self.lock.unlock();
    }
}

fn existing_file_size(path: &Path) -> io::Result<u64> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(metadata.len()),
        Ok(_) => Err(io::ErrorKind::InvalidInput.into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error),
    }
}

fn private_directory(path: &Path) -> io::Result<()> {
    let mut builder = DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_whole_records_and_prunes_old_archives() {
        let profile = tempfile::tempdir().unwrap();
        let directory = profile.path().join("logs");
        let active = directory.join("test.log");
        // A second record would cross the limit, so each file must contain one whole record.
        let mut log = RollingLog::open(&active, 17).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        assert!(
            RollingLog::open(&active, 17).is_err(),
            "second writer obtained the log lock"
        );
        for record in [
            b"record 01\n",
            b"record 02\n",
            b"record 03\n",
            b"record 04\n",
            b"record 05\n",
        ] {
            log.write_record(record).unwrap();
        }
        assert_eq!(fs::read_to_string(&active).unwrap(), "record 05\n");
        assert_eq!(
            fs::read_to_string(directory.join("test.log.1")).unwrap(),
            "record 04\n"
        );
        assert_eq!(
            fs::read_to_string(directory.join("test.log.2")).unwrap(),
            "record 03\n"
        );
        assert_eq!(
            fs::read_to_string(directory.join("test.log.3")).unwrap(),
            "record 02\n"
        );
        assert!(!directory.join("test.log.4").exists());
        let inherited_lock = log.lock.try_clone().unwrap();
        drop(log);
        RollingLog::open(&active, 17)
            .unwrap()
            .write_record(b"record 06\n")
            .unwrap();
        drop(inherited_lock);
        assert_eq!(
            fs::read_to_string(directory.join("test.log.1")).unwrap(),
            "record 05\n"
        );
    }

    #[test]
    fn filters_dependency_events_and_omits_panic_payload() {
        const CHILD_LOG: &str = "METHEUS_TEST_RUNTIME_LOG";
        if let Some(file) = std::env::var_os(CHILD_LOG) {
            install_panic_hook();
            init(
                env!("CARGO_CRATE_NAME"),
                Destination {
                    file: Some(Path::new(&file)),
                    always_stderr: true,
                },
            );
            tracing::trace!("first-party trace");
            tracing::error!(target: "rig::provider", "fixture-upstream-body");
            tracing::error!(
                target: concat!(env!("CARGO_CRATE_NAME"), "_extra"),
                "fixture-prefix-lookalike"
            );
            let _ = std::panic::catch_unwind(|| panic!("fixture-pairing-credential"));
            return;
        }
        let profile = tempfile::tempdir().unwrap();
        let log = profile.path().join("logs").join("test.log");
        let test_name = concat!(
            module_path!(),
            "::filters_dependency_events_and_omits_panic_payload"
        );
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                test_name.split_once("::").unwrap().1,
                "--nocapture",
            ])
            .env(CHILD_LOG, &log)
            .env("RUST_LOG", "trace")
            .output()
            .unwrap();
        assert!(output.status.success());
        for text in [
            fs::read_to_string(log).unwrap(),
            String::from_utf8(output.stderr).unwrap(),
        ] {
            assert!(text.contains("first-party trace"));
            assert!(text.lines().any(|line| {
                line.contains("ERROR") && line.contains("panic") && line.contains("file=")
            }));
            assert!(!text.contains("fixture-"));
        }
        assert!(
            !String::from_utf8(output.stdout)
                .unwrap()
                .contains("fixture-")
        );
    }
}
