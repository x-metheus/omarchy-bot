# Rich content in the Thread transcript

## 1. Question and method

What should a Bot be able to display in a Thread beyond plain text, and which interactions should resume the same durable Turn? This report synthesizes six research findings covering consumer chat, messaging cards, React toolkits, agent-to-UI protocols, and the repo. Public APIs establish documented patterns. Consumer implementation details marked `unverified` remain unknown. Repo claims were checked against the protocol, SQLite migrations, runtime, React transcript, and installed Astryx 0.5.2. V1 scope and payloads below are recommendations for the spec.

## 2. Prior-art comparison

| Product | Data model | How interaction returns | Media and links | Persistence and replay | Sandbox and security |
| --- | --- | --- | --- | --- | --- |
| ChatGPT | Apps use iframe HTML and structured data. Web-search `url_citation` and consumer message schema `unverified` in the audit. | Widget tool call or model-visible follow-up. | Citations and inline, carousel, or fullscreen app views. | Widget state snapshots. Consumer replay `unverified`. | Widget iframe and declared CSP. [Web Search][openai-search], [ChatGPT UI][openai-ui], [Apps Reference][openai-ref] |
| Claude.ai | Public API typed blocks and citation spans. Artifacts and MCP Apps are user-facing surfaces. Claude-specific claims `unverified` in the audit. | Conversational Artifact edits. MCP Apps can call tools or post messages. Agent SDK separately documents structured questions. | Artifacts include docs, code and visual outputs. Citation metadata supports external URLs. | Artifacts can be reopened and copied. Thread replay internals `unverified`. | MCP Apps iframe boundary. Consumer Artifact CSP `unverified`. [Artifacts][claude-artifacts], [Citations][claude-citations], [User Input][claude-input], [MCP Apps][mcp-apps] |
| Gemini | Public grounding search steps and citation fields `unverified`. Consumer Canvas schema `unverified`. | Canvas selection and Deep Research plan edits `unverified`. | File uploads, audio overviews, charts and grounded links `unverified`. | Canvas save/copy behavior `unverified`. Thread replay internals `unverified`. | Consumer Canvas sandbox/CSP `unverified`. [Canvas][gemini-canvas], [Deep Research][gemini-research], [Files][gemini-files], [Audio][gemini-audio], [Grounding][gemini-grounding] |
| Slack | Declarative Block Kit JSON. | Action and block IDs in callbacks. Fast ack, then reply or update. | Image, carousel, video, file blocks and link unfurls. | In-place replacement and ephemeral replies. Durable replay semantics `unverified`. | Block catalogue. Raw HTML exclusion and crawler isolation `unverified`. [Blocks][slack-blocks], [Interactions][slack-actions], [Unfurls][slack-unfurls] |
| Discord | Declarative embeds and components. | Message ID plus `custom_id`, ack or defer, then update. | Attachments, embed images and proxy URLs. | In-place updates or ephemeral responses. Durable replay semantics `unverified`. | Fixed component schema. Proxy URLs documented, fetch policy `unverified`. [Messages][discord-messages], [Components][discord-components], [Interactions][discord-actions] |
| Telegram | Bot API message objects, declarative keyboards and polls. | `CallbackQuery`, ack, then optional message edit. | Media groups. Link preview options `unverified`. | Message edits. Client replay semantics `unverified`. | Telegram defines keyboard controls and also lists HTML widgets. Preview fetch policy `unverified`. [Bot API][telegram] |
| Adaptive Cards | Versioned JSON with typed inputs. `Input.ChoiceSet` `unverified`. | Submit or Execute sends input and action data. Host can replace or refresh the card. | `Image`, `Media`, `Action.OpenUrl`. | Host-owned storage. Refresh can recover current state. | Native host renderer and constrained formatting. Media proxying `unverified`. [Schema][cards-schema], [Text][cards-text], [Actions][cards-actions] |
| AI SDK/AI Elements | Registered React views for tool or data parts. Full `UIMessage.parts` union `unverified`. | Tool approval response or client-side tool output. `needsApproval` `unverified`. | File/source parts, citation and source views. | App stores validated messages and rehydrates them. | Tool/data schemas. Markdown XSS policy `unverified`. [Chat][ai-chat], [Generative UI][ai-ui], [Approval][ai-approval], [Persistence][ai-storage], [Elements][ai-elements] |
| assistant-ui | Toolkit registers tools and renderers. Message primitives `unverified`. | Registered tool UI returns a result. General interrupt lifecycle `unverified`. | Image and source parts `unverified`. | Persistence adapters `unverified`. | Host-defined renderers and execution placement. Markdown sanitizer guarantees `unverified`. [Parts][aui-parts], [Toolkit migration guide][aui-tools], [History][aui-history] |
| CopilotKit | Registered components, A2UI surfaces, or isolated HTML apps. | HITL `respond` or backend resume `unverified` in the audit. | Renderer-specific. | Runner history and rehydration `unverified`. | Open Generative UI uses a sandboxed iframe. MCP Apps isolation `unverified`. [Generative UI][copilot-ui], [HITL][copilot-hitl], [Threads][copilot-threads], [Open UI][copilot-open] |
| MCP Apps | `ui://` HTML resource plus tool result data. | JSON-RPC bridge for tool calls, chat follow-ups and model context. | Resource-owned media and navigation mediated by the host. | Durable view state across reloads/devices left to the host. | Web hosts require a separate-origin sandbox proxy. Resource CSP metadata is optional. Host origin-check implementation `unverified`. [Overview][mcp-apps], [Specification][mcp-spec], [CSP/CORS][mcp-csp] |
| OpenAI Apps SDK | MCP Apps HTML resources plus `structuredContent` and host metadata. | MCP bridge and compatibility APIs for tools and follow-ups. | Widget media and host-mediated external opening. | Resource and tool data reconstruct the view. `setWidgetState` stores widget state between renders. Cross-device scope `unverified`. | Sandboxed iframe, declared domains. Exact origin checks `unverified`. [ChatGPT UI][openai-ui], [Reference][openai-ref], [UI Guidelines][openai-guides] |
| A2UI | Streamed declarative JSON referencing renderer catalogues and bound data. | Typed renderer actions and function responses. | Catalogue-dependent. | Host can save surface/data snapshots. Cross-device replay `unverified`. | Trusted renderer catalogue interprets data without executing agent code. [Specification][a2ui] |
| AG-UI | Streaming events. Full event families `unverified`. | Typed resume envelope with interrupt ID, status and optional `any` payload. A response schema is optional. | Host renderer supplies media and links. | Snapshots support resync. Deltas `unverified`. Durable storage is host-owned. | Transport-level contract. View isolation and egress are host-owned. [Events][ag-events], [Interrupts][ag-interrupts], [State][ag-state] |

The audit reported v1.0 content from both A2UI URLs. The legacy page declares a meta refresh to v1.0. Browser navigation and the reported June 8, 2026 update date remain `unverified`. The v1.0 page labels itself “Current.” The MCP Apps page uses wire revision `2026-01-26` and labels it “Stable” (reported status and date `unverified`). MCP Apps elicitation was outside the audited evidence. [A2UI legacy URL][a2ui-redirect], [A2UI v1.0][a2ui], [MCP Apps revision][mcp-spec]

**Evidence strength.** Independently verified clusters were Discord, OpenAI Apps SDK and A2UI message and surface shapes.  
Partly supported clusters were Slack, Telegram, Adaptive Cards, AI SDK, assistant-ui, CopilotKit, MCP Apps, AG-UI and consumer assistants.  
Unverified details are marked per row.

## 3. Cross-cutting principles

1. Give the host ownership of layout, accessible controls, and permitted actions. Typed data selects known views. Executable apps require an isolated view and a narrow bridge. [Block Kit][slack-blocks], [A2UI][a2ui], [MCP Apps][mcp-spec]
2. Correlate actions with stable request and option IDs. Acknowledge submission promptly, show pending feedback, and render the authoritative outcome when it arrives. A local UI action, a tool answer, and a new chat turn have different effects. [Discord interactions][discord-actions], [CopilotKit HITL][copilot-hitl], [AG-UI Interrupts][ag-interrupts]
3. Persist the data needed to rebuild a view with the same identity and result. Keep ephemeral controls like carousel position local. Streaming deltas and cached templates support responsiveness, while stored state supplies history. [AI SDK persistence][ai-storage], [Adaptive Card actions][cards-actions], [AG-UI State][ag-state]
4. Keep rich output readable as text or safe metadata if a view is unavailable. Use labelled controls, media alternatives, and bounded payloads. [Slack blocks][slack-blocks], [OpenAI UI Guidelines][openai-guides]

## 4. Content-type catalogue

**Current seam.** `PROTOCOL_VERSION = 1`. `MessageDto` is `.strict()` with kind-specific `superRefine` rules for `text | response | thinking | tool | event`. User and system messages may use `text`. Bot prose uses `response` with `text` and `{blockId, state, startedAt, completedAt?}`. `tool` carries a safe summary. `event` is retained but skipped by `ChatPanel`. The enum and SQLite `CHECK` both reject unknown kinds. Add a kind with an explicit protocol change, DB migration, and compatibility plan. Thread `seq` orders rows. The ordered-transcript decision is in `.scratch/ordered-rich-transcript/spec.md`. At the time of this research the repository contained only ADR 0016, and the link to ADR 0007 was broken. [Protocol](../../packages/protocol/src/api.ts), [Version](../../packages/protocol/src/index.ts), [SQLite](../../apps/daemon/src/persistence/db.ts), [Transcript](../../apps/web/src/components/ChatPanel.tsx), [Ordered transcript](../ordered-rich-transcript/spec.md), [ADR 0016](../../docs/agents/adr/0016-build-bots-on-pi-durable.md)

**Proposed conventions.** Use a daemon-owned `prompt` transcript kind for V1 interactions on the durable path with unified prompt support (§5). In phase 2, consider a `rich` kind with a small versioned union of recognized read-only blocks, a stable ID and a text fallback. Treat the shapes below as candidates for those typed fields and keep native `event` opaque. Persist committed blocks and results to SQLite and rebuild from the Thread snapshot and cursor updates. Bound content sizes since the web transcript has no virtualization. The web app has no app-level i18n or component-level unit tests. Its web unit tests are in `src/lib`, with Playwright for UI coverage. Use Astryx components and `var(--color-*)`, `var(--spacing-*)`, `var(--radius-*)` tokens. No raw `<div>` layout, hex/px styling, Tailwind or new StyleX. Use `Card` for standalone widgets and `Item`/`Table` for dense rows. Use `Collapsible` for disclosure and `BottomSheet` or `Dialog` for overlays. Astryx 0.5.2 has no `Accordion` or `Drawer` export. [Web rules](../../apps/web/AGENTS.md), [ChatPanel](../../apps/web/src/components/ChatPanel.tsx), [Web tests](../../apps/web/src/lib), [E2E](../../tests/e2e/specs)

### Questions with choices — V1 on the durable path

`{requestId, prompt, options:[{id,label,description?}], selection:single|multi, min?, max?, allowOther}`. Use `RadioList` with `RadioListItem` or `Selector` for single, `CheckboxList` with `CheckboxListItem` or `MultiSelector` for multi, and a labelled `TextArea` when Other is selected. Submit `{optionIds,otherText?}` through the durable answer endpoint. Validate distinct known option IDs, text bounds and selection count against the stored prompt. Count nonempty Other as one choice when enabled. The Bot gets the validated tool result in the same Turn. Persist prompt/options and terminal answer. Reload pending controls or a read-only answer summary in the original position.

### Media — V1 keeps current images. Rich media deferred

`{items:[{assetId, kind:image|video|audio, mime, alt?, caption?, posterId?, captionTrackId?}]}` with required alt for meaningful images and audio/video transcript or captions where available. Keep inline images in `AspectRatio`. Use `Thumbnail` and `Carousel` for galleries and `Lightbox` for images and video, with zoom for images. Its media interface has a display caption and no track field. In phase 2 supply timed captions via a managed WebVTT `<track>` in a native video player. Leave autoplay disabled. Astryx has no dedicated `Image`, `Video` or `Audio`. Use native audio controls inside `VStack` when added. Playback and zoom stay local. Persist managed asset IDs and captions. Reload reconstructs the gallery with an unavailable state for missing bytes. [Lightbox media, lines 49–66](https://unpkg.com/@astryxdesign/core@0.5.2/src/Lightbox/Lightbox.tsx), [Video player, lines 676–683](https://unpkg.com/@astryxdesign/core@0.5.2/src/Lightbox/Lightbox.tsx)

### Links and citations — V1 keeps plain links. Previews and citations deferred

`{url,title?,description?,imageAssetId?}` for a supplied preview and `{sources:[{id,url,title?,excerpt?}]}` with stable text markers for citations. Use `Item` rows or `Card` for a standalone preview. Map the array to the marker-ID record expected by `Markdown.sources` and set `citationStyle`. Route navigation through `components.citation` and host validation, since the default `Citation` renders its own anchor for a URL. A click opens externally with no Bot reply. Persist metadata and marker mapping as supplied. Reload without preview or favicon fetching. [Markdown sources, lines 147–156](https://unpkg.com/@astryxdesign/core@0.5.2/src/Markdown/Markdown.tsx), [Citation override, lines 954–968](https://unpkg.com/@astryxdesign/core@0.5.2/src/Markdown/Markdown.tsx), [Citation anchor, lines 192–216](https://unpkg.com/@astryxdesign/core@0.5.2/src/Citation/Citation.tsx)

### Files — V1 keeps user attachments. Bot-produced files and native Open deferred

Keep `AttachmentDto` on user `text`. The daemon stages then promotes bytes into its attachments directory and `/api/attachments/:id` requires a device token. For Bot output, publish `{assetId,name,mime,size,displayFolder?}` by importing a copy from the authorized shared folder. Use compact `Item` rows and `Button` Download/Open, with user attachments via `FileInput` where needed. Save or Open is a host action with no tool result. Reload resolves the immutable copy and reports removed bytes. Source edits must not silently change history. [Attachments](../../apps/daemon/src/modules/attachments/attachments.ts), [Routes](../../apps/daemon/src/api/attachmentRoutes.ts), [Auth](../../apps/daemon/src/api/http.ts), [Shared work files](../../docs/specs/bot-runtime.md)

### Code blocks — V1 via Markdown. Typed code and execution deferred

Keep fenced code in `response.text`. Use Astryx `Markdown` and its `CodeBlock` renderer. Copy is local. Persist the completed text and rebuild the same fence on reload. Later typed code could carry `{language,code,title?}` and use direct `CodeBlock` when a file association or title matters.

### Tables — V1 via Markdown. Structured tables deferred

Store static Markdown in `response.text`. Later `{columns:[{id,label,type}],rows}` can render through `Table`, `TableHeader` with `TableHeaderCell`, and `TableBody` with `TableRow` and `TableCell`. Sorting and paging are local. Persist original text or bounded rows. Reload restores the data and defaults for sorting and paging.

### Charts — Deferred

`{chartType,title,units?,series,summary}` with bounded numeric data and renderer-owned styles. Use `Heading`, `AspectRatio` around an app-owned chart, and `Table` for the accessible data view. Hover and series toggles stay local. Persist data and summary for identical reloads without a chart service.

### Maps and locations — Deferred

`{label,address?,lat?,lon?}` with validated coordinates. Use `Item` and `Button` to open an explicit map link. Consider an `AspectRatio` preview only with approved map egress. Opening is local. Persist coordinates and display text so restart and offline reload still show a location.

### Contact and calendar cards — Deferred

Use typed contact `{name, email?, phone?}` and event `{title,start,end,timeZone,location?}`. Render `Item` and `MetadataList` with labelled `Button` actions for copy or export. Return no Bot result for a local export. Creating or sending an event needs a separately confirmed action. Store the displayed fields and timezone with the Thread.

### Forms — Deferred

`{requestId,fields:[{id,label,type,required?,choices?}]}` with a closed field catalogue and strict validation. Use `FormLayout`, `Field`, `TextInput`, `TextArea`, `Selector`, `DateInput` or `TimeInput`. Return validated field values via the shared prompt endpoint. Recover pending schema and permitted summaries from SQLite. Keep drafts local and exclude secrets from durable prompts. [MCP Elicitation][mcp-elicitation]

### Approvals and confirmations — V1 for durable file access. Other gates deferred

`{requestId,kind:file_access,tool,path,folder}` with fixed Allow once, Always allow this folder and Deny decisions. Use the shared prompt view in `ChatMessage` with `Banner`, `Text` and `ButtonGroup` where unified prompts are supported (§5). Consider `AlertDialog` for granting persistent folder access. The authenticated answer settles the waiting file tool. Persist the outcome at its original `seq`, including expiry/cancellation. General confirmation authorizes a named operation and needs its own typed policy before it can trigger side effects.

### Progress and status — V1 keeps existing Turn and tool status. Typed progress deferred

Keep current working state and tool status. Later `{activityId,label,state,current?,total?,detail?}` can use `ProgressBar`, `StatusDot` or `Banner`. Use indeterminate progress when work is unmeasured. Viewing is local. Recover latest durable activity state plus terminal outcome. Expired transient progress must not look live after restart.

### Tool-call activity — V1 keeps current summaries. Expanded output deferred

Keep `ToolCallSummaryDto` and grouped `ChatToolCalls` with the per-Bot visibility setting. Expanding is local. Persist the safe summary and terminal state. Startup already marks interrupted running tool rows as errors. A resumed user prompt must show its own request state independently of the tool summary. [Startup recovery](../../apps/daemon/src/persistence/db.ts)

### Artifacts and canvas — Deferred

`{artifactId,revision,kind,title,assetId,summary}`. An `Item` or standalone `Card` opens an app-owned `Dialog`/`BottomSheet` or split pane using `CodeBlock` or `Markdown` for static content. Local inspect/copy stays local. Send deliberate edit requests as a follow-up tied to artifact and revision. Persist original revision, bytes and fallback. Executable views require phase 4 isolation and explicit save semantics.

### Polls — Deferred

`{pollId,prompt,options:[{id,label}],multi,closesAt?,state}` plus votes or aggregate counts. Use `RadioList` or `CheckboxList` with `ProgressBar` for results. Submit a vote without blocking the Turn. Key ballots by poll and authenticated paired-device ID. Repeat votes replace the device's ballot until close. Two paired devices count as two voters. Persist ballots and result policy server-side. Restore closure and visibility on reload. [Device identity](../../apps/daemon/src/api/http.ts#L189-L202), [Telegram Bot API][telegram]

### Suggested replies — Deferred

`{suggestions:[{id,label,text}],messageId}` shown as `ButtonGroup` near the composer only in an idle Thread. Click fills the draft. Explicit Send starts a new Turn if still idle. If a Turn starts elsewhere first, retain the draft and wait for idle. Persist suggestions with their originating row if history needs them. Hide stale suggestions after the next user turn and recover the draft through ordinary draft behavior. [Busy Send](../../apps/daemon/src/modules/turns/turns.ts#L255-L274), [Send result](../../packages/protocol/src/api.ts#L635-L640)

## 5. Approval flow as a general ask-user tool

**Availability.** Gate the V1 prompt slice on `runtime: "durable"` pending the unchecked Task 19 cutover. On the default worker path the Bot asks in text and the user replies normally. The web gate still accepts protocol 1 after a bump, so also gate unified prompts on Service capability. New clients use the file-only API and ordinary text questions with protocol 1 Services. [Runtime selection](../../apps/daemon/src/modules/turns/turns.ts#L229-L245), [Web gate](../../apps/web/src/lib/api.ts#L30-L33), [File-only API](../../apps/daemon/src/api/approvalRoutes.ts#L7-L21)

**Use the same durable mechanism.** Today the file-policy hook strips any model-supplied approval argument and marks out-of-policy reads, writes, and edits. A replay-safe pi-durable task inserts or finds an `approvals` row keyed by `task_id UNIQUE`, checks the same call/tool/path on replay and waits with `waitForAnswer` using wakeups and polling. The row expires after seven days. `GET /api/approvals[?threadId=]` lists pending rows. `POST /api/approvals/:id/answer` accepts `allow_once | allow_folder | deny` and uses compare-and-set on `pending`. Losing answers get 409. Terminal statuses are `allowed_once | allowed_folder | denied | expired | cancelled`. On clean shutdown a waiting Turn stays `working` and resumes the same request after restart. Hard-kill recovery is also covered by an existing test. [Store](../../apps/daemon/src/modules/runtime/approvals.ts), [Routes](../../apps/daemon/src/api/approvalRoutes.ts), [File hook](../../apps/daemon/src/modules/runtime/extensions/files-shell.ts), [Shutdown](../../apps/daemon/src/modules/turns/turns.ts), [Restart tests](../../apps/daemon/src/modules/runtime/restart.test.ts)

The generic piece is task identity, replay matching, expiry, cancellation, CAS and resume. File-specific pieces are the `read|write|edit` constraint, path and folder, enum answers, one-call grant, and the folder setting mutation on a successful persistent grant. Keep grant policy in the file path. The `ask_user` tool returns validated choice IDs and optional text to its waiting Bot task, with distinct cancelled/expired results. Replay must match the stored request kind and canonical payload.

Extend cleanup to `ask_user`. Today the hook calls `cancelTask` only for file tools. User abort cancels a pending request and a late answer must get 409. Clean shutdown leaves it pending for replay without spending restart budget. When crashes exhaust the budget, the Turn is `failed` and cleanup cancels its pending request. [Cleanup hook](../../apps/daemon/src/modules/runtime/extensions/files-shell.ts#L332-L335), [Shutdown](../../apps/daemon/src/modules/turns/turns.ts#L130-L143), [Restart contract](../../docs/specs/bot-runtime.md#L194-L200), [Restart limit test](../../apps/daemon/src/modules/runtime/restart.test.ts#L232-L249)

**Widen `approvals` and keep one store.** A sibling `questions` table would preserve the file schema but require cross-table pending discovery, request ordering and recovery. Rebuild the SQLite table to preserve in-flight IDs, task uniqueness, FKs, expiry, timestamps and pending index. Add `kind: file_access | question`, checked JSON request and answer columns with application validation per kind, and `answered` for questions. Backfill existing records as `file_access` and carry over historical decisions. The old mandatory file columns can move into the file payload. Add discriminated request/answer DTOs and a unified authenticated list/answer API with a compatibility adapter for the file approval API. Validate against the persisted request before CAS and include expiry in the settlement check. Keep folder grant and decision in one transaction. Use the shared pending check for clean shutdown, matching by Turn when available. [Migration](../../apps/daemon/src/persistence/db.ts), [Current DTOs](../../packages/protocol/src/api.ts)

**Project one durable `prompt` row per request.** Today approval resolution writes an event and leaves no message row. Allocate `seq` with the normal transcript writer at request time, after earlier block output is flushed. In the same transaction link the row uniquely to the request ID. The request row owns status. In the same CAS transaction, settlement updates the `prompt` row's projection with the outcome, display-safe answer and resolution time. Snapshots project from the request, so a missed event can't leave a terminal prompt actionable. Migrate live pending approvals with anchors and avoid inventing historical positions for settled legacy rows. Add `prompt` to the domain/DTO, both SQLite message checks, writer, reader, stream handling and renderer. Bump the strict wire protocol and apply the capability gate above. Publish notifications after commit and reconcile by ID/revision. Ordinary refetches use fetched rows. Cached rows win for matching IDs when a streamed update races the fetch. Test that reconnect recovers a missed resolution even when an unrelated streamed update races the snapshot. The resolved prompt must be read-only. [Message writer](../../apps/daemon/src/modules/threads/threads.ts), [Cache merge](../../apps/web/src/lib/messageStream.ts#L167-L185), [Event dispatch](../../apps/web/src/lib/events.ts), [Protocol gate](../../apps/web/src/components/ProtocolGate.tsx)

At the time of this research, Task 10 was open and the durable approval UI had yet to ship. Use one keyboard-operable Thread prompt component for both states and variants. The existing `LocalApprovalPrompt` is a separate Local Sidecar flow. Keep actionable prompts visible when tool summaries are hidden and use status feedback for decisions made on another client. [Local Sidecar prompt](../../apps/web/src/components/LocalApprovalPrompt.tsx)

## 6. Security

- **Main DOM.** Render schema-validated data via host-owned React components. Never mount Bot-supplied HTML, JSX, script, CSS, active SVG or raw widget documents in the main DOM. There are no iframes in the web app today. A future executable app needs a separate-origin sandbox, default-deny CSP, narrow validated RPC, source/origin checks and no native shell, device token or parent storage access. [MCP Apps spec][mcp-spec], [CSP/CORS][mcp-csp]
- **Markdown today.** Astryx parses Markdown into React elements without executing raw HTML. Its URL filter rejects `javascript:`, `vbscript:` and `data:text/html` after removing control characters. The app allows HTTP(S) Markdown images, sets `no-referrer`, and still loads images directly. HTTP(S) links open via the shell and `mailto:` may use the platform handler. The shell blocks Service links carrying `access_token`. Validate citation URL and icon inputs separately because `Citation` can render its own anchor and image. [ChatPanel](../../apps/web/src/components/ChatPanel.tsx), [Links](../../apps/web/src/components/ExternalLink.tsx), [Shell](../../apps/web/src/lib/shell.ts), [Image referrer policy][mdn-img]
- **Remote media.** Prefer managed, authenticated assets. Make remote media opt-in with a per-Bot policy and a per-item load action when needed. Direct loading still exposes the client IP to the destination. Keep tokenized URLs out of external links, widgets and logs. Serve active documents as explicit downloads and apply MIME/size allowlists to previews. [Image referrer policy][mdn-img], [Attachment routes](../../apps/daemon/src/api/attachmentRoutes.ts)
- **Unfurls.** Skip automatic preview fetching in V1 and phase 2. Display supplied metadata or a link without fetching page HTML, remote images or favicons. Any later fetcher needs egress isolation, HTTP(S) allowlists, DNS/IP and redirect validation, private/loopback/link-local blocking, tight time and byte limits, and no ambient credentials. The daemon may have network access that an external service lacks. [Slack unfurls][slack-unfurls], [OWASP SSRF][owasp-ssrf]
- **Trust.** Scope remote content and later widget permissions per Bot. Treat generated labels, URLs and form values as untrusted even for a trusted Bot. User authorization for file access comes from the authenticated answer path. Do not accept passwords or tokens through durable chat prompts. Keep answer bodies out of generic event payloads and diagnostics where an ID and revision suffice. [File hook](../../apps/daemon/src/modules/runtime/extensions/files-shell.ts), [MCP Elicitation][mcp-elicitation]

## 7. Recommended phases

1. **Smallest useful release slice — a Bot asks one single-select question in the Thread.** Gate `ask_user` on durable runtime and unified prompt support (§5). Ship `{prompt,options:[{id,label}]}`, an ordered `prompt` anchor, one `RadioList` and Submit, and a durable `{optionIds:[id]}` answer. Worker installations use text chat pending Task 19. Prove same-Turn resume, restart before answering, reload after answering, first-answer-wins across devices, visible expiry/cancellation, and 409 after abort. Complete gated V1 with multi-select, free-text Other, the shared file approval view and Task 10 notifications and cross-client updates. Keep the existing Markdown, attachments, Turn status and tool summaries.
2. **Read-only rich blocks.** Start on the durable path with a registered `publish_file` tool. Import an authorized file from the Bot's working folder in the Shared Workspace into immutable managed storage. Use the task ID to reuse the asset row and its `rich` row on replay. Allocate Thread `seq` after preceding output, serve the copy for authenticated Download/Open, and rebuild the file view from the same asset ID on reload. Verify fallback and accessibility before adding galleries, managed audio/video and link/citation metadata. Keep external fetch policy explicit. [Durable projection](../../apps/daemon/src/modules/runtime/transcript.ts#L54-L65), [Current promotion](../../apps/daemon/src/modules/attachments/attachments.ts#L191-L198), [Download route](../../apps/daemon/src/api/attachmentRoutes.ts#L47-L60)
3. **Structured data and richer interactions.** Add forms on the gated shared request mechanism, structured tables/charts, location and contact/event cards, progress, and static artifacts as use cases warrant. Add suggested replies, polls, expanded tool summaries and typed code only where their data or actions justify a distinct block.
4. **Isolated interactive artifacts.** Evaluate MCP Apps for interoperable widgets and native host catalogues for constrained forms. Define bridge capabilities, persisted revisions and state, origin/egress controls and reauthorization before shipping executable views.

## 8. Open questions for the spec

1. Is the first release slice single-select only, or must it ship with Other and multi-select to cover your first real workflow?
2. Should a user be able to skip a question and resume immediately, and should questions inherit the seven-day approval TTL?
3. Should free-text Other answers stay readable in Thread history, use a redacted summary, or be transient for specific fields?
4. When a Bot shares a work file, should the Thread own an immutable copy, a live link to the workspace file, or let the user choose?
5. Should remote Markdown images retain today's automatic loading, require per-Bot opt-in, or load only on click?
6. Is a metadata-only link card sufficient, or is an isolated user-triggered unfurl service worth operating later?
7. Can any paired device answer a pending prompt, and should notifications expose request details outside the Thread?
8. Which workflow warrants executable artifacts, and what access to network, files, and tools would it need?

## 9. Sources

- Consumer products. [OpenAI Web Search][openai-search], [ChatGPT UI][openai-ui], [Apps Reference][openai-ref], [UI Guidelines][openai-guides], [Claude Artifacts][claude-artifacts], [Claude Citations][claude-citations], [Claude Agent SDK User Input][claude-input], [Gemini Canvas][gemini-canvas], [Deep Research][gemini-research], [Files][gemini-files], [Audio Overviews][gemini-audio], [Grounding][gemini-grounding].
- Messaging platforms. [Slack Blocks][slack-blocks], [Interactions][slack-actions], [Unfurls][slack-unfurls], [Discord Messages][discord-messages], [Components][discord-components], [Interactions][discord-actions], [Telegram Bot API][telegram], [Adaptive Cards Schema][cards-schema], [Text][cards-text], [Actions][cards-actions].
- React toolkits. [AI SDK Chat][ai-chat], [Generative UI][ai-ui], [Approval][ai-approval], [Persistence][ai-storage], [AI Elements][ai-elements], [assistant-ui Parts][aui-parts], [Toolkit migration guide][aui-tools], [History][aui-history], [CopilotKit Generative UI][copilot-ui], [HITL][copilot-hitl], [Threads][copilot-threads], [Open UI][copilot-open].
- Protocols. [MCP Apps Overview][mcp-apps], [Specification][mcp-spec], [CSP/CORS][mcp-csp], [Elicitation][mcp-elicitation], [A2UI legacy URL][a2ui-redirect], [A2UI v1.0][a2ui], [AG-UI Events][ag-events], [Interrupts][ag-interrupts], [State][ag-state].
- Web security. [MDN Image Element][mdn-img], [OWASP SSRF Prevention][owasp-ssrf].
- Local evidence. Source links appear with the corresponding claims. Astryx inventory was checked against the installed `@astryxdesign/core` 0.5.2 package and its `Lightbox`, `Markdown`, `Citation` and `Chat` source directories.

[openai-search]: https://platform.openai.com/docs/guides/tools-web-search
[openai-ui]: https://developers.openai.com/apps-sdk/build/chatgpt-ui
[openai-ref]: https://developers.openai.com/apps-sdk/reference
[openai-guides]: https://developers.openai.com/apps-sdk/concepts/ui-guidelines
[claude-artifacts]: https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them
[claude-citations]: https://platform.claude.com/docs/en/build-with-claude/citations
[claude-input]: https://platform.claude.com/docs/en/agent-sdk/user-input
[gemini-canvas]: https://support.google.com/gemini/answer/16047321
[gemini-research]: https://support.google.com/gemini/answer/15719111
[gemini-files]: https://support.google.com/gemini/answer/14903178
[gemini-audio]: https://support.google.com/gemini/answer/16047373
[gemini-grounding]: https://ai.google.dev/gemini-api/docs/google-search
[slack-blocks]: https://docs.slack.dev/reference/block-kit/blocks
[slack-actions]: https://docs.slack.dev/interactivity/handling-user-interaction
[slack-unfurls]: https://docs.slack.dev/messaging/unfurling-links-in-messages
[discord-messages]: https://discord.com/developers/docs/resources/message
[discord-components]: https://discord.com/developers/docs/components/reference
[discord-actions]: https://discord.com/developers/docs/interactions/receiving-and-responding
[telegram]: https://core.telegram.org/bots/api
[cards-schema]: https://learn.microsoft.com/en-us/adaptive-cards/authoring-cards/card-schema
[cards-text]: https://learn.microsoft.com/en-us/adaptive-cards/authoring-cards/text-features
[cards-actions]: https://learn.microsoft.com/en-us/adaptive-cards/authoring-cards/universal-action-model
[ai-chat]: https://ai-sdk.dev/docs/ai-sdk-ui/chatbot
[ai-ui]: https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces
[ai-approval]: https://ai-sdk.dev/cookbook/next/human-in-the-loop
[ai-storage]: https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence
[ai-elements]: https://ai-sdk.dev/elements/llms.txt
[aui-parts]: https://www.assistant-ui.com/docs/api-reference/primitives/message-part.md
[aui-tools]: https://www.assistant-ui.com/docs/migrations/toolkit-tools.md
[aui-history]: https://www.assistant-ui.com/docs/integrations/persistence/custom-adapter.md
[copilot-ui]: https://docs.copilotkit.ai/concepts/generative-ui-overview
[copilot-hitl]: https://docs.copilotkit.ai/human-in-the-loop
[copilot-threads]: https://docs.copilotkit.ai/threads-lifecycle
[copilot-open]: https://docs.copilotkit.ai/generative-ui/open-generative-ui
[mcp-apps]: https://modelcontextprotocol.io/docs/extensions/apps
[mcp-spec]: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
[mcp-csp]: https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/csp-cors.md
[mcp-elicitation]: https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation
[a2ui-redirect]: https://a2ui.org/specification/v0.8-a2ui/
[a2ui]: https://a2ui.org/specification/v1.0-a2ui/
[ag-events]: https://docs.ag-ui.com/concepts/events
[ag-interrupts]: https://docs.ag-ui.com/concepts/interrupts
[ag-state]: https://docs.ag-ui.com/concepts/state
[mdn-img]: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/img
[owasp-ssrf]: https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
