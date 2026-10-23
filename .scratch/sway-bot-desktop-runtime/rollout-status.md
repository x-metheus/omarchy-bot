# Bot Desktop Runtime rollout

- architecture selection: true
- conformance pass: true (current automated two-Sway and real-browser evidence)
- production cutover: true
- Cage removal: true
- H.264 video-track removal: true
- WebRTC removal: true
- human acceptance: pending

Computer ADR 0009 is authoritative. Production provisions Sway only, without a compositor selector or Cage fallback. The one-shot leftover-Cage guard has been deleted. Projection v3 uses separate control/preview and view-only RFB WebSockets; SDP/ICE, RTC data channels, `node-datachannel`, and the obsolete UDP listener are gone.

The current conformance report proves exact browser/terminal Unicode, private URL launch, real noVNC pixels and Broker input, retained live state, isolated failures, and targeted cleanup. Admission limits are conservative configuration, not a historical Cage performance approval.

Human Host Session acceptance remains pending: [checklist](host-session-acceptance.md). Implementation, real evidence, artifact publication, and remaining acceptance are separated in [the completion report](completion-report.md).
