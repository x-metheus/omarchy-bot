use crate::{
    execute,
    protocol::{truncate, Action, ClientFrame, Decision, DecisionLine, Job, Os},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
};
use tokio::{
    sync::{mpsc, watch},
    task::JoinSet,
};

#[derive(Default, Deserialize, Serialize)]
struct Policy {
    #[serde(default)]
    always: Vec<String>,
    #[serde(default)]
    never: Vec<String>,
}
struct Pending {
    job: Job,
    cancel: watch::Sender<bool>,
    asking: bool,
    prompted: bool,
}
pub struct Handler {
    root: PathBuf,
    os: Os,
    policy: Policy,
    pending: HashMap<String, Pending>,
    asks: Vec<String>,
    cancelled: HashSet<String>,
    running: JoinSet<(String, execute::Result)>,
    outgoing: mpsc::UnboundedSender<ClientFrame>,
}
pub fn emit(value: serde_json::Value) {
    use std::io::Write;
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{value}");
    let _ = stdout.flush();
}
impl Handler {
    pub fn new(root: PathBuf, os: Os, outgoing: mpsc::UnboundedSender<ClientFrame>) -> Self {
        let policy = std::fs::read(root.join(".omarchy-bot-local-policy.json"))
            .ok()
            .and_then(|data| serde_json::from_slice(&data).ok())
            .unwrap_or_default();
        Self {
            root,
            os,
            policy,
            pending: HashMap::new(),
            asks: Vec::new(),
            cancelled: HashSet::new(),
            running: JoinSet::new(),
            outgoing,
        }
    }
    fn deny(&self, id: String, error: &str) {
        let _ = self.outgoing.send(ClientFrame::Result {
            job_id: id,
            ok: false,
            text: None,
            error: Some(truncate(error, 2048)),
            exit_code: None,
        });
    }
    fn run(&mut self, id: &str) {
        let pending = self.pending.get_mut(id).unwrap();
        pending.asking = false;
        let job = pending.job.clone();
        let root = self.root.clone();
        let os = self.os;
        let cancel = pending.cancel.subscribe();
        self.running.spawn(async move {
            let id = job.job_id.clone();
            (id, execute::execute(job, root, os, cancel).await)
        });
    }
    pub fn job(&mut self, job: Job) {
        if self.cancelled.contains(&job.job_id) || self.pending.contains_key(&job.job_id) {
            return;
        }
        if job.action == Action::Search
            && (job.query.as_deref() == Some("/") || job.path.as_deref() == Some("/"))
        {
            self.deny(job.job_id, "Local Sidecar search cannot scan /");
            return;
        }
        let rule = job.rule();
        if self.policy.never.contains(&rule) {
            self.deny(job.job_id, "Local Sidecar Never allowed this work");
            return;
        }
        let id = job.job_id.clone();
        let remembered = self.policy.always.contains(&rule);
        let (cancel, _) = watch::channel(false);
        if !remembered {
            let mut ask =
                json!({"type":"ask","jobId":id,"hostname":job.hostname,"action":job.action});
            for (key, value) in [
                ("command", &job.command),
                ("path", &job.path),
                ("destination", &job.destination),
                ("query", &job.query),
            ] {
                if let Some(value) = value {
                    ask[key] = json!(value);
                }
            }
            self.asks.push(id.clone());
            emit(ask);
        }
        self.pending.insert(
            id.clone(),
            Pending {
                job,
                cancel,
                asking: !remembered,
                prompted: !remembered,
            },
        );
        if remembered {
            self.run(&id);
        }
    }
    pub fn decide(&mut self, line: DecisionLine) -> std::result::Result<(), String> {
        let Some(id) = line.job_id.or_else(|| self.asks.last().cloned()) else {
            return Ok(());
        };
        let Some(pending) = self.pending.get(&id).filter(|entry| entry.asking) else {
            return Ok(());
        };
        let rule = pending.job.rule();
        self.asks.retain(|entry| entry != &id);
        if line.decision == Decision::Always || line.decision == Decision::Never {
            let rules = if line.decision == Decision::Always {
                &mut self.policy.always
            } else {
                &mut self.policy.never
            };
            if !rules.contains(&rule) {
                rules.push(rule);
            }
            std::fs::write(
                self.root.join(".omarchy-bot-local-policy.json"),
                serde_json::to_vec(&self.policy).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        }
        match line.decision {
            Decision::Deny | Decision::Never => {
                self.pending.remove(&id);
                self.deny(
                    id,
                    if line.decision == Decision::Never {
                        "Local Sidecar Never allowed this work"
                    } else {
                        "Local Sidecar denied this work"
                    },
                );
            }
            Decision::AllowOnce | Decision::Always => self.run(&id),
        }
        Ok(())
    }
    pub fn cancel(&mut self, id: String) {
        self.cancelled.insert(id.clone());
        if let Some(pending) = self.pending.remove(&id) {
            pending.cancel.send_replace(true);
            // The TypeScript approver retains its dismissal promise after a decision.
            if pending.prompted {
                emit(json!({"type":"ask.dismiss", "jobId":id}));
            }
        }
        self.asks.retain(|entry| entry != &id);
    }
    pub fn has_running(&self) -> bool {
        !self.running.is_empty()
    }
    pub async fn completed(&mut self) -> std::result::Result<(), String> {
        if let Some(completed) = self.running.join_next().await {
            let (id, result) = completed.map_err(|e| e.to_string())?;
            self.pending.remove(&id);
            if self.cancelled.contains(&id) {
                return Ok(());
            }
            match result {
                Ok(output) => {
                    let _ = self.outgoing.send(ClientFrame::Result {
                        job_id: id,
                        ok: true,
                        text: Some(output.text),
                        error: None,
                        exit_code: output.exit_code,
                    });
                }
                Err(error) => self.deny(id, &error),
            }
        }
        Ok(())
    }
    pub async fn close(&mut self) -> std::result::Result<(), String> {
        for id in self.pending.keys().cloned().collect::<Vec<_>>() {
            self.cancel(id);
        }
        while self.has_running() {
            self.completed().await?;
        }
        Ok(())
    }
}
