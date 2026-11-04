# PA 任务接入的最小切片与阻塞点

本批交付显式本机 HTTP 只读 client、DSH 原生查询工具与**请求预览**。预览明确显示“未提交；未创建 PA 任务；未获执行授权”，没有持久待办库，也不会调用 `POST /api/tasks`。这不是 Bot → 人工批准 → Forge 执行 → 原 PA 回写的业务闭环。

原 PA 工作台仍是任务发起、权限审批、接管、继续、重试和交付接收入口。本 integration 不修改 PA，不访问其数据库、日志、现有运行实例或引擎凭据，不执行模型或命令，不修改公共 CLI、Dashboard 或 Bot。

## 原 PA 的已核实语义

只读对照本地 `personal-agent` checkout **`1f13eac357e5ea20a9c6adfcb21d6bbefd517d13`** 的 `apps/server`、`packages/contracts`、`packages/runtime`，结论限于此版本：

| 入口/类型 | 实际行为 | 对接影响 |
| --- | --- | --- |
| `apps/server/src/app.ts:72`，`POST /api/tasks` | `store.create()` 后默认立即 `runner.enqueue()`；返回 `queued` 也可能已经开始执行 | 创建不是待审批，不发送“先创建再暂停”的竞态请求 |
| `app.ts:138,217` | resume/retry/return 与启动时已有 queued 任务默认入队 | 单独拦截创建路由不足以形成授权门 |
| `AppOptions.autoRun`，`apps/server/src/main.ts` | `autoRun:false` 是构建函数选项；正常入口没有公开此门 | 不能把测试选项宣称为生产授权流程 |
| `packages/contracts/src/index.ts:164`，`ApprovalRecord` | 关联 task/attempt/run，是活动 ACP 引擎发出的工具权限请求 | 不是创建前授权；不能由 Bot 凭请求内容伪造此审批 |
| `app.ts:142`，`POST /api/approvals/:id/resolve` | 校验 pending approval 仍附着活动引擎；过期返回 `STALE_ATTEMPT` | 不能先造空 approval 再通过此接口启动任务 |
| `packages/runtime/src/store.ts:129,159,384` | 原生 commandId 重放/冲突与审批写入持久化于同一 PA SQLite | 后续写入必须复用该幂等与事务边界，不能另建 Forge 任务库 |
| `apps/server/src/access-control.ts` | 本机开发模式限制 loopback Host/Origin；paired 模式校验精确公开 Host/Origin、设备 Cookie，变更另需 CSRF | 配对是访问认证，不等于独立人工执行授权 |
| `packages/contracts/src/index.ts:430`，`Device` | 当前设备元数据没有 Bot/人类角色或能力范围 | 把一个普通已配对设备 token 交给 Bot 并不能防止自我批准 |

当前没有外部 Forge 结果导入 HTTP 路由、引擎注册 API 或 `TaskEngine='forge'`。`TaskEngine` 只有 `fake | claude`，`TaskRunner` 的分支固定；`buildApp({ realAdapter })` 是代码级依赖注入，不是外部服务可用的接入点。

## 接入与凭据边界

独立包位于 `integrations/personal-agent-forge/`，不依赖其他 npm 包。DSH 的插件模块沿用已有原生 `ToolDefinition` 契约，通过 `ctx.tools.register()` 注册，保留原生 guard、参数验证、取消和销毁。

仅操作者配置可以指定服务，工具参数不能改 URL、Host、鉴权、环境、命令或 argv。配置强制精确的 `http://127.0.0.1:<port>`；不接受 localhost DNS、其他 IP、路径、query、fragment、URL 凭据或默认端口的非规范形式。不扫描端口、不自动连默认实例、不使用 HTTP 代理环境、不跟随重定向、不重试。paired 公开 origin 仅用于原 PA 要求的 Host/Origin header，网络连接仍固定为显式数值 loopback。

下面是隔离 fixture 的配置形状；实际端口和实例标签必须由操作者确定，不应通过此示例连接生产实例：

```js
const config = {
  schemaVersion: 1,
  origin: 'http://127.0.0.1:49123',
  instanceId: 'operator-labelled-isolated-pa',
  botId: 'full-operator-configured-bot-id',
  auth: { mode: 'loopback' },
  timeoutMs: 5000,
  maxResponseBytes: 4194304,
  maxItems: 10000,
};
// 由操作者控制的 DSH bootstrap 显式加载此模块和配置：
await ctx.plugin(await import('../integrations/personal-agent-forge/index.mjs'), config);
```

paired 模式只接受操作者拥有的**运行时函数**，不接受配置中的静态 token、任意环境变量名、凭据文件路径或工具参数中的凭据：

```js
config.auth = {
  mode: 'paired',
  publicOrigin: 'https://operator-selected-pa.example',
  credentials: async ({ signal }) => operatorProvidedCredentials({ signal }),
  // 回调仅返回 { deviceToken }，不返回 CSRF，不进行配对/提权。
};
```

`operatorProvidedCredentials` 是集成方显式提供的安全运行时输入，并非本包内置凭据读取器。每次 GET 单独调用，不缓存、不持久化、不输出；超时/取消通过 signal 通知回调，迟到结果不会建立连接。标准 JSON 插件配置不能携带函数；没有操作者 bootstrap 提供回调时 paired 模式直接拒绝加载，不能把 token 填进 JSON 代替。本批未增加生产安装或登录流程。

原 PA 的 HTTPS paired Cookie 名为 `__Host-pa-device`；明确 localhost HTTP 开发 origin 使用 `pa-device-dev`。仅发送原生 Cookie，没有虚构 Bearer token 支持。HTTP 错误返回本地固定错误码，不回显原响应 body/header；成功响应中误回显的本次 deviceToken 会替换为 `[REDACTED]`。无 Cookie jar、Set-Cookie 保存或隐式会话续期。

## 工具输出与请求预览

| 原生工具 | 输入 | 结果 |
| --- | --- | --- |
| `personal_agent_tasks` | `{}` | 原生 `GET /api/tasks` 的有限任务事实 |
| `personal_agent_task` | `{ taskId }` | 原生 `GET /api/tasks/:id` 的有限快照事实 |
| `personal_agent_request_preview` | `{ requestId, goal, forgeTaskKey?, forgeAttemptId? }` | 纯内存、无 HTTP 的预览；不创建 PA Task/Attempt/Run/Approval |

调用必须带 DSH 执行上下文中的完整 session ID 和 tool call ID。来源保留操作者设置的完整 botId、instanceId，以及原生 task/attempt/run/stage/approval/artifact/verification IDs；不截断、不按标题合并。instanceId 是操作者标签，PA 目前未提供可校验的实例身份端点，不能据此声称密码学实例认证。

预览中的 Forge taskKey/attemptId 仅是调用方声明，明确 `verified:false`；未声明的关系为 null，不从文字、活动 attempt 或相邻 run 猜测。预览的 PA IDs 与原生 command/approval IDs 都为 null，`submitted/paTaskCreated/executionAuthorized` 均为 false，状态只叫 `preview_only`。库级 `submitTask()` 同样拒绝并返回 `PA_TASK_AUTHORIZATION_UNAVAILABLE`；没有控制、批准或回写工具。

requestId 与内容、目标实例、Bot、DSH session 生成稳定 SHA-256 fingerprint，重复相同预览得到相同 fingerprint，内容变化则不同。它仅便于人工比对；没有保存、唯一性约束或防重放授权，`deduplicationEnforced:false`，不能冒充原 PA commandId 幂等提交。

查询保留原生 `status` 和独立的 `deliveryStatus`。completed 不等于 accepted，accepted 不等于产品验收；`productAcceptancePassed:null`。实际模型、执行 session、token 用量保持 null/unknown，即使输入夹带“用量为 0”或配置模型也不会升级为运行证据。缺失的 run attemptId 不从 task.activeAttemptId 补齐；缺失集合为 null，历史完整性为 unknown。

事件只投影 seq/type/time/显式 attemptId；不输出任意 data、配置快照、权限 rawInput、验证 argv 或工件正文。相同快照内拒绝重复/倒序 seq、越过 cursor、跨 task 记录、重复 IDs，以及同时存在的 stage/run/approval 关系冲突。不把快照新鲜度当作进程存活；未实现 SSE 或跨请求持久游标。

所有读请求默认总时限 5 秒（含凭据回调与 body），可配置 10–30000ms；响应默认最多 4MiB，header 与流式 body 均有边界，单数组最多 10000 项。超限、非 JSON、错误 UTF-8、压缩 body 或不完整传输失败，不返回部分“成功”事实。

## 完整闭环最少需要的 PA 扩展（未实施）

以下是后续方案，不是本 PR 的已支持 API。权威数据仍放原 PA SQLite，使用原 Task、commands、events 与事务，不新建 Forge 任务库。

1. **原生创建前请求与人工门。** 在 `packages/contracts/src/index.ts` 增加外部任务来源/执行授权类型；在 `packages/runtime/src/migrations.ts`、`store.ts` 的同一 DB 中保存请求内容 hash、来源 Bot/DSH/Forge IDs、申请者身份、待审批/批准/拒绝事实与独立人类审批身份。可选择原 Task 新增 `awaiting_authorization` 状态，或同 DB 请求记录在批准时才创建 Task；不能让未批准请求以普通 queued 状态被启动恢复逻辑自动捡起。审批是任务执行授权，与已有 ACP 工具权限 `ApprovalRecord` 分开建模。
2. **请求与批准能力分离。** 在 `apps/server/src/access-control.ts`、`packages/runtime/src/auth-store.ts`、原生 Device/principal 契约中增加受限 Bot 请求能力与独立人类审批能力。拟议 `POST /api/task-requests` 只保存请求；拟议 `POST /api/task-requests/:id/approve` 只允许独立人类身份，绑定完整目标、工作空间、验证命令、引擎、预算和内容 hash，并继续使用原 Host/Origin/CSRF、撤销和重放校验。不能把一个 `approved:true` 参数、DSH guard 成功或同一 Bot 的配对 Cookie 当作人类决定。
3. **批准后才能入队。** 在 `apps/server/src/app.ts` 的创建/控制/启动恢复路径与 `packages/runtime/src/runner.ts` 的 enqueue/start 再次检查持久批准事实。批准与创建/可运行状态在同一 PA 事务提交，之后才 enqueue；重复审批只返回原结果，变更内容需要新审批。resume/retry/return 的授权范围必须明确，重启、取消、撤销、过期或旧 attempt 不能绕过门。
4. **首选复用 EngineAdapter 管理 Forge 生命周期。** `packages/runtime/src/engine.ts:16,56,68,86` 已有 taskId/attemptId/runId、signal、onEvent、onPermission、prompt/cancel/close；`pipeline.ts:121–175` 已把事件/工件写入原 TaskStore 并隔离旧 attempt。增加受信任、操作者配置的 Forge adapter 注册与 TaskEngine 分支后，可在原生人类批准后由 PA 打开 adapter，使用 PA 提供的 cwd/角色/模式/attempt/run，调用既有 Forge prepare → budget gate → run → reconcile；不得接受 Bot 提供的任意可执行文件、URL、环境或 argv。Forge 的真实外部 attempt/session、预算估算/结算/unknown 与 PA attempt/run 的映射必须持久化在原 DB，不能仅拼进 goal 或模型总结。
5. **结果回到原 Task 的证据链。** adapter 的 `onEvent/onPermission` 可复用原事件与工具权限管道；`EnginePromptResult`、artifact 可以回传有限文本，但现有 `EngineEvent` 只支持 markdown 等少数事件，没有结构化 Forge usage/settlement 类型，需要扩展原契约与存储字段。PA-owned worktree、基线、验证结果和 patch 必须一致；不能让 Forge 在另一未关联 worktree 修改后宣称 PA 验证通过。使用原 runtime 的验证/评审/交付状态机；processPassed、agentCompleted、usageKnown、预算合规和人工接收各自保留事实，不以 Forge exit 0 自动 completed/accepted。
6. **若改选异步结果导入。** 需要新增限域、认证、请求大小限制和幂等的原生结果路由，绑定 PA task/attempt/run、批准 hash、Forge attempt 和证据 hash；原子检查当前 attempt，拒绝跨任务/重放/迟到结果，禁止直接写 `Task.status=completed` 或 `deliveryStatus=accepted`。当前没有此接口；EngineAdapter 路径优先，避免同时维护第二种执行状态机。进程所有权、取消/接管和重启后的不自动重放仍需原 PA 运行时确认。

上述改动涉及 PA 的授权与执行契约，须另立任务实施及验收；本 PR 没有修改 PA 源码。

## 可复现验收

从 Forge 仓库根目录运行：

```sh
npm --prefix integrations/personal-agent-forge test
```

17 项离线测试仅启动内存 loopback HTTP fixture（由系统分配临时端口，不扫描）。覆盖完整长 IDs/来源关系、unknown、completed/accepted/returned、静态配置与工具参数边界、运行时 paired Cookie、凭据拒绝/超时、401/403/404、重定向、body 超时/取消、字节与数组上限、UTF-8/JSON/压缩拒绝、重复事件/关系冲突，以及预览不提交/不幂等落库。fixture 对任何非 GET 请求设置失败计数，实际 mutation 为 0。

安装版 DSH 原生 registry/guard 验收（显式 opt-in）：

```sh
ELECTRON_RUN_AS_NODE=1 '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' \
  integrations/personal-agent-forge/test/native-smoke.mjs \
  '/Applications/DeepSeek Harness.app/Contents/Resources'
```

2026-11-04 已在 DSH **0.2.1-rc.5** 的真实 Cordis/ToolRuntime 通过注册、读取、未提交预览、原生 guard 拒绝、取消、参数拒绝和销毁；临时 HOME，内存 HTTP fixture，**PA 实例/DB 访问 0、HTTP mutation 0、模型调用 0**。这层证明原生工具契约与只读/预览边界，不是 PA 真服务、真实引擎、Bot 渠道消息或人工审批闭环验收。原 PA checkout 没有可用依赖安装，本批没有为此改动其工作区或借用生产实例。

测试目录独立；本 PR 不改公共 test runner，需直接运行上述命令。生产安装、凭据输入 UI、原 PA fake 实例联调、创建前授权、Forge 引擎执行和原 Task 结果回写均未实施/未验收。
