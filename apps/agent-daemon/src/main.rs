mod agent;
mod api;
mod attachments;
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
    let path = env::var_os("OMARCHY_AGENT_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("agent-daemon.sqlite3"));
    let port = env_or("OMARCHY_AGENT_PORT", "8765")?
        .parse()
        .context("OMARCHY_AGENT_PORT must be a TCP port")?;
    let settings_token = settings::load_token()?;
    let store = Store::open(&path)?;

    let runtime = Runtime::new().context("start HTTP runtime")?;
    let scratch = tempfile::tempdir().context("create private Rig scratch directory")?;
    let (turns, pending) = mpsc::unbounded_channel();
    let mut app = agent::headless_app(pending, runtime.handle().clone(), scratch.path(), &store);
    let router = api::router(
        store,
        turns,
        app.world().resource::<Wake>().clone(),
        settings_token,
    );
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
    Ok(exit)
}

fn env_or(name: &str, default: &str) -> Result<String> {
    match env::var(name) {
        Ok(value) => Ok(value),
        Err(env::VarError::NotPresent) => Ok(default.to_owned()),
        Err(env::VarError::NotUnicode(_)) => anyhow::bail!("{name} must be valid UTF-8"),
    }
}
