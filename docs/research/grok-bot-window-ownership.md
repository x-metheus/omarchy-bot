# Grok Bot：共享浏览器与窗口归属

归档日期：2026-11-03。本文整理已完成的三份研究报告（本地证据、官方资料研究、ticket07 对比），本次未重新调查、联网或运行实现。

2026-11-03 补充（设计已更新）：本文保留的是旧 exactly-one 关联规则的历史研究证据。ticket07 最新评论 “design revised with the user — title-stamp attribution” 已决定用唯一临时标题 nonce 精确关联 CDP target 和 Sway 容器，并明确覆盖同时弹窗；它取代了下文所述的待澄清阻塞和下一步设计决策。现行设计见 [ADR 0012](../contexts/computer-control/adr/0012-agent-browser-control-over-cdp.md)。原研究内容和来源保留，不能作为当前实现阻塞的依据。

## 观察与官方契约

用户观察：“参考grok bot的方案，我看到的结果他们使用的是同一个浏览器也共享profile，但是每个都是独立的窗口”。这是用户提供的产品行为观察；本研究没有独立观察认证后的 Grok 生产会话。

xAI 官方 [Use the computer and apps][P1] 原文：

> Browser cookies and signed-in sessions are shared

> Each Bot gets its own screen on the shared computer. Several Bots can therefore use browser and desktop tools in parallel

官方 [FAQ][P2] 原文：

> Each Bot gets its own screen on the shared computer. One Bot can run one computer-use task on its screen at a time.

这些文字支持共享 cookies/登录会话、每 Bot 独立 Screen 和并行工作。它们与用户的独立窗口观察相容，但没有规定磁盘 profile 路径、每个 Screen 的原生窗口数量、生产 Chromium 进程拓扑或弹窗归属算法。独立窗口不要求每个窗口具有独立浏览器进程。

## 仓库对比支持什么

以下代码位置由既有报告核对，本次未重新读取源码。所述 ticket07 实现含保留中的未提交修改，代码路径和测试断言均不等于已通过运行验收。

- **普通显式启动有 Screen 请求上下文。** [browserSupply.ts:232](../../apps/daemon/src/modules/computer/browserSupply.ts:232) 对同一 `--user-data-dir` 请求 `--new-window`；[swayBotScreenRuntime.ts:1312](../../apps/daemon/src/modules/computer/swayBotScreenRuntime.ts:1312) 在唯一新增目标/容器条件下绑定归属。共享 profile 与普通独立窗口在现有架构中相容。
- **页面自动创建的弹窗走另一条入口。** [browserRuntime.ts:137](../../apps/daemon/src/modules/computer/browserRuntime.ts:137) 通过 CDP `openerId` 和已有 ownership 找到 opener 的 Screen；这回答“谁打开”，尚未回答“哪个 Sway 容器显示新窗口”。
- **待解决的是新窗口之间的关联。** [swayBotScreenRuntime.ts:1213](../../apps/daemon/src/modules/computer/swayBotScreenRuntime.ts:1213) 仅在 pending popup 恰好一个时选择候选。两个尚未配对的弹窗重叠时，当前规则不能把各自的 CDP browser windowId 对应到正确的 Sway `con_id`，会保持未归属并停放。
- **已有 fixture 区分顺序与重叠。** [顺序 fixture:742](../../tests/integration/bot-screen-sway-popups.test.ts:742) 每次只有一个 pending；[重叠 fixture:940](../../tests/integration/bot-screen-sway-popups.test.ts:940) 先创建两个 target 再出现两个 Sway 窗口，并断言停放。报告只读过这些断言；本次未执行测试。“重叠”指未解决的归属生命周期交叠，无须事件发生于同一物理时刻。

## 上游源码的边界

公开 xAI `grok-build` 在 commit `72a6125` 的 [`methods.rs`][P3] 把 `bot.vncDescriptor` 描述为：

> Short-lived noVNC descriptor. May wake a hibernated box.

同版本 [`bot_relay.rs`][P4] 的参数包含 `agent_id`，结果包含 `vnc_url`、`expires_hint`。这证明所检查协议可按 Bot 请求 viewer descriptor；这些字段没有暴露 target/opener/native-window 的归属关联。不能把该协议等同于 Grok 生产图形后端实现。

作为本仓库技术栈的对照，[Chromium 156.0.8078.47 handler][C1] 返回浏览器 SessionID 和 bounds；[Sway 1.10.1 view][C2] 从 Wayland client credentials 取 PID，[IPC 序列化][C3] 输出 view PID。所检查字段本身没有给出 Chromium windowId 到 Sway `con_id` 的直接映射。这不证明 Grok 使用相同后端，也不是共享浏览器窗口归属的普遍不可能性结论。

## 有界结论与下一项决策

共享 browser/profile 与每 Bot 普通独立窗口相容。当前 ticket07 的 exactly-one 规则不能覆盖两个未配对页面弹窗重叠的调度；这个结论只针对现有关联规则。官方并行 Screen 承诺、普通窗口观察和 viewer descriptor 都不足以证明或否定 Grok 能正确处理这种重叠弹窗。现有公开证据没有揭示其实现机制。

下一步需要针对 ticket07 的关联规则与重叠弹窗验收作明确设计决策：若必须成功路由重叠弹窗，需要有证据支持的 browser-window ↔ native-container 区分规则；若允许歧义时继续停放，则需明确修改验收语义。本文不选择新机制、不改变 fail-closed 约束，也不授权实现。原实现仍阻塞于 settled design 的澄清。

## 来源与访问限制

本笔记依据已完成的本地证据、官方资料研究和比较报告归档，不依赖它们的临时交付路径。该轮 scout 报告记录了对官方文档和固定版本上游源码的新鲜 GET（HTTP 200）；比较报告另记录其独立 GET 成功。官方资料 researcher 自身的独立抓取被工具的 internal/fake-IP 检查阻止，搜索来源检查也未获得相关证据，因此它明确依赖 scout 的原始抓取。这些成功抓取均发生于先前研究流程，本次没有重抓或绕过限制。

没有获得 Grok 生产窗口管理源码、认证会话轨迹或两个重叠页面弹窗均正确归属的直接演示。历史营销 demo 不能替代生产证据。上述固定版本通用源码仅用于技术对照；未提交本地实现的运行正确性不在此次归档验证范围内。

[P1]: https://docs.x.ai/grok-bot/computer-and-apps#one-computer-shared-by-all-your-bots
[P2]: https://docs.x.ai/grok-bot/faq#can-several-bots-work-at-the-same-time
[P3]: https://github.com/xai-org/grok-build/blob/72a6125/crates/common/xai-tool-protocol/src/methods.rs#L142-L144
[P4]: https://github.com/xai-org/grok-build/blob/72a6125/crates/common/xai-tool-protocol/src/bot_relay.rs#L132-L156
[C1]: https://github.com/chromium/chromium/blob/156.0.8078.47/chrome/browser/devtools/protocol/browser_handler.cc#L92-L126
[C2]: https://github.com/swaywm/sway/blob/1.10.1/sway/tree/view.c#L508-L514
[C3]: https://github.com/swaywm/sway/blob/1.10.1/sway/ipc-json.c#L573-L578
