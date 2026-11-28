# Spec: Group Threads — the user and several Bots in one conversation

Status: approved 2026-11-11. The design was first approved as `.scratch/group-threads/spec.md`. On 2026-11-11 it moved here, was rearranged into the project's spec format, and was updated for the [pi-durable runtime](bot-runtime.md). The group design is unchanged. New are the runtime mapping, and the template sections the old spec lacked: tech stack, commands, project structure, code style, boundaries, success criteria, and open questions.

Depends on: [Bot runtime on pi-durable](bot-runtime.md).

## Objective

### Problem

A user can create several Bots with different Jobs, but can only talk to one at a time. To get a researcher, a writer, and a personal assistant working on the same question, the user has to copy text between Threads or wait for Bot mail. Bot mail opens a separate Thread owned by the target Bot, and never returns to the place the conversation started.

The user wants their Bots to work as personal assistants that can also chat together in one place, with the user present. Today the model cannot express that: a Thread belongs to exactly one Bot, has one conversation, has one Active Turn, and owns attachments through that Bot.

### Solution

Add **Group Threads**: one conversation between the user and two or more member Bots, with no maximum group size.

- The user creates a Group Thread from the Sidebar and writes in one Composer, with attachments.
- `@BotName` addresses specific Bots.
- A message with no mention reaches every member. Each Bot decides whether to reply from its own Job/Instructions and Personality, under reply rules that every Bot has even with no Job set.
- The Service, not the model's good behavior, enforces that decision: a Bot's output can reach the transcript only after an exact reply decision.
- A Bot can also bring in another member when it finishes speaking.
- Each Bot works in its own conversation and on its own Bot Screen, and their output appears in one attributed transcript.

Every Bot runs on the app's own [pi-durable runtime](bot-runtime.md), whose prompt is built only from app sections. There is no vendor default prompt to replace.

The only human participant is the owner of the Service. Other people, external messaging groups, and user accounts are out of scope.

Existing one-Bot Threads, Bot mail, and Takeover keep their current behavior.

### User stories

**Creating and finding Group Threads**

1. As a user, I want to create a Group Thread by choosing two or more Bots with no maximum, so that the group fits the work.
2. As a user, I want to name a Group Thread, or get a default name from its members, so that I can tell groups apart.
3. As a user, I want Group Threads in their own Sidebar section, so that they do not blur into the Bot list.
4. As a user, I want each Group Thread's Sidebar entry to show its members' avatars, unread count, and activity, so that I can see where work is happening.
5. As a user, I want to rename a Group Thread, so that its name can follow the work.
6. As a user, I want to add a Bot to a Group Thread, so that I can bring in a new skill mid-conversation.
7. As a user, I want to remove a Bot from a Group Thread, so that it stops receiving messages there.
8. As a user, I want removal rejected with a clear message while that Bot has an Active Turn in the group, so that in-flight work is not orphaned.
9. As a user, I want a Bot's own History to keep listing only its one-Bot Threads, so that selecting a Bot behaves as it does today.
10. As a user, I want the app's most-recently-active choice to keep selecting a Bot, so that opening the app does not change.

**Addressing Bots and deciding to reply**

11. As a user, I want `@` in the Composer to offer the group's members by name and avatar, so that I can address a Bot without typing its exact name.
13. As a keyboard user, I want the mention list fully keyboard-operable with accessible labels, so that addressing a Bot needs no pointer.
12. As a user, I want a mention to keep working after a Bot is renamed, so that history and routing stay correct.
13. As a user, I want a message mentioning Bots to reach only those Bots, so that I can target work and avoid waking the whole group.
14. As a user, I want a message with no mention to reach every member, so that whichever Bots are relevant can respond.
15. As a user, I want each Bot to have a Job/Instructions system prompt and a separate Personality prompt, so that I can define what it is responsible for and how it behaves.
16. As a user, I want a Bot's Personality to apply in one-Bot and Group Threads, so that it stays the same teammate everywhere.
19. As a member Bot, I want to decide whether a message with no mention needs my reply, using my Job/Instructions and Personality, so that I speak when it is my duty.
17. As a user, I want every Bot to have built-in reply rules, even with an empty Job and Personality, so that a new Bot does not answer everything.
18. As a user, I want a Bot's instructions unable to remove the built-in reply rules, so that group behavior stays dependable.
19. As a user, I want a Bot that decides not to reply to add nothing to the transcript, so that the conversation stays readable.
20. As a user, I want anything other than an exact reply decision treated as not replying, so that a model that insists on saying something cannot leak chatter into the group.
21. As a user, I want a Bot that passes not to run tools or start a Turn, so that a pass has no side effects and costs little.
22. As a user, I want Bots to decide one after another when no one is mentioned, so that a later Bot can see an earlier reply and not repeat it.
23. As a user, I want a slow Bot not to hold up the others for long, so that one long job does not silence the group.
24. As a user, I want a quiet note when every Bot passes on my message, so that I know it was received and can mention a Bot directly.
25. As a user, I want a mentioned Bot always to take a Turn, so that a direct question is never filtered out.
26. As a user, I want Bots already started to work at the same time, so that a long job in one does not stop the rest.
27. As a user, I want each Bot to keep its own Job/Instructions, Personality, and Display Settings in a group, so that it stays the same teammate.
31. As a member Bot, I want to receive the user messages, attachments, and other Bots' responses I have not yet seen, so that I can follow the conversation.
32. As a privacy-conscious user, I want other Bots' Thinking and Tool Calls kept out of what a Bot receives, so that groups share the conversation and not private working state.
33. As a member Bot, I want each message I receive labeled with its author, so that I can tell the user's requests from a peer's statements.
28. As a user, I want a peer Bot's text unable to pose as a user message, so that a Bot that read a hostile web page cannot speak with my authority.
35. As a member Bot, I want to know the group's members and my own identity, so that I can decide whom to bring in.
36. As a member Bot, I want to bring in other members when I finish speaking, so that I can hand over work in the open.
29. As a user, I want a Bot's response to wake other Bots only when it explicitly brings them in, so that one reply does not set off the whole group.
30. As a user, I want a brought-in Bot to start only after the first Bot's Turn completes, so that it can read the finished response.
31. As a user, I want a failed Turn to bring in nobody, so that a broken step does not trigger more work.
32. As a user, I want several requests to a busy Bot merged into one later Turn, so that it reads them together and does not run once per request.
33. As a user, I want a new message from me to cancel Bot-to-Bot work that has not started, so that I can take the conversation back at any point.
34. As a user, I want my message to steer a Bot that is already working, if it decides the message concerns it or I mentioned it, so that Steering works in a group without redirecting unrelated work.
35. As a user, I want Bot-initiated requests never to steer an active Turn, so that peers cannot corrupt in-flight work.
36. As a user, I want a Bot in a group to keep Bot mail, so that it can still hand off work to a Bot outside the group.

**Attachments**

37. As a user, I want to attach files and images to a group message using the same Composer actions as a one-Bot Thread, so that groups work the way I expect.
38. As a user, I want group attachments to render in history as they do elsewhere, so that I can see what I sent.
47. As a member Bot, I want attachments sent while I was not addressed to arrive in my next Turn, so that I can catch up on what the group has seen.
39. As a user, I want a message rejected with a clear reason if no Bot it reaches can read the attachment, so that I do not send something nobody can use.
49. As a member Bot whose model cannot read an attachment type, I want to be told the file exists and that I cannot read it, so that I do not guess at its contents.
40. As a user, I want a message with an attachment to a busy Bot delivered when that Bot's Turn ends, so that the attachment is not refused the way Steering refuses it today.
41. As a user, I want deleting a Bot to leave group attachments in place, so that other members and my history keep them.

**Transcript**

42. As a user, I want each run of Bot output labeled with that Bot's name and avatar, so that I can always see who said what.
43. As a user, I want output from concurrent Bots kept in its true order without any Bot's blocks being reordered, so that history stays truthful.
44. As a user, I want one working avatar per active member, so that I can see who is still working.
45. As a user, I want each Bot's Display Settings applied to that Bot's blocks only, so that hiding one Bot's Tool Calls does not hide another's.
46. As a user, I want an unavailable or failed member reported in the transcript beside that member's name, so that one failure does not look like the whole group failing.
47. As a user, I want a message to wait for a member whose model is not ready and run when it becomes ready, so that a temporary failure loses nothing.
48. As a user, I want accepted work to survive a Service restart without running twice, so that restarts neither lose nor duplicate actions.

**Computer, approvals, and attention**

49. As a user, I want to choose which member's Bot Screen to view from the group header, so that I can watch any of them.
50. As a user, I want Takeover to work on the chosen member's Screen, so that I can step in for that Bot only.
51. As a user, I want a Local Sidecar or file-access approval shown in the group with the requesting Bot's name, so that I know who is asking.
52. As a user, I want a Turn started by my message to use This Device, and a Bot-initiated Turn to have no This Device, so that a Bot cannot reach my laptop without my message having started the work.
53. As a user, I want unread counts and notifications to belong to the Group Thread, so that one group message does not mark every member Bot as unread.
54. As a user, I want a member Bot's activity point lit while it works in a group, so that Bot Activity stays true across all of its Threads.
55. As a user, I want my Composer Draft kept per Group Thread and per window, so that drafts behave as they do elsewhere.

**Shared models and app-owned prompts**

56. As a user, I want Bots to stay distinct even when they use the same LLM model, so that identity always follows the Bot.
57. As a user, I want a later Bot to know that an earlier Bot is already replying, so that Bots on the same model do not all give the same answer.
58. As a user, I want a rate limit or outage on a shared model reported beside the affected Bots, so that a failure does not look like those Bots choosing not to reply.
59. As a user, I want every Bot's system prompt to come from the app, so that all my Bots follow one set of behavior.
60. As a user, I want this to apply in one-Bot Threads too, so that a Bot does not change character between a Thread and a group.
61. As a user, I want my own Skills to keep working, so that app-owned prompts do not remove my configuration.
62. As a user, I want a Bot to use its tools correctly, so that an app-written prompt does not make it worse at work.

**Lifecycle and upgrade**

63. As a user, I want deleting a Bot to remove it from its groups while keeping its past messages under the name it had, so that other Bots' conversations are not rewritten.
64. As a user, I want a group left with no members to stay readable and refuse new messages, so that history is not lost.
65. As a user, I want upgrading to keep every existing Thread, Message, attachment, and conversation mapping intact, so that the feature costs me no history.
66. As a user, I want an out-of-date client told to update rather than misreading groups, so that the mismatch is clear.

## Tech stack

- The [runtime spec's](bot-runtime.md#tech-stack) stack: Bun, TypeScript, `pi-ai`, and `pi-durable`, pinned exactly.
- Group records live in the Service's SQLite database. Each member's conversation lives in the `pi_` tables like any other.
- Desktop frontend: React 19, Vite, and Astryx, following `apps/omarchy-bot/AGENTS.md`.

## Design

### How Group Threads use the runtime

| Group part | Runtime feature |
| --- | --- |
| A member's work in a group | one pi-durable conversation per Thread and Bot |
| Catch-up for a member | `write` entries in that member's conversation, before the Turn's input |
| A user message steering a busy member | `whenBusy: "steer"` |
| The Reply Decision | an isolated `pi-ai` call through the runtime module, outside any conversation |
| Reply Rules, Personality, roster | app prompt sections |
| `mention_group_members` | a tool in a group extension, selected only on Group Turns |
| Group Wakes | Service records, not pi-durable tasks, because routing, cancelling, and collapsing are the Service's rules |

### Domain model

- A Thread has one or more member Bots and is one of two kinds:
  - a **Direct Thread**, with exactly one member, which is today's behavior
  - a **Group Thread**, created with at least two members, with no maximum
- A Group Thread is one conversation. It is not a container of Threads; a new topic means a new Group Thread.
- Membership has one authoritative record for both kinds. Existing Threads migrate to one-member Direct Threads.
- A Bot's identity, Instructions, Personality, Display Settings, and Bot Screen do not change inside a group.
- A group uses the Shared Workspace by default unless given an explicit working folder, as Threads do today. No per-group work-file space is created. Each member keeps its own private folder for notes about itself, as set out in the [runtime spec](bot-runtime.md#workspaces). All work files go in the shared space.

### Persistence

- Add a membership table holding Thread, Bot, list position, and the Bot's catch-up cursor. Deleting a Bot cascades to its membership rows.
- `threads.bot_id` becomes nullable, and is set only for Direct Threads. Direct Threads keep cascading on Bot deletion; Group Threads do not.
- The runtime's Thread-to-conversation mapping is keyed by Thread and Bot instead of Thread alone.
- Bots gain a `personality` column, empty by default and limited to 8,000 characters like Job/Instructions. Migration leaves existing Bots with an empty Personality.
- Turns gain an unchangeable Bot-name snapshot, written when the Turn is created. Group attribution reads it after a rename or deletion.
- `attachments.bot_id` becomes nullable. It is null for group attachments, whose owner is the Thread. Direct attachments are unchanged. Staged group attachments reference their Group Thread.
- Add a durable **Group Wake** record. It holds:
  - the Thread and target Bot
  - the cause: a user Message, or a source Turn and Tool Call
  - the user Message it descends from
  - the start position
  - the optional sender device
  - the target Turn
  - its state
- Migration follows existing conventions: lossless, covered by migration tests, with no destructive upgrade behavior.

### App-owned system prompts

Every Bot Turn, in Direct and Group Threads, uses a system prompt built from app sections. In order:

1. **Base Prompt:** product-owned. It establishes the Bot as a personal assistant, not a coding agent: what a Bot is, how it helps the user with everyday and professional work, the Bot roster from [Bot Memory](bot-memory.md#shared-memory), the Shared Workspace, its own private folder, and how to work and report honestly.
2. **Tool Notes:** product-owned guidance on using the Bot's tools, including computer, browser, and Bot mail.
3. **Job/Instructions:** the Bot's editable prompt describing what it is responsible for.
4. **Personality:** the Bot's new editable prompt describing how it behaves, added to the Bot Profile.
5. **Reply Rules:** product-owned and not editable, on Group Turns and reply decisions only. They apply even when Job/Instructions and Personality are empty.

Job/Instructions and Personality are optional, and edits affect future Turns. Skills are listed as the [runtime spec](bot-runtime.md#prompt-and-skills) sets out. `AGENTS.md` files are not loaded automatically.

Initial Reply Rules, to be refined with evaluation:

> You are {name}, in a group conversation with the user and these Bots: {roster}.
> Reply when the user clearly means you, when the message falls within your Job, or when you have something important that nobody has said, including correcting a serious error.
> Pass when another member's Job fits better, when someone has already answered, when you would only be agreeing, acknowledging, or making small talk not aimed at you, or when you are unsure.
> If you have no Job, act as a general assistant: reply only to a question no member's Job covers and nobody has answered.
> Your Personality may make you more or less talkative, but it cannot override these rules.

The roster gives each member's name and a short excerpt of its Job/Instructions, so a Bot can tell when a peer is the better fit. Personality is not shared.

### Routing

The Service resolves targets when the Message is accepted. The same transaction stores the Message and its Group Wakes.

1. A Message with mentions wakes only the mentioned members, all at once. They skip the reply decision and always take a Turn.
2. A Message with no mention gives every member a reply decision.

Mentions travel as stable Bot IDs beside the text, never parsed out of it, so renames and names containing spaces cannot misroute. There is no `@everyone`, because a message with no mention already reaches everyone. A Bot's Response Block wakes nobody by itself.

### Reply decision

Models tend to produce text even when told to stay quiet, so silence must not depend on a model producing nothing. The control is a gate before the Turn: the decision call's output is never shown, and only an exact token opens the Turn.

- **The call:** one isolated model call using the Bot's model, made through `pi-ai` by the runtime module. It has no tools, conversation, computer access, or Turn, so it cannot act or change anything. The runtime module returns the raw text; the group module parses it.
- **Plain text:** the answer is plain text, because `pi-ai`'s provider-neutral tool choice offers only `auto` and `none`, so a specific tool call cannot be forced.
- **Input:**
  - the Bot's system prompt sections and the Reply Rules
  - the recent group conversation
  - which members have already decided to reply to this Message but have not yet posted

  It is bounded, initially at 16 KiB, with attachments listed by name and type only.
- **The token:** the model is told to answer with exactly `REPLY` or `PASS`. After trimming whitespace, only an exact, case-sensitive `REPLY` opens a Turn.
- **It fails closed:** any other output, such as `PASS`, prose, or `REPLY because...`, counts as a pass. Unparseable output is logged to the Service log with counts and without message content.
- **Errors differ from choosing not to reply:**
  - A call that errors or takes more than 20 seconds is retried once after a short backoff, because Bots sharing a model can hit one rate limit together.
  - If it fails again, the Bot does not reply, and the transcript says it could not respond.
  - Failures for one Message are combined into one note naming the affected Bots.
- **A pass** creates no Turn and no transcript entry, does not light Bot Activity, and does not move the Bot's catch-up cursor, so its next Turn still receives what it skipped.
- **A `REPLY`** starts a normal Turn in the member's conversation, with tools and streaming. Its system prompt also holds the Reply Rules, and its Response Blocks are shown as usual.
- Thinking and output from decision calls are not kept.

**Staggered decisions.** Deciding all at once would make Bots answer the same question without seeing each other.

- Members decide in order: the Bot that most recently responded, then list order.
- The next Bot's decision starts as soon as the previous Bot passes, posts its first Response Block, finishes its Turn, or has been going for 10 seconds.
- Each decision reads the conversation when it starts, so later Bots see earlier replies that have appeared by then.
- The stagger is an ordering rule. It does not make the work run one at a time.

**Nobody replied.** When every wake for a user Message has passed by decision, with no failure and no further wake pending, the transcript shows a quiet system note suggesting a direct mention. Notes are not passed to Bots.

### Group Wakes

- **Delivery rules,** carried over from the old mailbox decision (ADR 0008, removed from `docs/` in commit 713b4d5):
  - commit before acknowledging
  - claim atomically
  - reconcile on Service start
  - never replay a Turn that has been stored
- **States:** `queued`, `deciding`, `passed`, `dispatching`, `started`, `failed`, and `cancelled`.
- **Restarts:** a decision has no side effects, so a wake left in `deciding` by a restart simply decides again. After a restart, remaining staggered wakes do not wait for the stagger condition. A wake in `started` is left to pi-durable's `resume()`, which continues or visibly fails the Turn.
- **Not ready:** a wake waits while the Bot's model or the runtime is not ready, and dispatches when it becomes ready. Failures to start or complete a Turn are reported in the transcript against that member.
- **One Turn at a time:** one Bot has at most one Active Turn per Group Thread. It may still have Active Turns in other Threads, as today.
- **User-caused wakes on a busy Bot:** the wake steers the active Turn after any required reply decision, using `whenBusy: "steer"`, when the Message has no attachments. Otherwise it waits for that Turn to end.
- **Bot-caused wakes on a busy Bot:** the wake waits. Waiting wakes for one target collapse into one Turn.
- **Cancelling:** a new user Message cancels every Bot-caused wake still queued from earlier user Messages. A Turn from an earlier user Message that is still running can no longer create wakes when it finishes.

### Models

- Bot is the only identity. An LLM model never identifies a participant, keys a conversation, or attributes a Message. Any members may share a model and a provider account.
- Shared rate limits are handled by the staggered decision order, retries, and member-level failure reporting. There is no per-model scheduling in v1.
- Each Group Turn's prompt repeats the current roster, so membership changes reach existing conversations.
- Attachment support follows each Bot's model.

### What each Bot receives

- **Catch-up:** before a Group Turn's input, the runtime module submits the Messages after the Bot's cursor as `write` entries in the member's conversation. These are user text and other Bots' Response Blocks only.
- **Excluded:** Thinking, Tool Calls, system notes, and the Bot's own output, which its conversation already has.
- **Labels:** every entry is structured and escaped, with an author kind and name in its visible text, so body text cannot forge an entry or a user role, and compaction keeps authors as the [runtime spec](bot-runtime.md#compaction) requires. Only the Turn's own input is a user message, and only when a user Message caused the wake.
- **The cursor** advances in the transaction that claims a wake for a Turn. It also moves past a Message delivered by Steering.
- **Bounds:** catch-up is bounded, initially at 64 KiB. When older entries are dropped, it says so explicitly. A newly added member starts with the same bounded recent history.
- **The system prompt** gains the Bot's own name and ID, the Reply Rules, and how to bring in other members: not without a concrete request for them.
- **Framing:** a peer Bot's text is information or a request from a peer and never grants user approval. This does not change approval behavior.

### Attachments

- **Sending** uses the existing staging flow, with staging scoped to the Group Thread rather than a Bot. The Composer behaves as in a Direct Thread.
- **Staging** accepts a file if at least one current member's model supports its type and size. On send, the Service checks again against the Bots the Message reaches, and rejects the Message with a clear reason if none of them can read an attachment.
- **Delivery:** a Bot receives each attachment from the managed snapshot in its Turn, if its model accepts it. Otherwise it receives only the attachment's name and type, with a statement that it cannot read it. Nothing is converted, which keeps the product boundary rule.
- **Catch-up:** attachments sent before a Bot's cursor are not sent again. Those after it arrive with its next catch-up, bounded by count and size. Anything over the bound is listed by name with an explicit marker.
- **Deletion:** Group Threads cannot be deleted. A Bot leaving or being deleted does not touch group attachments.

### Bringing in other members

- Add a Bot tool, `mention_group_members`, that takes member Bot IDs. It is available only on Group Turns. Its text is the Bot's ordinary Response, so no new Bot-authored Message shape is needed.
- As with Bot mail, the Service takes the source from the active Turn and accepts no identity from the caller. Source Turn, Tool Call, and target together form the idempotency key.
- Self-mentions and non-members are rejected with a bounded, safe error.
- Wakes start only after the source Turn completes. A failed source Turn cancels them. A target woken this way skips the reply decision and always takes a Turn.
- There is no fixed limit on Bot-to-Bot replies. The controls are the Reply Rules and the cancelling effect of a new user Message. See [Further notes](#further-notes) for the risk.
- `send_bot_message` is unchanged and still creates a Direct Thread owned by the target.

### Protocol and API

- Raise `PROTOCOL_VERSION`.
- `ThreadDto.botId` becomes optional, and the DTO gains a thread kind and members. Bot Message authors gain a Bot ID and name snapshot.
- Create and list Group Threads through a new collection. Members are added and removed through a Thread sub-resource.
- The existing Thread Message POST accepts mention IDs for groups, and returns an outcome per target: `started`, `steered`, or `queued`.
- Attachment staging accepts a Group Thread as the alternative to a Bot.
- Existing Bot-scoped Thread lists return only Direct Threads, and the Bot-scoped Message POST keeps creating Direct Threads.
- Turn events already carry `botId`, which is how clients attribute streaming output.
- Bot create, update, and read contracts gain `personality`.
- The runtime module's API gains a reply-decision call that returns the raw text.

### Workspace UI

- Create Bot and Bot Settings gain a Personality field beside Job/Instructions.
- The Sidebar gets a Groups section with a create action, showing members' avatars, unread count, and an activity point.
- Unread attention for groups is held per Group Thread, separately from per-Bot unread.
- A group transcript labels each run of Bot output with name and avatar, and shows one temporary working avatar per active member. Direct Threads keep today's presentation.
- The header lists members and gives access to each member's Bot Screen and Bot Settings. Computer Surface and Takeover act on the chosen member. Member lists must stay usable with many members, because size is unlimited.
- Composer Drafts for groups are keyed by Thread within a window.
- Fork and compact actions are not offered on Group Threads in v1.

### Lifecycle

- Deleting a Bot removes its membership, Group Wakes, and group conversations. Its group Messages and Turns stay, under the name snapshot.
- A group with no members stays readable and rejects sends. A group with one member stays usable and can take new members.

### Documentation changes that ship with this work

- **Workspace glossary:** Thread was defined as "between the user and one Bot". If the glossary is restored to `docs/`, redefine Thread; add Direct Thread, Group Thread, Group Wake, Reply Rules, and Reply Decision; and add Personality to Bot Profile.
- **Avatars:** the old transcript decision (ADR 0005, removed in commit 713b4d5) said historical Bot messages have no avatar and there is one temporary working avatar. Keep this for Direct Threads, with the group exception above.
- **New ADR:** membership, a conversation per member, Group Wakes, the fail-closed Reply Decision with staggered order, and Thread-owned group attachments.
- **README:** the Sidebar, Threads, Attachments, and product model sections.

Bot mail stays separate. No permission layer is added.

## Commands

```
bun install --frozen-lockfile
bun run typecheck
bun run lint:boundaries
bun test apps/daemon
bun test                 # full Bun suite
bun run test:e2e
OMARCHY_BOT_DEV=1 bun run dev
```

## Project structure

```
apps/daemon/src/modules/groups/              new: membership, routing, Group Wakes, Reply Decision parsing
  *.test.ts                                  tests next to the code
apps/daemon/src/modules/runtime/extensions/group.ts
                                             mention_group_members, Reply Rules and Personality sections
apps/daemon/src/modules/runtime/             reply-decision call; mapping keyed by Thread and Bot
packages/agent-contract/                     DTO and protocol changes
apps/omarchy-bot/src/                        Groups section, mention list, attributed transcript, member header
tests/e2e/                                   the Group Thread flow
```

## Code style

Follow the existing daemon modules. The group module uses the runtime through its own API:

```ts
export interface BotRuntime {
  // ...existing calls from the runtime spec
  decideReply(botId: BotId, input: ReplyDecisionInput, signal: AbortSignal): Promise<string>;
}

export function parseReplyDecision(raw: string): "reply" | "pass" {
  return raw.trim() === "REPLY" ? "reply" : "pass";
}
```

## Testing strategy

- Tests assert behavior a client can observe: HTTP responses, events, stored transcripts, and what reaches the model request. They do not assert internal state.
- **Primary seam:** the Service HTTP API and event stream, with the runtime on a fake model provider, as in the [runtime spec](bot-runtime.md#testing-strategy). The Bot mailbox integration tests are the model to follow. Cover:
  - routing with and without mentions, including renamed and departed members
  - Reply Decision: only exact `REPLY` opens a Turn; prose, lowercase, `REPLY` with extra text, empty output, errors, and timeouts all pass; mentioned Bots skip it
  - a pass: no Turn, no transcript entry, no Bot Activity, an unmoved cursor, and the note when everyone passes
  - staggered decisions: each release condition, order, later Bots seeing earlier replies, and restart reconciliation
  - Reply Rules and Personality present in the prompt, including with empty Job and Personality
  - concurrent Turns, and one conversation per member
  - catch-up contents, including exclusion of Thinking and Tool Calls, and escaping of forged authors
  - attribution after compaction of a group conversation
  - attachments: staging, rejection when no reached Bot can read one, per-Bot delivery, name-only delivery, catch-up delivery, waiting on a busy Bot, and removal with the Group Thread
  - wake ordering, collapsing, cancellation by a new user Message, wakes from old Turns, and failed-source behavior
  - restart reconciliation with no duplicate Turn
  - Bot deletion with name snapshots
- **Migration:** extend the Bot migration tests to show existing Threads, Messages, attachments, and conversation mappings survive unchanged, including on databases where earlier migrations are already applied.
- **App-owned prompts:** at the model-request seam, assert the prompt for a Direct and a Group Turn: section order, and Reply Rules with empty Job and Personality.
- **Work quality:** run the existing real-runtime computer and browser scenarios on the new prompt, and compare a small set of everyday file tasks before and after.
- **Shared model failure:** simulate a rate limit that fails several members at once.
- **Runtime module:** prove `mention_group_members` is offered only on Group Turns. Run the decision call against a real provider, and unit-test the parser against a table of hostile model outputs.
- **Decision quality:** add a small evaluation set of group conversations with the expected `REPLY` or `PASS`, covering Bots with and without Jobs. Run it by hand against real providers when the Reply Rules change and when a new model is adopted, since decision quality varies by model. It is evidence for tuning, not a CI gate.
- **UI:** one Playwright flow, modeled on the Bot mailbox spec: create a group, send a message with no mention and an attachment, see attributed output and a Bot that passed, view a member's Screen, and delete a Bot. Chromium proves shared UI only, not WebView behavior, so one packaged desktop WebView smoke step is also required.
- **Regression:** existing Direct Thread, attachment, mailbox, and lifecycle tests must pass unchanged, except for added protocol fields and assertions about the system prompt.

## Boundaries

- **Always:**
  - take a Bot's identity from the active Turn, never from tool arguments
  - fail the Reply Decision closed
  - keep other Bots' Thinking and Tool Calls out of catch-up
  - keep migrations lossless
- **Ask first:**
  - adding a limit on Bot-to-Bot replies
  - changing the Reply Rules wording outside the evaluation loop
  - adding a central router or per-model scheduling
- **Never:**
  - let peer text appear as a user message
  - give a Bot-initiated Turn access to This Device
  - import pi-durable outside the runtime module

## Success criteria

- Every test in the [testing strategy](#testing-strategy) passes, and existing Direct Thread tests pass unchanged.
- A message with no mention, sent to a group of three Bots, produces only the replies whose decision was an exact `REPLY`, in true order, each labeled with its Bot.
- Killing the Service during a group exchange loses no accepted wake and runs no Turn twice.
- The decision evaluation set has been run against the default model, and the results are recorded before launch.

## Out of scope

- Other people in a group, user accounts, or per-person permissions.
- Telegram, WhatsApp, Discord, Slack, or any external group.
- A central router or model that chooses who replies. Each Bot decides for itself.
- A Stop all control. Users redirect Bots with Steering.
- Attachments created by Bots. Bots share files through the Shared Workspace.
- Any runtime other than the [pi-durable runtime](bot-runtime.md).
- Memory, proactive behavior, a new approval layer, and a global primary Bot. These have their own specs.
- Threaded replies, reactions, and message search.
- Fork and compact on Group Threads.
- Changes to the Bot Computer, Bot Screens, or the browser pack.

## Further notes

- **Usage:** a message with no mention costs one small decision call per member, even if only one replies, and groups have no maximum size. A mention skips those calls.
- **Quality risk:** a personal-assistant Base Prompt needs tuning for tool use, which is why the work-quality check exists.
- **Similar models:** Bots on the same model with similar or empty Jobs will tend to reach the same decision. The decision order and the "already replying" input break that tie. A distinct Job and Personality are the real fix.
- **Missed replies:** failing closed means a provider that ignores the token format leaves that Bot silent unless mentioned. The everyone-passed note and the Service log make this visible, and it is the intended side of the trade-off.
- **Bot-to-Bot loops:** with no reply limit, two Bots could keep bringing each other in until the user sends a message. The Reply Rules make this less likely but cannot prevent it, because a mentioned Bot skips the Reply Decision. If it shows up in use, the first response should be to add a limit.
- **Build order:** the agreed plan puts Memory first, but this spec does not depend on code from it. The rule it needs from Memory is that each Bot's memory stays private, and a Bot may use its own memory in a group because only the user and the user's Bots are present. That rule must be revisited if other people ever join groups.
- **Shared computer:** all members share one Bot Computer profile, including browser sign-ins, as every Bot already does. Group Threads add no isolation, and a member is not a security boundary.

## Open questions

None. The runtime prototype found that stored `write` entries keep their authors, but a compaction summary can lose who said what. Catch-up stays as `write` entries, with author labels in visible text, under the runtime spec's [author rules for compaction](bot-runtime.md#compaction).
