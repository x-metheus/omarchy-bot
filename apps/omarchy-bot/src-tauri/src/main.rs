#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod attachments;

#[cfg(target_os = "linux")]
use gio::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt;
use url::Url;

const KEYCHAIN_SERVICE: &str = "com.omarchy.bot";
const KEYCHAIN_USER: &str = "service-connection";
const RESTART_EXIT_CODE: i32 = 75;

static APP_LOG: std::sync::OnceLock<Mutex<std::fs::File>> = std::sync::OnceLock::new();

fn log_lifecycle(message: &str) {
    let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
    let line = format!("{timestamp} pid={} {message}\n", std::process::id());
    let _ = std::io::stderr().write_all(line.as_bytes());
    if let Some(file) = APP_LOG.get() {
        if let Ok(mut file) = file.lock() { let _ = file.write_all(line.as_bytes()); }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    base_url: String,
    token: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingRequest {
    service_url: String,
    code: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Decision { AllowOnce, Deny, Always, Never }

#[derive(Serialize)]
struct DecisionLine<'a> {
    #[serde(rename = "type")]
    decision: Decision,
    #[serde(rename = "jobId")]
    job_id: &'a str,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
enum Approval {
    #[serde(rename = "ask", rename_all = "camelCase")]
    Ask {
        job_id: String,
        hostname: String,
        action: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        command: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        destination: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        query: Option<String>,
    },
    #[serde(rename = "ask.dismiss", rename_all = "camelCase")]
    Dismiss { job_id: String },
}

impl Approval {
    fn job_id(&self) -> &str {
        match self { Self::Ask { job_id, .. } | Self::Dismiss { job_id } => job_id }
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum SidecarFrame {
    Registered {
        #[serde(rename = "type")]
        _kind: Registered,
        #[serde(rename = "deviceId")]
        device_id: String,
    },
    Approval(Approval),
}

#[derive(Deserialize)]
enum Registered { #[serde(rename = "registered")] Registered }

struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    device_id: String,
    registered: bool,
    approvals: Vec<Approval>,
    pending: HashSet<String>,
}

struct ShellState {
    origin: Option<String>,
    connection: Option<Connection>,
    keychain: Mutex<()>,
    pending_pairing: Mutex<Option<PairingRequest>>,
    restart_link: Mutex<Option<String>>,
    sidecar: Mutex<Option<Sidecar>>,
}

fn service_origin(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Enter a valid Service origin.")?;
    let loopback = is_loopback_service(&url);
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || !url.username().is_empty() || url.password().is_some()
        || url.path() != "/" || url.query().is_some() || url.fragment().is_some()
    {
        return Err("Use HTTPS, or HTTP through a loopback address, without a path or credentials.".into());
    }
    Ok(url)
}
fn is_loopback_service(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) => host == "localhost",
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

fn websocket_url(mut service: Url) -> Result<Url, String> {
    service.set_scheme(if service.scheme() == "https" { "wss" } else { "ws" }).map_err(|_| "Invalid Sidecar Service URL.")?;
    Ok(service)
}

#[tauri::command]
fn host_digest(salt: String) -> Result<String, String> {
    if salt.len() != 64 || !salt.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
        return Err("The Service returned an invalid host identity salt.".into());
    }
    let override_file = std::env::var_os("OMARCHY_BOT_MACHINE_ID_FILE");
    let files: &[&std::ffi::OsStr] = match override_file.as_deref() {
        Some(file) => &[file],
        None => &[std::ffi::OsStr::new("/etc/machine-id"), std::ffi::OsStr::new("/var/lib/dbus/machine-id")],
    };
    for file in files {
        if let Ok(machine_id) = std::fs::read_to_string(file) {
            let machine_id = machine_id.trim();
            if machine_id.len() == 32 && machine_id.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                && machine_id.bytes().any(|byte| byte != b'0') {
                let mut digest = Sha256::new();
                digest.update(salt.as_bytes());
                digest.update(b":");
                digest.update(machine_id.as_bytes());
                return Ok(format!("{:x}", digest.finalize()));
            }
        }
    }
    Err("This machine's host identity is unavailable.".into())
}

#[tauri::command]
fn sidecar_start(app: tauri::AppHandle, state: tauri::State<ShellState>) -> Result<(), String> {
    if state.sidecar.lock().map_err(|_| "Local Sidecar is busy.")?.is_some() { return Ok(()); }
    let connection = state.connection.as_ref().ok_or("Pair with a Service before starting local actions.")?;
    start_sidecar(&app, connection)
}

fn start_sidecar(app: &tauri::AppHandle, connection: &Connection) -> Result<(), String> {
    let service = websocket_url(service_origin(&connection.base_url)?)?;
    let config = app.path().app_config_dir().map_err(|_| "Could not locate app configuration.")?;
    std::fs::create_dir_all(&config).map_err(|_| "Could not create app configuration.")?;
    let identity_path = config.join("sidecar-device-id");
    let device_id = match std::fs::read_to_string(&identity_path) {
        Ok(identity) => identity,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut random = [0u8; 16];
            getrandom::fill(&mut random).map_err(|_| "Could not generate Local Sidecar identity.")?;
            let identity = format!("dev_{}", random.iter().map(|byte| format!("{byte:02x}")).collect::<String>());
            std::fs::write(&identity_path, &identity).map_err(|_| "Could not persist Local Sidecar identity.")?;
            identity
        },
        Err(_) => return Err("Could not read Local Sidecar identity.".into()),
    };
    if device_id.len() != 36 || !device_id.starts_with("dev_") || !device_id.as_bytes()[4..].iter().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)) {
        return Err("The stored Local Sidecar identity is invalid.".into());
    }
    let root = app.path().app_local_data_dir().map_err(|_| "Could not locate Local Sidecar data.")?.join("sidecar");
    std::fs::create_dir_all(&root).map_err(|_| "Could not create Local Sidecar data.")?;
    let executable = std::env::current_exe().map_err(|_| "Could not locate bundled Local Sidecar.")?;
    let binary = executable.with_file_name(if cfg!(windows) { "omarchy-bot-sidecar.exe" } else { "omarchy-bot-sidecar" });
    let mut command = Command::new(binary);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW: the Sidecar communicates through pipes.
    let mut child = command
        .env("OMARCHY_BOT_SERVICE_URL", service.as_str())
        .env("OMARCHY_BOT_DEVICE_ID", &device_id)
        .env("OMARCHY_BOT_DEVICE_TOKEN", &connection.token)
        .env("OMARCHY_BOT_SIDECAR_ROOT", root)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|_| "Could not start bundled Local Sidecar.")?;
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    *app.state::<ShellState>().sidecar.lock().map_err(|_| "Local Sidecar is busy.")? = Some(Sidecar {
        child, stdin, device_id, registered: false, approvals: Vec::new(), pending: HashSet::new(),
    });
    // Drain diagnostics without forwarding child output that may contain credentials.
    std::thread::spawn(move || { let _ = std::io::copy(&mut BufReader::new(stderr), &mut std::io::sink()); });
    let handle = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break; };
            let Ok(frame) = serde_json::from_str::<SidecarFrame>(&line) else { continue; };
            let state = handle.state::<ShellState>();
            let Ok(mut guard) = state.sidecar.lock() else { break; };
            let Some(sidecar) = guard.as_mut() else { break; };
            match frame {
                SidecarFrame::Registered { device_id, .. } if device_id == sidecar.device_id => sidecar.registered = true,
                SidecarFrame::Approval(approval @ Approval::Ask { .. }) => {
                    if sidecar.pending.insert(approval.job_id().to_owned()) { sidecar.approvals.push(approval); }
                },
                SidecarFrame::Approval(approval @ Approval::Dismiss { .. }) => {
                    sidecar.pending.remove(approval.job_id());
                    sidecar.approvals.retain(|ask| ask.job_id() != approval.job_id());
                    sidecar.approvals.push(approval);
                },
                _ => {},
            }
            drop(guard);
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.eval("window.dispatchEvent(new Event('omarchy-sidecar')); ");
            }
        }
        stop_sidecar(&handle.state::<ShellState>());
        if let Some(window) = handle.get_webview_window("main") {
            let _ = window.eval("window.dispatchEvent(new Event('omarchy-sidecar')); ");
        }
    });
    Ok(())
}

fn stop_sidecar(state: &ShellState) {
    let sidecar = state.sidecar.lock().ok().and_then(|mut guard| guard.take());
    if let Some(mut sidecar) = sidecar {
        drop(sidecar.stdin);
        // Closing stdin asks the Sidecar to stop its command trees before it exits.
        for _ in 0..100 {
            if matches!(sidecar.child.try_wait(), Ok(Some(_))) { return; }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let _ = sidecar.child.kill();
        let _ = sidecar.child.wait();
    }
}

#[tauri::command]
fn sidecar_events(state: tauri::State<ShellState>) -> Result<serde_json::Value, String> {
    let mut guard = state.sidecar.lock().map_err(|_| "Local Sidecar is busy.")?;
    Ok(match guard.as_mut() {
        Some(sidecar) => serde_json::json!({ "status": { "running": sidecar.registered, "deviceId": sidecar.device_id }, "approvals": std::mem::take(&mut sidecar.approvals) }),
        None => serde_json::json!({ "status": { "running": false }, "approvals": [] }),
    })
}

#[tauri::command]
fn sidecar_decide(state: tauri::State<ShellState>, job_id: String, decision: Decision) -> Result<(), String> {
    let mut guard = state.sidecar.lock().map_err(|_| "Local Sidecar is busy.")?;
    let sidecar = guard.as_mut().ok_or("No Local Sidecar is running.")?;
    if !sidecar.pending.contains(&job_id) { return Err("This local approval is no longer pending.".into()); }
    let frame = serde_json::to_string(&DecisionLine { decision, job_id: &job_id }).map_err(|_| "Could not encode Local Sidecar decision.")?;
    writeln!(sidecar.stdin, "{frame}").and_then(|_| sidecar.stdin.flush()).map_err(|_| "Could not deliver Local Sidecar decision.")?;
    sidecar.pending.remove(&job_id);
    Ok(())
}


fn pairing_request(value: &str) -> Option<PairingRequest> {
    let url = Url::parse(value).ok()?;
    if url.scheme() != "omarchy-bot" || url.host_str() != Some("pair")
        || !url.username().is_empty() || url.password().is_some() || url.port().is_some()
        || !matches!(url.path(), "" | "/") || url.fragment().is_some()
    {
        return None;
    }
    let mut service = None;
    let mut code = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "service" if service.is_none() => service = Some(value.into_owned()),
            "code" if code.is_none() => code = Some(value.into_owned()),
            _ => return None,
        }
    }
    let service = service_origin(&service?).ok()?;
    let code = code?;
    if code.is_empty() || code.len() > 256 || code.chars().any(char::is_control) { return None; }
    Some(PairingRequest { service_url: service.origin().ascii_serialization(), code })
}

fn keychain_error(error: keyring::Error) -> String {
    let recovery = if cfg!(windows) { "Check Windows Credential Manager and try again" } else if cfg!(target_os = "macos") { "Unlock your OS keychain and try again" } else { "Unlock your Secret Service keyring and try again" };
    format!("Could not access the OS keychain: {error}. {recovery}; credentials were not discarded.")
}

fn keychain() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER).map_err(keychain_error)
}

fn read_connection() -> Result<Option<Connection>, String> {
    let secret = match keychain()?.get_password() {
        Ok(secret) => secret,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(error) => return Err(keychain_error(error)),
    };
    let connection: Connection = serde_json::from_str(&secret)
        .map_err(|_| "The OS keychain connection is invalid. Remove the com.omarchy.bot / service-connection entry to pair again.".to_string())?;
    service_origin(&connection.base_url)?;
    if connection.token.is_empty() { return Err("The OS keychain device token is empty. Remove its service-connection entry to pair again.".into()); }
    Ok(Some(connection))
}

#[tauri::command]
fn store_connection(app: tauri::AppHandle, state: tauri::State<ShellState>, base_url: String, token: String) -> Result<(), String> {
    let origin = service_origin(&base_url)?.origin().ascii_serialization();
    if state.origin.as_ref().is_some_and(|paired| paired != &origin) {
        return Err("Open a pairing deep link for the new Service before changing this connection.".into());
    }
    if token.is_empty() || token.len() > 4096 { return Err("The Service returned an invalid device token.".into()); }
    let _guard = state.keychain.lock().map_err(|_| "The OS keychain is busy. Restart the app.")?;
    let secret = serde_json::to_string(&Connection { base_url: origin, token }).map_err(|_| "Could not encode the Service connection.")?;
    keychain()?.set_password(&secret).map_err(keychain_error)?;
    if let Ok(directory) = app.path().app_config_dir() { let _ = std::fs::remove_file(directory.join("revoked-service")); }
    stop_sidecar(&state);
    app.exit(RESTART_EXIT_CODE);
    Ok(())
}

#[tauri::command]
fn clear_connection(app: tauri::AppHandle, state: tauri::State<ShellState>) -> Result<(), String> {
    let _guard = state.keychain.lock().map_err(|_| "The OS keychain is busy. Restart the app.")?;
    // A notice is optional; it must never prevent deletion of a revoked credential.
    match keychain()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {},
        Err(error) => return Err(keychain_error(error)),
    }
    if let (Some(origin), Ok(directory)) = (&state.origin, app.path().app_config_dir()) {
        let notice = std::fs::create_dir_all(&directory).and_then(|_| std::fs::write(directory.join("revoked-service"), origin));
        if notice.is_err() { eprintln!("The revoked credential was cleared, but its Service address could not be retained."); }
    }
    stop_sidecar(&state);
    app.exit(RESTART_EXIT_CODE);
    Ok(())
}

#[tauri::command]
fn open_browser(app: tauri::AppHandle, value: String) -> Result<(), String> {
    let url = Url::parse(&value).map_err(|_| "Invalid browser URL.")?;
    if !matches!(url.scheme(), "https" | "http") || url.host().is_none()
        || !url.username().is_empty() || url.password().is_some()
    { return Err("Only HTTP or HTTPS browser URLs without credentials are allowed.".into()); }
    if url.query_pairs().any(|(key, _)| key == "access_token") {
        return Err("An authenticated Service link cannot be opened in the system browser.".into());
    }
    app.opener().open_url(url.as_str(), None::<&str>).map_err(|error| format!("Could not open the system browser: {error}"))
}

#[cfg(target_os = "linux")]
fn probe_certificate(url: &Url) -> Result<bool, String> {
    let client = gio::SocketClient::new();
    client.set_tls(true);
    client.set_timeout(10);
    Ok(match client.connect_to_uri(url.as_str(), 443, gio::Cancellable::NONE) {
        Ok(stream) => { let _ = stream.close(gio::Cancellable::NONE); false },
        Err(error) => error.matches(gio::TlsError::BadCertificate),
    })
}

#[cfg(target_os = "macos")]
fn probe_certificate(url: &Url) -> Result<bool, String> {
    use security_framework::{policy::SecPolicy, secure_transport::{HandshakeError, SslConnectionType, SslContext, SslProtocolSide}};
    use std::net::{TcpStream, ToSocketAddrs};
    let Some(host) = url.host() else { return Ok(false); };
    let host = match host {
        url::Host::Domain(domain) => std::borrow::Cow::Borrowed(domain),
        url::Host::Ipv4(address) => std::borrow::Cow::Owned(address.to_string()),
        url::Host::Ipv6(address) => std::borrow::Cow::Owned(address.to_string()),
    };
    let timeout = std::time::Duration::from_secs(10);
    let Ok(addresses) = (host.as_ref(), url.port_or_known_default().unwrap_or(443)).to_socket_addrs() else { return Ok(false); };
    let Some(stream) = addresses.filter_map(|address| TcpStream::connect_timeout(&address, timeout).ok()).next() else { return Ok(false); };
    if stream.set_read_timeout(Some(timeout)).is_err() || stream.set_write_timeout(Some(timeout)).is_err() { return Ok(false); }
    let Ok(mut context) = SslContext::new(SslProtocolSide::CLIENT, SslConnectionType::STREAM) else { return Ok(false); };
    if context.set_peer_domain_name(&host).is_err() || context.set_break_on_server_auth(true).is_err() { return Ok(false); }
    // Stop at server authentication: diagnose system trust without sending credentials or accepting an exception.
    let Err(HandshakeError::Interrupted(handshake)) = context.handshake(stream) else { return Ok(false); };
    if !handshake.server_auth_completed() { return Ok(false); }
    let Ok(Some(mut trust)) = handshake.context().peer_trust2() else { return Ok(false); };
    if trust.set_policy(&SecPolicy::create_ssl(SslProtocolSide::SERVER, Some(&host))).is_err() { return Ok(false); }
    Ok(trust.evaluate_with_error().is_err())
}

#[cfg(windows)]
fn probe_certificate(url: &Url) -> Result<bool, String> {
    use schannel::{schannel_cred::{Direction, SchannelCred}, tls_stream};
    use std::net::TcpStream;
    use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
    use std::time::Duration;

    let timeout = Duration::from_secs(10);
    let addresses = match url.socket_addrs(|| Some(443)) {
        Ok(addresses) => addresses,
        Err(_) => return Ok(false),
    };
    let Some(stream) = addresses.iter().find_map(|address| TcpStream::connect_timeout(address, timeout).ok()) else { return Ok(false); };
    stream.set_read_timeout(Some(timeout)).and_then(|_| stream.set_write_timeout(Some(timeout)))
        .map_err(|_| "Could not configure the TLS certificate check.")?;
    let credentials = SchannelCred::builder().acquire(Direction::Outbound)
        .map_err(|_| "Could not initialize Windows TLS certificate validation.")?;
    let untrusted = Arc::new(AtomicBool::new(false));
    let validation_failed = Arc::clone(&untrusted);
    let host = url.host_str().expect("validated Service host").trim_start_matches('[').trim_end_matches(']');
    let _ = tls_stream::Builder::new().domain(host).verify_callback(move |validation| {
        // Observe Windows trust/hostname validation without accepting an invalid certificate.
        validation.result().inspect_err(|_| validation_failed.store(true, Ordering::Relaxed))
    }).connect(credentials, stream);
    Ok(untrusted.load(Ordering::Relaxed))
}

#[tauri::command]
async fn certificate_untrusted(state: tauri::State<'_, ShellState>, origin: String) -> Result<bool, String> {
    let url = service_origin(&origin)?;
    if url.scheme() != "https" { return Ok(false); }
    if state.origin.as_ref().is_some_and(|paired| paired != &url.origin().ascii_serialization()) {
        return Err("The certificate probe is restricted to the paired Service.".into());
    }
    tauri::async_runtime::spawn_blocking(move || probe_certificate(&url))
        .await.map_err(|_| "The TLS certificate check failed.")?
}

#[tauri::command]
fn save_attachment(app: tauri::AppHandle, filename: String, bytes: Vec<u8>) -> Result<String, String> {
    let directory = app.path().download_dir().map_err(|error| format!("Could not locate Downloads: {error}"))?;
    attachments::write_attachment(&directory, &filename, &bytes).map(|path| path.display().to_string())
}

#[tauri::command]
fn restart_app(app: tauri::AppHandle) { app.exit(RESTART_EXIT_CODE); }

#[cfg(desktop)]
async fn available_update(app: &tauri::AppHandle) -> Result<Option<tauri_plugin_updater::Update>, String> {
    app.updater().map_err(|error| error.to_string())?
        .check().await.map_err(|error| format!("Could not check for app updates: {error}"))
}

#[cfg(desktop)]
#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(available_update(&app).await?.map(|update| update.version))
}

#[cfg(desktop)]
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let update = available_update(&app).await?.ok_or("No newer app release is available.")?;
    update.download_and_install(|_, _| {}, || {}).await
        .map_err(|error| format!("Could not verify and install the app update: {error}"))
}

#[tauri::command]
fn take_pairing_request(state: tauri::State<ShellState>) -> Option<PairingRequest> {
    state.pending_pairing.lock().ok()?.take()
}


fn receive_link(app: &tauri::AppHandle, link: &str) {
    let Some(request) = pairing_request(link) else { return; };
    let state = app.state::<ShellState>();
    if state.origin.as_ref().is_some_and(|origin| origin != &request.service_url) {
        if let Ok(mut next) = state.restart_link.lock() { *next = Some(link.to_string()); }
        app.exit(RESTART_EXIT_CODE);
        return;
    }
    if let Ok(mut pending) = state.pending_pairing.lock() { *pending = Some(request); }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval("window.dispatchEvent(new Event('omarchy-pair')); ");
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn main() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic| {
        log_lifecycle(&format!("panic location={:?}\n{}", panic.location(), std::backtrace::Backtrace::force_capture()));
        default_hook(panic);
    }));
    let mut context = tauri::generate_context!();
    #[cfg(windows)]
    if let Some(directory) = std::env::var_os("OMARCHY_BOT_SMOKE_DIR") {
        context.config_mut().app.app_directories_override = Some(tauri::utils::config::AppDirectoriesOverride::Root(directory.into()));
    }
    // Match Tauri's app_log_dir before creating the native runtime, which can panic.
    let logging = (|| -> Result<(), Box<dyn std::error::Error>> {
        #[cfg(target_os = "macos")]
        let directory = dirs::home_dir().map(|home| home.join("Library/Logs").join(&context.config().identifier));
        #[cfg(not(target_os = "macos"))]
        let directory = dirs::data_local_dir().map(|data| data.join(&context.config().identifier).join("logs"));
        #[cfg(windows)]
        let directory = std::env::var_os("OMARCHY_BOT_SMOKE_DIR").map(|root| std::path::PathBuf::from(root).join("logs")).or(directory);
        let directory = directory.ok_or("Native app log directory is unavailable")?;
        std::fs::create_dir_all(&directory)?;
        let file = std::fs::OpenOptions::new().create(true).append(true).open(directory.join("omarchy-bot.log"))?;
        let _ = APP_LOG.set(Mutex::new(file));
        Ok(())
    })();
    if let Err(error) = logging { let _ = writeln!(std::io::stderr(), "Could not open native app log: {error}"); }
    log_lifecycle("startup");
    let incoming = std::env::args().skip(1).find_map(|argument| pairing_request(&argument));
    let loaded = read_connection();
    let error = loaded.as_ref().err().cloned();
    let stored = loaded.ok().flatten();
    // An explicit pairing link opens Add Service without deleting the previous keychain entry.
    let connection = if incoming.is_some() { None } else { stored };
    let origin = connection.as_ref().map(|connection| connection.base_url.clone());
    let mut policy = context.config().app.security.csp.clone().expect("CSP configured").to_string();
    let network = if let Some(origin) = &origin {
        let socket = websocket_url(Url::parse(origin).expect("validated Service origin")).expect("WebSocket scheme");
        format!("{origin} {}", socket.origin().ascii_serialization())
    } else { "http://localhost:*/api/pairing/exchange http://127.0.0.1:*/api/pairing/exchange https://*:*/api/pairing/exchange".into() };
    policy = policy.replace("connect-src 'self' ipc: http://ipc.localhost", &format!("connect-src 'self' ipc: http://ipc.localhost {network}"));
    if let Some(origin) = &origin { policy = policy.replace("img-src 'self' data: blob:", &format!("img-src 'self' data: blob: {origin}")); }
    context.config_mut().app.security.csp = Some(tauri::utils::config::Csp::Policy(policy));
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, arguments, _| {
        for link in arguments.iter().skip(1) { receive_link(app, link); }
    }));
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    let application = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .manage(ShellState { origin, connection: connection.clone(), keychain: Mutex::new(()), pending_pairing: Mutex::new(None), restart_link: Mutex::new(None), sidecar: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![store_connection, clear_connection, open_browser, certificate_untrusted, restart_app, take_pairing_request, save_attachment, check_update, install_update, sidecar_events, sidecar_decide, sidecar_start, host_digest])
        .setup(move |app| {
            let revoked = if connection.is_none() {
                std::fs::read_to_string(app.path().app_config_dir()?.join("revoked-service")).ok()
                    .and_then(|origin| service_origin(&origin).ok()).map(|url| url.origin().ascii_serialization())
            } else { None };
            let defaults: serde_json::Value = serde_json::from_str(include_str!("../../shell-defaults.json"))?;
            let initial = serde_json::json!({ "connection": connection, "pairing": incoming, "error": error, "revoked": revoked, "platform": std::env::consts::OS, "defaults": defaults });
            let script = format!("({})({});", include_str!("shell.js"), initial);
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Omarchy Bot").inner_size(1200.0, 800.0).min_inner_size(480.0, 480.0)
                .initialization_script(script)
                .on_navigation(|url| url.username().is_empty() && url.password().is_none() && url.port().is_none()
                    && matches!((url.scheme(), url.host_str()), ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))))
                .build()?;
            Ok(())
        })
        .on_window_event(|_, event| match event {
            tauri::WindowEvent::CloseRequested { .. } => log_lifecycle("window-close-requested"),
            tauri::WindowEvent::Destroyed => log_lifecycle("window-destroyed"),
            _ => {},
        })
        .build(context)
        .expect("Could not start Omarchy Bot");
    let handle = application.handle().clone();
    let mut environment = handle.env();
    // Rebuild argv at the process boundary so consumed pairing codes are never replayed.
    environment.args_os.truncate(1);
    let exit = application.run_return(|app, event| {
        // Apple Events arrive after setup; the native queue retains links until the WebView subscribes.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &event {
            for url in urls { receive_link(app, url.as_str()); }
        }
        match event {
            tauri::RunEvent::ExitRequested { code, .. } => log_lifecycle(&format!("exit-requested code={code:?}")),
            tauri::RunEvent::Exit => {
                log_lifecycle("exit");
                stop_sidecar(&app.state::<ShellState>());
            },
            _ => {},
        }
    });
    log_lifecycle(&format!("event-loop-return code={exit}"));
    if exit == RESTART_EXIT_CODE {
        if let Ok(mut link) = handle.state::<ShellState>().restart_link.lock() {
            if let Some(link) = link.take() { environment.args_os.push(link.into()); }
        }
        tauri::process::restart(&environment);
    }
    std::process::exit(exit);
}

#[cfg(test)]
mod sidecar_wire_tests {
    use super::*;

    #[test]
    fn decisions_use_the_existing_wire_values() {
        for (wire, decision) in [("allow-once", Decision::AllowOnce), ("deny", Decision::Deny), ("always", Decision::Always), ("never", Decision::Never)] {
            let parsed: Decision = serde_json::from_value(serde_json::json!(wire)).unwrap();
            assert_eq!(parsed, decision);
            assert_eq!(serde_json::to_value(DecisionLine { decision, job_id: "job-1" }).unwrap(), serde_json::json!({"type": wire, "jobId": "job-1"}));
        }
        for invalid in [serde_json::json!("AllowOnce"), serde_json::json!("allow"), serde_json::Value::Null, serde_json::json!(42)] {
            assert!(serde_json::from_value::<Decision>(invalid).is_err());
        }
    }

    #[test]
    fn approvals_keep_camel_case_fields_and_ignore_malformed_frames() {
        for wire in [
            serde_json::json!({"type":"ask", "jobId":"job-1", "hostname":"laptop", "action":"run"}),
            serde_json::json!({"type":"ask", "jobId":"job-1", "hostname":"laptop", "action":"transfer", "command":"echo ok", "path":"file", "destination":"target", "query":"needle"}),
            serde_json::json!({"type":"ask.dismiss", "jobId":"job-1"}),
        ] {
            let SidecarFrame::Approval(approval) = serde_json::from_value(wire.clone()).unwrap() else { panic!("expected approval") };
            assert_eq!(approval.job_id(), "job-1");
            assert_eq!(serde_json::to_value(approval).unwrap(), wire);
        }
        assert!(matches!(serde_json::from_str::<SidecarFrame>(r#"{"type":"registered","deviceId":"dev_1"}"#).unwrap(), SidecarFrame::Registered { device_id, .. } if device_id == "dev_1"));
        for invalid in [
            r#"{"type":"unknown","jobId":"job-1"}"#,
            r#"{"type":"ask","jobId":42,"hostname":"laptop","action":"run"}"#,
            r#"{"type":"ask","jobId":"job-1"}"#,
            r#"{"type":"ask.dismiss"}"#,
            r#"{"type":"registered","deviceId":null}"#,
            "not json",
        ] {
            assert!(serde_json::from_str::<SidecarFrame>(invalid).is_err(), "{invalid}");
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn certificate_probe_rejects_untrusted_ipv6_tls() { check_certificate_probe("[::1]:0"); }

    #[test]
    fn certificate_probe_distinguishes_untrusted_tls_from_an_unreachable_service() {
        check_certificate_probe("127.0.0.1:0");
    }

    fn check_certificate_probe(bind: &str) {
        let directory = std::env::temp_dir().join(format!("omarchy-tls-{}-{}", std::process::id(), if bind.starts_with('[') { "ipv6" } else { "ipv4" }));
        std::fs::create_dir_all(&directory).unwrap();
        let certificate = directory.join("cert.pem");
        let key = directory.join("key.pem");
        let generated = Command::new("openssl").args(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout"])
            .arg(&key).arg("-out").arg(&certificate).stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap();
        assert!(generated.success());
        let listener = std::net::TcpListener::bind(bind).unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let mut server = Command::new("openssl").args(["s_server", "-accept", &address.to_string(), "-cert"])
            .arg(&certificate).arg("-key").arg(&key).arg("-quiet")
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let result = std::panic::catch_unwind(|| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while std::net::TcpStream::connect(address).is_err() {
                assert!(std::time::Instant::now() < deadline, "TLS fixture did not start");
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            assert!(probe_certificate(&Url::parse(&format!("https://{address}")).unwrap()).unwrap());
        });
        let _ = server.kill();
        let _ = server.wait();
        std::fs::remove_dir_all(directory).unwrap();
        result.unwrap();
        assert!(!probe_certificate(&Url::parse(&format!("https://{address}")).unwrap()).unwrap());
    }
}
