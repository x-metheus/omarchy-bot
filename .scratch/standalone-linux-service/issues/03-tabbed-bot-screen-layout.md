# 03: Tabbed Bot Screen layout

**What to build:** Each Bot Screen workspace is tabbed: the focused window fills the Screen, other windows stay visible as readable titled tabs, and dialogs, pop-ups, and portal pickers float centered. Agents get complete, unambiguous screenshots and humans get a familiar surface in Web Control (Computer ADR 0011).

**Blocked by:** None (can start immediately)

**Status:** resolved

Spec: [standalone Linux Service](../spec.md)

- [x] Opening a second application on a Screen leaves the first at full Screen size behind a tab, not a split (real-Sway conformance, Seam 3).
- [x] Tab titles are visible and legible in a Screen capture.
- [x] A dialog window floats centered over its parent.
- [x] Window routing per Screen workspace and window listing are unchanged.
- [x] Runtime contract suite stays green on fake and scripted adapters.

## Comments

Generated Sway config makes every workspace tabbed, keeps the title bar, hides edge borders, floats the Bot Desktop placeholder, and floats X11 dialogs, pop-ups, and portal pickers centered. Window routing and listing are unchanged.

Real-Sway layout test (`OMARCHY_BOT_REAL_SWAY=1`): 1 pass, 0 fail, 22 expects. A second window stays full Screen width behind a tab. The capture shows both titles, and the focused window's color spans 690 of 690 body rows; a simulated split spans 0. A transient dialog is smaller than its parent, centered within 32px, listed only on its Screen, and painted. Fake and scripted contract suite: 38 pass, 4 skip, 0 fail. `bun run typecheck` passed.

The Wayland dialog check does not exercise the X11 window-type rules or the portal app-id rules. Those are config, measured separately on a private Sway 1.12.
