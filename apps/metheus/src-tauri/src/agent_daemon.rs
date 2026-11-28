//! Local Agent Daemon startup and owner-authorized pairing.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::{Digest, Sha256};

const DEFAULT_PORT: u16 = 8765;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const NO_AUTOSTART: &str = "disable-autostart";
const OPERATOR_TOKEN: &str = "settings-token";
const MASTER_KEY: &str = "master.key";

pub(super) struct LocalDaemon {
    directory: PathBuf,
    recall_bundle: Option<PathBuf>,
    log_directory: Option<PathBuf>,
    port: u16,
    child: Mutex<Option<Child>>,
}

#[derive(Deserialize)]
struct Health {
    service: String,
    proof: Option<String>,
}

impl LocalDaemon {
    pub(super) fn new(
        directory: PathBuf,
        resource_directory: Option<PathBuf>,
        log_directory: Option<PathBuf>,
    ) -> Self {
        let port = std::env::var("METHEUS_DESKTOP_AGENT_PORT")
            .or_else(|_| std::env::var("OMARCHY_BOT_AGENT_PORT"))
            .ok()
            .and_then(|value| value.parse().ok())
            .filter(|port| *port != 0)
            .unwrap_or(DEFAULT_PORT);
        Self {
            directory,
            recall_bundle: resource_directory.map(|directory| directory.join("recall-model")),
            log_directory,
            port,
            child: Mutex::new(None),
        }
    }

    pub(super) fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub(super) fn autostart(&self) -> Result<bool, String> {
        self.directory
            .join(NO_AUTOSTART)
            .try_exists()
            .map(|disabled| !disabled)
            .map_err(|error| error.to_string())
    }

    fn set_autostart(&self, enabled: bool) -> Result<(), String> {
        let setting = self.directory.join(NO_AUTOSTART);
        if enabled {
            match fs::remove_file(setting) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error),
            }
        } else {
            fs::create_dir_all(&self.directory).and_then(|()| fs::write(setting, []))
        }
        .map_err(|error| format!("Could not save the local launch setting: {error}"))
    }

    fn start_if_needed(&self) -> Result<(), String> {
        let mut child = self
            .child
            .lock()
            .map_err(|_| "Local launch is unavailable.")?;
        if let Some(process) = child.as_mut() {
            if process
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none()
            {
                return Ok(());
            }
            *child = None;
        }
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, self.port));
        if std::net::TcpStream::connect_timeout(&address, REQUEST_TIMEOUT).is_ok()
            || !self.autostart()?
        {
            return Ok(());
        }
        let binary = daemon_binary()?;
        self.provision()?;
        let mut command = Command::new(binary);
        command
            .env("OMARCHY_AGENT_PORT", self.port.to_string())
            .env(
                "OMARCHY_AGENT_DB",
                self.directory.join("agent-daemon.sqlite3"),
            )
            .env(
                "OMARCHY_AGENT_MASTER_KEY_FILE",
                self.directory.join(MASTER_KEY),
            )
            .env(
                "OMARCHY_AGENT_SETTINGS_TOKEN_FILE",
                self.directory.join(OPERATOR_TOKEN),
            )
            .env_remove("OMARCHY_AGENT_WORK_DIR")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            // The daemon can outlive this App and must keep its stderr destination.
            .stderr(Stdio::inherit())
            .env_remove("OMARCHY_AGENT_LOG_DIR");
        if let Some(directory) = &self.log_directory {
            command.env("OMARCHY_AGENT_LOG_DIR", directory);
        }
        if let Some(bundle) = &self.recall_bundle {
            command.env("OMARCHY_AGENT_RECALL_BUNDLE_DIR", bundle);
            if std::env::var_os("OMARCHY_AGENT_RECALL_DOWNLOAD").is_none() {
                command.env("OMARCHY_AGENT_RECALL_DOWNLOAD", "1");
            }
        }
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let process = command.spawn().map_err(|error| {
            tracing::error!(
                error_code = "daemon_spawn_failed",
                kind = ?error.kind(),
                "Could not start the local Agent Daemon"
            );
            format!("Could not start the local Agent Daemon: {error}")
        })?;
        tracing::info!(pid = process.id(), "Local Agent Daemon spawned");
        *child = Some(process);
        Ok(())
    }

    fn provision(&self) -> Result<(), String> {
        let write = || -> std::io::Result<()> {
            fs::create_dir_all(&self.directory)?;
            let master = secret()?;
            write_once(&self.directory.join(MASTER_KEY), &master)?;
            write_once(
                &self.directory.join(OPERATOR_TOKEN),
                hex(&secret()?).as_bytes(),
            )
        };
        write().map_err(|error| format!("Could not provision the local Agent Daemon: {error}"))
    }

    async fn health(&self, client: &reqwest::Client, challenge: Option<&str>) -> Option<Health> {
        let url = match challenge {
            Some(challenge) => format!("{}/health?challenge={challenge}", self.origin()),
            None => format!("{}/health", self.origin()),
        };
        client
            .get(url)
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?
            .json::<Health>()
            .await
            .ok()
            .filter(|health| health.service == "omarchy-agent-daemon")
    }

    async fn wait_for_daemon(&self) -> Result<bool, String> {
        let client = client()?;
        for _ in 0..100 {
            if self.health(&client, None).await.is_some() {
                return Ok(true);
            }
            let running = {
                let mut child = self
                    .child
                    .lock()
                    .map_err(|_| "Local launch is unavailable.")?;
                match child.as_mut() {
                    Some(process) => match process.try_wait().map_err(|error| error.to_string())? {
                        Some(exit) => {
                            tracing::error!(
                                error_code = "daemon_exited_before_ready",
                                code = exit.code(),
                                "Local Agent Daemon exited before becoming ready"
                            );
                            *child = None;
                            return Err(format!(
                                "The local Agent Daemon exited before becoming ready ({exit})."
                            ));
                        }
                        None => true,
                    },
                    None => false,
                }
            };
            if !running {
                return Ok(false);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        tracing::warn!(
            error_code = "daemon_readiness_timeout",
            "Local Agent Daemon did not become ready"
        );
        Err("The local Agent Daemon did not become ready.".into())
    }

    async fn pairing_code(&self, app_name: &str) -> Result<String, String> {
        let token = fs::read_to_string(self.directory.join(OPERATOR_TOKEN))
            .map_err(|_| "Enter the pairing code issued by the daemon operator.")?;
        let client = client()?;
        let challenge = hex(&secret().map_err(|error| error.to_string())?);
        let proof = self
            .health(&client, Some(&challenge))
            .await
            .and_then(|health| health.proof)
            .and_then(|proof| URL_SAFE_NO_PAD.decode(proof).ok())
            .ok_or("Enter the pairing code issued by the daemon operator.")?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&Sha256::digest(token.as_bytes()))
            .map_err(|error| error.to_string())?;
        mac.update(challenge.as_bytes());
        // A different application can occupy the loopback port. Prove ownership before sending the bearer.
        mac.verify_slice(&proof)
            .map_err(|_| "Enter the pairing code issued by the daemon operator.")?;
        let result = client
            .post(format!("{}/api/pairing/codes", self.origin()))
            .bearer_auth(token)
            .json(&serde_json::json!({"name": format!("{app_name} ({})", std::env::consts::OS)}))
            .send()
            .await
            .map_err(|_| "Could not reach the local Agent Daemon.")?
            .error_for_status()
            .map_err(|_| "The local Agent Daemon could not issue a pairing code.")?;
        #[derive(Deserialize)]
        struct Code {
            code: String,
        }
        Ok(result
            .json::<Code>()
            .await
            .map_err(|_| "The Agent Daemon sent an invalid pairing response.")?
            .code)
    }
}

fn daemon_binary() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("METHEUS_AGENT_DAEMON_BIN")
        .or_else(|| std::env::var_os("OMARCHY_BOT_AGENT_DAEMON_BIN"))
        .map(PathBuf::from)
    {
        if path.is_absolute() && path.is_file() {
            return Ok(path);
        }
        return Err(
            "METHEUS_AGENT_DAEMON_BIN must point to an installed Agent Daemon executable."
                .into(),
        );
    }
    let name = format!("metheus-agent-daemon{}", std::env::consts::EXE_SUFFIX);
    let beside_app = std::env::current_exe()
        .ok()
        .map(|path| path.with_file_name(&name));
    let path = std::env::var_os("PATH").unwrap_or_default();
    beside_app
        .into_iter()
        .chain(
            std::env::split_paths(&path)
                .filter(|dir| dir.is_absolute())
                .map(|dir| dir.join(&name)),
        )
        .find(|path| path.is_file())
        .ok_or_else(|| "Install the Agent Daemon or enter the address of a running daemon.".into())
}

fn client() -> Result<reqwest::Client, String> {
    // The updater enables rustls without a default provider. This loopback client owns its connector.
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|_| "Could not initialize the local daemon connection.")?
    .with_root_certificates(rustls::RootCertStore::empty())
    .with_no_client_auth();
    reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|_| "Could not initialize the local daemon connection.".into())
}

fn secret() -> std::io::Result<[u8; 32]> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|error| std::io::Error::other(error.to_string()))?;
    Ok(bytes)
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(
        String::with_capacity(bytes.len() * 2),
        |mut output, byte| {
            let _ = write!(output, "{byte:02x}");
            output
        },
    )
}

fn write_once(path: &Path, value: &[u8]) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(path) {
        Ok(mut file) => {
            let result = file.write_all(value).and_then(|()| file.sync_all());
            if result.is_err() {
                drop(file);
                let _ = fs::remove_file(path);
            }
            result
        }
        Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub(super) async fn ensure_local_daemon(
    state: tauri::State<'_, LocalDaemon>,
) -> Result<bool, String> {
    state.start_if_needed()?;
    state.wait_for_daemon().await
}

#[tauri::command]
pub(super) fn set_daemon_autostart(
    state: tauri::State<'_, LocalDaemon>,
    enabled: bool,
) -> Result<(), String> {
    state.set_autostart(enabled)
}

#[tauri::command]
pub(super) async fn local_daemon_pairing_code(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalDaemon>,
) -> Result<String, String> {
    state.pairing_code(&app.package_info().name).await
}

#[cfg(test)]
mod tests {
    use super::*;

    struct StopOnDrop(LocalDaemon);

    impl Drop for StopOnDrop {
        fn drop(&mut self) {
            if let Ok(Some(process)) = self.0.child.get_mut() {
                let _ = process.kill();
                let _ = process.wait();
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn daemon_stderr_reaches_the_original_sink_after_the_launcher_exits() {
        use std::io::Read;
        use std::os::unix::fs::PermissionsExt;

        const PROFILE: &str = "METHEUS_TEST_DAEMON_STDERR_PROFILE";
        if let Some(profile) = std::env::var_os(PROFILE) {
            let port = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
                .unwrap()
                .local_addr()
                .unwrap()
                .port();
            let daemon = LocalDaemon {
                directory: PathBuf::from(profile).join("daemon"),
                recall_bundle: None,
                log_directory: None,
                port,
                child: Mutex::new(None),
            };
            daemon.start_if_needed().unwrap();
            return;
        }

        let profile = tempfile::tempdir().unwrap();
        let fixture = profile.path().join("stderr-fixture");
        fs::write(
            &fixture,
            r#"#!/bin/sh
while [ ! -f "$METHEUS_TEST_DAEMON_STDERR_PROFILE/launcher-exited" ]; do
    [ -d "$METHEUS_TEST_DAEMON_STDERR_PROFILE" ] || exit 1
    sleep 0.02
done
printf 'daemon fallback after launcher exit\n' >&2
"#,
        )
        .unwrap();
        fs::set_permissions(&fixture, fs::Permissions::from_mode(0o700)).unwrap();

        let mut launcher = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "agent_daemon::tests::daemon_stderr_reaches_the_original_sink_after_the_launcher_exits",
            ])
            .env(PROFILE, profile.path())
            .env("METHEUS_AGENT_DAEMON_BIN", &fixture)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        assert!(launcher.wait().unwrap().success());
        fs::write(profile.path().join("launcher-exited"), []).unwrap();
        let mut stderr = String::new();
        launcher
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        assert_eq!(stderr, "daemon fallback after launcher exit\n");
    }

    #[test]
    #[ignore = "set METHEUS_AGENT_DAEMON_BIN to a locally built daemon"]
    fn native_launcher_honors_preference_starts_and_attaches_to_real_daemon() {
        let profile = tempfile::tempdir().expect("disposable app profile");
        let port = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .and_then(|listener| listener.local_addr())
            .expect("reserve a local test port")
            .port();
        let owner = StopOnDrop(LocalDaemon {
            directory: profile.path().join("owner"),
            recall_bundle: None,
            log_directory: Some(profile.path().join("logs")),
            port,
            child: Mutex::new(None),
        });
        tauri::async_runtime::block_on(async {
            owner
                .0
                .set_autostart(false)
                .expect("disable native autostart");
            owner.0.start_if_needed().expect("read disabled preference");
            assert!(!owner
                .0
                .wait_for_daemon()
                .await
                .expect("disabled daemon probe"));
            assert!(!owner.0.directory.join(MASTER_KEY).exists());

            owner
                .0
                .set_autostart(true)
                .expect("enable native autostart");
            owner.0.start_if_needed().expect("launch real daemon");
            assert!(owner
                .0
                .wait_for_daemon()
                .await
                .expect("daemon became ready"));
            let log = fs::read_to_string(profile.path().join("logs/agent-daemon.log")).unwrap();
            assert!(log.contains("Agent Daemon ready"));
            let code = owner
                .0
                .pairing_code("Metheus")
                .await
                .expect("prove local ownership and mint a code");
            let paired = client()
                .unwrap()
                .post(format!("{}/api/pairing/exchange", owner.0.origin()))
                .json(&serde_json::json!({"code": code}))
                .send()
                .await
                .expect("exchange local pairing code");
            assert!(paired.status().is_success());
            let operator_token = fs::read_to_string(owner.0.directory.join(OPERATOR_TOKEN))
                .expect("read the test daemon operator token");
            let devices: serde_json::Value = client()
                .expect("build a loopback HTTP client")
                .get(format!("{}/api/devices/paired", owner.0.origin()))
                .bearer_auth(operator_token.trim())
                .send()
                .await
                .expect("request the paired devices")
                .error_for_status()
                .expect("authorize the paired devices request")
                .json()
                .await
                .expect("decode the paired devices");
            assert_eq!(
                devices["devices"][0]["name"],
                format!("Metheus ({})", std::env::consts::OS),
                "new local pairing uses the app display name"
            );

            let attached = LocalDaemon {
                directory: profile.path().join("attached"),
                recall_bundle: None,
                log_directory: Some(profile.path().join("logs")),
                port,
                child: Mutex::new(None),
            };
            attached
                .set_autostart(false)
                .expect("disable autostart in second profile");
            attached
                .start_if_needed()
                .expect("attach to existing process");
            assert!(attached
                .wait_for_daemon()
                .await
                .expect("existing daemon ready"));
            assert!(attached.child.lock().unwrap().is_none());
            assert!(attached.pairing_code("Metheus").await.is_err());
        });
    }
}
