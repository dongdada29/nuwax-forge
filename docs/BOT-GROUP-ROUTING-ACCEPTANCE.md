# DS-Bot 原生群路由合约验收

2026-11-04，在固定原包 `ds-bot@0.2.7` 上完成原生模块合约测试，未调用真实模型。现有 [Bot 接入切片](BOT-INTEGRATION.md) 已覆盖真实 DSH 宿主、身份及群持久化；本切片补充每个 Bot 的模型选择、群调度调用顺序、`@` 派发和工具内权限检查，不重复宿主验收。

**观察到的语义边界：独立群 Session 首次使用时会注入该成员自己私聊的最新摘要。** 本测试记录了摘要中的合成哨兵，没有观察到直接读取其他 Bot 的私聊。因此，独立 Session 不等于完全没有自身私聊上下文；个人 Bot 使用自身信息参与群任务是否符合产品预期，需按产品语义另行确认。本报告不将这一观察直接认定为产品缺陷，也不宣称已证明不会泄露私聊。

## 固定来源与运行

- npm 原包和上游 `gitHead`：[`71d344bf193f3f18185f25de3d8e5c483046910a`](https://github.com/Fei2411/DS-Bot/tree/71d344bf193f3f18185f25de3d8e5c483046910a)。版本、提交关系沿用 `BOT-INTEGRATION.md` 与 `lib/bots/pin.mjs`；本测试不联网重新查询 npm 元数据。
- 先调用现有 `verifyBotArchive(bytes)` 验证固定 SHA-512 SRI，再解压临时目录、核对包名/版本与现有 7 个文件 SHA-256。SRI 覆盖所有导入文件，包括新增覆盖的 `models.js`、`chat-index.js`、`privacy.js` 和 `parts.js`。
- 直接 import 原包模块，不修改、拷贝或裁剪其函数；不安装依赖、不启动 DSH、不读现有配置或凭据，不请求模型网络服务。
- `node:test`；本机验证 Node `v24.22.1`。原 `chat-index.js` 使用本机 Node SQLite，数据库只位于本次临时目录，测试结束关闭并清理。

```sh
# 默认：归档拒绝对照执行；原包行为测试跳过，无下载。
node --test packages/cli/test/bots-*.test.mjs

# 显式提供原始归档：SRI 不符会在解压/导入前失败。
FORGE_BOT_ROUTING_TARBALL=/absolute/path/ds-bot-0.2.7.tgz \
node --test packages/cli/test/bots-routing.test.mjs
```

本次结果：默认 Bot 测试 **8 通过、2 跳过**（真实宿主与本原包行为套件未开启）；开启本原包套件时 **8 通过、0 跳过**（1 归档拒绝对照、6 行为子测试及父套件）。

## 原生调用链与观察

路径均位于固定原包的 `src/host/`，fixture 只承接外部服务与可控测试数据。

| 合约 | 原生调用链 | 观察证据 |
| --- | --- | --- |
| 每 Bot 自己的模型 | `roster.createBot → buildBot → waitForModel → models.applyModel → selectSessionModel → ctx.sessionController.selectModel` | Chief/Bravo/Charlie 的问候分别到 `fixture-a/alpha`、`fixture-b/beta`、`fixture-c/gamma`，均携带 `high`；选择期间模拟 DSH 改写默认模型的副作用，原逻辑逐次恢复用户默认值 |
| 群内仍使用成员模型 | 已注册 `group_relay.execute → openingCall → runRound → memberTurn → groupSessionFor → desiredModel/desiredEffort → selectSessionModel → roomTurn → rt.deliver` | 三个群成员分别走原 Bot 模型；三私聊、一群 relay、三成员群 Session 共 7 个不同 ID；强制对 Bravo 调用原 `applyModel` 后，私聊和既有群 Session 同步换模型，Chief 不变 |
| admin 模式 | `openingCall → runRound → roomTurn` | 普通消息只产生 `start:Chief → finish:Chief` |
| everyone 模式的 admin-first | 原 `update_group → roster.updateRoom` 切模式；`openingCall → startable → memberTurn` | 把 admin 排在成员数组最后后，仍观察 `start:Chief → finish:Chief → start:Bravo → finish:Bravo → start:Charlie → finish:Charlie`；后发成员的输入含先发成员回复 |
| 用户 `@` 并发 | `openingCall → mentionsIn → shared/mentions.mentionSpans → runRound` | `@Bravo @Charlie @Bravo` 在 admin/everyone 两模式均只调用两人且去重。响应屏障必须等两人都开始才释放（2 秒内未到齐会失败并清理），证明两个 `start` 均先于任意 `finish`，不只检查返回数组排序 |
| Bot 回复中的 `@` | `memberTurn → callFrom → callIn → runRound` | Chief fixture 回复 `@Bravo` 后，原调度新增 Bravo 调用；`askedBy` 为 Chief。引用标签 `@Bravo` 则作为会话引用，不误派给 Bravo |
| 工具内权限 | 原 `tools.install → hideBotUnusedTools/shareBotTools → agent.ctx.tools.register → execute` | 非 Main Bot 不能建群；未知成员/无效模式拒绝且群状态不变；普通成员不能改群；非 Main 的群管理员能改模式，但不能改工作目录或清空管理员；Main Bot 也不能替用户设置群权限；群内 `message_bot` 不能派到群外成员；群外普通 Bot 不能读该群；非群 Session 的 relay 返回错误 |

没有复制 admin-first、`@` 解析或权限判断到 fixture。模型开始/结束记录来自 `rt.deliver` 外部边界，回复通过原 `roomWaiters` 完成；后续调度、回复落群日志与 `askedBy` 均由原 `groups.js` 执行。错误被原包捕获时，测试同时检查 warnings，避免把空轮次当作通过。

## 自身私聊摘要的可重复观察

固定源码的关键路径是：

1. [`groups.js` 的 `groupSessionFor`](https://github.com/Fei2411/DS-Bot/blob/71d344bf193f3f18185f25de3d8e5c483046910a/ds-bot/src/host/groups.js#L266-L300) 在首次建群成员 Session 后调用 `rt.ownChatBrief(member)`。
2. [`chat-index.js` 的 `ownChatBrief`](https://github.com/Fei2411/DS-Bot/blob/71d344bf193f3f18185f25de3d8e5c483046910a/ds-bot/src/host/chat-index.js#L282-L289) 调用原 `latestOwnChat → indexedParts → catchUp → eventsBackwards → ctx.sessionController.page`，由原 `parts.historyEntry` 解析合成存储事件。
3. [`groups.js` 的 `memberTurn`](https://github.com/Fei2411/DS-Bot/blob/71d344bf193f3f18185f25de3d8e5c483046910a/ds-bot/src/host/groups.js#L784-L797) 把 `session.brief` 拼接到群 prompt。

测试分别给三个 Bot 的合成私聊写入 `PRIVATE_<Name>_SENTINEL`，然后只点名 Bravo：

- 首次调用读取存储的 Session 列表恰为 `[Bravo 私聊 ID]`，Bravo 的群 prompt 含自身哨兵，不含 Chief/Charlie 哨兵。
- 第二轮复用 Bravo 的群 Session，不重新读取私聊，也不在本轮新增文本中再次拼接哨兵。**这不说明模型的整个群上下文已清除首次摘要**：真实 DSH 的历史仍可能保留首条消息。
- 同一 Bot 在第二个群获得另一个成员 Session，不带入第一个群的独有哨兵；新群首次 prompt 仍包含其自身私聊摘要。
- 原 `read_own_chat` 仍可显式读取 Bravo 自身私聊，并在群日志追加 `kind=lookup` 记录。
- 群日志本轮没有哨兵，因为 fixture 回复刻意只返回固定文本；这不证明真实模型不会复述摘要或通过回复间接把自身信息分享给其他群成员。

## Fixture 范围与未验项

`helpers/bots-routing-fixture.mjs` 提供内存 Session/工具注册/模型目录/默认模型存储、状态索引、持久化回调和合成历史页。外部 peer 的 `defineTool` 只保留原定义；未使用的 UI API 仅提供定义占位，其执行会拒绝。`rt.deliver` 使用可控本地响应并完成原 waiter，不运行 DSH 的 Agent 循环或 LLM adapter。创建 Bot、创建/更新群、模型选择、原工具定义及 Session 作用域注册、群调度、摘要选择与索引均使用原包代码。

群输入直接作为 fixture 数据放进原 `roomInbox`，随后执行原 Session 注册的 `group_relay`。这不是原用户 API、Cordis 事件/完整工具 middleware、HTTP 鉴权或浏览器端到端测试，也没有证明真实 DSH 的请求流一定进入相同代码路径。既有真实宿主验收及单独的真实宿主 provider 验收应与这里的模块证据分别解读。

仍未验：真实付费模型、真实模型自动选择工具和回复语义、模型复述自身摘要的行为、token/费用、供应商凭据与故障、完整历史压缩/跨 part 行为、真实工具工作超过宽限期的 late reply/approval/重启恢复、浏览器交互。未修改原包、Forge public CLI、入口/profile、集成层或 Dashboard。
