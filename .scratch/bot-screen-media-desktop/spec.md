# Bot Screen Media Transport and Lightweight Bot Desktop

Status: ready-for-agent

> **Scope correction accepted 2026-09-05:** System ADR 0009 and the [current product model](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md#shared-workspace-and-plugin-boundary) govern desktop ownership, on-demand session lifetime, Shared Workspace files, and resource acceptance. This spec and its tickets are historical where they prescribe application-profile policy, imply viewer lifetime owns background work, or treat the capacity gate as sufficient host-safety/normal-use-cost evidence. The pure-headless Cage choice and independent per-Bot input remain in force; browser profiles, Cookies, and login sharing are outside the plugin desktop scope. The sentence below that nested Hyprland remains production until Cage passes is historical: Cage cutover is recorded in ticket 08 and Computer ADR 0008. Requirement homes: [requirement map](../shared-workspace-desktop-boundary/requirement-map.md#media-and-desktop-specification).

## Requirement map (2026-09-05)

Still-valid (use the current homes):

- Cage sole compositor; pure-headless; no dual runtime → Computer ADR 0008.
- PNG Preview, H.264 Web Control, HTTP snapshot fallback → ADR 0008; [workspace-redesign Computer](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md#10-computer); [parent spec](../shared-workspace-desktop-boundary/spec.md) stories 57–59, 65.
- Neutral persistent Bot Desktop; application exit is not Screen death → workspace-redesign Computer; parent stories 42–43.
- Stop expanded encoding when unused; Agent screenshots without a viewer → ADR 0009; parent stories 56, 60.
- Independent per-Bot input; viewer switch does not destroy the session → ADR 0009; parent stories 40, 51–55.

Retired or historical evidence only:

- “Nested Hyprland remains the production runtime until Cage passes” → historical. Current compositor is ADR 0008.
- Per-Bot browser/profile/Cookie/login policy → ADR 0009; story 20 already marked superseded.
- Four-Screen active-stream gate as normal-use cost or Host Session proof → [capacity-report.json](capacity-report.json); current acceptance is [required host/resource evidence](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md#required-host-safety-and-resource-evidence).
- JPEG/H.264/wayvnc/Cage prototype numbers in Further Notes → keep with their stated limits; not current acceptance.

## Problem Statement

Web Control currently sends complete PNG captures over an ordered WebRTC DataChannel. This preserves Bot Screen identity and input safety, but each frame requires a new capture process, static-image framing is used for continuous motion, and four active 1080p Screens already approach the measured latency envelope. The user sees avoidable delay during Expanded Web Control, while terminal-heavy frames consume substantial bandwidth once their content changes rapidly.

The Bot Screen runtime is also accidentally defined by its implementation choices. A nested Hyprland process and an Alacritty process currently act as the compositor, initial application, readiness proof, and lifetime boundary. The user needs a persistent lightweight Bot Desktop, not a permanently open terminal or a second full Omarchy session. The runtime must retain the proven per-Bot pixels, focus, cursor, input, lifecycle, Broker, and Screen Projection semantics without carrying Hyprland-specific weight indefinitely.

The solution must build on the working WebRTC and Computer Broker path rather than replacing it with a parallel VNC product. It must preserve Computer Preview, Web Control, Takeover, one-way paste, Bot switching, HTTP snapshot fallback, and failure isolation while improving the media path and reducing per-Screen compositor cost.

## Solution

Screen Projection will use a hybrid WebRTC transport. Computer Preview will remain a low-frequency, read-only lossless image projection, with a fresh HTTP snapshot as its non-WebRTC fallback. Expanded Web Control will use an H.264 WebRTC video track while the existing control and input DataChannels continue to carry mode, authority, and validated user input. Entering expanded mode starts one bounded, long-lived capture/encode pipeline; leaving expanded mode or closing the projection stops it. The system will never queue stale video frames to preserve nominal frame count.

A lightweight Bot Desktop runtime will replace Alacritty as the semantic application and lifetime sentinel. Cage is the selected compositor because the experiment proved pure-headless startup, full-output application presentation, direct capture, and compatibility with the existing virtual pointer/keyboard helper at a fraction of nested Hyprland's proportional memory. The Bot Desktop will provide a persistent neutral surface and an application host while the computer worker launches real applications into the Bot-owned Wayland socket.

Nested Hyprland remains the production runtime until the Cage implementation passes the same real Screen Projection, input isolation, lifecycle, recovery, deletion, and four-Screen capacity gates. Once those gates pass, the change is a clean cutover: production no longer requires Hyprland, `hyprctl`, a generated Hyprland configuration, or Alacritty to make a Bot Screen ready. The per-Bot Surface identity, private runtime, Computer Broker, worker, capture/input isolation, and WebRTC session model remain unchanged.

## User Stories

1. As a user entering Web Control, I want the Bot Screen to render as continuous video, so that pointer and keyboard feedback feels immediate.
2. As a user viewing Computer Preview, I want a low-frequency lossless image, so that terminal text remains crisp without running a continuous video encoder.
3. As a user whose WebRTC preview has not connected, I want a fresh HTTP snapshot, so that I can still understand the selected Bot Screen's state.
4. As a user whose browser cannot negotiate H.264, I want an explicit read-only fallback state, so that stale images are not presented as interactive Web Control.
5. As a user expanding Computer Preview, I want the transition to video to preserve the same Surface, so that no other Bot's pixels can appear during the handoff.
6. As a user collapsing Web Control, I want continuous encoding to stop promptly, so that an idle Screen does not consume CPU and bandwidth.
7. As a user switching Bots, I want the old image, video track, control authority, and input path cleared atomically, so that the previous Bot Screen cannot leak into the new Computer Surface.
8. As a user reconnecting after an interrupted projection, I want a fresh video keyframe and current geometry, so that recovery does not require recreating the Bot.
9. As a user resizing the browser, I want pointer coordinates mapped through the video's actual content rectangle, so that letterboxing does not misroute clicks.
10. As a user with Web Control, I want click, drag, scroll, key transitions, shortcuts, and one-way plain-text paste to behave exactly as they do now, so that the media improvement does not regress control.
11. As a user entering Takeover, I want the same pending computer tool to remain held while the video transport changes mode, so that my input never interleaves with the Bot's input.
12. As a user finishing Takeover, I want a fresh final observation from the same Bot Screen, so that the owning Agent turn can continue with current visual context.
13. As a user closing or losing the page during Takeover, I want the Bot to remain waiting, so that incomplete sensitive work never resumes automatically.
14. As a user with two browser windows, I want the newest Web Controller to replace the old controller for that Screen, so that stale input authority cannot survive a reconnect.
15. As a user, I want a Bot Screen to open on a neutral Bot Desktop rather than an arbitrary terminal, so that the surface represents the Bot's workspace instead of an implementation fixture.
16. As a user, I want applications launched by the Bot to fill the available Bot Screen appropriately, so that a lightweight compositor does not create unusable small windows.
17. As a user interacting with an application dialog, I want transient windows to remain visible and controllable, so that authentication and confirmation flows work on the lightweight desktop.
18. As a user, I want closing an application to leave the Bot Screen ready, so that one application process is not mistaken for the Screen's lifecycle.
19. As a user, I want a failed application to be distinguishable from a failed Bot Screen, so that I receive an accurate recovery state.
20. **Superseded application-state requirement:** per-Bot browser/Electron profile policy is not a desktop responsibility under ADR 0009. Desktop endpoint routing and plugin-owned runtime remain independent; this revision neither chooses shared versus separate logins nor authorizes changing existing application data.
21. As a user running multiple Bots, I want their desktops, video, focus, cursor, keyboard, and application processes to remain independent, so that they can operate concurrently.
22. As a user, I want actions addressed to Bot A to leave Bot B and the Shared Screen unchanged, so that a lighter compositor does not weaken routing isolation.
23. As a user deleting a Bot, I want its desktop, encoder, helper, worker, sockets, and plugin-owned runtime removed before deletion completes, while Shared Workspace files and application-owned data remain outside this cleanup boundary.
24. As a user restarting the daemon, I want a valid Bot Screen reconciled or honestly reprovisioned at a new runtime generation, so that stale media and input cannot attach to it.
25. As a user, I want one Bot Screen crash to leave sibling Screens usable, so that compositor or encoder failures remain Surface-scoped.
26. As a user on the supported LAN setup, I want at least 15 displayed FPS at 1080p and no more than 200 ms median input-to-visible feedback, so that Web Control remains usable.
27. As a user, I want four concurrent 1080p Bot Screens to satisfy the measured capacity policy, so that the configured default does not destabilize the workstation.
28. As a user selecting the 720p profile, I want the media and desktop geometry to agree on 720p, so that lower-cost operation does not distort input or video.
29. As a maintainer, I want one Screen Projection service to own signaling, media, control, input, and backpressure, so that competing transport state machines cannot disagree.
30. As a maintainer, I want a long-lived capture/encode pipeline instead of one process per expanded frame, so that process startup is not part of steady-state latency.
31. As a maintainer, I want stale captured or encoded frames dropped before newer frames, so that backpressure cannot turn into growing interaction latency.
32. As a maintainer, I want source, encoded, sent, received, decoded, and displayed frame accounting, so that every shortfall has an attributable stage.
33. As a maintainer, I want encoder startup, keyframe, failure, and shutdown state measured per Surface without retaining pixels, so that transport failures are diagnosable without recording screen content.
34. As a maintainer, I want the capture and input helpers to connect only to the assigned private Wayland socket and output, so that no fallback can target the Shared Screen.
35. As a maintainer, I want runtime readiness defined by the compositor, output, Bot Desktop, helper, and worker rather than a terminal window, so that readiness matches the product contract.
36. As a maintainer, I want runtime facts such as sockets, PIDs, codec state, and compositor choice kept out of persistence, so that restart reconciliation remains authoritative.
37. As a maintainer, I want the compositor choice hidden behind the existing Bot Screen runtime boundary, so that callers continue to use Bot-owned lifecycle and operation results.
38. As a maintainer, I want the public Screen Projection protocol to identify its preview, expanded, and snapshot transports explicitly, so that incompatible clients fail clearly.
39. As a maintainer, I want the protocol cutover applied to every daemon and browser caller at once, so that no deprecated frame path or compatibility shim survives.
40. As a maintainer, I want actual Browser paint and canvas readback to define displayed frames, so that receiving RTP packets is not misreported as user-visible success.
41. As a maintainer, I want the existing Computer Surface behavior tests to remain the UI regression boundary, so that transport changes do not force tests onto component internals.
42. As a maintainer, I want the real final-stack capacity harness to be the release gate, so that synthetic codec throughput cannot substitute for observable Web Control behavior.
43. As a maintainer, I want Cage compared at the same resolution and workload as nested Hyprland before cutover, so that the prototype's 720p memory and capture results are not overgeneralized.
44. As a maintainer, I want a new architecture decision to supersede only the compositor-specific parts of the nested-Hyprland decision, so that the proven per-Bot isolation model remains authoritative.
45. As an operator, I want unavailable H.264, capture, encoder, or Cage dependencies reported before partial provisioning, so that a Screen never appears ready with a broken projection path.
46. As an operator, I want every encoder and compositor process inside the Bot Screen's supervised process tree, so that shutdown and permanent deletion have one complete cleanup boundary.
47. As an operator, I want non-loopback exposure to retain the repository's explicit insecure-remote-access warning, so that transport efficiency is not confused with authentication or confidentiality.
48. As a security reviewer, I want typed and pasted text, screenshots, and video frames excluded from diagnostics, so that the new pipeline does not expand sensitive retention.

## Implementation Decisions

- Preserve the domain model: every Bot owns one opaque Surface, every Screen Projection resolves Bot and Surface ownership, and every input event remains bound to Surface ID, runtime generation, geometry generation, controller epoch, and sequence.
- Preserve the Computer Broker, Takeover, one-controller-per-Screen rule, held-input release barriers, motion coalescing, and per-Surface input serialization. The media pipeline does not become an input authority.
- Keep one Screen Projection service as the primary orchestration seam. It owns WebRTC peer lifetime, preview framing, the H.264 track, control/input channels, mode transitions, backpressure, keyframes, metrics, and cleanup.
- Extend the Bot Screen projection source at its existing runtime boundary to provide two capabilities: a fresh lossless snapshot and a bounded stream of raw frames for expanded video. Callers must not receive compositor sockets, process IDs, or command construction details.
- Computer Preview sends lossless PNG at approximately one frame per second. JPEG is not the default because the experiment showed faster capture but larger terminal frames in both static and changing-text fixtures.
- Expanded Web Control uses an H.264 WebRTC video track. The control and input DataChannels remain ordered and retain their current semantic responsibilities. The image-frame DataChannel is not used while expanded video is active.
- The browser creates an H.264-capable receive direction in its offer. The answer contract declares the preview image transport, expanded video transport, control/input channel names, geometry, and fallback snapshot capability. The protocol version is incremented and all daemon, shared-client, browser, harness, and fake-peer callers move together without aliases or version-one fallback branches.
- The video format is H.264 Baseline-compatible YUV 4:2:0 with a 90 kHz RTP clock. The pipeline emits codec headers with keyframes, produces an immediate keyframe when expanded mode starts or reconnects, produces periodic recovery keyframes, and honors browser keyframe requests where the underlying WebRTC library exposes them.
- Expanded capture and encoding are long-lived for the expanded session. Per-frame capture process spawning is prohibited in steady state. The capture helper connects directly to the assigned child Wayland socket and named output and emits framed raw buffers plus current geometry to the encoder.
- The encoder starts only after expanded mode is requested and transport is ready. Collapse, Bot switch, peer close, Surface failure, daemon shutdown, or deletion closes its input, stops the encoder, releases buffers, and waits for process-tree termination.
- Backpressure is latency-oriented: at most one capture and one not-yet-sent encoded frame may be pending. When a newer frame supersedes stale work, the stale frame is dropped and accounted for. Input and control messages never wait behind video bytes.
- Projection metrics distinguish capture attempts, source frames, encoded frames, RTP sends, browser receives, decodes, paints, pre-capture skips, encoder drops, transport skips, send failures, decode drops, paint drops, and unexplained shortfalls. Metrics contain counts and latency only, never pixels or typed/pasted content.
- The HTTP snapshot route remains Bot-and-Surface-scoped, performs a fresh capture, returns the actual image media type, disables caching, and returns an explicit unavailable response rather than falling back to the Shared Screen. The Computer Surface uses it while preview signaling is pending or failed; it never labels snapshot fallback as interactive Web Control.
- The browser uses the video element's intrinsic dimensions and rendered content rectangle for expanded coordinate mapping. A new geometry generation invalidates queued input and stale pixels before the updated track is considered interactive.
- A missing or failed H.264 negotiation leaves Computer Preview available through PNG/WebRTC or HTTP snapshot and makes Expanded Web Control explicitly unavailable. It does not silently run expanded PNG/JPEG streaming indefinitely.
- Introduce a compositor-neutral production runtime implementation behind the current Bot Screen runtime adapter. Lifecycle callers continue to request provision, capture/snapshot, projection source, input, status, recovery, and stop through the existing Bot-owned manager boundary.
- Select Cage as the lightweight compositor. Launch it with a private mode-0700 runtime, a pure headless wlroots backend, an explicit output profile, no host Wayland parent, no full Omarchy configuration, and no global systemd or D-Bus environment import.
- Disable Xwayland unless a measured required Bot application cannot operate as a native Wayland client. Enabling it is a per-runtime capability decision, not an unconditional desktop service.
- Replace Alacritty as the default runtime application with a minimal persistent Bot Desktop host. The host paints a neutral surface, remains alive when launched applications exit, and supplies the stable Cage child process. It contains no panel, wallpaper service, notification daemon, portal stack, clipboard bridge, or user-visible runtime controls.
- Applications launched by the computer worker inherit only the owning Bot Screen's Wayland socket and per-Bot config/state/cache profile. Application exit does not stop the compositor or change Surface identity.
- Cage must present the active application or transient dialog over the usable output rather than leaving the default labwc-style 800×600 managed window. The 1080p and 720p output modes are explicit and their logical/video dimensions feed the existing geometry contract.
- Runtime readiness requires the Cage Wayland socket, configured output, committed Bot Desktop surface, ready input helper, and ready computer worker. No terminal title, Alacritty process, or `hyprctl` query participates in readiness.
- Preserve the existing native virtual pointer/keyboard helper and its wire protocol because the prototype proved Cage compatibility. It remains bound to the assigned output and retains authority, generation, sequence, held-input, and one-way paste validation.
- Preserve the private per-Bot profile and supervised application-unit model. Compositor, Bot Desktop, capture helper, encoder, input helper, worker, and launched applications belong to the Bot Screen's teardown boundary.
- Add a Computer Control architecture decision that supersedes the Hyprland-specific provisioning mechanism in the existing per-Bot compositor decision while retaining its Bot ownership, private socket, headless output, independent input/focus, capacity, and non-security-boundary conclusions.
- Keep nested Hyprland available only until Cage passes every acceptance gate in this specification. After the gate passes, remove production Hyprland/`hyprctl`/Alacritty requirements and generated Hyprland configuration rather than retaining dual runtime implementations.
- No persistence migration is required. Compositor name, codec state, process identifiers, Wayland sockets, and WebRTC media state remain runtime facts and are reconstructed during reconciliation.
- Keep the current network security posture governed by the existing transport-security decision. This work must not claim that H.264, WebRTC, private Wayland sockets, or loopback-only wayvnc experiments provide authentication or adversarial isolation.

## Testing Decisions

- The primary and highest test seam is the existing opt-in final-stack Bot Screen capacity harness exercising the production daemon, real compositor runtime, real capture/encoder, actual WebRTC peer, built web client, and browser paint/readback. This single seam decides whether H.264 and Cage may replace the production paths.
- A good test asserts observable Screen behavior: correct pixels, displayed FPS, input-to-visible feedback, Bot/Surface isolation, mode transition, recovery, and complete cleanup. It does not assert private command arrays, codec class construction, process ordering, component structure, source strings, or exact internal callbacks.
- Extend the final-stack harness to identify preview image frames separately from expanded H.264 frames and to count source, encoded, sent, received, decoded, and displayed stages without treating RTP receipt as display.
- Run the existing 1/2/4/8-Screen 1080p matrix plus the 720p fallback. Four concurrent 1080p Screens must each sustain at least 15 browser-displayed FPS and no more than 200 ms median input-to-visible feedback on the recorded LAN reference setup.
- Record input-to-visible p95 and require no regression beyond the checked-in approved envelope unless a new measured approval explicitly replaces it. Do not weaken a gate merely because the codec or compositor changed.
- Require zero unexplained frame drops for the approved four-Screen row. Every skipped or dropped frame must belong to a named capture, encoder, transport, decode, or paint category.
- Measure per-Screen and total PSS/RSS, CPU, attributable GPU data where available, capture latency, encode latency, encoded bytes, startup/readiness, teardown, and residual processes/sockets/files. Cage must show a material compositor-memory reduction at the same 1080p profile; the prototype's 720p comparison is not itself a release gate.
- Verify that idle Screens and Computer Preview have no running H.264 encoder and remain near the existing low-frequency preview rate. Entering expanded mode starts exactly one bounded pipeline; collapse and disconnect remove it.
- Verify initial negotiation, expanded-mode entry, periodic keyframes, reconnect, browser keyframe request, encoder crash, capture-helper crash, and a connected peer that never produces a decodable frame. Each failure must produce an explicit Surface-scoped state and preserve read-only snapshot fallback where capture remains available.
- Reuse the existing Computer Surface browser tests for Takeover, Bot switching, letterboxed coordinate mapping, pointer transitions, keyboard shortcuts, one-way paste, blur cleanup, narrow preview, missing frames, retry, and capacity-full presentation. Update their fake projection peer at the public browser boundary to supply a MediaStream track rather than teaching tests about encoder internals.
- Add browser behavior coverage for preview-to-video and video-to-preview transitions, clearing the previous Bot's video on selection change, snapshot fallback during failed negotiation, and refusing interactive state until the first correctly sized decoded frame is painted.
- Reuse the existing Bot Screen lifecycle integration tests for deletion ordering, restart reconciliation, fresh runtime generation after invalid recovery, sibling failure isolation, capacity admission, and stale input rejection. Extend the fake runtime only with the smallest stream capability needed to express those public outcomes.
- Reuse the existing projection signaling/status integration boundary to test the new versioned answer contract, required H.264 offer, stable control/input channel semantics, Bot/Surface ownership checks, explicit unsupported-codec failure, and clean session close.
- Extend the real platform smoke seam from nested Hyprland to two concurrent Cage Bot Screens. Prove different pixels, separate focus/cursor/key state, click/drag/scroll/paste, no Shared Screen pointer movement, output-bound capture, and complete process/socket/runtime cleanup.
- Add real Bot Desktop lifecycle scenarios: neutral desktop readiness without Alacritty, application launch, application exit without Screen exit, transient dialog visibility/input, Bot Desktop crash, compositor crash, and reprovision at a new generation.
- Verify both 1080p and 720p geometry end to end. Captured dimensions, negotiated video dimensions, browser intrinsic video size, content-rectangle input mapping, and helper logical coordinates must agree.
- Verify that HTTP snapshots are fresh, no-store, Surface-scoped, unavailable after deletion, and never sourced from the Shared Screen. Existing contextual Computer API integration coverage is the prior art.
- Verify diagnostic retention by asserting semantic counts and latency fields while typed text, pasted text, frame bytes, screenshots, raw controller identifiers, and lease tokens remain absent. Existing input-diagnostic privacy tests are the prior art.
- Keep deterministic codec unit tests limited to framed capture parsing, access-unit/keyframe boundaries, timestamp progression, and backpressure replacement where an external failure would otherwise be difficult to reproduce. Do not duplicate browser-visible behavior at this lower seam.
- The clean cutover is complete only when the real Cage/H.264 final-stack row passes, every production caller uses the new protocol, the old expanded image pump and Hyprland runtime are removed, and no compatibility aliases or dormant dual paths remain.

## Out of Scope

- Replacing the Computer Broker, Takeover protocol, controller epochs, input ordering, held-input cleanup, or Agent computer-tool boundary.
- Using wayvnc and noVNC as the primary Screen Projection or Web Control path.
- Running wayvnc beside every production Bot Screen; the successful child-socket probe remains reference evidence only.
- Selecting labwc as the Bot Desktop compositor.
- Running a full Omarchy/UWSM session, shell, panel, wallpaper stack, portal stack, or global session services per Bot.
- Treating a Shared Screen workspace or host virtual output as a Bot Screen.
- Keeping simultaneous production Hyprland and Cage implementations after the Cage acceptance gate passes.
- Making JPEG the global continuous-frame codec or retaining expanded image streaming as an invisible fallback for failed H.264.
- Hardware H.264/NVENC selection before it has its own quality, resource, driver, and four-Screen measurements; the proven initial encoder is software H.264.
- VP8, VP9, AV1, H.265, audio, camera, USB forwarding, file transfer, bidirectional clipboard, or remote clipboard reads.
- Mobile Web Control gestures or soft-keyboard guarantees.
- Multiple simultaneous Web Controllers for one Bot Screen.
- Preserving running graphical processes across machine reboot.
- Adversarial isolation between processes sharing one Unix user.
- TURN deployment, NAT traversal policy, application authentication, or a secure remote-access claim. A later non-loopback security change must treat authentication and TLS as requirements independent of whether TURN is needed for routing.
- Persisting video, screenshots, typed text, pasted text, or raw input events for diagnostics.

## Further Notes

- The 2026-09-04 experiment found JPEG q60 faster to capture than PNG but larger for terminal-heavy content. In a matched one-Screen browser run, PNG and JPEG q60 displayed 16.17 and 16.13 FPS; input-to-visible p50/p95 improved from 56.1/67.6 ms to 36.7/49.0 ms with JPEG, with zero drops in both rows. The short one-Screen runs passed their operational row but intentionally did not satisfy the separate four-Screen release gate.
- The H.264 prototype used the production WebRTC library and a real Chromium video track against the existing child socket. Under a rapidly changing terminal fixture it rendered 1920×1080 at 9.94 FPS, sent 112 frames with zero failures, and averaged 61,673 encoded bytes per frame. The measured 443 ms first-frame value included page startup and signaling and is not a steady-state interaction metric.
- The wayvnc 0.10.1 probe bound only to loopback and the child Wayland socket, captured the correct 1920×1080 output, and injected visible keyboard input. Its selected raw encoding transferred 8,294,400 bytes per frame and was intentionally not a bandwidth comparison.
- Cage 0.3.1 and labwc 0.20.2 both ran on a pure headless wlroots 0.20.2 backend, rendered Alacritty, supported direct `grim` capture, and accepted the existing input helper. Cage presented the application over the full output and measured 8.52 MiB compositor PSS; labwc defaulted to a managed 800×600 window and measured 17.22 MiB; the observed nested Hyprland compositor measured 121.11 MiB. Those capture comparisons used the wlroots default 1280×720 output and therefore establish feasibility, not the final 1080p performance ratio.
- The experiment implementation is preserved on the throwaway branch `experiment/bot-screen-transports` at commit `c7d28bf`. The evidence and decision are recorded in the Bot Screen feasibility research document.
- The existing per-Bot nested-compositor architecture decision remains authoritative until the required superseding Cage decision is accepted and the final-stack gates pass.
