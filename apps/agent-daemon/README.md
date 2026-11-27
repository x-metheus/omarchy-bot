# Agent Daemon

The standalone daemon runs a Rig 0.47.1 Agent for each active Bot Turn. The Bot ID also identifies its single Conversation. The HTTP listener binds to IPv4 loopback. Run one daemon per SQLite file.

## OpenAI smoke test

From the repository root, run the daemon in a terminal with `OPENAI_API_KEY` already exported through your credential manager. The default model is `gpt-4.1-mini`. Set `OMARCHY_AGENT_MODEL` to select another OpenAI Chat Completions model available to your account. The real smoke uses OpenAI's default endpoint, so leave `OPENAI_BASE_URL` unset. A scripted server can supply an alternate Chat Completions base URL, including its `/v1` path.

```sh
cd apps/agent-daemon
OMARCHY_AGENT_DB=./agent-smoke.sqlite3 cargo run --locked
```

The daemon prints its HTTP address after binding. `OMARCHY_AGENT_PORT` defaults to `8765`. Set it to `0` for an available port and use the printed address. `OMARCHY_AGENT_DB` defaults to `agent-daemon.sqlite3` in the current directory.

In a second terminal, use `curl` and `jq` to create a Bot, stream a reply, and ask a follow-up that refers to the earlier message.

```sh
base=http://127.0.0.1:8765
bot=$(curl -fsS "$base/bots" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke Bot"}' | jq -er .id)
curl -fsSN "$base/bots/$bot/messages" -H 'Content-Type: application/json' \
  -d '{"text":"Remember the word amber. Reply with a short acknowledgment."}'
curl -fsSN "$base/bots/$bot/messages" -H 'Content-Type: application/json' \
  -d '{"text":"What word did I ask you to remember? Reply with just that word."}'
curl -fsS "$base/bots/$bot" | jq .
```

Expect ordered `delta` events followed by `committed` for each reply. The follow-up should answer `amber`. Stop the daemon with Ctrl+C and start it again with the same database command. In the second terminal, run the final `GET` again. The Bot ID and ordered messages should match the earlier read.

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
cargo test --locked --test conversation
```

The tests launch the actual binary with a temporary database and a local scripted OpenAI Chat Completions endpoint. They need no provider credential.
