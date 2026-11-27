# Agent Daemon

The standalone daemon runs a Rig 0.47.1 Agent for each active Bot Turn. The Bot ID also identifies its single Conversation. The HTTP listener binds to IPv4 loopback. Run one daemon per SQLite file.

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

A successful `PUT` commits the selection and any key replacement together. Invalid input or a failed write preserves the prior configuration. Writes and Turn admission share a lock. A Turn admitted after a successful write uses the new selection and key. An already admitted Turn keeps its original connection. The latest committed write determines the active selection.

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
| `POST /bots` with `{"name":"Lumen"}` | `201` with `id` and `name` |
| `GET /bots/{id}` | `200` with `bot` and `messages`, oldest first |
| `POST /bots/{id}/messages` with `{"text":"Hello"}` | `200` with a `text/event-stream` reply |
| `GET /bots/{id}/attachments/{attachmentId}` | `200` with the stored bytes and media type |

A successful message POST commits the user message before starting the model call. Each `delta` contains a JSON string. The terminal `committed` event contains the same `{id, role, text}` message returned by `GET` and is sent after the SQLite commit. A failed Turn ends with an `error` event containing `code` and `message`. Any deltas from that Turn are provisional. The committed user message remains in the Conversation.

A Bot accepts one Turn at a time. An overlapping POST receives `409` with `turn_in_progress` and adds no message. A Turn continues after its client disconnects. A client whose stream closes before a terminal event can use `GET` to read the committed state. On process restart, the daemon loads committed messages from SQLite and starts a fresh Turn on the next POST.

## Shared UserMemory

A Bot can save a fact or standing preference from its current user message. For example, say “Always reply in French,” “My time zone is Europe/Paris,” or “Please call me Áine.” The daemon verifies the proposal against the original committed text and shares the saved value with all Bots on that daemon. Use a direct first-person statement for facts, such as “Remember that my favorite tea is hojicha.” Ambiguous wording requires clarification. Use a model that supports tool calls when saving UserMemory.

Ask any Bot “What do you remember about my units preference?” to inspect the current value. If the source is available, the Bot can cite its Conversation and quote your original statement. Say “Change my units preference to metric” to correct it, or “Forget my units preference” as its own message to clear it for every Bot. The original Conversation messages remain readable. A later explicit statement can establish the preference again.

Each model request receives the current reply language, time zone, and preferred name when available. Other entries are selected by matching words from the current request against the entry's topic, with a limit of six. A current instruction such as “Reply in English this time” takes precedence for that request. Request context and tool traces do not become Conversation messages.

### Storage and provenance contract

`user_memory` holds one current value per key. Recurring keys are `preferences.reply_language`, `profile.time_zone`, and `profile.preferred_name`. Additional keys are `preferences.units`, `preferences.format`, and `facts.<snake_case_topic>`. Each row stores `source_bot_id`, `source_message_id`, `source_order`, and the half-open UTF-8 byte range `[evidence_start, evidence_end)` in the original user text. Source identifiers survive deletion independently of the source row. A missing source row makes the original evidence unavailable.

`messages.id` is the global committed order. `message_order` keeps its SQLite high-water mark across restarts and source deletion. Message insertions allocate through the daemon Store, and the insertion trigger advances the high-water mark in the same transaction. The memory write updates SQLite only for a strictly newer `source_order`, then publishes the committed value to Rig's shared read snapshot.

Rig's request preparation stage records the eligible committed input against each model effect. A tool call resolves its originating effect, then the daemon verifies the source Bot, message ID, user role, and verbatim evidence against SQLite. When several deliveries share an Agent, request preparation must select the eligible authored input using the durable message identity carried through `Incoming` and `DeliveredAs`/`DeliveredIn`. The captured source remains stable for tool calls originating from that invocation.

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

## Checks

Run from `apps/agent-daemon`.

```sh
cargo fmt --all -- --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked
```

Integration tests launch the actual daemon binary with temporary SQLite databases and local scripted OpenAI Chat Completions and Anthropic Messages endpoints. The tests use fixture credentials.
