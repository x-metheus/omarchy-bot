# 15: Automatically update plugins without overwriting local work

**Parent:** [Shared Plugins, Native Discovery, and Default Cross-Agent Skill Creation](../spec.md)

**What to build:** Supported remotely installed Skills, official Service content, and version-manageable local MCP packages update automatically. A user or Bot can inspect update state and act on blocked updates, but local edits survive and failures leave prior usable content available. Locally created Skills are never assigned an invented remote source.

**Blocked by:** [03: Install complete Skills from explicit sources](03-explicit-skill-source-installation.md); [10: Deliver the first complete official Microsoft Service](10-official-microsoft-service.md).

**Status:** ready-for-human

**Spec coverage:** User Stories 22, 65, 66, 67, 68, 69, 70, 71. Apply the parent specification's domain, host-safety, credential, and behavioral-verification constraints throughout.

- [ ] Apply the automatic-update policy through the shared plugin interface to eligible remote Skill sources, official Service resources, default official Creator resources where eligible, and supported local MCP package versions. Use source-supported version mechanisms and project/product-scoped dependencies, never host-global package or Agent updates.
- [ ] Track true source identity, installed revision, available revision, and sufficient content baseline to distinguish upstream-clean resources from local user/Bot edits. Hosted remote MCP deployments are not represented as locally pinnable or roll-backable packages.
- [ ] Update clean eligible installations without a manual approval prompt. Complete resource sets must become usable at the supported reload boundary; do not present partly downloaded or mixed-version Service content as fully ready.
- [ ] Preserve local modifications and report update attention instead of overwriting or automatically merging them. Recheck actual content immediately before replacement so edits made while an update is downloading are protected too.
- [ ] Locally created Skills with no upstream origin are excluded from remote replacement. Explicit live local sources are not disposable caches, and independently installed resources are not swept into another Service's update.
- [ ] A failed fetch, invalid bundle, interrupted replacement, or unavailable dependency leaves the prior usable content intact and an observable failure. New provider authorization requirements become pending user action; an updater never grants consent or copies cross-client tokens.
- [ ] Client and Bot inspection expose current/available revision, local-modification condition, update failure, and pending authorization/reload. A Bot can explicitly request an update or use existing management/file tools to resolve local content; do not build a new merge engine or publication workflow.
- [ ] Automatic or explicit updates do not forcibly terminate another Bot's Active Turn or swap an in-use tool registry merely to clear a status flag. Subsequent use after the real reload consumes the new version, and obsolete resources are released when safe.
- [ ] At the real-daemon seam, use deterministic versioned sources to prove a behavior change after a clean update, preservation of edits before/during download, preservation on failure, and exclusion of local Skills. Control scheduling/source state rather than waiting hours or asserting timer implementation.
- [ ] Use a real loaded Skill/MCP consumer to prove updated behavior and the actual browser panel to verify attention/failure presentation. Record unsupported update mechanisms honestly and update the public policy documentation.

## Comments

### 2026-09-12 — Remote-content updates verified

Through the real daemon, a complete controlled remote Skill changed executable behavior from `amount=42` to `amount=44`. An invalid upstream bundle retained `44`; a local edit producing `amount=91` survived another update attempt and daemon restart. The independent local Skill retained its original revision. Production Chromium displayed modified state, installed/available revisions, and actionable update failure without losing the Thread or Composer draft.

Service companion staging/failure/repair is covered by the real-daemon lifecycle regression. Existing regressions also exercise an edit made while acquisition is pending. Hosted MCP deployments remain provider-controlled.

### 2026-09-12 — Explicit npm ownership and clean cutover implemented

The requested clean cutover uses explicit public npm MCP package ownership.
Superseded acquisition and fingerprint implementations were removed in favor of
shared resource modules; no parallel business runtime or compatibility alias was
added. Native stdio/HTTP definitions remain supported user inputs, not legacy shims.
An opaque command is never interpreted as consent to own or update its package.

The implemented contract accepts either native `transport` or an explicit
`package` with an exact public npm name (no version suffix), optional binary,
arguments, and write-only environment. Managed installation and updates resolve
npm `latest` into private product-owned storage. Node 24+ is required; the Linux
native launcher uses experimental `process.execve`. Host/global package and Agent
updates remain excluded. Declared preinstall/install/postinstall hooks and
non-Node entrypoints are unsupported. Hosted deployments remain provider-controlled,
and the bundled Pi adapter changes with the product runtime.

Automatic and explicit updates preserve local modifications, stage complete
replacements, recheck content before activation, and retain prior content when
acquisition or activation fails. Native process leases protect running consumers;
obsolete versions are collected after those processes exit. Inspection exposes
installed/available versions and modification/failure attention; explicit updates
use `POST /api/plugins/mcp/:id/update` with `{}`.

### 2026-09-12 — Managed package behavior verified

- The real-daemon regression exercises Bot `manage_plugins` save/update, the HTTP update endpoint, and the automatic-update routine against complete controlled npm archives. Native consumers changed behavior from version 1 to 2 and then 3; an already-running version-1 consumer retained its original behavior.
- Invalid integrity retained version 2. Local behavior `91` survived an update, including an edit made during acquisition. Metadata still discovered the available upstream revision while local content blocked installation. Declared install hooks were rejected without executing the fixture canary.
- Disabled/native edits, concurrent removal, deliberate native restoration before collection, and process-lease cleanup were preserved. A truncated lease did not permit deletion while its named process remained live.
- A real Pi worker consumed the installed package, retained its private credential binding, and actually selected a different binary within the same package version after native reload. Changing package identity or native/managed ownership cleared the previous credential binding unless explicitly supplied.
- Production Chromium installed public `@modelcontextprotocol/server-filesystem@2026.8.31`. Native Pi Check discovered 14 tools; an actual native `read_text_file` returned `managed native package result=107`. Explicit update checking against the real npm source succeeded.
- A local package resource survived forced private-daemon termination and startup through the final packaged production entrypoint. Further Client update attempts reported local-modification attention instead of overwriting it. At 390×844 the final package card showed one modification warning and no horizontal overflow.
- The extracted runtime also performed a fresh real npm installation through its production API. Its Pi native Check discovered 14 tools, and its newly installed native consumer returned the same bounded file result. The native adapter Skill path pointed inside that extracted runtime, not the development checkout.
- `bun run typecheck`, the production Web build, and the complete runtime archive build passed. The six targeted integration files, including `mcp-packages.test.ts`, passed **18 tests, 0 failures, 443 assertions**. Controlled archives and fake ordinary test Bots are not evidence of live provider consent or Codex/Claude model execution.

Public npm packages are the supported managed local mechanism. Arbitrary native
commands, private registries, non-registry dependencies, unsupported lifecycle
scripts, and provider-hosted deployments are not silently adopted or updated.
README and Agent integration documentation describe these boundaries and the
explicit package input; the former ownership decision is no longer an acceptance
blocker. External client/provider prerequisites remain recorded in ticket 16.
