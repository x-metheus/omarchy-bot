# Bots use only the pack browser

Status: accepted on 2026-11-03. Supersedes the `OMARCHY_BOT_BROWSER=host` opt-in in [Computer ADR 0011](0011-bundle-one-sway-bot-computer.md) (2026-10-27 amendment) and the host-browser paragraph of [Computer ADR 0012](0012-agent-browser-control-over-cdp.md). It does not change the shared Bot Computer, routed Screens, serialized seat, the checksum-pinned browser pack, or the private CDP pipe.

Every Bot on every Service Host uses the browser pack's Chromium and nothing else. The Service never starts, adopts, or controls a browser installed on the host, and there is no setting that makes it do so.

The opt-in existed so a Service Host without the pack could still open pages. In practice it was the only way a Bot could reach the user's own browser, and the host browser kept leaking in through paths the opt-in never governed. On 2026-11-02 a Pi Bot ran `swaymsg exec brave` and got the user's host Brave inside its Bot Screen, with a Brave profile inside the Bot Computer's home. Even after the Screen `PATH` was narrowed, `xdg-open`, link handoff, and `open_app brave` still resolved to `/usr/bin/brave` through the host's default URL handler. With two browsers allowed, every launch, ownership, and identity check had to answer "which browser is this?" in its own way. One browser makes that question disappear.

## Decision

- **One browser.** The Bot Computer runs only the pack Chromium. `OMARCHY_BOT_BROWSER` is removed. If it is still set, the Service logs that the variable is ignored, and the CLI rejects it on `install`, `update` and `reconfigure` with a message pointing here.
- **Every launch path ends at the pack.**
  - `open_url` and the Browser Tool launch the pack.
  - An `open_app` request for another browser (by executable or desktop id) is refused with an actionable error that names `open_url` and the Browser Tool.
  - Inside the Bot Computer, the default handlers for `http`, `https` and `text/html`, plus `BROWSER`, point at the pack. So `xdg-open`, gio, and links handed off by other applications open in the pack.
  - Common host browser names, resolved through the Screen `PATH` (for example by `swaymsg exec`), reach a Service shim that opens the pack instead.
- **A private profile.** The pack profile lives in a Service-owned directory that no host browser uses by default, not in `<XDG_CONFIG_HOME>/chromium`. An existing profile is moved once, so Bots keep their sign-ins.
- **One identity check.** A process belongs to the browser only if it is the pack binary or one of that binary's descendants. App-id patterns and executable names no longer decide this.

## Consequences

- Agent browser control (Computer ADR 0012) is available on every Service Host. Its host-browser error path is deleted.
- A Service Host without the browser pack has no Bot browser. `open_url`, the Browser Tool and `request_takeover` report that the browser pack is missing and how to install it. They never fall back to a host browser.
- Scripts, containers and tests that set `OMARCHY_BOT_BROWSER=host` move to the pack (`OMARCHY_BOT_BROWSER_PACK_DIR` for fixtures).
- Host browser profiles and windows are never touched.
