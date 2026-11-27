# Agent Daemon

The standalone daemon hosts one Rig 0.47.1 root Agent per Bot Conversation. The Bot ID also identifies its single Conversation. The HTTP listener binds to IPv4 loopback. Run one daemon per SQLite file.

## Headless startup

Use Rust 1.97.1. In a POSIX shell, create a private state directory and provision two separate random secrets. Run this block once for a new instance.

```sh
state="$HOME/.local/state/omarchy-agent-daemon"
install -d -m 700 "$state"
(
  umask 077
  set -C
  openssl rand 32 > "$state/master.key" &&
    openssl rand -hex 32 > "$state/settings-token"
)
```

From the repository root, start the daemon. These paths work on restart too. The daemon reads both files at startup.

```sh
state="$HOME/.local/state/omarchy-agent-daemon"
export OMARCHY_AGENT_DB="$state/agent-daemon.sqlite3"
export OMARCHY_AGENT_MASTER_KEY_FILE="$state/master.key"
export OMARCHY_AGENT_SETTINGS_TOKEN_FILE="$state/settings-token"
cd apps/agent-daemon
cargo run --locked
```

The daemon prints its bound address. `OMARCHY_AGENT_PORT` defaults to `8765`. Set it to `0` for an available port and use the printed address. `OMARCHY_AGENT_DB` defaults to `agent-daemon.sqlite3` in the current directory. On startup with no provider credential, the daemon can create Bots and read Conversations. A message POST receives `503 provider_unconfigured` before the user message is committed.

The master key file must contain exactly 32 raw bytes. SQLite stores provider keys as AES-256-GCM ciphertext with a fresh OS-random nonce per write and the provider authenticated as associated data. Keep the database and its matching master key in separate protected backups. Restore both to resume saved Settings. A missing or incorrect key for the saved selection prevents startup. If the master key is permanently lost, stop the daemon and back up SQLite before clearing Settings in a transaction. Run `BEGIN IMMEDIATE; DELETE FROM model_settings; DELETE FROM provider_credentials; COMMIT;` against that database, then provision a new master key and re-enter provider credentials. Conversation history remains available. An independently replaced Settings bearer token takes effect on restart.

## Settings API

`GET /settings` and `PUT /settings` require `Authorization: Bearer <token>` using the operator-provisioned token file. The daemon checks the header before reading a Settings request body. When the token file is omitted, both routes reject requests. An operator can also run without the master key file before saving any Settings. `GET` then reports `writable: false` and `PUT` returns `503 settings_read_only`.

Send `PUT /settings` as JSON with `provider` (`openai` or `anthropic`), `model`, and optional `apiKey`. Supply `apiKey` on first setup and to rotate that provider's credential. Omit it to reuse that provider's stored key. Model IDs must be nonempty and free of surrounding whitespace and control characters. API keys must be nonempty printable ASCII without whitespace. Unknown fields and explicit `null` keys are rejected. The provider validates account credentials and model availability on the next Turn. A syntactically valid key can save successfully and later fail upstream, yielding a sanitized `turn_failed` event.

Both methods return the same status shape. `active` is `null` until configured. Its `source` is `saved` or `environment`. `storedCredentials` indicates which providers have an encrypted credential in the database.

```json
{
  "active": {"provider": "openai", "model": "gpt-4.1-mini", "source": "saved"},
  "storedCredentials": {"openai": true, "anthropic": false},
  "writable": true
}
```

A successful `PUT` commits the selection and any key replacement together. Invalid input or a failed write preserves the prior configuration. Writes and message admission share a lock. An HTTP message starting a Turn uses the model and key captured at admission. Input delivered into a running Turn uses that Turn's connection. A Subagent inherits its parent's connection when spawned, and a report can wake the root using its existing connection. The latest committed write determines the active selection.

| Provider | Default request URL | Operator base URL override |
| --- | --- | --- |
| `openai` | `https://api.openai.com/v1/chat/completions` | `OPENAI_BASE_URL`, including the gateway's `/v1` or equivalent API prefix |
| `anthropic` | `https://api.anthropic.com/v1/messages` | `ANTHROPIC_BASE_URL`, the API root before `/v1/messages` |

Set overrides in the daemon environment before startup. Use a trusted endpoint that implements the selected protocol and use HTTPS for network deployments. Rig supplies Anthropic output limits for known models. The daemon supplies a 1,024-token limit for Messages aliases without a Rig default.

For existing headless deployments, `OPENAI_API_KEY` and `OMARCHY_AGENT_MODEL` optionally bootstrap OpenAI Chat Completions. The default bootstrap model is `gpt-4.1-mini`. A saved selection takes precedence. The environment key stays in the host bootstrap and does not count as a stored Settings credential.

## Live smoke for both protocols

Start the daemon as above with the official endpoints or authorized gateway overrides. In a second terminal, use `curl`, `jq`, and Python 3. The helper prompts for provider keys without echo and sends them directly to loopback. The model names below can be replaced with IDs enabled for your account.

```sh
base=http://127.0.0.1:8765
token_file="$HOME/.local/state/omarchy-agent-daemon/settings-token"

select_provider() {
  python3 - "$base" "$token_file" "$1" "$2" "${3:-}" <<'PY'
import getpass
import json
import sys
import urllib.request
from pathlib import Path

base, token_file, provider, model, rotate = sys.argv[1:]
settings = {"provider": provider, "model": model}
if rotate == "replace":
    settings["apiKey"] = getpass.getpass(f"{provider} API key: ")
request = urllib.request.Request(
    f"{base}/settings", data=json.dumps(settings).encode(), method="PUT",
    headers={"Authorization": "Bearer " + Path(token_file).read_text().rstrip("\r\n"),
             "Content-Type": "application/json"},
)
with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=15) as response:
    print(json.dumps(json.load(response), indent=2))
PY
}

select_provider openai gpt-4.1-mini replace
bot=$(curl -fsS "$base/bots" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke Bot"}' | jq -er .id)
curl -fsSN "$base/bots/$bot/messages" -H 'Content-Type: application/json' \
  -d '{"text":"Remember the word amber. Reply with a short acknowledgment."}'

select_provider anthropic claude-haiku-4-5 replace
curl -fsSN "$base/bots/$bot/messages" -H 'Content-Type: application/json' \
  -d '{"text":"What word did I ask you to remember? Reply with just that word."}'
curl -fsS "$base/bots/$bot" | jq .
```

Expect ordered `delta` events followed by `committed` for both replies. The follow-up should answer `amber`. Restart the daemon with the same database and key files and use the same Bot ID to read its Conversation. Send another follow-up to exercise the restored Anthropic selection. Run `select_provider openai gpt-4.1-mini` to switch back using the stored OpenAI key, or add `replace` to rotate it before the next Turn.

## HTTP behavior

| Request | Response |
| --- | --- |
| `POST /bots` with `{"name":"Lumen"}` | `201` with the new Bot profile and `duties: null` |
| `GET /bots/{id}` | `200` with `bot` and `messages`, oldest first |
| `PATCH /bots/{id}` with `{"name":"Prism"}` | `200` with the renamed Bot profile |
| `POST /bots/{id}/messages` with `{"text":"Hello"}` | `200` with a `text/event-stream` reply |
| `GET /bots/{id}/attachments/{attachmentId}` | `200` with the stored bytes and media type |
| `GET /recall/status` | `200` with independent Recall model availability |

A Bot profile has `id`, `name`, and `duties`. Creating a Bot requires a nonempty name. Rename updates the name on the existing profile. The same ID opens the original Conversation before and after a restart.

Set duties by sending an explicit standing instruction such as “Your ongoing job is to classify new color samples by their shade.” Send a later message to revise those duties. Use a model that supports tool calls. The Agent uses the latest user-authored message text as evidence. The daemon saves the proposed duties and the completed reply in the same transaction, then supplies the saved duties to the model on later Turns.

A successful message POST commits the user message before starting the model call. Each `delta` contains a JSON string. The terminal `committed` event contains the same `{id, role, text}` message returned by `GET` and is sent after the SQLite commit. A failed Turn ends with an `error` event containing `code` and `message`. Any deltas from that Turn are provisional. The committed user message remains in the Conversation.

A Bot accepts new messages while a Turn is running. Rig delivers them through the Inbox at the next model call. A POST stream starts receiving deltas when its input is delivered and closes after that Turn's `committed` or `error` event. When Rig delivers multiple inputs to the same Turn, their POST streams receive the same committed reply ID. A disconnect leaves the Turn running. Use `GET` to read committed history, including replies to background Subagent reports after the POST streams close.

### Rig lifecycle

The daemon restores a Bot's committed Conversation into its root Agent on the first POST after startup. Subsequent POSTs append the user message to SQLite before handing it to the root's Rig Inbox. The Inbox effect carries the Bot and durable user message ID, and Rig provides its `DeliveredAs` and `DeliveredIn` mapping when the message reaches the model. Model calls and the tools they produce carry the eligible source for that invocation. Subagent results enter the root Inbox with Rig's Agent author and are available to the root on its next model call.

`SubagentsPlugin` owns delegation, messaging, and reports. The `task` tool instructs the root to end its Turn after dispatching asynchronous work, leaving it available for new requests. Turn settlement sends one reply to the ordered Conversation writer, which commits before notifying any attached POST streams. A report can start a Turn with no attached POST stream. SQLite preserves committed messages across a daemon restart. Live Rig Inbox entries and Subagents last for the daemon process.

## Observational Memory

As a Bot approaches its selected model's history budget, the daemon starts a separate model request to summarize an older prefix of committed messages. Each Bot has one observation in SQLite with the exact committed message ID it covers. Later requests can include that historical summary with recent original messages. The Conversation returned by `GET /bots/{id}` and the original text available to Recall remain complete.

The daemon uses the pinned Rig catalog's input limits. It estimates space for the prompt, tools and current Turn, and reserves room for the reply. Model aliases without catalog limits use an 8,192-token input estimate. While an observation is pending or after it fails, the Agent can continue with recent history that fits and any previously saved observation. The active Turn, including its tool calls and results, stays intact. The observer uses the selected chat provider and receives committed message text from that Bot as historical data.

## Daemon-host tools

Set `OMARCHY_AGENT_WORK_DIR` to an existing absolute directory to enable `read`, `edit`, `write`, and `shell` on the daemon host. Provision `OMARCHY_AGENT_SETTINGS_TOKEN_FILE` before starting in this mode. Every Bot, Conversation, attachment, and message request then needs `Authorization: Bearer <token>`. The daemon returns `401 conversation_unauthorized` before admitting unauthorized work. Leave `OMARCHY_AGENT_WORK_DIR` unset for ordinary chat without host tools.

`read` returns UTF-8 text or a supported PNG, JPEG, GIF, or WebP image. Images are sent to the selected model when its provider and model support image input. `edit` applies the requested replacements together. `write` creates a file or replaces a text version observed by the calling Agent during the current daemon run. If the file changes after observation, read it again before replacing it. File tools resolve paths within the configured workspace.

`shell` starts in the configured directory or a `cwd` within it. It uses `sh` on Linux and macOS and Windows PowerShell on Windows. It returns stdout and stderr with an exit status or a timeout when `timeout_secs` is reached. Commands run with the permissions of the daemon account. The starting directory limits where a command launches. Commands can access anything the daemon account can access. On Windows a timeout stops PowerShell itself, and a subprocess may continue.

Run `cargo test --locked -j 3 --test conversation host_tools` from `apps/agent-daemon` on each supported host. The tests use a disposable workspace and scripted loopback providers.

Rig's per-call `CallPlace` and `Workspace` are the execution boundary for adding authorized desktop tooling. The HTTP Conversation router is the authentication boundary for paired-device access.

## Shared UserMemory

A Bot can save a fact or standing preference from its current user message. For example, say “Always reply in French,” “My time zone is Europe/Paris,” or “Please call me Áine.” The daemon verifies the proposal against the original committed text and shares the saved value with all Bots on that daemon. Use a direct first-person statement for facts, such as “Remember that my favorite tea is hojicha.” Ambiguous wording requires clarification. Use a model that supports tool calls when saving UserMemory.

Ask any Bot “What do you remember about my units preference?” to inspect the current value. If the source is available, the Bot can cite its Conversation and quote your original statement. Say “Change my units preference to metric” to correct it, or “Forget my units preference” as its own message to clear it for every Bot. The original Conversation messages remain readable. A later explicit statement can establish the preference again.

Each model request receives the current reply language, time zone, and preferred name when available. Other entries are selected by matching words from the current request against the entry's topic, with a limit of six. A current instruction such as “Reply in English this time” takes precedence for that request. Request context and tool traces do not become Conversation messages.

### Storage and provenance contract

`user_memory` holds one current value per key. Recurring keys are `preferences.reply_language`, `profile.time_zone`, and `profile.preferred_name`. Additional keys are `preferences.units`, `preferences.format`, and `facts.<snake_case_topic>`. Each row stores `source_bot_id`, `source_message_id`, `source_order`, and the half-open UTF-8 byte range `[evidence_start, evidence_end)` in the original user text. Source identifiers survive deletion independently of the source row. A missing source row makes the original evidence unavailable.

`messages.id` is the global committed order. `message_order` keeps its SQLite high-water mark across restarts and source deletion. Message insertions allocate through the daemon Store, and the insertion trigger advances the high-water mark in the same transaction. The memory write updates SQLite only for a strictly newer `source_order`, then publishes the committed value to Rig's shared read snapshot.

When Rig builds a request, the daemon binds it to the most recent authored input delivered into that Turn and present in its model context. Tool calls carry the source of the model effect that produced them. The daemon verifies the source Bot, message ID, user role, and verbatim evidence against SQLite. Report-only Turns have no source for memory writes.

`user_memory_forgotten` stores the last committed user message order for each forgotten key. A forget transaction removes the value and records its order, even if no value has been saved yet. A newer verified statement replaces the tombstone with a current value. Across both tables, the latest applicable user message wins. An equal order is a repeat and cannot change the state. The daemon holds the snapshot write lock across the commit and publication so model preparation sees the complete change.

Inspection returns current values only. Available sources include the originating Bot ID and name, committed message ID, and verbatim evidence. The source is `null` when its original message is unavailable. A Bot's normal Conversation reads continue to return the original text.

Model requests treat UserMemory as authoritative for standing preferences. When applicable, a forgotten key is accompanied by its committed order instead of its old value. Historical Recall results should carry their original committed message IDs. Observational Memory summaries should retain the committed order they cover. Earlier statements, summaries, Recall results, and prior tool receipts are historical context. Only a new, explicit authored user statement can restore a forgotten key.

## Conversation attachments

Include an optional `attachments` array in a message POST. The daemon associates entries with the committed message in array order. The `text` field remains required and stores the exact user-authored text used for UserMemory evidence. Attachment content enters the selected model's current Turn. A later Turn can include the content again by referencing its ID.

```json
{
  "text": "Use the new note and the diagram I attached earlier.",
  "attachments": [
    {"type":"inline","name":"sample.txt","mediaType":"text/plain","content":"Sample material is cobalt."},
    {"type":"reference","id":"e30e61e5-aaea-4840-a622-ebe5167d4df5"}
  ]
}
```

Send extracted plain UTF-8 text in `content` for `text/plain`, up to 64 KiB. For `image/png`, `image/jpeg`, `image/gif`, and `image/webp`, send standard padded base64 of a static image up to 1 MiB decoded and 2,048 pixels on either axis. The daemon verifies the format and decodes the image before storing its original bytes. The JSON request limit is 2 MiB with up to eight attachment entries. Use a file name as the label. Extract document text on the client before sending it. Both text and image content are shared with the configured model provider when used in a Turn.

`GET /bots/{id}` returns an `attachments` array on each message with attachment records. Each record has `id`, `name`, `mediaType`, and `available`. Download available content from the attachment GET route. Both download and reference reuse require an existing association in the target Bot's Conversation on the connected daemon. Unknown IDs and IDs from another Bot return `404 attachment_not_found`. A malformed POST reference returns `422 invalid_message`. A rejected reference leaves the submission uncommitted.

An admitted message with an unusable attachment emits an `attachment_warning` SSE event with `attachmentId`, `code`, and `message` before reply deltas. Missing, invalid, or over-limit content gives `attachment_unavailable`. An unsupported MIME type gives `attachment_format_unsupported`. These records are visible in the Conversation with `available: false`, and their content GET returns `410 attachment_unavailable`. A valid image for a text-only selected model gives `attachment_model_unsupported` and remains downloadable. The Agent can still use the message text and any usable attachments.

OpenAI Chat Completions and Anthropic Messages accept text attachments as text parts. For image support, the daemon uses the pinned Rig catalog for known models, including `openai/gpt-4.1-mini` and `anthropic/claude-haiku-4-5`. For unlisted gateway aliases it uses Rig's provider wire capability rule. Select an alias the gateway documents as vision-capable. Provider failures appear as `turn_failed` and the committed message stays in the Conversation. [Rig model catalog](https://docs.rs/rig-core/0.47.1/rig_core/catalog/) · [OpenAI vision guide](https://developers.openai.com/api/docs/guides/images-vision/) · [Anthropic vision guide](https://platform.claude.com/docs/en/build-with-claude/vision)

### Live attachment smoke

Use a disposable daemon database, an authorized credential, and a vision-capable model that supports streaming on the selected endpoint. For an authorized Chat Completions gateway, set `OPENAI_BASE_URL` to its API root and select its vision-capable model ID in Settings or through `OMARCHY_AGENT_MODEL`. Start a fresh Bot as in the smoke test above. Put a neutral text sample that says `Calibration sample: cobalt.` in `sample.txt` and prepare a static red PNG named `pixel.png` within the stated limits. Run this with `curl` and `jq`.

```sh
jq -n --rawfile note sample.txt --arg image "$(base64 -w0 pixel.png)" '{
  text: "Which calibration sample does the text name, and what color is the PNG?",
  attachments: [
    {type:"inline",name:"sample.txt",mediaType:"text/plain",content:$note},
    {type:"inline",name:"pixel.png",mediaType:"image/png",content:$image}
  ]
}' | curl -fsSN "$base/bots/$bot/messages" -H 'Content-Type: application/json' --data-binary @-
```

Expect a committed reply identifying cobalt and red and a Conversation with both attachment IDs on the submitted message.

## Recall

An Agent using a tool-capable chat model can call `recall` with a query. Recall searches committed user and assistant text from the calling Bot before the first user message delivered to its current Turn. A report-only Turn searches the committed history at lookup. Recall returns up to five historical matches with `bot_id`, `message_id`, `role`, verbatim `text`, and the half-open UTF-8 range `[start_byte, end_byte)` in the original message. `message_id` is the global committed order and resolves against `GET /bots/{id}`. Each tool result labels its messages as `historical`. Recall evidence has no authority to update UserMemory or establish a current preference.

When the user asks which other Bot discussed a specific earlier topic, the Agent can opt in with `recall` and `scope: "source_bot"`. This searches the owner's other Bots on the same daemon for messages committed before the current Turn. It returns up to three matching passages with the source Bot's current name and stable ID. Reference-code queries require an exact identifier match, and topic queries use a minimum semantic similarity. The Agent receives the passages in the same Turn and replies in the current Conversation.

The daemon embeds and indexes messages locally. Ordinary chat can run while Recall verifies the model or builds its index. A Recall call can catch up on pending messages within its scope. If the Agent chooses to use Recall, retrieved text is included in the configured chat provider's next request.

### Offline provision

The pinned model is Xenova's multilingual E5 small INT8 ONNX export at revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78`. On a connected machine, run this from `apps/agent-daemon`, then copy the verified directory to the daemon host.

```sh
recall_dir=/path/to/recall-model
hf download Xenova/multilingual-e5-small \
  --revision 761b726dd34fb83930e26aab4e9ac3899aa1fa78 \
  --local-dir "$recall_dir" \
  onnx/model_int8.onnx config.json tokenizer.json special_tokens_map.json tokenizer_config.json
recall_manifest="$PWD/recall-model.sha256"
(cd "$recall_dir" && sha256sum -c "$recall_manifest")
```

Set `OMARCHY_AGENT_RECALL_MODEL_DIR` to the absolute directory before starting the daemon. At startup the daemon verifies the five fixed files against [recall-model.sha256](recall-model.sha256), loads them through Rig FastEmbed, and runs a CPU inference check. `GET /recall/status` reports `loading`, `ready`, or `unavailable` with `reason`. Unavailable reasons are `not_configured`, `model_missing`, `model_unreadable`, `verification_failed`, and `initialization_failed`. The model loads entirely from local files. After replacing missing or rejected files, restart the daemon to verify them again.

The index uses FastEmbed 4.9.1 with the ONNX Runtime 1.20.0 CPU build, 384-dimensional normalized mean pooling, FastEmbed's 512-token limit, and one input per dynamic quantization batch. Queries use `query: ` and trimmed text. Passages use `passage: ` and verbatim text in windows of up to 480 UTF-8 bytes with 80 bytes of overlap, aligned to character boundaries. Exact case-insensitive identifier tokens containing digits take priority over cosine similarity. SQLite stores versioned vectors as derived data keyed to their original messages. Change the index version when changing artifacts or preprocessing so the daemon rebuilds affected rows from original Message History. [Model card](https://huggingface.co/intfloat/multilingual-e5-small) · [Pinned export](https://huggingface.co/Xenova/multilingual-e5-small/tree/761b726dd34fb83930e26aab4e9ac3899aa1fa78) · [Rig FastEmbed 0.47.1](https://docs.rs/rig-fastembed/0.47.1/rig_fastembed/)

### CPU evaluation

The [fixture](tests/fixtures/recall.json) uses 16 neutral passages and 14 labeled queries across English, Spanish, French, German, Portuguese, Chinese, Japanese, and mixed Chinese/English. Candidate runs used the pinned Rust Rig adapter and ONNX Runtime, one embedding at a time, on three logical CPUs on a Linux x86_64 Ryzen 9 7900X. Timings include local model loading and tokenization. Peak RSS is for the standalone probe. The table gives semantic ranks before exact identifier matching.

| Candidate | Artifact bytes | Load | Index 16 | Query p50 / max | Peak RSS | Top 1 / 3 / 5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Xenova multilingual E5 small INT8 | 135,138,591 | 1.52 s | 37.1 ms | 1.9 / 2.4 ms | 806 MiB | 10 / 13 / 14 |
| Xenova multilingual E5 small FP32 | 487,352,531 | 2.23 s | 85.5 ms | 4.2 / 5.4 ms | 1,545 MiB | 10 / 13 / 14 |
| Qdrant multilingual MiniLM L12 v2 quantized | 252,138,706 | 1.67 s | Runtime error | — | — | — |

INT8 matched FP32 on aggregate recall with 28% of the artifact bytes. It ranked the German-to-French match third and the Japanese-to-English match fifth, one position below FP32 for each. Both E5 models ranked bare `GDN-417-R` first and placed the near neighbor above `GDN-417-Q` when the identifier appeared in a sentence. The daemon prioritizes exact tokens. MiniLM loaded but failed first inference with a missing `encoder.layer.0.attention.output.LayerNorm.weight` input to `SkipLayerNormalization`. The CPU results are specific to the measured Linux host. [MiniLM candidate revision](https://huggingface.co/Qdrant/paraphrase-multilingual-MiniLM-L12-v2-onnx-Q/tree/faf4aa4225822f3bc6376869cb1164e8e3feedd0)

To exercise the real daemon and verified local model with a scripted provider on loopback, run from `apps/agent-daemon`.

```sh
OMARCHY_AGENT_RECALL_TEST_MODEL_DIR="$recall_dir" cargo test --locked -j 3 \
  --test conversation recall_returns_original_messages_from_the_calling_bot_after_restart \
  -- --ignored --exact
OMARCHY_AGENT_RECALL_TEST_MODEL_DIR="$recall_dir" cargo test --locked -j 3 \
  --test conversation source_recall::source_bot_recall_returns_matching_originals_in_the_current_conversation \
  -- --ignored --exact
```

## Checks

Run from `apps/agent-daemon`.

```sh
cargo fmt --all -- --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked
```

Integration tests launch the actual daemon binary with temporary SQLite databases and local scripted OpenAI Chat Completions and Anthropic Messages endpoints. The tests use fixture credentials.
