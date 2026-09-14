# 05: Search, read, and write on the Sidecar

**What to build:** Let a Bot find and inspect files on the named Sidecar without ingesting a home directory or writing into Shared Workspace by accident. Search stays path-oriented and bounded; read and write take explicit sandbox paths; the approval card still names the hostname and path.

**Blocked by:** 02: Run an approved command on this-device through `local`

**Status:** resolved

- [x] `local.search` returns bounded path hits and short snippets, not full file bodies, and cannot flood the model from a home-directory walk.
- [x] Search roots are explicit or a small documented default (for example the user’s home, excluding obvious secret directories); a Bot cannot scan `/` by accident in v1.
- [x] `local.read` and `local.write` require explicit paths and stay inside the fixture sandbox.
- [x] `local.write` does not follow Shared Workspace defaults, so a laptop write cannot be mistaken for Bot Computer or plugin-host work files.
- [x] Ask still fires before mutating file work; the approval frame shows the device hostname and exact path.
- [x] Tool Call summaries name the device and a safe path target; errors use existing Tool Call summary redaction.
- [x] File actions are not screenshot, pointer, Host compositor, attachment-draft, Bot mail, or Bot Screen file ownership.

## Answer

`local.write` / `local.read` / `local.search` fan Turn-bound jobs to the online Local Sidecar. Writes take an explicit sandbox path, wait for Ask (hostname + path on the job), and land under the fixture sandbox rather than Shared Workspace. Deny does not create the file. Search returns a path plus a short snippet, does not ingest HOME or Shared Workspace, and searching `/` fails the Tool Call. Summaries name the device and path; file work is not screenshot, pointer, or Bot mail.

Validation:

- `bun test tests/integration/local-sidecar-files.test.ts packages/agent-contract/src/local-protocol.test.ts` — 7 passed

