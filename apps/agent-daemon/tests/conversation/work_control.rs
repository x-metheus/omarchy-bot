#[path = "work_control_live.rs"]
mod live;

use super::{
    Daemon, Provider, ProviderCall, ReplyStream, bot_id, chat_reply, http_client, transcript,
};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::time::timeout;

const PRIMARY: &str = "Look up parcel Alder in the north depot.";
const INDEPENDENT: &str = "Check the count for parcel Birch.";

fn task(title: &str, prompt: &str) -> Value {
    json!({"description": title, "prompt": prompt})
}

async fn pair(provider: &mut Provider) -> (ProviderCall, ProviderCall, ProviderCall) {
    provider
        .next()
        .await
        .tools(&[
            ("alder", "task", task("Locate parcel Alder", PRIMARY)),
            ("birch", "task", task("Count parcel Birch", INDEPENDENT)),
        ])
        .await;
    let (mut root, mut primary, mut independent) = (None, None, None);
    for _ in 0..3 {
        let call = provider.next().await;
        let last = call.last_message();
        let slot = if last["role"] == "tool" {
            &mut root
        } else if last.to_string().contains(PRIMARY) {
            &mut primary
        } else {
            assert!(last.to_string().contains(INDEPENDENT), "{last}");
            &mut independent
        };
        assert!(slot.replace(call).is_none(), "duplicate fixture call");
    }
    (root.unwrap(), primary.unwrap(), independent.unwrap())
}

fn task_id<'a>(call: &'a ProviderCall, title: &str) -> &'a str {
    call.chat_messages()
        .iter()
        .filter(|m| m["role"] == "tool")
        .filter_map(|m| m["content"].as_str())
        .find(|text| text.contains(title))
        .and_then(|text| text.split('`').nth(1))
        .expect("Rig returned the delegated task ID")
}

async fn lookup(provider: &mut Provider, call: ProviderCall, prompt: &str) -> ProviderCall {
    call.tools(&[("lookup", "task", task("Read parcel label", prompt))])
        .await;
    let one = provider.next().await;
    let two = provider.next().await;
    let (continued, reader) = if one.last_message()["role"] == "tool" {
        (one, two)
    } else {
        (two, one)
    };
    assert!(reader.last_message().to_string().contains(prompt));
    let args = json!({"agent": continued.started_agent()});
    continued.tools(&[("hold", "wait", args)]).await;
    reader
}

async fn reply(call: ProviderCall, text: &str) {
    call.text(text).await;
    call.finish().await;
}

async fn wait_for_reply(daemon: &Daemon, client: &reqwest::Client, bot: &str, text: &str) -> Value {
    timeout(super::DEADLINE, async {
        loop {
            let history = daemon.read(client, bot).await;
            if transcript(&history).contains(&("assistant", text)) {
                return history;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("detached report committed in the original Conversation")
}

#[tokio::test]
async fn a_correction_updates_one_lookup_when_the_obsolete_result_returns_late() {
    const START: &str = "Locate Alder in the north depot and count Birch.";
    const CORRECTION: &str = "Look for Alder in the south depot instead.";
    const OBSOLETE: &str = "North depot label: GRN-807";
    const CURRENT: &str = "South depot label: BLU-159";
    const BIRCH: &str = "Birch count: 12";
    const FINAL: &str = "Alder is BLU-159 in the south depot. Birch count is 12.";
    let mut provider = Provider::start().await;
    let directory = tempfile::tempdir().unwrap();
    let client = http_client();
    let daemon = Daemon::start(&directory.path().join("conversation.sqlite3"), &provider).await;
    let bot = daemon.create(&client).await;
    let id = bot_id(&bot);
    let mut started = ReplyStream::new(daemon.send(&client, id, START).await);
    let (root, alder, birch) = pair(&mut provider).await;
    let alder_id = task_id(&root, "Locate parcel Alder").to_owned();
    let old_lookup = lookup(&mut provider, alder, "Read Alder in the north depot.").await;
    chat_reply(root, &mut started, "Both checks are underway.").await;

    let mut correction = ReplyStream::new(daemon.send(&client, id, CORRECTION).await);
    let call = provider.next().await;
    assert_eq!(call.last_message()["content"], CORRECTION);
    call.tools(&[(
        "redirect",
        "message",
        json!({"agent": alder_id, "text": CORRECTION}),
    )])
    .await;
    let root = provider.next().await;
    assert!(
        root.last_message()
            .to_string()
            .contains("with its next step")
    );
    chat_reply(root, &mut correction, "Alder now uses the south depot.").await;

    reply(birch, BIRCH).await;
    let root = provider.next().await;
    let birch_report = root.last_message().to_string();
    assert!(birch_report.contains(BIRCH), "{birch_report}");
    reply(root, BIRCH).await;

    reply(old_lookup, OBSOLETE).await;
    let alder = provider.next().await;
    let history = alder.body["messages"].to_string();
    assert!(
        history.contains(PRIMARY),
        "Alder owns the continuation: {history}"
    );
    assert!(
        !history.contains(INDEPENDENT),
        "Birch receives no correction: {history}"
    );
    let corrected_at = history.find(CORRECTION).unwrap_or_else(|| {
        panic!("the running Alder Subagent must receive the correction: {history}")
    });
    let old_at = history.find(OBSOLETE).unwrap_or_else(|| {
        panic!("the obsolete lookup must still return to its Subagent: {history}")
    });
    assert!(
        corrected_at < old_at,
        "the obsolete result arrived after the correction"
    );
    let new_lookup = lookup(&mut provider, alder, "Read Alder in the south depot.").await;
    reply(new_lookup, CURRENT).await;
    let alder = provider.next().await;
    assert!(alder.last_message().to_string().contains(CURRENT));
    reply(alder, CURRENT).await;
    let root = provider.next().await;
    assert!(root.last_message().to_string().contains(CURRENT));
    let history = root.body["messages"].to_string();
    assert!(history.contains(BIRCH));
    assert!(!history.contains(OBSOLETE));
    reply(root, FINAL).await;

    let history = wait_for_reply(&daemon, &client, id, FINAL).await;
    assert!(
        transcript(&history)
            .iter()
            .all(|(_, text)| !text.contains("GRN-807"))
    );
    daemon.stop().await;
}

#[tokio::test]
async fn progress_and_ambiguity_preserve_work_until_a_targeted_cancel() {
    const PROGRESS: &str = "How are the parcel checks going?";
    const CANCEL: &str = "Cancel the Alder lookup and keep the Birch count going.";
    const FINAL: &str = "The Birch count is 12.";
    let mut provider = Provider::start().await;
    let directory = tempfile::tempdir().unwrap();
    let client = http_client();
    let daemon = Daemon::start(&directory.path().join("conversation.sqlite3"), &provider).await;
    let bot = daemon.create(&client).await;
    let id = bot_id(&bot);
    let mut started = ReplyStream::new(daemon.send(&client, id, "Check Alder and Birch.").await);
    let (root, alder, birch) = pair(&mut provider).await;
    let alder_id = task_id(&root, "Locate parcel Alder").to_owned();
    let birch_id = task_id(&root, "Count parcel Birch").to_owned();
    let alder_lookup = lookup(&mut provider, alder, "Read the Alder label.").await;
    chat_reply(root, &mut started, "Both checks are underway.").await;

    let mut progress = ReplyStream::new(daemon.send(&client, id, PROGRESS).await);
    let root = provider.next().await;
    assert_eq!(root.last_message()["content"], PROGRESS);
    root.tools(&[("status", "work_status", json!({}))]).await;
    let root = provider.next().await;
    let active = root.last_message()["content"].as_str().unwrap();
    let work: Value = serde_json::from_str(active).expect("the Agent receives both live statuses");
    assert_eq!(work.as_array().unwrap().len(), 2);
    for (id, title) in [
        (&alder_id, "Locate parcel Alder"),
        (&birch_id, "Count parcel Birch"),
    ] {
        assert!(
            work.as_array().unwrap().iter().any(|item| {
                item["agent"].as_str().unwrap().starts_with(id)
                    && item["title"] == title
                    && item["state"] == "running"
            }),
            "missing live status for {title}: {work}"
        );
    }
    chat_reply(root, &mut progress, "Alder and Birch are both in progress.").await;

    for (ambiguous, question) in [
        (
            "Use Tuesday's record for that check.",
            "Which check should use Tuesday's record, Alder or Birch?",
        ),
        (
            "Cancel that check.",
            "Which check should I cancel, Alder or Birch?",
        ),
    ] {
        let mut stream = ReplyStream::new(daemon.send(&client, id, ambiguous).await);
        let root = provider.next().await;
        assert_eq!(root.last_message()["content"], ambiguous);
        chat_reply(root, &mut stream, question).await;
        assert!(
            !alder_lookup.frames.is_closed(),
            "Alder is still in progress"
        );
        assert!(!birch.frames.is_closed(), "Birch is still in progress");
    }

    let mut cancel = ReplyStream::new(daemon.send(&client, id, CANCEL).await);
    let root = provider.next().await;
    assert_eq!(root.last_message()["content"], CANCEL);
    root.tools(&[(
        "stop",
        "stop_work",
        json!({"agent": alder_id, "evidence": CANCEL}),
    )])
    .await;
    let root = provider.next().await;
    assert!(
        root.body["messages"]
            .to_string()
            .contains("Stop requested for Locate parcel Alder")
    );
    timeout(super::DEADLINE, alder_lookup.frames.closed())
        .await
        .expect("Rig closed the cancelled lookup's in-flight model stream");
    assert!(
        !birch.frames.is_closed(),
        "the independent lookup is still running"
    );
    chat_reply(
        root,
        &mut cancel,
        "I stopped Alder. Birch is still running.",
    )
    .await;

    reply(birch, "Birch tally: 12.").await;
    let root = provider.next().await;
    assert!(root.last_message().to_string().contains("Birch tally: 12."));
    reply(root, FINAL).await;
    wait_for_reply(&daemon, &client, id, FINAL).await;
    daemon.stop().await;
}
