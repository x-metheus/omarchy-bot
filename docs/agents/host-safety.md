# Host safety

Treat the host OS and graphical session as immutable during repository work.

- Resolve missing system dependencies with existing binaries, repository-managed dependencies, or temporary portable artifacts. If none is available, stop that scenario and report the missing prerequisite.
- NEVER invoke host package managers or system/global update flows (`pacman`, AUR helpers, Omarchy updates, or global `mise` upgrades), or stop/restart the host compositor, Omarchy Shell, bar, or graphical-session services, without explicit user authorization in the current conversation.
- Bot Screen processes MUST use private runtime/profile directories and targeted child-process or transient-unit teardown. Never import, modify, or terminate the host graphical-session environment.
