# Bot 平台选型调研

**建议首版采用 Tauri 2 客户端、自有 Bot daemon 和 OpenClaw Gateway。** 用户在 Tauri 里创建和联系 Bot。daemon 保存 Bot 身份、消息投递记录、任务、记忆权限和密钥绑定。Gateway 在后台运行 agent，调用远程节点和受管浏览器。三个部分可以装在一台 Linux 主机上，之后也可以把后台放到用户的 VPS 或托管环境。桌面窗口的生命周期不参与任务调度。

这是一份基于官方文档的选型建议。假设首版优先交付单人多 Bot、Linux 桌面和 Linux 远程执行机，SaaS 是后续目标。按五项需求独立评估，未用现有代码的迁移成本给候选方案加分。本文未做运行实测、报价或并发压测。

## 从 Grok Bot 借鉴什么

Grok Bot 让用户给一项长期职责起名字。主 Bot 接到差旅请求后，可以把工作交给费用 Bot。费用 Bot 记得收据放在哪里，各 Bot 都知道用户的时区。Bot 可以在群里回复，也可以私信另一只 Bot 交接，私信出现在各自聊天里。对本产品，值得沿用的是稳定的收件人、明确的职责和少量跨 Bot 事实；同时要让委派结果能自动回到发起任务的会话。[Bot 管理](https://docs.x.ai/grok-bot/bots) · [任务、记忆与电脑示例](https://docs.x.ai/grok-bot/how-grok-bot-works) · [聊天与交接](https://docs.x.ai/grok-bot/chat-and-collaboration)

Grok 的同一用户可以让多只 Bot 共用电脑、文件和浏览器登录态。这里建议默认给每只 Bot 分配独立浏览器配置，用户有意复用某个业务账号时，再授权共享。Grok 文档里的安全表单可以收取外部服务的 API key，但仅凭这一点不能推断它支持用自己的模型供应商密钥支付推理费。本报告以 Grok 为交互参考，自托管和模型 BYOK 单独选型。[Grok 的电脑、凭证与共享范围](https://docs.x.ai/grok-bot/how-grok-bot-works)

### Bot 和 agent 的边界

| 问题 | 产品中的 Bot | 执行层的 agent |
| --- | --- | --- |
| 用户联系谁 | 有 `bot_id`、名字、职责、收件箱和所有者，空闲时也可收信 | 接受一次任务，读授权上下文，选择模型和工具，可调用临时子 agent |
| 跨任务保留什么 | 用户可查的会话、任务、长期记忆、授权和用量归属 | 执行配置可复用；一次运行有独立 `run_id`、步骤、工具结果和终止状态 |
| 重启或换模型会怎样 | 地址、历史和欠交付的结果继续有效 | 运行可以中断或重试，换模型后可产生新的运行 |

“Agent”没有统一的生命周期。OpenClaw 的 `agentId` 本身就是可长期存在的配置和工作区，适合与一只 Bot 建立映射。比如研究 Bot 查证一个事实时，可临时启动两个子 agent；用户仍向研究 Bot 回信，用量和结果也归它。以后换运行时，只需更新映射。[OpenClaw 多 agent 路由](https://docs.openclaw.ai/concepts/multi-agent)

## 三种可落地的路线

| 路线 | Bot 协作与记忆 | 常驻、远程执行与浏览器 | 对这五项需求的判断 |
| --- | --- | --- | --- |
| **OpenClaw Gateway + 产品 daemon** | 有跨会话发送、独立工作区和会话；补产品收件箱、共享事实权限及交付回执 | 有 Gateway、配对的无头节点、远程命令和浏览器代理 | 首选。最大收益是直接复用远程执行路径。原生模型配置和 SecretRef 可对接 BYOK。主要代价是产品协议适配，以及 SaaS 要为不同信任域分开部署 |
| **Letta App Server + 产品 daemon** | 有长生命周期 agent。当前共享记忆文档描述组织拥有的 Git 仓库，agent 通过提交、推送、拉取协作 | App Server 可常驻并直接供 SDK 远程访问。客户端远程连服务与 Bot 操作另一台执行机是两个能力，后者及浏览器仍需选型验证 | 若产品核心变成多只 Bot 长期共编知识库，优先级会上升。不能直接把 Letta Cloud 的共享仓库计为纯自托管版已交付能力 |
| **LangGraph + 自建执行服务** | checkpoint 支持线程恢复，store 支持跨线程数据；可自行定义 mailbox、权限和共享范围 | 自选调度服务、远程 worker、浏览器、凭证及客户端协议 | 若 SaaS 首发，或核心任务是有明确步骤、必须恢复的长流程，这条路线更值得投入。当下需要自己拼装和验证的部件最多 |

三条路线都可通过服务 API 接 Tauri 和手机，这一项不足以拉开差距。OpenClaw 已提供远程命令与浏览器两条独立路径，是此次优先选择它的原因。其核心仓库采用 MIT 许可；官方同时明确一个 Gateway 对应一个互信边界，不能据此把不互信的租户装进同一个 Gateway。[OpenClaw 会话工具](https://docs.openclaw.ai/concepts/session-tool) · [节点执行](https://docs.openclaw.ai/nodes/node-exec) · [远程浏览器](https://docs.openclaw.ai/tools/browser/remote) · [信任模型](https://docs.openclaw.ai/gateway/security) · [许可](https://github.com/openclaw/openclaw/blob/main/LICENSE) · [Letta App Server](https://docs.letta.com/self-hosting/app-server/) · [Letta Shared Memory](https://docs.letta.com/concepts/shared-memory) · [LangGraph 持久化](https://docs.langchain.com/oss/python/langgraph/persistence.md)

## 推荐方案怎样工作

以“编辑 Bot 请研究 Bot 在远程浏览器核对一项资料”为例。用户应能关掉桌面，稍后从手机打开原会话，看到查到的来源、执行状态，以及由哪只 Bot、哪把模型 key 承担用量。

### 1. Bot 之间发消息

- **按 Bot 寻址。** 编辑 Bot 调用 `send_message(to_bot_id, body, reply_to)`。daemon 从调用身份确定发送者和工作区，检查两只 Bot 的通信权限，再把消息、收件记录和待投递项写入同一事务。发件方拿到 `message_id` 即可继续工作。接收 Bot 空闲或执行机离线都可以入队。
- **区分收信和完成。** 收件 Bot 得到独立任务，摘要和产物通过 `reply_to` 回到原会话。界面区分已入队、已接收、已完成、失败或已取消。没有回应时可从原任务查进度，群聊也保留可见的结果链接。
- **处理重复和循环。** 使用至少一次投递，以 `(recipient_bot_id, message_id)` 去重。把同一提交键映射到运行时支持幂等提交的入口，记录 `run_id`。运行时已接收但响应丢失时先对账。消息附根任务 ID，设置可配置的跳数、调用次数和费用上限。收件 Bot 收到正文并不会继承发件 Bot 的工具或凭证权限。
- **只保留一条权威投递路径。** Gateway 的 `sessions_send` 可异步受理或等待回复，其超时可能发生在已受理之后。产品通过受控消息工具登记跨 Bot 交接，收紧原生跨会话访问，避免模型绕过产品账本；产品适配器使用 Gateway 的会话 RPC，把消息来源标明为 Bot。同一会话的原生聊天提交键可用于去重，外层仍要记录最终交付。[会话发送语义](https://docs.openclaw.ai/concepts/session-tool) · [会话 RPC](https://docs.openclaw.ai/gateway/protocol/rpc-session-control) · [跨 agent 权限](https://docs.openclaw.ai/concepts/multi-agent)

### 2. 独立 daemon、远程任务和浏览器

| 部署 | 运行位置与故障行为 |
| --- | --- |
| 本机桌面首版 | daemon 和 Gateway 作为 OS 后台服务启动，独立于 Tauri。单实例 daemon 用 SQLite 持久化任务与事件。关窗口继续执行；主机关机或休眠时暂停，开机后对账恢复。需要退出登录后也继续工作时，安装方式必须支持无图形会话运行 |
| 自托管远程 | 用户可把 daemon 和 Gateway 装在常开的 VPS。执行机主动配对为 node，Gateway 把获准的命令及浏览器操作定向到该节点。笔记本离线只影响依赖该节点的任务。浏览器使用 Bot 对应的受管 Chromium 配置，下载或截图作为带权限的任务产物返回 |
| 托管 SaaS | 共用设备接入、租户管理和计费服务；为每个互信工作区分配隔离的 Gateway、运行身份、磁盘和凭证。跨信任域使用独立容器或 VM，并限制宿主机访问。产品账本迁到支持并发事务的数据库，按租户隔离记录和产物。成本模型要实测空闲工作区、活跃浏览器及唤醒时延 |

任务按步骤保存状态。安全可重试的读取走重试，已产生外部副作用的步骤用业务幂等键或结果查询确认。浏览器点击“提交”后若断线且网站无法对账，将任务停在“结果待确认”，保留最后一个可核查证据。密钥、浏览器 profile 和获准执行的命令分别授权；同一个 Gateway 内的工作区目录或浏览器 profile 本身不足以隔离任意 shell。给有 shell 权限的 Bot 单独的 OS 执行身份或沙箱，限制可挂载数据和可选 profile。[Gateway 协议](https://docs.openclaw.ai/gateway/protocol) · [无头节点](https://docs.openclaw.ai/nodes) · [浏览器运行模式](https://docs.openclaw.ai/tools/browser/remote) · [沙箱](https://docs.openclaw.ai/gateway/sandboxing)

### 3. 独立记忆与共享记忆

首版用数据库就能实现两种范围。**私有记忆**按工作区和 Bot 存取，例如费用 Bot 的收据目录；**共享记忆**归工作区所有，例如时区、项目术语或参与 Bot 名单，可限定读者。Bot 可以自动保存自身偏好和工作摘要。用户明确要求“让所有 Bot 记住”时写入共享区；自动共享仅开放用户已授权的字段。发送一条私信不会把整段聊天放入共享区。

每条事实保存来源、写入者、版本和更新时间。读取时先做范围过滤，再按任务相关性检索；更新用版本检查，冲突时保留来源供纠正。用户可以查看、纠正和忘记事实；删除时使检索索引及运行缓存失效，记录删除标记以防从旧摘要重新导入。删除一只 Bot 会删除它的私有记忆，共享事实按工作区策略保留，必要时隐藏或移除已删除的来源。首版用结构化事实和全文检索，用真实召回样本决定是否增加向量索引。Gateway 只获得本次允许读取的上下文，禁用会绕过这一规则的共享记忆插件或跨 Bot 工作区挂载。[Grok 的记忆示例](https://docs.x.ai/grok-bot/how-grok-bot-works) · [OpenClaw 工作区与记忆范围](https://docs.openclaw.ai/concepts/multi-agent) · [Letta 的共享机制](https://docs.letta.com/concepts/shared-memory)

### 4. Tauri 首版和手机规划

1. **桌面首版。** Tauri 2 提供 Bot 列表、会话、交接进度、任务取消、记忆纠正、节点配对和模型 key 设置。首轮聚焦 Linux 打包。关闭再打开后根据事件游标补齐进度。可以随安装包带后台二进制，但启动、升级和恢复由服务管理器负责。桌面 UI 经版本化的产品 API 连接本地或远程 daemon，Gateway 管理凭证留在后台。[Tauri 外部二进制](https://v2.tauri.app/develop/sidecar/) · [Tauri 分发目标](https://v2.tauri.app/distribute/)
2. **手机首版。** iOS 和 Android 复用同一产品 API、事件游标及适合小屏的会话组件，优先评估 Tauri 2 移动端。扫码配对使用一次性短时令牌，每台手机有独立可撤销身份。提供收发消息、任务进度、审批与取消。离线发信保留客户端消息 ID，重连时去重。推送仅提示有更新，打开后再鉴权取正文。自托管环境通过私有网络或认证的 HTTPS 入口接入；桌面主机睡眠时，客户端显示后台离线。
3. **发布前的移动端验证。** 在真机验证 iOS/Android 的密钥存储、深链配对、推送和进后台再恢复。操作系统会调度并限制后台工作，持续执行归常在线 daemon。若 Tauri 移动插件不能满足上述能力，可以单独替换手机壳并复用协议。[Apple 后台任务](https://developer.apple.com/documentation/backgroundtasks) · [Android 后台工作](https://developer.android.com/develop/background-work/background-tasks)

### 5. 模型推理的 Bring Your Own Key

| 环节 | 首版设计 |
| --- | --- |
| 绑定和归属 | 用户添加供应商、模型和 key，通过一次最低成本的验证调用确认可用。工作区可设默认凭证，单只 Bot 可覆盖；默认禁止未获授权的 Bot 继承其他凭证。每次运行记录 `credential_id`、版本、模型、Bot 和供应商报告的 token 用量。费用由对应供应商账户承担 |
| 本地和 VPS | 使用专用密钥表单。凭证通过本地受保护通道或 TLS 直接进入目标 daemon 的凭证服务。桌面可选系统密钥环；无人值守 Linux 使用服务账号可在开机时解锁的加密凭证，例如 systemd encrypted credentials。无图形登录重启必须可测。业务数据库仅存引用，手机只持设备会话凭证 |
| 使用时 | 受信任的推理代理根据 Bot 身份和策略选 key，向绑定且允许的供应商端点发送请求。Gateway 获得限 Bot、模型、时效和额度的内部凭证，普通工具、远程 node 及浏览器拿不到供应商 key。首轮可验证 OpenAI 和 Anthropic 两种协议的流式输出、工具调用、取消和用量。禁止把真实 key 随自定义地址或重定向转发 |
| 托管 SaaS | 用户明确选择托管 key 后，以租户数据密钥加密，再由 KMS 包装数据密钥；只有推理代理的运行身份可以按租户解密。需要 key 留在用户机器的用户继续使用自托管模式。托管推理时代理需在请求期间接触明文，模型供应商也会收到请求 |
| 撤销和故障 | 提供轮换、撤销、测试连接和用量查询。撤销后拦截新调用并使缓存失效，已到达供应商的请求仍可能产生费用。401 标记待更新，429 按供应商提示有界退避，余额不足时暂停。单任务、单 Bot 和工作区设预算；并发请求先预留再按实际用量结算。禁止默默改用另一把付费 key |

OpenClaw 的模型供应商配置、自定义端点和 SecretRef 是接入依据。租户级用量归属、代理端预算与撤销属于产品责任，尤其要验证代理保留供应商原生工具调用语义。日志、导出、记忆和崩溃报告均不记录 key。[模型供应商](https://docs.openclaw.ai/concepts/model-providers) · [自定义端点](https://docs.openclaw.ai/concepts/model-providers/custom-providers) · [SecretRef](https://docs.openclaw.ai/gateway/secrets) · [systemd 服务凭证](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#Credentials) · [KMS 信封加密](https://docs.aws.amazon.com/kms/latest/developerguide/kms-cryptography.html)

## 决定是否采用的最小验证

| 场景 | 通过条件 |
| --- | --- |
| A 给 B 派活，接收成功时断网 | A 能查到同一条交接；重新投递只触发一个逻辑任务；B 的回复能回到 A 的原会话。连续相互委派触发限额后停止 |
| 从 Tauri 提交任务，关闭窗口 | 远程 Linux 节点执行命令并用受管浏览器访问测试页，结果写回。断开节点、重启 daemon 后任务可对账。模拟浏览器提交响应丢失时不会重复提交 |
| A 和 B 记住不同偏好，共享同一时区 | B 可以引用时区，不能通过检索、跨会话工具、shell 或浏览器配置读到 A 的私有内容。修改共享时区在两边生效，删除后新会话无法召回 |
| 同一工作区的两只 Bot 使用不同 key | 供应商记录、任务用量归属一致；撤销其中一把只影响获授权使用它的任务。工具输出、日志、导出和远程进程环境中找不到测试 key |
| 换手机、换部署 | 真机断线重连可补齐同一个任务；撤销手机配对后读不到新事件。两套托管工作区使用相同 Bot 名称时，任务、密钥、浏览器及产物仍互不可见 |

**采用条件。** 先锁定 OpenClaw 版本验证前四项，手机与租户隔离分别作为移动发布和托管发布的门槛。如果原生工具可绕过产品的消息、记忆或凭证权限，或一次断线会带来无法对账的重复执行，就不要把该适配器定为基础设施。保留独立的 Bot API 和数据模型，优先用同一组场景复测 LangGraph + 自建执行服务。这样下一次选型比较的是用户能观察到的行为。
