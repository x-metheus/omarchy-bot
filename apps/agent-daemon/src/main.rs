mod agent;
mod api;
mod attachments;
mod desktop_tools;
mod duties;
mod host_tools;
mod recall;
mod recall_assets;
mod settings;
mod store;
mod user_memory;

use std::env;
use std::net::{Ipv4Addr, SocketAddrV4};
use std::path::PathBuf;

use anyhow::{Context, Result};
use rig_harness::AppExit;
use rig_harness::prelude::Wake;
use tokio::net::TcpListener;
use tokio::runtime::Runtime;
use tokio::sync::mpsc;

use crate::store::Store;

fn main() -> Result<AppExit> {
    let mut args = env::args_os().skip(1);
    if let Some(command) = args.next() {
        let download = match command.to_str() {
            Some("--prepare-recall-model") => true,
            Some("--verify-recall-model") => false,
            _ => anyhow::bail!("unknown daemon argument"),
        };
        let directory = args.next().context("provide the Recall model directory")?;
        anyhow::ensure!(args.next().is_none(), "expected one Recall model directory");
        let runtime = Runtime::new().context("start Recall preparation runtime")?;
        runtime
            .block_on(recall::prepare_model(PathBuf::from(directory), download))
            .map_err(|reason| anyhow::anyhow!("Recall model preparation failed: {reason:?}"))?;
        println!("Verified Recall model and CPU inference");
        return Ok(AppExit::Success);
    }
    let path = env::var_os("OMARCHY_AGENT_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("agent-daemon.sqlite3"));
    let port = env_or("OMARCHY_AGENT_PORT", "8765")?
        .parse()
        .context("OMARCHY_AGENT_PORT must be a TCP port")?;
    let settings_token = settings::load_token()?;
    let workspace = host_tools::WorkspaceRoot::from_env()?;
    if workspace.is_some() && settings_token.is_none() {
        anyhow::bail!("OMARCHY_AGENT_WORK_DIR requires OMARCHY_AGENT_SETTINGS_TOKEN_FILE");
    }
    let store = Store::open(&path)?;

    let runtime = Runtime::new().context("start HTTP runtime")?;
    let model = recall_assets::location(&path);
    let recall = recall::Recall::start(runtime.handle(), model, store.clone());
    let scratch = tempfile::tempdir().context("create private Rig scratch directory")?;
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
        .context("bind Agent Daemon HTTP listener")?;
    let address = listener.local_addr()?;
    let http = runtime.spawn(async move { axum::serve(listener, router).await });
    println!("LISTENING http://{address}");
    let exit = app.run();
    http.abort();
    conversation_loop.abort();
    Ok(exit)
}

fn env_or(name: &str, default: &str) -> Result<String> {
    match env::var(name) {
        Ok(value) => Ok(value),
        Err(env::VarError::NotPresent) => Ok(default.to_owned()),
        Err(env::VarError::NotUnicode(_)) => anyhow::bail!("{name} must be valid UTF-8"),
    }
}
