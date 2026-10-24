# 03: Tabbed Bot Screen layout

**What to build:** Each Bot Screen workspace is tabbed: the focused window fills the Screen, other windows stay visible as readable titled tabs, and dialogs, pop-ups, and portal pickers float centered. Agents get complete, unambiguous screenshots and humans get a familiar surface in Web Control (Computer ADR 0011).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

Spec: [standalone Linux Service](../spec.md)

- [ ] Opening a second application on a Screen leaves the first at full Screen size behind a tab, not a split (real-Sway conformance, Seam 3).
- [ ] Tab titles are visible and legible in a Screen capture.
- [ ] A dialog window floats centered over its parent.
- [ ] Window routing per Screen workspace and window listing are unchanged.
- [ ] Runtime contract suite stays green on fake and scripted adapters.
