//! Keep native Responses history scoped to the connection that produced it.

use std::sync::Arc;
use std::time::Instant;

use futures::StreamExt;
use rig_core::completion::{CompletionResponse, UnsupportedOption};
use rig_core::effect::{Answered, EffectKind, HandlerDescriptor};
use rig_core::message::Message;
use rig_core::operation::Completion;
use rig_core::serve::{Dispatch, Reply, Serve, adapters::ModelAdapter};
use rig_core::streaming::Relayed;
use uuid::Uuid;

pub(super) struct ResponsesHandler {
    model: ModelAdapter<Completion>,
    scope: Arc<str>,
}

impl ResponsesHandler {
    pub(super) fn new(model: ModelAdapter<Completion>, id: Uuid, revision: i64) -> Self {
        Self {
            model,
            scope: format!("custom/{id}/{revision}").into(),
        }
    }
}

impl Serve for ResponsesHandler {
    type Family = <ModelAdapter<Completion> as Serve>::Family;

    fn descriptor(&self) -> HandlerDescriptor {
        self.model.descriptor()
    }

    fn check(&self, kind: &EffectKind) -> Vec<UnsupportedOption> {
        self.model.check(kind)
    }

    async fn serve(&self, mut kind: EffectKind, dispatch: Dispatch) -> Reply {
        let same_connection = |message: &Arc<Message>| {
            matches!(message.as_ref(), Message::Assistant(assistant)
                if assistant.origin.as_ref().is_some_and(|origin| origin.provider == self.scope.as_ref()))
        };
        if let EffectKind::Completion { request, .. } = &mut kind
            && let Some(first) = request.chat_history.iter().position(same_connection)
        {
            // Rig compares the wire's provider name, so re-enable native replay only for this revision.
            for message in &mut Arc::make_mut(request).chat_history[first..] {
                if same_connection(message)
                    && let Message::Assistant(assistant) = Arc::make_mut(message)
                    && let Some(origin) = &mut assistant.origin
                {
                    "openai".clone_into(&mut origin.provider);
                }
            }
        }

        let started = Instant::now();
        match self.model.serve(kind, dispatch).await {
            Reply::Outcome(mut outcome) => {
                match &mut outcome {
                    Ok(Answered::Completion(response)) => finish(response, &self.scope, started),
                    Err(error) => log_failure(error.http_status, started),
                    _ => {}
                }
                Reply::Outcome(outcome)
            }
            Reply::Stream(stream) => {
                let scope = self.scope.clone();
                Reply::Stream(Box::pin(stream.map(move |mut item| {
                    match &mut item {
                        Ok(Relayed::Origin(origin)) => {
                            scope.as_ref().clone_into(&mut origin.provider)
                        }
                        Ok(Relayed::Done(response)) => finish(response, &scope, started),
                        Err(error) => log_failure(error.http_status, started),
                        _ => {}
                    }
                    item
                })))
            }
        }
    }
}

fn finish(response: &mut Arc<CompletionResponse>, scope: &str, started: Instant) {
    if response.error.is_some() {
        log_failure(None, started);
    }
    scope.clone_into(&mut Arc::make_mut(response).origin.provider);
}

fn log_failure(upstream_status: Option<u16>, started: Instant) {
    let code = match upstream_status {
        Some(401 | 403) => "provider_authentication_failed",
        Some(429) => "provider_rate_limited",
        _ => "provider_inference_failed",
    };
    tracing::warn!(
        duration_ms = started.elapsed().as_millis() as u64,
        ?upstream_status,
        code,
        "Provider inference failed"
    );
}
