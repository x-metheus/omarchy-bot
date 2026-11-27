pub(crate) mod conversation;
mod observational_memory;

pub(crate) use conversation::{AgentCommand, ReplySink, TurnRequest};

use std::path::Path;

use bevy_log::LogPlugin;
use rig_basics::subagents::SubagentsPlugin;
use rig_core::catalog::{Catalog, Connector};
use rig_ecs::retry::RetryPolicy;
use rig_harness::host::launcher::LauncherPlugin;
use rig_harness::host::session::SessionPlugin;
use rig_harness::prelude::*;
use tokio::runtime::Handle;
use tokio::sync::mpsc;

use crate::api::ConversationCommand;
use crate::duties;
use crate::store::Store;
use crate::user_memory;

pub(crate) fn headless_app(
    pending: mpsc::UnboundedReceiver<AgentCommand>,
    conversations: mpsc::UnboundedSender<ConversationCommand>,
    runtime: Handle,
    scratch: &Path,
    store: &Store,
) -> App {
    // Provider diagnostics can include raw response bodies. Keep them inside Rig.

    let mut app = App::new();
    app.insert_resource(TokioRuntime(runtime))
        .insert_resource(RigHome(Home::at(scratch)))
        .add_plugins((
            HeadlessPlugins.build().disable::<LogPlugin>(),
            RigHarnessPlugins
                .build()
                .disable::<LauncherPlugin>()
                .disable::<SessionPlugin>(),
        ))
        // A provider retry could stream a second attempt after deltas from the first.
        .insert_resource(RetryPolicy {
            max_retries: 0,
            ..RetryPolicy::default()
        })
        // Subagents inherit the parent's BYOK connection. There is no second catalog login.
        .insert_resource(Models(Connector::new(Catalog::default())));
    rig_harness::load::<SubagentsPlugin>(&mut app, "rig-basics", "");
    conversation::add(&mut app, pending, conversations);
    user_memory::install(&mut app, store);
    observational_memory::install(&mut app, store);
    duties::register(&mut app);
    app
}
