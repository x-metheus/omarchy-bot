use gio::prelude::*;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt;
use url::Url;

const KEYCHAIN_SERVICE: &str = "com.omarchy.bot";
const KEYCHAIN_USER: &str = "service-connection";
const RESTART: i32 = 75;

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
    keychain: Mutex<()>,
    pending_pairing: Mutex<Option<PairingRequest>>,
    restart_link: Mutex<Option<String>>,
}

fn service_origin(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Enter a valid Service origin.")?;
    let loopback = match url.host() {
        Some(url::Host::Domain(host)) => host == "localhost",
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || !url.username().is_empty() || url.password().is_some()
        || url.path() != "/" || url.query().is_some() || url.fragment().is_some()
    {
        return Err("Use HTTPS, or HTTP through a loopback address, without a path or credentials.".into());
    }
    Ok(url)
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
    format!("Could not access the OS keychain: {error}. Unlock your Secret Service keyring and try again; credentials were not discarded.")
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
    app.exit(RESTART);
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
    app.exit(RESTART);
    Ok(())
}

#[tauri::command]
fn open_browser(app: tauri::AppHandle, value: String) -> Result<(), String> {
    let url = Url::parse(&value).map_err(|_| "Invalid browser URL.")?;
    if !matches!(url.scheme(), "https" | "http") || url.host().is_none()
        || !url.username().is_empty() || url.password().is_some()
    { return Err("Only HTTP or HTTPS browser URLs without credentials are allowed.".into()); }
    app.opener().open_url(url.as_str(), None::<&str>).map_err(|error| format!("Could not open the system browser: {error}"))
}

#[tauri::command]
async fn certificate_untrusted(state: tauri::State<'_, ShellState>, origin: String) -> Result<bool, String> {
    let url = service_origin(&origin)?;
    if url.scheme() != "https" { return Ok(false); }
    if state.origin.as_ref().is_some_and(|paired| paired != &url.origin().ascii_serialization()) {
        return Err("The certificate probe is restricted to the paired Service.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let client = gio::SocketClient::new();
        client.set_tls(true);
        client.set_timeout(10);
        match client.connect_to_uri(url.as_str(), 443, gio::Cancellable::NONE) {
            Ok(stream) => { let _ = stream.close(gio::Cancellable::NONE); false },
            Err(error) => error.matches(gio::TlsError::BadCertificate),
        }
    }).await.map_err(|_| "The TLS certificate check failed.".into())
}

#[tauri::command]
fn save_attachment(app: tauri::AppHandle, filename: String, bytes: Vec<u8>) -> Result<String, String> {
    use std::io::Write;
    if filename.is_empty() || filename == "." || filename == ".." || filename.contains(['/', '\\']) || filename.chars().any(char::is_control) {
        return Err("The attachment has an invalid filename.".into());
    }
    let directory = app.path().download_dir().map_err(|error| format!("Could not locate Downloads: {error}"))?;
    std::fs::create_dir_all(&directory).map_err(|error| format!("Could not create Downloads: {error}"))?;
    let mut target = directory.join(&filename);
    for suffix in 1.. {
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&target) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(&bytes) {
                    let _ = std::fs::remove_file(&target);
                    return Err(format!("Could not save the attachment: {error}"));
                }
                return Ok(target.display().to_string());
            },
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => target = directory.join(format!("{suffix}-{filename}")),
            Err(error) => return Err(format!("Could not save the attachment: {error}")),
        }
    }
    unreachable!()
}

#[tauri::command]
fn restart_app(app: tauri::AppHandle) { app.exit(RESTART); }

#[cfg(desktop)]
#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let update = app.updater().map_err(|error| error.to_string())?
        .check().await.map_err(|error| format!("Could not check for app updates: {error}"))?;
    Ok(update.map(|update| update.version))
}

#[cfg(desktop)]
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let update = app.updater().map_err(|error| error.to_string())?
        .check().await.map_err(|error| format!("Could not check for app updates: {error}"))?
        .ok_or("No newer app release is available.")?;
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
        app.exit(RESTART);
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
    let incoming = std::env::args().skip(1).find_map(|argument| pairing_request(&argument));
    let loaded = read_connection();
    let error = loaded.as_ref().err().cloned();
    let stored = loaded.ok().flatten();
    // An explicit pairing link opens Add Service without deleting the previous keychain entry.
    let connection = if incoming.is_some() { None } else { stored };
    let origin = connection.as_ref().map(|connection| connection.base_url.clone());
    let mut context = tauri::generate_context!();
    let mut policy = context.config().app.security.csp.clone().expect("CSP configured").to_string();
    let network = if let Some(origin) = &origin {
        let mut socket = Url::parse(origin).expect("validated Service origin");
        socket.set_scheme(if socket.scheme() == "https" { "wss" } else { "ws" }).expect("WebSocket scheme");
        format!("{origin} {}", socket.origin().ascii_serialization())
    } else { "http: https:".into() };
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
        .manage(ShellState { origin, keychain: Mutex::new(()), pending_pairing: Mutex::new(None), restart_link: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![store_connection, clear_connection, open_browser, certificate_untrusted, restart_app, take_pairing_request, save_attachment, check_update, install_update])
        .setup(move |app| {
            let revoked = if connection.is_none() {
                std::fs::read_to_string(app.path().app_config_dir()?.join("revoked-service")).ok()
                    .and_then(|origin| service_origin(&origin).ok()).map(|url| url.origin().ascii_serialization())
            } else { None };
            let initial = serde_json::json!({ "connection": connection, "pairing": incoming, "error": error, "revoked": revoked });
            let script = format!("({})({});", include_str!("shell.js"), initial);
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Omarchy Bot").inner_size(1200.0, 800.0).min_inner_size(480.0, 480.0)
                .initialization_script(script)
                .on_navigation(|url| matches!(url.scheme(), "tauri") && url.host_str() == Some("localhost"))
                .build()?;
            Ok(())
        })
        .build(context)
        .expect("Could not start Omarchy Bot");
    let handle = application.handle().clone();
    let mut environment = handle.env();
    // Rebuild argv at the process boundary so consumed pairing codes are never replayed.
    environment.args_os.truncate(1);
    let exit = application.run_return(|_, _| {});
    if exit == RESTART {
        if let Ok(mut link) = handle.state::<ShellState>().restart_link.lock() {
            if let Some(link) = link.take() { environment.args_os.push(link.into()); }
        }
        tauri::process::restart(&environment);
    }
    std::process::exit(exit);
}
