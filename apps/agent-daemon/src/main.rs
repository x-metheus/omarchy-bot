mod agent;
mod api;
mod attachments;
mod desktop_tools;
mod duties;
mod host_tools;
mod logging;
mod recall;
mod recall_assets;
mod settings;
mod store;
mod user_memory;

use std::env;
use std::net::{Ipv4Addr, SocketAddrV4};
use std::path::PathBuf;

use anyhow::Result;
use rig_harness::AppExit;
use rig_harness::prelude::Wake;
use tokio::net::TcpListener;
use tokio::runtime::Runtime;
use tokio::sync::mpsc;

use crate::store::Store;

fn main() -> AppExit {
    logging::init();
    tracing::info!(pid = std::process::id(), "Agent Daemon startup");
    match run() {
        Ok(exit) => exit,
        Err(error_code) => {
            tracing::error!(error_code, "Agent Daemon startup failed");
            AppExit::error()
        }
    }
}

fn run() -> Result<AppExit, &'static str> {
    let mut args = env::args_os().skip(1);
    if let Some(command) = args.next() {
        let download = match command.to_str() {
            Some("--prepare-recall-model") => true,
            Some("--verify-recall-model") => false,
            _ => return Err("unknown_argument"),
        };
        let directory = args.next().ok_or("missing_recall_model_directory")?;
        if args.next().is_some() {
            return Err("unexpected_recall_argument");
        }
        let runtime = Runtime::new().map_err(|_| "recall_runtime_failed")?;
        runtime
            .block_on(recall::prepare_model(PathBuf::from(directory), download))
            .map_err(|reason| {
                tracing::error!(?reason, "Recall model preparation failed");
                "recall_model_preparation_failed"
            })?;
        println!("Verified Recall model and CPU inference");
        return Ok(AppExit::Success);
    }
    let path = env::var_os("OMARCHY_AGENT_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("agent-daemon.sqlite3"));
    let port = env_or("OMARCHY_AGENT_PORT", "8765")
        .map_err(|_| "invalid_http_port")?
        .parse()
        .map_err(|_| "invalid_http_port")?;
    let settings_token = settings::load_token().map_err(|_| "settings_token_load_failed")?;
    let workspace = host_tools::WorkspaceRoot::from_env().map_err(|_| "workspace_load_failed")?;
    if workspace.is_some() && settings_token.is_none() {
        return Err("workspace_requires_settings_token");
    }
    let store = Store::open(&path).map_err(|_| "database_open_failed")?;

    let runtime = Runtime::new().map_err(|_| "http_runtime_failed")?;
    let model = recall_assets::location(&path);
    let recall = recall::Recall::start(runtime.handle(), model, store.clone());
    let scratch = tempfile::tempdir().map_err(|_| "scratch_directory_failed")?;
    let (turns, pending) = mpsc::unbounded_channel();
    let (conversations, commands) = mpsc::unbounded_channel();
    let mut app = agent::headless_app(
        pending,
        conversations.clone(),
        runtime.handle().clone(),
        scratch.path(),
        &store,
    );
    app.insert_resource(recall.clone());
    recall::register(&mut app);
    let desktops = desktop_tools::Desktops::default();
    if settings_token.is_some() {
        host_tools::register(&mut app, workspace);
        desktop_tools::install(&mut app, desktops.clone());
    }
    let router = api::router(
        store.clone(),
        conversations,
        settings_token,
        recall.clone(),
        desktops,
    );
    let conversation_loop = runtime.spawn(api::run_conversations(
        store,
        turns,
        app.world().resource::<Wake>().clone(),
        commands,
        recall,
    ));
    let listener = runtime
        .block_on(TcpListener::bind(SocketAddrV4::new(
            Ipv4Addr::LOCALHOST,
            port,
        )))
        .map_err(|_| "http_bind_failed")?;
    let address = listener.local_addr().map_err(|_| "http_address_failed")?;
    tracing::info!(port = address.port(), "Agent Daemon ready");
    let http = runtime.spawn(async move {
        if axum::serve(listener, router).await.is_err() {
            tracing::error!(
                error_code = "http_serve_failed",
                "Agent Daemon HTTP server failed"
            );
        }
    });
    println!("LISTENING http://{address}");
    let exit = app.run();
    http.abort();
    conversation_loop.abort();
    tracing::info!(?exit, "Agent Daemon exit");
    Ok(exit)
}

fn env_or(name: &str, default: &str) -> Result<String> {
    match env::var(name) {
        Ok(value) => Ok(value),
        Err(env::VarError::NotPresent) => Ok(default.to_owned()),
        Err(env::VarError::NotUnicode(_)) => anyhow::bail!("{name} must be valid UTF-8"),
    }
}
