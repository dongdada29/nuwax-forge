# DS-Bot 非空记忆契约验收

本切片验证固定原版 DS-Bot 的记忆工具、隐私检查和持久化，**结果属于「原生模块 + fixture 宿主服务」**。它补充 [Bot 接入验收](BOT-INTEGRATION.md) 的空记忆面板证据，不重复真实 DSH 安装/启动验收，也不把 fixture 当成真实模型或浏览器体验通过。

## 来源与运行

固定 `ds-bot@0.2.7`，上游提交 `71d344bf193f3f18185f25de3d8e5c483046910a`，来源及 SRI 复用 [pin.mjs](../packages/cli/lib/bots/pin.mjs)。测试先调用 Forge 已有的 `verifyBotArchive` 核对完整 npm 归档的 SHA-512 SRI，再将同一份已校验字节写入临时归档解压，核对包名、版本和 `BOT_FILES` 的 7 个 SHA-256。包括 `store.js`、`privacy.js` 在内的整个原包均受完整归档 SRI 约束，不从工作副本加载替代源码。

默认测试不下载、不安装依赖、不依赖任何预存的 `/tmp` 文件、DSH 安装或用户凭据；原包验收明确跳过。临时目录通过 `os.tmpdir()` 分配并清理。Node >=22；显式验收还需系统 `tar`。

```sh
# 默认：归档失败对照通过，原包契约验收显示 skipped。
node --test packages/cli/test/bots-memory.test.mjs

# 显式：用户提供固定 npm 原始 tgz；测试不会下载包。
FORGE_BOT_TEST_TARBALL=/absolute/path/ds-bot-0.2.7.tgz \
node --test packages/cli/test/bots-memory.test.mjs

# CLI 回归（默认仍不运行真实 DSH 或模型）。
npm test --workspace @nuwax-ai/devkit-cli
```

主测试位于 [bots-memory.test.mjs](../packages/cli/test/bots-memory.test.mjs)。原生测试在子进程中运行，显式设置全新 HOME，仅继承 PATH；不传递 provider keys、DSH 配置、`NODE_OPTIONS` 或现有用户 HOME。未设置 `FORGE_BOT_TEST_TARBALL` 时，CI 通过不代表非空记忆功能通过；错误路径或损坏归档在显式启用后必须失败，不会退回跳过。

## 实际执行路径

测试加载解压后的原始 `store.js` → `privacy.js` → `tools.js` → `memory.js`，未修改、复制或实现这些模块的业务逻辑：

1. Bot 角色、群成员和 Session ID 是固定 fixture 输入，经原 `store.save()` 保存；原 `store` 构建会话归属索引并持有数据目录锁。这不是 `roster.createBot()` / `createRoom()` 或真实 DSH Session 创建验收。
2. 原 `memory.install()` 定义 `remember`、`recall`、`forget`；原 `tools.hideBotUnusedTools()` 把定义注册到 fixture Session，非 Bot Session 和群自身的中转 Session 不获这三个工具。
3. fixture 调度器执行原工具 guard、原 `privacy` 的 `tools/execute` 中间件和原工具 `execute()`。权限、查询、改写、journal 和文件事务均来自原代码。
4. 回读使用原 `recall` 和 `memoryEndpoint('memory-view')`；历史使用原 `memory-history`。测试只读取原生生成的 journal 作独立隔离检查，**不直接写入任何记忆、快照、journal 或 pending 文件**。
5. 持久化测试先由一个运行时写入，另一个 Node 进程验证锁拒写；关闭第一个运行时、释放原生锁后，再启动新的 Node 进程，由原 `store.load()` 和原记忆模块重新读取身份与记忆。新进程不重新注入 fixture 状态，比较三个面板完整回读结果，并重新执行工具和权限断言。

外围适配器仅提供事件注册、effect 清理、Session 工具表、空会话历史、固定时钟、SDK `defineTool`/错误类型及未使用的 Deep View 元数据。它们没有记忆存储、检索或权限实现。DSH 的真实 SDK、Cordis 生命周期、参数验证和请求序列化未在本层运行；fixture 的工具派发不能证明这些服务的兼容性。`desiredModel`、`defaultModel`、`llm` 和 `BlockAssembler` 路径均遇调用即失败，并断言模型服务调用计数为零。自动审查监听器虽然由原模块注册，本测试不发出触发审查的状态事件。

## 2026-11-04 实测结果

本机 Node `24.22.1`：显式测试外层 **2/2 通过**；其中原包子进程 **8/8 通过**，未请求模型服务。离线执行 `npm ci --offline --ignore-scripts --no-audit --no-fund` 建立本地 workspace 依赖后，CLI 回归 **123 通过、12 显式跳过、0 失败**。

| 原生模块证据 | 已验证结果 |
| --- | --- |
| own 非空写读 | Alpha/Beta 各自写入并回读；默认 recall、用户面板和群面板不混入另一 Bot 的 own 内容；不存在对象拒绝 |
| team 共享与写权限 | Chief 和群 admin 可写；所有 Bot 可读；普通 Bot 写入/删除被拒；移除 admin 身份后写入被拒，内容不变 |
| group 语境隔离 | 群成员 Session 的默认写入进入该群；同群成员可读；另一群、Bot 自己的对话和不在群语境的 Chief 不读到该群内容；保留旧 Session 映射但撤销成员资格后仍拒写且不回读群内容 |
| 私有 Bot | 原隐私中间件阻止其他 Bot（包括 Chief）对私有记忆 recall/remember/forget；私有 Bot 可读公共 Bot，普通公共 Bot 不可读其他公共 Bot；Chief 可修改公共 Bot；用户面板仍可看私有 Bot |
| 日志与更改 | 私有条目仅在私有 journal，团队 journal 与其他 Bot 历史没有该文本；原 remember replace/topic recall/forget 生效，历史保留 add/replace/remove；超长、非法 topic、未知 scope 和合成密钥样式输入被拒，完成后无残留 pending |
| 提示词快照 | 当前 Session 快照保持原内容，recall 立即读到改写；原 `renewMemory()` 后提示词读取新内容 |
| 独立 home | 相同 fixture 身份在两个原生 home 中分别写 own/team/group，互不串读 |
| 跨进程与持久化 | 锁占用时第二进程只读且拒写；释放后新进程回读 own/team/group/private 非空内容，面板结果与重启前一致，私有拒绝规则仍生效 |

## 验收边界

| 层次 | 本切片结论 |
| --- | --- |
| 原生模块 + fixture 服务 | 上述非空写读、权限、隔离、journal、锁及有序关闭后的进程持久化已验证 |
| 真实 DSH / 原编译客户端 | 仍使用 [既有宿主验收](BOT-INTEGRATION.md) 的证据；本切片未重新验证非空记忆经真实 DSH 派发、HTTP 面板或浏览器显示 |
| 真实模型行为 | 未验证；没有调用 `memory-ask`、摘要生成、自动审查或让模型选择工具；不声称模型能正确提取记忆、遵循权限或产生业务结果 |
| 故障与系统边界 | 未验证进程被强杀时 pending 恢复、磁盘故障、Windows 文件替换、系统重启或 OS 文件权限隔离；测试中的锁持久化是正常关闭后重启，非崩溃恢复 |

后续真实模型验收需要在获授权的独立实例里，通过原用户界面/`memory-ask` 或实际对话触发记忆写入，再观察真实面板、模型回读与重启。不要直接写 Markdown 数据文件代替这一产品路径，也不要把本文件的 fixture 结果标成已完成该验收。
