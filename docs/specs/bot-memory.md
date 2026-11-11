# Spec: Bot Memory — private and shared automatic memory

Status: approved 2026-11-11. The design was first approved as `.scratch/bot-memory/spec.md`. On 2026-11-11 it moved here, was rearranged into the project's spec format, and was updated for the [pi-durable runtime](bot-runtime.md). The memory design is unchanged. New are the runtime mapping, and the template sections the old spec lacked: tech stack, project structure, code style, boundaries, success criteria, and open questions.

Depends on: [Bot runtime on pi-durable](bot-runtime.md), which provides the `beforeRequest` and `afterRun` hooks.

> The research behind this design was written up as `reports/Personal agent memory design.md`, which is not in the repository.

## Objective

### Problem

A Bot forgets the user between conversations, so a new Thread starts from nothing. A personal assistant that forgets is not a personal assistant.

The other extreme also fails. From long use of Hermes, the user's biggest problem is that its `MEMORY.md` is sometimes wrong, and wrong memory then has to be fixed by hand. The user prefers how Grok Bot and Muse feel: memory works in the background, and the user does not have to know about it or look after it.

So memory has to be invisible when it works, easy to correct when it is wrong, and hard to get wrong in the first place. Wrong memory is the main failure this design is built to prevent.

### Solution

Each Bot gains a private memory, and all Bots share one Shared Memory. Both work by themselves. There is no memory screen, file, notification, or setup. The Service learns Facts from conversation, recalls relevant ones on each model request, and leaves them out of the Bot's stored conversation.

Accuracy comes from structure rather than from trusting a model:

- a Fact counts as something the user said only if the Service finds the quote in the user's own message
- outside content is never recalled automatically
- a newer fact replaces an older one

When memory is wrong, the user just says so in chat. It stops being wrong on the next message and is not relearned. If the Bot cannot find or fix it, `/memory` commands give a direct path that the Service runs without the model. These exist only for when they are needed, and nothing ever prompts the user to use them.

Private Facts belong to one Bot. Shared Memory holds what every Bot should know about the user, and every Bot also knows who the other Bots are, even outside a group.

### User stories

**Invisible by default**

1. As a user, I want my Bot to learn without my asking, so that I do not have to manage memory.
2. As a user, I want no notifications, lists, or files about memory in normal use, so that it stays out of my way.
3. As a user, I want to say "remember this" when I choose to, so that something important is saved at once.
4. As a user, I want facts from one Thread available in my Bot's other Threads, so that a new conversation does not start from nothing.
5. As a user, I want small talk and one-off details not saved, so that memory does not fill with noise.
6. As a user, I want secrets kept out of memory as far as possible, and sensitive categories saved only when I ask, so that memory does not become a liability.

**Being right**

7. As a user, I want a fact treated as mine only when my own words prove it, so that a model's guess cannot pass as something I said.
8. As a user, I want a new fact to replace the one it contradicts, so that my Bot uses the current truth.
9. As a user, I want nothing but my own words able to override what I said, so that a web page or another Bot cannot replace it.
10. As a user, I want facts from web pages, tools, attachments, and other Bots kept out of automatic recall, so that outside content cannot quietly shape my Bot.
11. As a user, I want a Bot's inference kept below what I actually said, so that its guesses do not outrank me.
12. As a user, I want a dated plan to stop being treated as current after its date, so that old plans do not come back as facts.
13. As a user, I want a Bot with no relevant memory to say it does not know, so that it does not invent memories.

**Fixing wrong memory**

14. As a user, I want to correct a fact just by telling my Bot it is wrong, so that fixing memory is ordinary conversation.
15. As a user, I want a correction to apply on my next message, including in other Threads, so that I do not have to repeat it.
16. As a user, I want a corrected or forgotten fact not to come back later, so that I only have to fix it once.
17. As a user, I want the old value gone from what my Bot sees, so that the wrong value cannot sit beside the right one.
18. As a user, I want a direct way to list, explain, and delete facts without the model involved, so that I can fix memory even when the Bot is the one confused.
19. As a user, I want to see where a fact came from when I ask, so that I can tell why my Bot believes it.
20. As a user, I want a diagnostic command outside the app's clients, so that I can inspect memory if something seems seriously wrong.

**Recall**

21. As a user, I want relevant facts brought up automatically, so that the Bot does not have to remember to look.
22. As a user, I want no memory brought up when none is relevant, so that memory does not derail or distort unrelated work.
23. As a user, I want my Bot to search our past conversations when needed, so that "what did we decide last month?" gets a real answer.
24. As a user, I want no fixed storage limit, so that older facts are not squeezed out.

**Privacy and deletion**

25. As a user, I want each Bot's private memory unavailable to other Bots through the product, so that each stays private.
26. As a user, I want to be told honestly what "private" covers, so that I know a Bot with shell access is not sandboxed.
27. As a user, I want forgetting to remove a fact from memory, search, and disk, so that the request is real.
28. As a user, I want honest wording on what forgetting does not reach, so that I can trust the rest.
29. As a user, I want deleting a Bot to delete its memory and conversations, so that deletion is complete.
30. As a user, I want a Bot in a group to use only what it learned in that group unless it looks further, so that its private memory does not leak to other Bots.
31. As a user, I want what another Bot says in a group never to become something my Bot believes I said, so that Bots cannot plant facts in each other.

**Reliability**

32. As a user, I want learning failures never to interrupt a conversation, so that a provider outage does not affect my work.
33. As a user, I want failures recorded where I can find them, so that memory cannot silently stop working.

**Shared Memory**

34. As a user, I want every Bot to know who my other Bots are and what they do, in any Thread, so that they always know each other.
35. As a user, I want to tell one Bot my name or time zone and have all of them know it, so that I do not repeat myself.
36. As a user, I want to say "tell all my Bots" and have that shared, so that I decide what else everyone knows.
37. As a user, I want a correction to a shared fact to reach every Bot on my next message, so that I only fix it once.
38. As a user, I want guesses and outside content kept out of Shared Memory, so that one Bot's mistake cannot spread to all of them.
39. As a user, I want shared facts kept when the Bot that learned them is deleted, so that deleting a Bot does not make the others forget me.

## Tech stack

- The [runtime spec's](bot-runtime.md#tech-stack) stack: Bun, TypeScript, `pi-ai`, and `pi-durable`, pinned exactly.
- Facts, tombstones, and the event log live in the Service's SQLite database, in Service tables next to the `pi_` tables.
- Search is SQLite FTS5 with BM25 ranking. The tokenizer is chosen before launch; see [Recall](#recall).
- No embedding model or vector store in v1.

## Design

### Lessons applied from Hermes

| Hermes problem | This design |
| --- | --- |
| `MEMORY.md` can be wrong, and fixing it is manual | Provable user facts, outside content kept out of recall, correction by chat, no relearning |
| Small capped files | No storage cap; only what is recalled has a budget |
| Frozen snapshot | Recalled per model request, and never stored in the conversation |
| Depends on the model to curate | The Service runs learning and recall |
| Failures can be silent | `/memory status` and the CLI show them |

Hermes's files are visible and hand-edited. This design has neither, in line with the user's preference.

### How memory uses the runtime

Memory is an app extension in the runtime registry. It uses the runtime's [hook points](bot-runtime.md#hook-points-for-later-specs):

| Memory part | Runtime feature |
| --- | --- |
| Recall | a `beforeRequest` hook. It adds recalled Facts to that one model request, and they are never stored as entries. |
| Background Review | a durable task, started from `afterRun` |
| Memory tools | tools in the memory extension. The Bot's identity comes from the conversation's Bot, never from tool arguments. |
| `/memory` commands | handled by the Service before input is submitted to the conversation, so the model never sees them |
| Service-rendered receipts | Service Messages. They are recorded in the conversation only as `write` entries if the Bot needs to see them. |

### Ownership and storage

- Memory is Service-owned Bot data in the Service's SQLite database. It is not a file, and it is not in the Shared Workspace.
- This replaces the `~/.omarchy-bot/memory/` intention in the old product boundary.
- Verbatim Thread history stays the source of truth. Facts are a derived index and can be rebuilt or corrected.

### Shared Memory

Shared Memory has two separate parts:

- **Bot roster:** every model request, in any Thread, tells the Bot each other Bot's name and a short excerpt of its Job/Instructions. It is read live from Bot Profiles in a prompt section, and is not stored as Facts, so it cannot go stale or be wrong. Personality is not included.
- **Shared Facts:** Facts with `scope: shared`, which every Bot recalls.

The Service enforces what can become a Shared Fact:

- **Your own words only:** a Shared Fact must be `user_stated` with a verified quote. Inferences and tool, attachment, and peer content can never be shared.
- **Private by default:** a Fact is shared only in two cases:
  - its `slot` is on a fixed list, initially name, preferred name, time zone, and language
  - the user explicitly asks for it to be shared, through `memory_save` on a Turn the user started

  The model's own judgment cannot widen the list.
- **One value:** a shared `slot` holds one current value for all Bots, and no Bot keeps a private copy. Writes run in a transaction, so two Bots learning the same fact produce one Fact.
- **Corrections and tombstones are shared:** a correction through any Bot applies to all of them on the next message, and blocks relearning by any of them.
- **Sensitive categories** are never added to the fixed list.
- **Ownership:** Shared Facts belong to the user, not the Bot that learned them. They survive that Bot's deletion, with the source reference cleared.
- **What is not shared:** other Bots' private Facts, and what other Bots are working on or have learned. There is no shared work log. Bots find these out by asking each other, through Bot mail or in a Group Thread, and the other Bot chooses what to answer. Under the trust rules, what a Bot learns this way is a tainted `peer_bot` Fact.

### Facts

A **Fact** belongs to one Bot, or to Shared Memory, and holds:

- `scope`: `private` or `shared`
- `text`: one self-contained statement
- `kind`: `preference`, `person`, `plan`, `fact`, or `event`
- `source`: `user_stated` or `observed`
- `origin`, always set by the Service: `user_message`, `bot_inference`, `tool`, `attachment`, or `peer_bot`
- `quote`: the supporting text, when one exists
- `slot`: an optional stable key such as `home_city`
- `sourceThreadId`, `sourceMessageId`, and `reviewModel`
- `createdAt`, `lastConfirmedAt`, `validFrom`, and `validUntil`
- `supersededBy`

Numeric confidence scores are deliberately excluded: the research found no benefit without a real reliability signal.

### Trust rules

The Service enforces these. No model makes these decisions:

- **`user_stated` requires proof:** the Service must find `quote` as a literal substring of the user's own Message text. Otherwise the Fact is `observed`.
- **Only user evidence overrides user evidence:** non-user evidence cannot supersede or confirm a `user_stated` Fact.
- **Taint is sticky:** a conversation becomes tainted when it uses external-content tools, or receives an attachment, mail, or peer messages. The runtime module marks this as tools run and input arrives. It stays tainted for the life of that conversation.
- **Tainted Facts are saved but not recalled automatically.** They stay findable through `memory_search`, and the user's own words can confirm them.
- **Verified user Facts are exempt from taint.** A `user_stated` Fact with a verified quote stays recallable, even if learned in a tainted conversation. Without this, every group Fact would be tainted, because every group conversation receives peer messages.
- **Framing is hygiene, not a boundary:** recalled entries are labeled as data that may be out of date. This is worth doing, but safety rests on the rules above.

### Learning

- **Background Review** is a durable task. After each run, `afterRun` starts or moves forward the Thread's review task, which sleeps with `sleepUntil` until one of these is true:
  - the Thread has had no Active Turn for 10 minutes
  - the Thread has waited too long while busy

  The task then reviews Messages after the Thread's watermark. Because it is durable, a Service restart resumes it through `resume()`, and no separate start-up scan is needed.
- **The review call** is one isolated `pi-ai` call with no tools and no conversation. Its input is bounded at 32 KiB per batch.
- **Review input** excludes attachments, Tool Calls, and recalled memory text, so a recalled Fact cannot be relearned from itself. Recall text never enters stored entries, so this holds by construction.
- **Supersession candidates** are passed to Review by `slot` and by `kind`, not by keyword search alone, so "wife" and "spouse" can still meet.
- **Review prompt rules:**
  - keep only what stays true across chats
  - write each Fact as a statement, not a command
  - treat an empty answer as the normal result, because most conversations need no change
  - make at most 20 operations per batch
- **Review may replace its own Facts:** `observed` Facts can be superseded by Review. Only the user's words can change `user_stated` Facts.
- **Review output** is JSON with `add`, `supersede`, and `confirm` operations, strictly validated. Invalid output is discarded, and the watermark does not move. After three failures, the batch is set aside for retry and recorded.
- **`memory_save`** saves immediately for "remember this". It stores `observed`, and Review can promote it with a verified quote.
- **Same-slot updates are deterministic:** a new `user_stated` Fact on an occupied slot supersedes the old value with no model decision. Other conflicts are left to Review.
- **Quality of the review model matters.** Which model reviewed is recorded per Fact, because weak models invent facts.
- There is no consolidation job, "dreaming", or age-based decay. The research found aggressive consolidation can lose facts, and found no controlled evidence for the rest.
- History from before this feature is not reviewed.

### Recall

- **Delivery is ephemeral.** Recall runs in the `beforeRequest` hook before each model request. It reaches the model but never enters the stored conversation. This keeps corrections clean, prevents context growth, and stops memory labels being lost in compaction. Prototype step 2 of the [runtime spec](bot-runtime.md#prototype) checks this.
- **Query:** FTS5 over Facts, using the user's words parsed into OR-ed quoted terms, with BM25 weighting. Raw text must never be passed as an FTS5 query: local tests showed natural questions returning nothing, and apostrophes raising syntax errors.
- **Relevance floor:** recall may return nothing, and should when nothing clears the floor. The budget is a ceiling, initially 2 KiB, not an amount to fill.
- **Pinned profile:** a small set of about 1 KiB, holding `user_stated` identity and standing preferences, rendered live from the database. Otherwise preferences get no special treatment, as always-on preferences are the riskiest for over-personalization.
- **Unreviewed messages:** recall also searches the user's own recent Messages not yet reviewed, labeled as such, so a correction works before Review has run.
- **Excluded:** superseded Facts, expired `plan` and `event` Facts, and tainted Facts.
- **In Group Threads:**
  - Recall covers Shared Facts, private Facts whose source is that group, and unreviewed Messages from that group.
  - The pinned profile holds Shared Facts only.
  - A Bot's other private Facts are reachable only through `memory_search`.
- **Peer statements** in a group are stored as tainted `peer_bot` Facts.
- **Known leak path:** anything a Bot finds with `memory_search` and repeats in a group becomes visible to other members. The Base Prompt tells it not to repeat private Facts unless the user asks. That is a request to the model, not a guarantee.
- **Vectors:** added only if hybrid search beats FTS5 by 10 or more points on a held-out paraphrase test, and the search tool does not recover the difference. Embeddings need an extra model and credentials.
- **Tokenizer:** Chinese must be handled before launch. In a local test, `柏林` did not match `我住在柏林` under `porter unicode61`. The trigram tokenizer or similar must be tested.

### Tools

Tools in the memory extension. The Bot's identity is taken from the conversation's Bot, never from arguments:

- `memory_save`: add a Fact. It accepts `scope: shared` only with a quote verified against the user's Message, on a Turn the user started. Otherwise it fails and nothing is saved as shared.
- `memory_search`: search Facts, including tainted and replaced ones on request. It returns source, origin, and date.
- `memory_forget`: delete Facts by ID.
  - It is allowed only on an untainted Turn started by the user, so that injected content cannot destroy memory.
  - Group Turns are always tainted, so in a group the Bot asks the user to do this in its Direct Thread.
  - A new user statement on the same `slot` still replaces the old value there.
- `conversation_search`: search the user's Messages and Response Blocks in this Bot's own Threads, excluding Thinking and Tool Calls.

### Correcting and forgetting

- **Correction in chat:** "that's wrong" resolves through the Bot to Fact IDs. The Service writes the change, so the new value is `user_stated` with the user's message as the quote, and the old one is superseded.
- **Service-rendered receipt:** when a Bot changes memory at the user's request, the Service, not the model, appends a short line stating exactly what changed. It appears only for these requests, so memory stays invisible otherwise.
- **`/memory` commands:**
  - `list`, `why <id>`, `delete <id>`, and `status`
  - handled by the Service before any input reaches the conversation, and rendered literally from the database
  - never advertised in normal use
  - Direct Threads only, because other members could read the output in a group
- **Diagnostic CLI:** the Service's CLI gets a `memory` command with the same operations, on the machine running the Service. Its executable name follows the rename.
- **Tombstones:** a forgotten or corrected Fact leaves a tombstone. It holds the Fact ID, the source Message IDs, and a keyed hash of the normalized text. This blocks relearning without keeping the text. A new explicit user statement overrides it. It does not catch paraphrases. Test how well this works, because it is the main defense against wrong facts coming back.
- **Purge steps:** a local SQLite test found deleted text stayed in the database file until FTS5 `optimize` ran with `secure_delete=ON`, or `optimize` with `VACUUM`. Forgetting must run these. The `pi_` tables share the same database file, so `secure_delete` is set for the whole database.
- **Conversation reset:** a study found agents act on revoked values even when told to forget them. So each Thread where the forgotten fact actually appeared gets a new conversation after a forget, and the old conversation's entries are deleted.
  - The new conversation is seeded from the Service transcript, the same way as the runtime's [migration fallback](bot-runtime.md#storage).
  - Continuity loss must be measured.
  - Ephemeral recall limits how often a reset is needed.
- **Truthful wording:** "Removed from memory, search, and what I see from now on. Old Thread text stays until you delete the Thread. Your model provider may have received it under its own policy."
- **Deletion:**
  - Bot Deletion removes that Bot's private Facts, private tombstones, search rows, and conversations. Shared Facts stay.
  - Deleting a Thread removes its search rows and keeps its Facts, with the source reference cleared. The confirmation says so.

### Secrets and sensitive information

- A deterministic scan runs on proposed Fact text and fails closed. It also covers the search index.
- Health, politics, religion, and similar categories are saved only on explicit request.
- The promise is best effort. Scanners miss secrets, and nothing recognizes "the alarm code is 4417".

### Privacy

- Every private read and write is scoped by the Bot ID that the Service derives. There is no operation for reading another Bot's private memory. Shared Facts are readable by every Bot.
- "Private" is an API-level guarantee, not an OS boundary. As the [runtime spec](bot-runtime.md#file-access) says, Bots run as the user and the workspace is not a sandbox. File tools always refuse the Service data directory, but a Bot with shell access could likely read the database. OS-level isolation is later work.
- A Bot's private folder in the Shared Workspace holds notes about itself, not memory, so its file tools cannot edit its memory.

### Reliability and observability

- Failures stay out of the conversation. They are visible in `/memory status` and the CLI: last review, batches set aside, and counts.
- An append-only event log records memory operations and which Fact IDs each model request received. It uses content hashes, so deletion is honored.

### API and documents

- Service-rendered lines and `/memory` output likely need a new Message type, and so a client protocol change. Check during implementation.
- **Workspace glossary:** add Memory, Fact, Shared Memory, Bot Roster, Background Review, and Recall, if the glossary is restored to `docs/`.
- **New ADR:** Service-owned private and shared memory, provable user facts, ephemeral recall, and no memory screen.

## Commands

```
bun install --frozen-lockfile
bun run typecheck
bun run lint:boundaries
bun test apps/daemon
bun test                 # full Bun suite
```

The evaluation runs with its own script against real providers. It is added with the evaluation set.

## Project structure

```
apps/daemon/src/modules/memory/          new: Facts, trust rules, Review, recall, tombstones, purge
  store.ts                               Fact, tombstone, and event-log tables
  recall.ts                              FTS5 query building and the relevance floor
  review.ts                              the Background Review task and output validation
  commands.ts                            /memory commands and the CLI
  *.test.ts                              tests next to the code
apps/daemon/src/modules/runtime/extensions/memory.ts
                                         memory tools, the beforeRequest hook, the afterRun hook
tests/memory-eval/                       the evaluation set and its runner, outside CI gates
```

Only `modules/runtime` imports pi-durable. The memory module is plain Service code that the runtime extension calls.

## Code style

Follow the existing daemon modules. The runtime extension depends on a small memory API, not on storage details:

```ts
export interface BotMemory {
  recall(botId: BotId, threadId: ThreadId, userText: string): Promise<RecallResult>;
  scheduleReview(threadId: ThreadId): Promise<void>;
  save(turn: TurnContext, input: SaveFactInput): Promise<FactId>;
  forget(turn: TurnContext, factIds: FactId[]): Promise<ForgetReceipt>;
}
```

## Testing strategy

- **Write the evaluation first.**
  - Build 150 to 200 items from redacted history and scripted life events, with the truth decided before the text is written.
  - Compare paired arms on one model: no memory, full history, FTS5 without a relevance floor, FTS5 with the floor, the floor plus the search tool, and hybrid.
  - Replay at simulated weeks 3, 6, and 9.
  - Do not act on differences under about 10 points.
- **Wrong memory is the headline measure,** reflecting the user's main complaint:
  - wrong-fact rate, reviewed by a person each month, per review model
  - invented-fact rate
  - false `user_stated` rate under injected web, attachment, and peer content, which should be zero in the fixed attack set
  - old value present anywhere in the prompt after a correction, which should be zero
  - a wrong fact returning after correction, at later simulated weeks
- **Also measure:**
  - recall@5 by slice, including paraphrase
  - correct, wrong, abstained, and confident-wrong answers, counted separately
  - harm on tasks that do not need memory, compared with no memory
  - disagreement between the Bot's answer and the Service's list, where any disagreement is a bug
  - leaks after a forget, relearning, and bytes left on disk
  - context growth, cache hit rate, and review cost per Bot
- **CI gates, deterministic only:**
  - private Facts are scoped to their Bot
  - only verified `user_stated` Facts can be shared
  - slots off the list stay private
  - a shared correction reaches every Bot's next prompt
  - Shared Facts survive Bot Deletion
  - the roster reflects a renamed or deleted Bot on the next request
  - a Group Turn receives no Facts from outside that group
  - `/memory` is refused in a group
  - peer text never becomes `user_stated`
  - a tool can never produce `user_stated`
  - quote verification
  - non-user evidence cannot override `user_stated`
  - tainted Facts are never recalled
  - tombstones block relearning
  - no forgotten bytes remain after purge
  - recall text is absent from stored pi-durable entries
  - a pending Review task survives a Service restart and runs once
- **Primary seam:** the Service with the runtime on a fake model provider, as in the [runtime spec's testing strategy](bot-runtime.md#testing-strategy). Tests assert what reaches the model request and what Facts exist afterward.
- Real-provider scores are evidence for tuning, not CI gates. Add logged real failures to the set each month.

## Boundaries

- **Always:**
  - derive the Bot's identity in the Service, never from tool arguments
  - keep recall out of stored entries
  - run the purge steps on every forget
  - keep the wording about "private" and forgetting truthful
- **Ask first:**
  - adding slots to the shared list
  - adding embeddings or any extra model
  - changing the recall budget or relevance floor defaults
- **Never:**
  - let a model decide `source`, `origin`, or taint
  - show memory UI or notifications in normal use
  - pass raw user text as an FTS5 query

## Success criteria

- Every CI gate in the [testing strategy](#testing-strategy) passes.
- On the evaluation set: zero false `user_stated` Facts under the attack set, and zero old values in the prompt after a correction.
- The wrong-fact rate is no worse than the full-history arm, and memory causes no measurable harm on tasks that do not need it.
- A correction made in one Thread changes the next model request in every Thread of that Bot, and in every Bot for a Shared Fact.

## Out of scope

- A memory screen or any UI beyond chat.
- Sharing private Facts, work logs, or current activity between Bots.
- Embeddings, vector stores, and knowledge graphs in v1.
- Consolidation jobs and external memory providers.
- Importing or exporting memory.
- Proactive behavior, which has its own spec and will depend on memory.

## Further notes

- **Other products:** Grok Bot's personal Bots are chat-only, as this design mostly is. Muse feels invisible in use, but Meta's help page describes editable `Memory.md` files, so its memory isn't actually hidden. Neither has published evidence of how well its memory works. Grok Bot's docs warn that memory "is not a reliable source of truth".
- **Invisible has a cost:** with nothing visible, a wrong Fact may go unnoticed until it causes a wrong answer. Provable user facts and keeping outside content out of recall reduce how often this happens, but cannot prevent it.
- **Shared Memory raises the stakes:** a wrong Shared Fact is wrong in every Bot at once, which is why only verified user words can enter it. Include it in the wrong-fact review.
- **Reversal:** the user first chose fully private memory, then added Shared Memory so that Bots always know each other. Grok Bot shares a few facts such as name and time zone, but its docs say deleting a Bot deletes shared facts it saved. This design keeps them.
- **Background cost:** Review costs one small model call per batch, using the user's allowance without visible activity.
- **Untested design:** the trust rules and tombstones are a synthesis from research, and no shipping product documents them. The evaluation must prove them.

## Open questions

- Should Review use the Bot's own model, or one Service-wide review model? The spec records the model per Fact but does not choose.
- How much continuity does a conversation reset after a forget actually lose? Measure it before launch.
