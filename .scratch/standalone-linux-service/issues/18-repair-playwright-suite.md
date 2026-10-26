# 18: Repair the Playwright end-to-end suite

**What to build:** `bun run test:e2e` passes again. 40 of 82 Playwright tests already failed on `140ecab`, before the standalone Linux Service series, with the same 40 failing on `linux-service`. The first diagnosed cause: specs look up the message input as `getByRole("textbox", { name: "Message input" })`, but the `@astryxdesign` input now exposes `combobox "Message input"`. Other failures may have other causes and each needs its own diagnosis.

**Blocked by:** None (can start immediately)

**Status:** open

Spec: [standalone Linux Service](../spec.md)

- [ ] Every failing test is classified with evidence: stale test (selector/role/text/flow changed), product regression, or environment.
- [ ] Stale tests are updated to the current accessible UI, selecting by role and accessible name, with no `force`, sleeps, or CSS-structure selectors added.
- [ ] Product regressions found by the suite are fixed in the product with the test kept as written, or are listed in the Comments with a reason if out of scope.
- [ ] The message input's role is confirmed correct for its behavior (combobox only if it really owns a popup/listbox, such as mentions or slash commands); if it is wrong, the product is fixed rather than the test.
- [ ] Visual snapshots are updated only where the diff is reviewed and explained in the Comments.
- [ ] `bun run test:e2e` passes in full; the result is recorded with the full `bun test` suite still at baseline.

## Comments
