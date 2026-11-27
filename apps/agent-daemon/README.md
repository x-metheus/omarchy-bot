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

A successful message POST commits the user message before starting the model call. Each `delta` contains a JSON string. The terminal `committed` event contains the same `{id, role, text}` message returned by `GET` and is sent after the SQLite commit. A failed Turn ends with an `error` event containing `code` and `message`. Any deltas from that Turn are provisional. The committed user message remains in the Conversation.

A Bot accepts one Turn at a time. An overlapping POST receives `409` with `turn_in_progress` and adds no message. A Turn continues after its client disconnects. A client whose stream closes before a terminal event can use `GET` to read the committed state. On process restart, the daemon loads committed messages from SQLite and starts a fresh Turn on the next POST.

## Checks

Run from `apps/agent-daemon`.

```sh
cargo fmt --all -- --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked
```

Integration tests launch the actual daemon binary with temporary SQLite databases and local scripted OpenAI Chat Completions and Anthropic Messages endpoints. The tests use fixture credentials.
