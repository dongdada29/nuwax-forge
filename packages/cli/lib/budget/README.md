# 执行入口预算 guard

预算预测自身离线、0 次模型调用。`nuwax-devkit run` 和 `gui run` 已在真实 spawn 前接入本包现有 `core.mjs` / `actual.mjs`；Python 通过本安装 `bridge.mjs` 复用同一算法，没有第二套公式。默认安装、测试、doctor、verify 不加载模型 SDK、不连接 GUI。

## 宿主 Codex 会话 guard（budget guard 子命令）

```sh
nuwax-devkit budget guard --sessions ~/.codex/sessions/2026/10/27 \
  --budget /tmp/budget.json --marker "本轮起点标记文本" --json
```

`run`/`gui run` 只治理被派发的子进程；宿主 Codex 主对话由本子命令事后/步间核对（由编排方在派发新工作前调用）。离线、0 次模型调用、只读：解析会话 JSONL 的 `token_count` 事件（取 `info.total_token_usage` 最后值），宿主自 marker 起差额（marker 前最后一个快照为基线，无 marker 按整会话基线 0）+ 按 `session_meta source.subagent.thread_spawn.parent_thread_id` 匹配的 worker 会话合计（marker 模式只计 marker 之后 spawn 的）。token 归一口径**复用 `actual.mjs` 的规范 usage JSON 解析**（includes-cache：total=input+output、cached 为输入子集、parts≠total 拒绝），不写第二套公式。

预算 JSON（结构同仓外原型 budget_snapshot.py 内嵌字段）：`totalTokens`/`stopBeforeTotalTokens` 必填，`parentTokens`（宿主相位）/`executorTokens`（worker 相位）/`acceptanceReserveTokens`（observed > total−reserve 即占验收预留）/`wallMinutes`（起点→最后快照墙钟）可选。判定：任一相位阈值确定性超限 → verdict `over` exit **2**；宿主无 token_count / marker 未找到 / worker 快照缺数字 / 墙钟不可测 → verdict `unknown` exit **3**（unknown ≠ 0，不放行）；预算 JSON 或路径数据错误 exit 1。over 与 unknown 并存按 over（可立即止损），unknown 仍列出。目录含多个非 worker 会话时用 `--parent-id <宿主线程 id>` 唯一指定；坏 JSON 行跳过并计数，不中断不伪 0。

**诚实边界（沿用原型，勿删）**：`warning: snapshot tail and in-flight calls unknown; phase gate, not provider hard cap`——只计至最后一个 token_count 快照，其后尾部与在途调用未知；这是相位门（超阈值即停止派发新工作），不是供应商硬顶，无法中止已发出请求的消耗。测试 `test/budget-guard.test.mjs` 全部使用临时目录伪造脱敏 JSONL，绝不读真实 `~/.codex` 会话。

## crew plan → route → run

```sh
nuwax-devkit run --plan /tmp/task-plan.json --project /path/to/worktree \
  --state /tmp/task-state --brief-file /tmp/brief.txt
```

也可使用已有 Python 入口（源码时在 crew 包目录运行，安装后需把该包目录放入 PYTHONPATH）：

```sh
python3 -B -m crew run --plan /tmp/task-plan.json --worktree /path/to/worktree \
  --brief @/tmp/brief.txt --ledger /tmp/task-state/ledger.jsonl --artifacts /tmp/task-state/artifacts
```

模型任务的最小字段：

```json
{
  "taskKey": "small-task",
  "mode": "model",
  "budget": {"maxTokens": 12000, "maxWallSeconds": 180, "maxAttempts": 1},
  "budgetSpec": {
    "schemaVersion": 1, "id": "small-task", "taskKind": "text-implementation",
    "mode": "model", "model": {"name": "explicit-model-name"},
    "expectedCalls": 1, "initialContextTokens": 2000,
    "perCallOutputTokens": 1000, "budgetTokens": 12000
  },
  "context": {"maxBytes": 65536, "maxTokens": 16000, "maxFiles": 16, "contextFiles": ["src/target.txt"]},
  "assignments": [{"executor": "approved-executor", "role": "implement", "command": ["approved-command", "--brief-file", "{briefFile}"]}]
}
```

`command` 仍是原有 shell 字符串或 argv 数组；不会自动插入模型参数、更换模型、重写 prompt、添加 retry/resume。数组中的 shell 元字符保持字面值。示例执行器需替换为已核验命令，执行器必须自行把本阶段实耗写入 `{stepArtifacts}/usage.json`，否则结算为 unknown。已有 `{worktree}` / `{brief}` / `{artifacts}` 语义保留；新增 `{briefFile}`、`{contextManifest}`、`{stepArtifacts}` 供有限文件交接。等价环境变量为 `NUWAX_CREW_BRIEF_FILE` / `NUWAX_CREW_CONTEXT_MANIFEST` / `NUWAX_CREW_STEP_ARTIFACTS`。

任务或 assignment 的 `mode:"model"`、`modelTask:true`、非空 `model`、`budgetSpec.mode:"model"`，以及 `runtime.contextMode:"fresh-exec"` 或 `runtime.model`（且 contextMode 不是 no-model）均触发治理。plan 声明模型不能被 assignment 的 no-model 覆盖。`runtime.contextMode:"no-model"` / `mode:"no-model"` 的固定配方标记 `declared-no-model`；完全未声明模型的旧 Python 内部命令保持兼容并标记 `legacy-unmanaged`。新公开 `nuwax-devkit run` 缺少显式声明时 blocked（不派发 Python），避免新入口默认落入 legacy；本工具不通过猜测命令名称证明全量治理。标准 `contract.validate → router.route` 会保留这些治理字段。

`budgetSpec` 可在 assignment 上覆盖 plan；`context` 同理。串行步骤共享 plan 的 `budget.maxTokens`，每步使用 HIGH 预留，结束后释放本步预留并扣除可比的真实分段总量。预测 guard 使用 `max(校准 HIGH, 原算法未校准 HIGH)`，历史低耗不能降低本次已交付上下文的下界。`budgetSpec.budgetTokens` 是本步上限，`budget.maxTokens` 是整个 plan 共享上限；两者都必需。缺预算、非法配置、unknown 维度、HIGH 超本步/剩余上限，均持久化 blocked 原因和预测且不 spawn。

实耗可用规范 JSON：`{"usageScope":"run-segment","inputSemantics":"includes-cache","usage":{"inputTokens":123,"outputTokens":45}}`，或 snake 风格 input_tokens/output_tokens。保留 raw scope/cache 数字，按既有算法归一为含缓存读 input+output；cacheWrite 单列，不声称是供应商账单。Claude `modelUsage` 默认 session-cumulative，不能拿累计总数当本阶段核销；未确认分段、口径未知、缺数据、报告重试或损坏均保持 unknown，余额为 null，后续模型步骤 blocked。只有明确已扣同 session baseline 的 usage 才应声明 run-segment。可选 plan `budgetHistory` 只写仓外脱敏校准 JSONL；未知实耗不落样本。

`maxAttempts` 默认且仅支持 1，>1 明确拒绝；使用同一 ledger 按 taskKey 阻断已启动过的模型任务，成功/失败/unknown 均不得再次启动，不伪称支持跨 attempt 预算。改 ledger/taskKey 属于新任务，无法提供跨状态目录的全局配额保证。不自动 retry，不自动 resume 长会话；`retries` 只能为 0。命令失败、超时或取消后停止；单步实耗已知超预算也不放行后续模型步骤。wall timeout 默认 900 秒，模型 plan 上限 3600 秒；使用 CLI timeout 与 plan maxWallSeconds 较小者。执行结果的 `processPassed` 仅代表进程，预算结果另有 `budgetPassed`，产品验收仍需 verification。

## 有限上下文与工件

brief、解析后的命令文本、spec.inputs 与显式 contextFiles 一并计入字节/启发式 token 上限；初始输入至少采用实际交付文本的启发式 HIGH。默认总字节 64KiB / HIGH 16000 tokens / 16 文件；可配置硬界限分别为 1MiB / 262144 / 64。文件仅限 worktree 内明确路径，拒绝目录、二进制、越界/越界符号链接、.env/.ssh/.aws/.codex/.git 等凭据/历史目录；不扫描整个项目。

每步保存 context-manifest.json（路径、sha256、字节、启发式区间）、budget-guard.json 与 budget-reconcile.json；每次 attempt 保存 brief.txt，原命令只存仓外 command.json。主结果/ledger/日志命令头使用 hash+bytes，不重复长 prompt；stdout/stderr 原日志落磁盘，返回 summary 最多 400 字符，原文件内容不会回填 JSON。manifest 用于恢复交接与核对源文件 hash；它不冻结源文件，也不限制执行器启动后自行读取文件、历史或产生的新上下文。输入工件可能含正文，按普通私有任务工件管理。

## GUI 独立契约

```sh
nuwax-devkit gui run --recipe /tmp/gui.json --state /tmp/gui-state \
  --budget-spec /tmp/gui-budget.json --budget-history /tmp/gui-history.jsonl \
  --cdp http://127.0.0.1:19222 --sdk /path/to/midscene --runtime /path/to/puppeteer --json
```

必须显式给 budget spec：mode=model、模型名匹配配方、expectedCalls 至少覆盖 maxAiOperations、taskKind 为 gui/visual、视觉成本完整、预算 HIGH 足够。配方文本及可选 recipe.context 同样受有限输入界限约束。缺/unknown/超限退出 3 并保存 blocked manifest，不派发 runner、不连接 CDP；原缺认证→3、缺 SDK/runtime→4 等前置错误优先级保留。SDK 前置只解析路径，预算通过后 runner 再加载；runner 自身也重查预算。运行后自动 reconcile，实耗 unknown/超限不能通过，已知分段数据才写校准。

GUI 仍是独立 guiRecipeSchemaVersion=1，不导入 TaskStore；不会启动/重启 app、自动发现 CDP、自动授权或自动补装 SDK。maxAiOperations 为 driver 操作数界限，token 为整次 runner 执行前保守预留；SDK 内部多请求和重试只能事后观测。SIGINT/SIGTERM/超时停止 runner 进程组，条件恢复为有限尽力，不关闭外部附着应用。

## 观测局限与离线验收

这是执行前和步间 guard + wall timeout。没有流式 token 计量时，已启动子进程/SDK 在本步内部可能超出预测，无法保证供应商内部硬 token 中止。实耗依赖执行器/报告如实提供；预算规格是预测，HIGH 也不是数学上界或账单承诺。

`test_execution_budget.py` 与 `execution-budget.test.mjs` 使用真实 marker 子命令和合成 SDK 检查阻断/放行/共享余额/累计陷阱/上下文界限/GUI 派发边界，0 次模型调用、0 次真实 GUI/CDP 连接。随 crew 的 `examples/budget-guard-offline.plan.json` 是可运行的固定离线样例，明确写 0 次调用的真实实耗；把它声明成模型任务仅为验收 guard 接线。
