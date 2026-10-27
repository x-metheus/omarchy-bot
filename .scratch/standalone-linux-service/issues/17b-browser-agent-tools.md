# 17b: Agent-native browser control over CDP

**What to build:** Agents control the Bot Screen's browser through its structure, not only through pixels. The daemon launches the pack browser (17) with `--remote-debugging-pipe`. Through that private pipe it exposes a `browser` tool next to `computer`, which works on the page's accessibility tree:

- `snapshot` returns the tree with stable element refs.
- `click`, `type` and `select` act on a ref.
- `navigate`, `read_text`, `tabs` and `wait_for` cover pages, tabs and waiting.

The browser stays a visible window on the Bot Screen, so users watch and take over as they do today. Screenshots and raw input remain the fallback for content the tree doesn't cover, such as canvases and challenges. When a page shows a CAPTCHA, an anti-bot challenge or a login, the Agent asks the user to take over instead of trying to defeat it.

**Blocked by:** 17

**Status:** open

Spec: [standalone Linux Service](../spec.md)

- [ ] The daemon launches the pack browser with `--remote-debugging-pipe` and a private profile per Bot Computer, which stays the shared profile of Computer ADR 0009. No TCP debugging port is ever opened, and a test asserts that no listening socket appears. Teardown is targeted to that browser's process tree.
- [ ] Launching stays neutral to anti-bot checks: a real window, no automation flags, `navigator.webdriver` false, and no CDP `Runtime.enable` on page targets. Page scripts run only in isolated worlds. A conformance test checks these from inside a page.
- [ ] A `browser` tool contract lives in `packages/agent-contract` beside `computer-tool.ts`, with these actions:
  - `snapshot` returns the accessibility tree, with refs, roles, names, values and states, trimmed to a size limit.
  - `click`, `type` and `select` act on a ref.
  - `navigate`, `back`, `read_text`, `tabs` (list, open, switch, close) and `wait_for` (text, ref or navigation, with a timeout).

  A stale ref fails with a message telling the Agent to take a new snapshot.
- [ ] `click` and `type` are delivered as real input at the element's on-screen position through the daemon's existing input path (Computer ADR 0010), not as script `.click()`/value assignment. They are scrolled into view first.
- [ ] Every `browser` action goes through the Computer Broker under the same per-Screen arbitration and Takeover rules as `computer` (ADR 0003). A user Takeover holds a pending `browser` call exactly as it holds a `computer` call.
- [ ] Agent-requested takeover: a `request_takeover` action, with a reason shown in Web Control, holds the invocation until the user selects "I'm done". It then returns a fresh snapshot. The tool description tells Agents to use it for CAPTCHAs, anti-bot challenges, logins and payment. A Bot must never try to solve or bypass a challenge.
- [ ] The pi worker and the scripted workers expose the tool, and the real-model pi conformance gains a step: open a local fixture page, snapshot it, fill a form by ref and read the result back.
- [ ] README, the computer-control CONTEXT glossary (Browser Tool, Element Ref) and a new Computer ADR record the decision: one pinned Chromium driven over a CDP pipe, structure first with pixels as the fallback, and challenges handed to the user rather than evaded.

## Comments

### 2026-10-27 — why this ticket exists

Split from 17 at the user's direction. Host Chrome and Firefox aren't agent-native browsers. The "AI browsers" (Atlas, Comet, Dia) are Chromium driven through the DevTools Protocol plus an accessibility-tree layer, so this ticket builds that layer on the pack browser. A headless agent browser such as Lightpanda was ruled out as the default because it can't appear on the Bot Screen. It could still come later as a separate background tool.

Known limits to carry into the ADR:
- Sites can still challenge or block the Bot. IP reputation, which datacenter or VPS hosts make worse, is often the main factor, and some sites block agents as a policy.
- Firefox is out of scope because it removed CDP and offers only WebDriver BiDi.
