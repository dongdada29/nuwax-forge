# PA 原生任务、预览与受限 intake

Forge 默认只查询原 PA 任务或生成请求预览。预览始终明确“未提交；未创建 PA 任务；未获执行授权”，没有持久待办库。操作者显式启用受限 intake、提供独立 intake 凭据并预设工作空间别名后，`personal_agent_request` 才能把 Forge 任务提交到原 PA；必须确认原任务及其原生 `task_admission` 记录，才报告提交结果。

Bot 没有批准、控制、接收交付或结果导入工具。原 PA 的人工审批是执行门，DSH guard 成功不是 PA 执行授权。任务、审批、幂等记录与状态均复用原 PA；本 integration 不读写 PA 数据库，不另建任务库，不执行模型或命令，不修改 PA 源码、公共 CLI、Dashboard 或 Bot。

## 原 PA 版本与必要扩展

最初只读切片对照 PA `1f13eac357e5ea20a9c6adfcb21d6bbefd517d13`：`POST /api/tasks` 默认立即执行，旧 `ApprovalRecord` 仅是运行中 ACP 工具权限，不能用于创建前审批。因此旧 PA 不能启用本切片的写入。

原生准入扩展 `db33b3f36dffc76a562eaae16974c7180997027f` 增加独立 intake 身份与原 Task 的创建前 `task_admission`：新任务强制 paused，只有原工作台的已配对人类身份可批准；intake 仅可 `POST /api/tasks`、`GET /api/tasks` 和读取自己的 `GET /api/tasks/:id`，不能批准或控制。intake 必须搭配 PA 的 paired 安全策略，匿名 loopback 不可开启。

Forge Worker 扩展 `8240f5ece6743fa277c4454594e449d4a371933c` 进一步支持 `engine:'forge'`、原 Task/准入请求中的声明来源，以及服务器按 workspace 固定的模板。本包按该协议实现；原 PA 仍负责权限、预算、验证命令、worktree、单 Worker 生命周期与结果入库。本包不会向旧 PA 降级成 fake/claude，不会用“先创建再暂停”绕过授权门，也不接受 Bot 自报批准。

## 操作者配置与凭据

独立包：`integrations/personal-agent-forge/`，无额外 npm 依赖。操作者在受信任 DSH bootstrap 中加载模块；标准 JSON 插件配置无法携带运行时函数。未配置凭据回调时 paired/intake 模式拒绝加载，不读取 ambient 环境、日志、浏览器 Cookie、PA 文件或端口发现结果。

```js
const config = {
  schemaVersion: 1,
  origin: 'http://127.0.0.1:49123', // 操作者显式指定隔离实例的实际端口
  instanceId: 'operator-labelled-pa-instance',
  botId: 'full-operator-configured-bot-id',
  auth: {
    mode: 'intake',
    intakeId: 'operator-provisioned-intake-id',
    publicOrigin: 'https://operator-selected-pa.example',
    credentials: async ({ signal }) => operatorProvidedIntakeCredentials({ signal }),
    // 回调仅返回 { intakeToken }，43 字符 base64url。
  },
  submission: {
    enabled: true, // 缺省 false；只允许 intake 模式显式开启
    workspaces: { project: 'full-native-registered-workspace-id' },
  },
  timeoutMs: 5000,
  maxResponseBytes: 4194304,
  maxItems: 10000,
};
await ctx.plugin(await import('../integrations/personal-agent-forge/index.mjs'), config);
```

`operatorProvidedIntakeCredentials` 由操作者显式提供，不是本包内置文件/环境凭据读取器。本包没有 token 文件 helper，不接受静态 token、凭据路径、任意环境变量名或工具参数中的凭据，不复制到 profile、brief、仓库、输出或日志。PA 服务端由操作者配置 `PERSONAL_AGENT_INTAKE_ID/TOKEN`；本客户端不读取这些变量。ID 必须与配置及响应的 server-owned intakeId 一致，token 只在运行时回调中提供，每个请求重新获取。

网络固定连接精确的 `http://127.0.0.1:<port>`：不接受 DNS localhost、其他 IP、路径、query、fragment、URL 凭据或非规范默认端口。paired/intake 的 publicOrigin 仅用于原 PA 所需的精确 Host/Origin header，连接不会解析或访问该域名。不扫描端口、不自动连接默认实例、不使用 HTTP 代理环境、不跟随重定向、不重试。

三种身份严格分离：

| auth.mode | 运行时回调 | Header 与能力 |
| --- | --- | --- |
| `loopback` | 不接受凭据 | 原有显式本机只读；不能启用提交 |
| `paired` | `{ deviceToken }` | 原 PA `__Host-pa-device` 或明确 localhost 开发模式的 `pa-device-dev` Cookie；本包仅查询，不能启用提交 |
| `intake` | `{ intakeToken }` | `Authorization: Bearer ...`，无 Cookie/CSRF；查询自己的任务，仅显式 opt-in 可提交 Forge 任务 |

intake token 和 deviceToken 不可互换。paired 的人类 Cookie 永不用于写入。错误不回显原响应 body/header；成功响应若误回显本次 token（包括 JSON 转义形式）会先脱敏。无 Cookie jar、Set-Cookie 保存、配对、提权或隐式续期。

## 原生 DSH 工具与协议

工具由 `ctx.tools.register()` 注册，保留 DSH 原生参数验证、policy guard、取消与销毁。`personal_agent_request` 标为非并发安全；其余工具为只读/纯预览。

| 工具 | 输入 | 行为 |
| --- | --- | --- |
| `personal_agent_tasks` | `{}` | 原生任务列表；intake 身份仅限自己的任务 |
| `personal_agent_task` | `{ taskId }` | 原生任务快照与原 ID、准入事实；无控制能力 |
| `personal_agent_request_preview` | `{ requestId, goal, workspace?, forgeTaskKey?, forgeAttemptId? }` | 永远纯内存、无 HTTP、无原生任务/审批 ID 的预览 |
| `personal_agent_request` | `{ requestId, goal, workspace }` | 缺省返回未提交预览；仅 intake + enabled + 允许的 alias 才提交 |

库级 `bridge.submitTask()` 在未显式开启时继续以 `PA_TASK_AUTHORIZATION_UNAVAILABLE` 拒绝。Bot 参数不能传 URL、身份、source/sessionId、commandId、engine、native workspaceId、验证命令、profileIds、runtime、binary、permissions、budget、state、环境或 argv。workspace 只能是操作者预设 alias，原生 workspaceId 由映射取出；其余执行模板全部由 PA 服务端固定注入。

POST 固定为 `/api/tasks`，JSON 仅有：

```json
{
  "commandId": "forge_<sha256>",
  "goal": "待操作者审阅的目标",
  "engine": "forge",
  "workspaceId": "operator-mapped-native-id",
  "source": {
    "kind": "dsh-bot",
    "instanceId": "operator-labelled-pa-instance",
    "sessionId": "actual-dsh-execution-session-id",
    "requestId": "caller-stable-request-id"
  }
}
```

source 中 instanceId 来自配置，sessionId 来自真实 DSH execution context，requestId 来自工具参数；每个 ID 1–200 字符且禁止控制字符。未知 source 字段拒绝。source 是客户端声明，不是认证；实际准入归属以 PA server-owned intakeId 为准。botId 与 tool call ID 保留在工具返回的完整来源关系中，不伪造成服务端认证身份。

commandId 是 `forge_` 加 `SHA256(JSON.stringify([instanceId, sessionId, requestId]))`，不包含 goal、workspace 或 tool call ID。同一请求跨调用重放同一 key；改变 goal/workspace 仍保留原 key，由原 PA 的幂等命令返回 409，不能改 requestId 规避冲突或未知提交结果。预览自己的 fingerprint 只便于比对，不是原 PA 幂等承诺，仍为 `deduplicationEnforced:false`。

## 成功、重放与不确定性

发送前只有预览，不提前宣称已提交。只接受 POST 200/201 和 GET 200。POST 后固定 GET 返回的原 Task，交叉核对 taskId、commandId、goal、engine、workspaceId、intakeId、source、原 admission ID 与 fingerprint；再验证原 `task_admission` 记录的 task/attempt/run 关系、原 request 内容及按 PA canonical 规则重算的 SHA-256 指纹。不能仅凭一个 paused 字符串或客户端自己生成审批事实。

201 新建必须在 POST 与快照中仍为 paused、delivery pending、无 active attempt、admission pending，原审批 unresolved 且没有选择项，才返回 `awaiting_human_approval`、原 Task/Approval IDs 与 `executionAuthorized:false`。人类可能在查询前已操作；状态不再匹配时返回不确定错误，不捏造 pending。

200 是原生幂等重放，任务可能已 approved/running/completed、被拒绝或取消。仍核对不可变请求与原准入指纹，再如实返回当前任务/审批状态；不会强制改回 pending。`paTaskCreated:false` 表示此次响应没有新建任务，`replayed:true`，原 Task ID 保持不变。executionAuthorized 仅反映原 admission 是否 approved，不能代替执行完成或产品验收。

超时、取消、断连、无效响应或后续核对失败可能发生在 PA 已落库之后，抛出的安全错误带稳定 commandId、来源与 `submissionState:'unknown'`，明确不要假定未创建。没有自动重试；操作者应保留相同 requestId 查询/重放原任务。401/403/409、重定向、202 或其他非 200/201 不会被宣称为成功。

单请求总时限默认 5 秒（含凭据回调和 body），可配置 10–30000ms；POST 后 GET 各自有此边界，DSH 总工具超时 35 秒。回调收到超时/取消 signal，迟到结果不会建立连接。JSON 请求编码后最多 32768 字节；响应最多 4MiB，header、流式 body、UTF-8、压缩与数组均有检查；数组最多 10000 项。超限不返回部分成功事实。

## 查询投影

保留完整的实例、Bot、DSH session/tool call 以及原 Task/Attempt/Run/Stage/Approval/Artifact/Verification IDs，不截断，不按标题合并。缺失 attempt 或集合保持 null，不从 task.activeAttemptId、事件或相邻 run 补齐。source 明确 `sourceAuthenticated:false`，instanceId 是操作者标签，当前不声称密码学实例认证。

status 与 deliveryStatus 独立：completed 不等于 accepted，accepted 不等于产品验收；`productAcceptancePassed:null`。任务快照从唯一一条 `forge.delivery_verified` 事件（PA `recordForgeDelivery` 记录的 `ForgeExecutionRecord.result`）导入 Worker 用量：`usageKnown:true` 且 chargedTokens 为非负安全整数、sessionId 合法时，`chargedTokens` 与 `executionSessionId` 同时落到 task 与 `runId` 精确相等的那条 run；`usageKnown:false` 降级为 unknown 口径（不硬填、不拒绝）；宣称已知但校验失败则整响应拒绝；runId 不匹配只填 task 不填 run。`inputTokens/outputTokens/actualModel` 保持 null——Forge 结算只认证 charged 总量与会话身份，无 input/output 分拆与模型名，用量下界不当账单。任务列表接口不带事件，用量维持 unknown。本投影不拿配置、缺失或 0 当作完成证据。事件只提取 seq/type/time/显式 attempt；不输出任意 event data、配置快照、权限 rawInput、验证 argv、工件正文或服务器模板路径。重复/倒序 seq、超 cursor、跨 task、重复 IDs、重复 delivery 与明确关系冲突拒绝；未实现 SSE/持久游标，不承诺历史完整性或进程存活。

## 验证与边界

```sh
npm --prefix integrations/personal-agent-forge test
```

28 项离线 HTTP fixture 测试覆盖默认关闭、独立 intake 与人类 Cookie 隔离、固定 POST/source、稳定命令重放/409、201 待审批、200 后续真实状态、指纹与跨来源核对、鉴权、状态码、重定向、大小、超时/取消、落库后丢失确认的原任务找回、未知用量等。fixture 端口由系统分配，不扫描。默认 `npm run test:integrations:offline` 会枚举本目录全部 `*.test.mjs`，本次实测 50 项、49 通过、1 项明确 opt-in 跳过；后续新增测试不再依赖固定文件名列表。

既有 Dashboard 的 PA executor 白名单同时保留明确的 `forge` 引擎标签；它只展示来源事实，不增加执行或批准能力。

真实安装版 DSH 0.2.1-rc.5 的原生 registry/guard/dispatch 可复现：

```sh
ELECTRON_RUN_AS_NODE=1 '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' \
  integrations/personal-agent-forge/test/native-smoke.mjs \
  '/Applications/DeepSeek Harness.app/Contents/Resources'
ELECTRON_RUN_AS_NODE=1 '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' \
  integrations/personal-agent-forge/test/native-intake-smoke.mjs \
  '/Applications/DeepSeek Harness.app/Contents/Resources'
```

两项 smoke 均使用临时 HOME 与内存 HTTP fixture，不访问 PA 实例/DB，不调用模型。intake smoke 验证 preview/guard/取消/伪造 source 不产生 POST，合法调用仅 1 POST + 1 GET 后确认原 pending admission，没有审批/控制工具。

原 PA 真服务联调为显式 opt-in，传入**隔离 source clone**，使用该 clone 的 tsx loader：

```sh
node --import /absolute/isolated-pa/node_modules/tsx/dist/loader.mjs \
  integrations/personal-agent-forge/test/isolated-pa-smoke.mjs \
  /absolute/isolated-pa
```

脚本每次创建新的临时 PA DB、Git 仓库与配对身份；真 HTTP 验证 intake 提交/重放/冲突和原准入事实，intake 批准/控制被 403 拒绝。独立配对的 fixture 人类通过原 PA 路由批准后才触发 marker adapter，随后故意以 fixture 错误结束，不启动付费模型、真实 Forge Worker 或生产实例。它不改 PA 源码，也不使用生产数据。真实 UI 操作、渠道 Bot、真实 Worker/模型、发布安装与业务完整闭环仍须分层验收。

2026-11-04 已在上述 PA `8240f5ec` 的干净隔离 clone 通过：原 paused/admission/source 与指纹、同 key 重放、换 goal 的 409、intake 批准/控制的 403、独立 paired 人类审批均通过；marker open 在批准前为 0、批准后为 1，随后重放如实返回原 approved admission 与 marker 故意停止后的 failed 状态。模型调用及生产实例访问均为 0，临时数据已清理，PA 源码保持干净。

同日原 PA **原 Web UI** 验收通过（隔离实例 `8240f5ec` + 安装版 CLI `98c5d60`，任务 `fbeb086a`）：原生配对 UI → 原生审批按钮 → Forge 单 Worker → 实际验证 exit 0 → 原生接收按钮消失并显示 accepted；最终 `completed/accepted`、admission approved、development/verification 两 stage 与 developer run 全部 completed，无活动进程。页面无横向溢出，配对横幅与验证可见。Worker 用量为确定性 marker fixture（合成 input 100 / output 10 / charged 110，非真实计费），`realProviderCalls=0`。验收收据与截图保存在本地交付目录，未入库；真实模型 Worker、渠道 Bot 派发与业务完整闭环仍待分层验收。
