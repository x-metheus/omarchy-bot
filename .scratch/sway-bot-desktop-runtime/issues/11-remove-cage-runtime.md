# 11: Remove the Cage runtime after Sway cutover

**Parent:** [#8](https://github.com/XMethues/omarchy-bot/issues/8)

**What to build:** Contract the compositor migration by deleting the obsolete Cage production implementation and every Cage-only artifact once Sway is the sole wired runtime.

**Blocked by:** 10: Cut production Bot Desktop Sessions over to Sway.

**Status:** resolved

- [x] Cage runtime adapter, portable runtime supply, bootstrap wiring, configuration, environment overrides, preflight checks, and Cage-only native assumptions are removed.
- [x] Cage binaries and libraries are absent from the shipped runtime artifact and first-enable acquisition.
- [x] Cage-specific unit, smoke, capacity approval, and fixture assertions are removed or replaced by equivalent Sway behavior coverage rather than retained as dead compatibility tests.
- [x] User-facing errors, Agent guidance, comments, and authoritative documentation no longer describe Cage as current or selectable.
- [x] Historical ADRs, research, and bounded measurements remain available and clearly marked historical; evidence is not rewritten as if it never existed.
- [x] No runtime selector, compatibility alias, no-op Cage configuration, or automatic fallback remains.
- [x] Repository search and production startup demonstrate that Cage is not reachable as a Bot Desktop Runtime.
- [x] General Bot Screen lifecycle, projection, input, and capacity interfaces retain compositor-agnostic names.

## Answer

Sway is the only Bot Desktop Runtime. Cage adapter, portable supply, Cage env overrides, and Cage-only tests are gone. Leftover-Cage tree detection stays as one-shot migration safety, not a runtime. Historical Cage capacity numbers were not rewritten.

### Files deleted
- `apps/daemon/src/modules/computer/cageBotScreenRuntime.ts`
- `apps/daemon/src/modules/computer/cageRuntimeSupply.ts`
- `tests/integration/bot-screen-cage-runtime.test.ts`
- `tests/integration/bot-screen-cage.smoke.test.ts`
- `tests/integration/bot-screen-runtime-supply.test.ts`

### Files edited
- Production: `config.ts` (removed `botScreenRuntimeSupplyDir` / `runtime/cage`), `botDesktopRollout.ts` (`cageRemoval: true`), `swayRuntimeSupply.ts` comments, `leftoverCage.ts` kept as migration helper.
- Tests: `bot-screen-config.test.ts`, `bot-screen-lifecycle.test.ts` (Cage fixture retired; leftover-profile coverage added to the existing Sway delete test), `computer.test.ts`, `bot-screen-sway-cutover.test.ts` (rollout + production-graph assertion), `bot-screen-normal-use.test.ts`, `bot-screen-capacity.load.test.ts` (new rows report `sway`), `helpers/bot-screen-load-observe.ts`, `helpers/bot-screen-capacity-report.ts`, `tests/unit/bot-screen-capacity-report.test.ts` (historical Cage comments).
- Docs: `README.md`, [technology-selection.md](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/technology-selection.md), [workspace-redesign.md](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md), [CONTEXT.md](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/contexts/computer-control/CONTEXT.md), [agents-integration.md](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/agents-integration.md), [CONTEXT-MAP.md](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/CONTEXT-MAP.md), system ADR 0009, Computer ADR 0008 banner (historical), Computer ADR 0009 (authoritative), related ADR banners, current spec/requirement-map, research banners. Rollout: `.scratch/sway-bot-desktop-runtime/rollout-status.md`.

### Tests
`bun test tests/integration/bot-screen-sway-cutover.test.ts tests/integration/computer.test.ts tests/integration/bot-screen-config.test.ts tests/integration/bot-screen-lifecycle.test.ts tests/integration/bot-screen-sway-runtime-supply.test.ts tests/unit/bot-screen-capacity-report.test.ts tests/integration/bot-screen-normal-use.test.ts`

87 pass, 1 skip (`OMARCHY_BOT_REAL_SCREEN_LOAD` matrix), 0 fail. `bun run typecheck` clean. Default `bun test` does not need `OMARCHY_BOT_REAL_SWAY=1` or `OMARCHY_BOT_REAL_CAGE_SMOKE`.

### Command
`rg -n "CageBotScreen|PortableCage|cageBotScreenRuntime|cageRuntimeSupply|OMARCHY_BOT_CAGE_BIN" --glob '!**/adr/0008*' --glob '!**/.scratch/bot-screen-media-desktop/**' --glob '!**/research/**'` hits only the cutover test that asserts those files/markers are absent.

### Leftovers kept on purpose
- `leftoverCage.ts` / `OMARCHY_BOT_DESTROY_LEFTOVER_CAGE`: refuse start when leftover non-Sway trees exist.
- Capacity approval JSON `runtime: "cage"` and Hyprland-vs-Cage PSS rows: historical schema-v3 evidence; comments say they are not the current compositor.
- Historical ADR 0008 body, research notes, and resolved `.scratch` tickets: bannered historical, not rewritten.
- `OMARCHY_BOT_WLR_RANDR_BIN` and `OMARCHY_BOT_FFMPEG_BIN` kept (Sway / ticket 12).

### Rollout
architecture selection true, conformance pass true, production cutover true, Cage removal true, human acceptance pending.
