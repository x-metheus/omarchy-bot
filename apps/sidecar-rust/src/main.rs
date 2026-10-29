use futures_util::{SinkExt, StreamExt};
use omarchy_bot_sidecar::{
    handler::{emit, Handler},
    protocol::{valid_device, Capability, ClientFrame, DecisionLine, Os, ServerFrame, Shell},
};
use std::{
    env,
    io::{self, BufRead},
    path::PathBuf,
    time::Duration,
};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async_tls_with_config, tungstenite::Message, Connector};
use url::Url;

fn required(name: &str) -> Result<String, String> {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{name} is required"))
}
fn tls() -> Result<Connector, String> {
    // Vendored OpenSSL keeps Linux self-contained and accepts the same private CAs as Bun.
    let mut config = native_tls::TlsConnector::builder();
    if let Some(path) = env::var_os("NODE_EXTRA_CA_CERTS").filter(|p| !p.is_empty()) {
        let file = std::fs::File::open(path)
            .map_err(|_| "NODE_EXTRA_CA_CERTS could not be read".to_string())?;
        for certificate in rustls_pemfile::certs(&mut io::BufReader::new(file)) {
            let certificate =
                certificate.map_err(|_| "NODE_EXTRA_CA_CERTS contains invalid PEM".to_string())?;
            config.add_root_certificate(
                native_tls::Certificate::from_der(certificate.as_ref()).map_err(|_| {
                    "NODE_EXTRA_CA_CERTS contains an invalid certificate".to_string()
                })?,
            );
        }
    }
    config
        .build()
        .map(Connector::NativeTls)
        .map_err(|_| "Local Sidecar could not initialize TLS".into())
}
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(windows)]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
async fn main_inner() -> Result<(), String> {
    let service = Url::parse(&required("OMARCHY_BOT_SERVICE_URL")?).map_err(|_| {
        "OMARCHY_BOT_SERVICE_URL must be a ws or wss Service URL without credentials".to_string()
    })?;
    if !matches!(service.scheme(), "ws" | "wss")
        || !service.username().is_empty()
        || service.password().is_some()
    {
        return Err(
            "OMARCHY_BOT_SERVICE_URL must be a ws or wss Service URL without credentials".into(),
        );
    }
    let (os, shell) = match env::consts::OS {
        "linux" => (Os::Linux, Shell::Posix),
        "macos" => (Os::Macos, Shell::Posix),
        "windows" => (Os::Windows, Shell::PowerShell),
        other => {
            return Err(format!(
                "Local Sidecar execution is not supported on {other}"
            ))
        }
    };
    let device_id = required("OMARCHY_BOT_DEVICE_ID")?;
    if !valid_device(&device_id) {
        return Err("OMARCHY_BOT_DEVICE_ID must be a Local Sidecar device identity".into());
    }
    let token = required("OMARCHY_BOT_DEVICE_TOKEN")?;
    let hostname = env::var("OMARCHY_BOT_HOSTNAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_string())
        .unwrap_or_else(|| {
            hostname::get()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
    let root = PathBuf::from(required("OMARCHY_BOT_SIDECAR_ROOT")?);
    let root = if root.is_absolute() {
        root
    } else {
        env::current_dir().map_err(|e| e.to_string())?.join(root)
    };
    let root = omarchy_bot_sidecar::execute::normalize(&root);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let mut channel = service.join("/api/devices").map_err(|e| e.to_string())?;
    channel.set_query(None);
    channel.set_fragment(None);
    channel
        .query_pairs_mut()
        .append_pair("access_token", &token);
    let connector = if channel.scheme() == "wss" {
        Some(tls()?)
    } else {
        None
    };
    let (mut socket, _) = connect_async_tls_with_config(channel.as_str(), None, false, connector)
        .await
        .map_err(|_| "Local Sidecar device channel failed to connect".to_string())?;
    socket
        .send(Message::Text(
            serde_json::to_string(&ClientFrame::Register {
                device_id,
                hostname,
                os,
                shell,
                capabilities: vec![
                    Capability::Shell,
                    Capability::Search,
                    Capability::Files,
                    Capability::Transfer,
                ],
            })
            .map_err(|e| e.to_string())?
            .into(),
        ))
        .await
        .map_err(|_| "Local Sidecar device channel failed to register".to_string())?;
    let (outgoing, mut frames) = mpsc::unbounded_channel();
    let mut handler = Handler::new(root, os, outgoing);
    let (decisions, mut lines) = mpsc::unbounded_channel();
    // A blocking stdin thread must not keep the runtime alive after the Service closes.
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            match line {
                Ok(line) => {
                    if decisions.send(Some(line)).is_err() {
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = decisions.send(None);
    });
    let mut heartbeat = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(10),
        Duration::from_secs(10),
    );
    let shutdown = shutdown_signal();
    tokio::pin!(shutdown);
    let result = loop {
        tokio::select! {
            _ = &mut shutdown => break Ok(()),
            line = lines.recv() => match line {
                Some(Some(line)) => if let Ok(decision) = serde_json::from_str::<DecisionLine>(&line) { if let Err(error) = handler.decide(decision) { break Err(error); } },
                _ => break Ok(()),
            },
            incoming = socket.next() => match incoming {
                Some(Ok(Message::Text(text))) => if let Ok(frame) = serde_json::from_str::<ServerFrame>(&text) { match frame {
                    ServerFrame::Registered { device_id } => emit(serde_json::json!({"type":"registered", "deviceId":device_id})),
                    ServerFrame::Error { error } => emit(serde_json::json!({"type":"error", "error":error})),
                    ServerFrame::Job(job) => handler.job(job),
                    ServerFrame::Cancel { job_id } => handler.cancel(job_id),
                } },
                Some(Ok(Message::Ping(payload))) => { if socket.send(Message::Pong(payload)).await.is_err() { break Ok(()); } },
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break Ok(()),
                _ => {},
            },
            Some(frame) = frames.recv() => {
                if socket.send(Message::Text(serde_json::to_string(&frame).map_err(|e| e.to_string())?.into())).await.is_err() { break Ok(()); }
            },
            _ = heartbeat.tick() => {
                if socket.send(Message::Text("{\"type\":\"heartbeat\"}".into())).await.is_err() { break Ok(()); }
            },
            completed = handler.completed(), if handler.has_running() => if let Err(error) = completed { break Err(error); },
        }
    };
    let cleanup = handler.close().await;
    let _ = socket.close(None).await;
    result.and(cleanup)
}
#[tokio::main]
async fn main() {
    if let Err(error) = main_inner().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
