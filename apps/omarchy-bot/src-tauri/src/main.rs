#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_daemon;
mod attachments;
mod desktop_tools;

#[cfg(target_os = "linux")]
use gio::prelude::*;
use agent_daemon::LocalDaemon;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::sync::Mutex;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt;
use url::Url;

const KEYCHAIN_SERVICE: &str = "com.omarchy.bot";
const KEYCHAIN_USER: &str = "agent-daemon-connection";
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

struct ShellState {
    origin: Option<String>,
    connection: Option<Connection>,
    keychain: Mutex<()>,
    pending_pairing: Mutex<Option<PairingRequest>>,
    restart_link: Mutex<Option<String>>,
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
        .map_err(|_| "The OS keychain connection is invalid. Remove the com.omarchy.bot / agent-daemon-connection entry to pair again.".to_string())?;
    service_origin(&connection.base_url)?;
    if connection.token.is_empty() { return Err("The OS keychain device token is empty. Remove its agent-daemon-connection entry to pair again.".into()); }
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
    if let Ok(directory) = app.path().app_config_dir() { let _ = std::fs::remove_file(directory.join("revoked-agent-daemon")); }
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
        let notice = std::fs::create_dir_all(&directory).and_then(|_| std::fs::write(directory.join("revoked-agent-daemon"), origin));
        if notice.is_err() { eprintln!("The revoked credential was cleared, but its Service address could not be retained."); }
    }
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

fn allows_app_navigation(url: &Url, dev: bool) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let origin = (url.scheme(), url.host_str(), url.port());
    matches!(
        origin,
        ("tauri", Some("localhost"), None) | ("http" | "https", Some("tauri.localhost"), None)
    ) || (dev && origin == ("http", Some("127.0.0.1"), Some(7322)))
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
    let network = origin.as_deref().unwrap_or("http://localhost:*/api/pairing/exchange http://127.0.0.1:*/api/pairing/exchange https://*:*/api/pairing/exchange");
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .manage(desktop_tools::DesktopTools::default())
        .manage(ShellState { origin, connection: connection.clone(), keychain: Mutex::new(()), pending_pairing: Mutex::new(None), restart_link: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![store_connection, clear_connection, open_browser, certificate_untrusted, restart_app, take_pairing_request, save_attachment, check_update, install_update, agent_daemon::ensure_local_daemon, agent_daemon::set_daemon_autostart, agent_daemon::local_daemon_pairing_code, desktop_tools::choose_desktop_path])
        .setup(move |app| {
            let daemon = LocalDaemon::new(app.path().app_local_data_dir()?.join("agent-daemon"), app.path().resource_dir().ok());
            let local = serde_json::json!({ "baseUrl": daemon.origin(), "autostart": daemon.autostart().unwrap_or(false) });
            app.manage(daemon);
            let revoked = if connection.is_none() {
                std::fs::read_to_string(app.path().app_config_dir()?.join("revoked-agent-daemon")).ok()
                    .and_then(|origin| service_origin(&origin).ok()).map(|url| url.origin().ascii_serialization())
            } else { None };
            let initial = serde_json::json!({ "connection": connection, "pairing": incoming, "error": error, "revoked": revoked, "localDaemon": local });
            let script = format!("({})({});", include_str!("shell.js"), initial);
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Omarchy Bot").inner_size(1200.0, 800.0).min_inner_size(480.0, 480.0)
                .disable_drag_drop_handler()
                .initialization_script(script)
                .on_navigation(|url| allows_app_navigation(url, cfg!(dev)))
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
                app.state::<desktop_tools::DesktopTools>().stop();
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
#[test]
fn navigation_allows_only_app_origins_and_the_exact_vite_origin_in_dev() {
    for app in ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"] {
        let url = Url::parse(app).expect("app origin");
        assert!(allows_app_navigation(&url, false), "{app}");
        assert!(allows_app_navigation(&url, true), "{app}");
    }
    let vite = Url::parse("http://127.0.0.1:7322/index.html").expect("Vite dev URL");
    assert!(allows_app_navigation(&vite, true));
    assert!(!allows_app_navigation(&vite, false));
    for foreign in [
        "http://127.0.0.1:7323",
        "http://localhost:7322",
        "https://127.0.0.1:7322",
        "http://127.0.0.1",
        "http://user@127.0.0.1:7322",
        "https://tauri.localhost:7322",
        "https://example.test",
    ] {
        let url = Url::parse(foreign).expect("foreign origin");
        assert!(!allows_app_navigation(&url, true), "{foreign}");
        assert!(!allows_app_navigation(&url, false), "{foreign}");
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

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
