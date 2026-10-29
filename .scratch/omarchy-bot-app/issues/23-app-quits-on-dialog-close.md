# 23: Omarchy Bot quits when the user closes a dialog

**What to build:** On Linux, closing a dialog in Omarchy Bot leaves the app running with its window intact. Today the window disappears when the user closes a dialog. Opening and closing every dialog (Settings, Plugins, History, Create Bot, the local approval prompt, and the expanded Bot Screen view) leaves the app running and responsive, and quitting the app normally leaves no crash dump.

Observed on the user's Omarchy host on 2026-10-29 with the installed AppImage built from `main` at `a92c542` (Rust Sidecar), paired to a same-machine Service at `http://127.0.0.1:7321`, launched from the desktop entry:
- The user reports that the app crashes when they close a dialog. Which dialog was not identified; the expanded Bot Screen view is a native `<dialog>` running a live noVNC stream and is the first suspect.
- Three times in 90 seconds the window went away. Each time, systemd-coredump caught `WebKitWebProcess` (from the bundled WebKitGTK 2.50.6) with SIGTRAP raised by WebKit's own watchdog: "WebProcess didn't exit as expected after the UI process connection was closed". That means the UI process (the Tauri app) closed or exited first, and the web process then failed to exit in time. No core was produced for the app process itself, and nothing from the app reached the journal.
- Each window used about 38–45 s of CPU over 46–62 s of wall time (peak 630–750 MB), so the web view was nearly saturated a core while open. This is a defect in its own right and probably why the web process misses its exit deadline.

Find out from evidence, not guesswork, why the UI process exits: an `app.exit`/restart path (`RESTART_EXIT_CODE`), a window-close request, a panic, or a WebKit-level failure that the app turns into a quit. Fix the root cause and the idle CPU burn.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [ ] A packaged-AppImage reproduction, in the repository's Linux app container smoke harness, shows the app exiting when a dialog closes. The cause is identified with evidence (exit code, logs, or a backtrace) and recorded in Comments
- [ ] Fixed: the packaged WebKitGTK smoke opens and closes each dialog, including the expanded Bot Screen view, by its close button, Esc, and backdrop click where supported, and the app stays running with its window responsive
- [ ] With a Bot Screen visible and the app otherwise idle, the web view's CPU stays low. The smoke measures it with a recorded bound
- [ ] Quitting the app normally leaves no `WebKitWebProcess` watchdog crash; the smoke checks the web process exits cleanly
- [ ] Unexpected app exits and panics are written to a log the user can find. The path is documented in the README, so the next report has evidence
- [ ] Record whether the bundled WebKitGTK version matters. Host safety: try a different WebKit only inside the container, never by installing packages on the host
