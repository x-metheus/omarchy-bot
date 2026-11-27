# Ordered rich transcript

**Status:** resolved

## Authority

- [Feature specification](./spec.md)
- Ordered transcript ADR 0007
- [Accepted workspace design](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md)
- [Agent adapter contract](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/agents-integration.md)
- [Workspace language](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/contexts/workspace/CONTEXT.md)
- [Agent Integration language](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/contexts/agent-integration/CONTEXT.md)

The feature specification defines product behaviour. Context documents define canonical terms. The ADR records the durable cross-context boundary. Historical Activity tickets describe the implementation they delivered but do not override this effort.

## Tickets

1. [Stream Response Blocks as Markdown](./issues/01-stream-response-markdown.md) — resolved
2. [Persist per-Bot Display Settings](./issues/02-bot-display-settings.md) — resolved
3. [Present native Tool Call summaries](./issues/03-native-tool-calls.md) — resolved
4. [Stream Pi Thinking Blocks](./issues/04-pi-thinking-blocks.md) — resolved
5. [Contract the legacy transcript model](./issues/05-contract-legacy-transcript.md) — resolved
6. [Verify ordered mixed-Turn behaviour](./issues/06-ordered-transcript-qa.md) — resolved

## Frontier

All six ordered rich transcript tickets are complete.

## Cross-cutting invariants

- Response Blocks, Thinking Blocks, Tool Calls, Steering, and recognized product content preserve occurrence order.
- Hidden Tool Calls and Thinking remain received and retained; display settings never alter Agent behaviour.
- Only officially exposed reasoning or provider-authored summaries are Thinking.
- Full Tool Call input and output are not transcript history.
- Native Events are residual Agent-specific signals, not a generic Thread content type.
- Bot Activity remains independent from transcript content and means only active versus inactive.
- Only Pi is implemented in this effort; every other Agent remains Pending.
