//! Native consent, execution, and lifetime for the paired desktop connection.

mod executor;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::{Client, Response, StatusCode};
use rig_core::tool::ToolOutput;
use rig_tools::Seen;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};
use tokio::sync::{oneshot, watch};
use tokio::task::JoinSet;
use uuid::Uuid;

use self::executor::Name;
use crate::{Connection, ShellState};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const IDLE_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_EVENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_APPROVAL_BYTES: usize = 4096;
const UNAVAILABLE: &str = "The paired desktop tool connection is unavailable.";

#[derive(Default)]
pub(super) struct DesktopTools {
    running: Mutex<Option<Running>>,
}

struct Running {
    stop: watch::Sender<()>,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl DesktopTools {
    pub(super) fn stop(&self) {
        let running = self
            .running
            .lock()
            .expect("desktop connection lock poisoned")
            .take();
        if let Some(running) = running {
            drop(running.stop);
            let _ = tauri::async_runtime::block_on(running.task);
        }
    }
}

#[derive(Serialize)]
pub(super) struct DesktopSelection {
    session: Uuid,
    name: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum SelectionKind {
    Directory,
    File,
}

#[tauri::command]
pub(super) async fn choose_desktop_path(
    window: WebviewWindow,
    shell: State<'_, ShellState>,
    desktop: State<'_, DesktopTools>,
    kind: SelectionKind,
) -> Result<Option<DesktopSelection>, String> {
    let connection = shell
        .connection
        .as_ref()
        .ok_or("Pair this desktop before choosing a working directory.")?;
    let (pick, selected) = oneshot::channel();
    let picker = window.dialog().file().set_parent(&window);
    let receive = move |path| {
        let _ = pick.send(path);
    };
    match kind {
        SelectionKind::Directory => picker
            .set_title("Choose a desktop working directory")
            .pick_folder(receive),
        SelectionKind::File => picker.set_title("Choose a desktop file").pick_file(receive),
    }
    let Some(path) = selected.await.map_err(|_| "The desktop picker closed.")? else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .ok()
        .and_then(|path| path.canonicalize().ok())
        .ok_or("The selected desktop path is unavailable.")?;
    let (directory, file) = match kind {
        SelectionKind::Directory if path.is_dir() => (path.as_path(), None),
        SelectionKind::File if path.is_file() => (
            path.parent()
                .ok_or("The selected desktop file has no parent directory.")?,
            Some(
                path.file_name()
                    .and_then(|name| name.to_str())
                    .ok_or("The selected file needs a UTF-8 name.")?,
            ),
        ),
        _ => return Err("The selected desktop path is unavailable.".into()),
    };
    let (peer, events) = Peer::connect(connection, file).await?;
    let selection = DesktopSelection {
        session: peer.ready.session,
        name: file.map(str::to_owned).unwrap_or_else(|| {
            directory
                .file_name()
                .unwrap_or(directory.as_os_str())
                .to_string_lossy()
                .into_owned()
        }),
    };
    let (stop, stopped) = watch::channel(());
    let task = tauri::async_runtime::spawn(peer.run(
        events,
        directory.into(),
        file.map(Arc::from),
        window.app_handle().clone(),
        stopped,
    ));
    let previous = desktop
        .running
        .lock()
        .expect("desktop connection lock poisoned")
        .replace(Running { stop, task });
    if let Some(previous) = previous {
        drop(previous.stop);
        let _ = previous.task.await;
    }
    Ok(Some(selection))
}

#[derive(Deserialize)]
struct Ready {
    device: Uuid,
    session: Uuid,
}

#[derive(Deserialize)]
struct Request {
    id: Uuid,
    name: Name,
    arguments: Value,
}

#[derive(Deserialize)]
struct Cancel {
    id: Uuid,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum Execution {
    Completed { output: ToolOutput },
    Denied,
    Failed { message: String },
}

struct Peer {
    client: Client,
    url: String,
    connection: Connection,
    ready: Ready,
    approval: Arc<tokio::sync::Mutex<()>>,
}

impl Peer {
    async fn connect(
        connection: &Connection,
        file: Option<&str>,
    ) -> Result<(Self, Events), String> {
        let client = client().map_err(|_| UNAVAILABLE)?;
        let url = format!("{}/api/desktop-tools", connection.base_url);
        let (ready, events) = tokio::time::timeout(CONNECT_TIMEOUT, async {
            let mut endpoint = url::Url::parse(&url).ok()?;
            if let Some(file) = file {
                endpoint.query_pairs_mut().append_pair("file", file);
            }
            let response = client
                .get(endpoint)
                .bearer_auth(&connection.token)
                .send()
                .await
                .ok()?
                .error_for_status()
                .ok()?;
            let mut events = Events {
                response,
                buffer: Vec::new(),
            };
            let (name, data) = events.next().await?;
            if name != "ready" {
                return None;
            }
            Some((serde_json::from_str::<Ready>(&data).ok()?, events))
        })
        .await
        .ok()
        .flatten()
        .ok_or(UNAVAILABLE)?;
        let url = format!("{url}/{}", ready.session);
        Ok((
            Self {
                client,
                url,
                connection: connection.clone(),
                ready,
                approval: Arc::default(),
            },
            events,
        ))
    }

    async fn run(
        self,
        mut events: Events,
        directory: Arc<Path>,
        file: Option<Arc<str>>,
        app: AppHandle,
        mut stopped: watch::Receiver<()>,
    ) {
        let peer = Arc::new(self);
        let mut jobs = JoinSet::new();
        let mut requests: HashMap<_, tokio::task::AbortHandle> = HashMap::new();
        let seen = Seen::default();
        loop {
            tokio::select! {
                biased;
                _ = stopped.changed() => break,
                result = jobs.join_next_with_id(), if !jobs.is_empty() => {
                    let Some(result) = result else { break; };
                    let id = match result {
                        Ok((id, true)) => id,
                        Ok((_, false)) => break,
                        Err(error) if error.is_cancelled() => error.id(),
                        Err(_) => break,
                    };
                    requests.retain(|_, job| job.id() != id);
                }
                event = tokio::time::timeout(IDLE_TIMEOUT, events.next()) => {
                    let Ok(Some((name, data))) = event else { break; };
                    match name.as_str() {
                        "request" => {
                            let Ok(request) = serde_json::from_str::<Request>(&data) else { break; };
                            if requests.contains_key(&request.id) || requests.len() >= 16 { break; }
                            let id = request.id;
                            let (peer, directory, file, app, seen) = (peer.clone(), directory.clone(), file.clone(), app.clone(), seen.clone());
                            let job = jobs.spawn(async move {
                                let result = peer.execute(request, directory, file.as_deref(), app, seen).await;
                                peer.client.post(format!("{}/{id}", peer.url))
                                    .bearer_auth(&peer.connection.token).timeout(CONNECT_TIMEOUT).json(&result).send().await
                                    .is_ok_and(|response| matches!(response.status(), StatusCode::NO_CONTENT | StatusCode::NOT_FOUND))
                            });
                            requests.insert(id, job);
                        }
                        "cancel" => {
                            let Ok(Cancel { id }) = serde_json::from_str(&data) else { break; };
                            if let Some(job) = requests.remove(&id) { job.abort(); }
                        }
                        "keepalive" => {}
                        _ => break,
                    }
                }
            }
        }
        jobs.shutdown().await;
        drop(events);
        let _ = peer
            .client
            .delete(&peer.url)
            .bearer_auth(&peer.connection.token)
            .timeout(CONNECT_TIMEOUT)
            .send()
            .await;
    }

    async fn execute(
        &self,
        request: Request,
        directory: Arc<Path>,
        file: Option<&str>,
        app: AppHandle,
        seen: Seen,
    ) -> Execution {
        let failed = |message: &str| Execution::Failed {
            message: message.into(),
        };
        let operation = match request.name.decode(&request.arguments, file) {
            Ok(operation) => operation,
            Err(error) => return failed(error),
        };
        let arguments =
            serde_json::to_string_pretty(&request.arguments).expect("serialize tool arguments");
        if arguments.len() > MAX_APPROVAL_BYTES {
            return failed(
                "The desktop tool arguments are too long to review. Request a smaller operation.",
            );
        }
        let dialog = format!(
            "Paired device: {}\nAgent Daemon: {}\nWorking directory: {:?}\n\n{}\n{}{}",
            self.ready.device,
            self.connection.base_url,
            directory,
            request.name.label(),
            arguments,
            if matches!(request.name, Name::Shell) {
                "\n\nThe command runs with your desktop account’s permissions."
            } else {
                ""
            },
        );
        let gate = self.approval.clone().lock_owned().await;
        let Some(window) = app.get_webview_window("main") else {
            return Execution::Denied;
        };
        let (decision, approved) = oneshot::channel();
        window
            .dialog()
            .message(dialog)
            .parent(&window)
            .title("Approve desktop tool")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Allow once".into(),
                "Deny".into(),
            ))
            .show_with_result(move |choice| {
                let _gate = gate;
                let _ = decision.send(choice == MessageDialogResult::Custom("Allow once".into()));
            });
        if approved.await != Ok(true) {
            return Execution::Denied;
        }
        let accepted = self
            .client
            .post(format!("{}/{}/authorize", self.url, request.id))
            .bearer_auth(&self.connection.token)
            .timeout(CONNECT_TIMEOUT)
            .send()
            .await;
        if !accepted.is_ok_and(|response| response.status() == StatusCode::NO_CONTENT) {
            return failed(UNAVAILABLE);
        }
        match operation.execute(directory, seen).await {
            Ok(output) => Execution::Completed { output },
            Err(error) => failed(&error.to_string()),
        }
    }
}

struct Events {
    response: Response,
    buffer: Vec<u8>,
}

impl Events {
    async fn next(&mut self) -> Option<(String, String)> {
        loop {
            if let Some(end) = self.buffer.windows(2).position(|bytes| bytes == b"\n\n") {
                let frame: Vec<_> = self.buffer.drain(..end + 2).collect();
                let frame = std::str::from_utf8(&frame).ok()?;
                if frame.starts_with(':') {
                    return Some(("keepalive".into(), String::new()));
                }
                let name = frame
                    .lines()
                    .find_map(|line| line.strip_prefix("event: "))?;
                let data = frame.lines().find_map(|line| line.strip_prefix("data: "))?;
                return Some((name.into(), data.into()));
            }
            let chunk = self.response.chunk().await.ok()??;
            if self.buffer.len() + chunk.len() > MAX_EVENT_BYTES {
                return None;
            }
            self.buffer.extend_from_slice(&chunk);
        }
    }
}

fn client() -> Result<Client, Box<dyn std::error::Error + Send + Sync>> {
    let mut roots = rustls::RootCertStore::empty();
    roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(Client::builder()
        .tls_backend_preconfigured(tls)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .build()?)
}
