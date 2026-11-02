# 独立客户端 Agent

这是 devkit 的可选 CLI 入口，不改平台 Agent、Loop、已有会话、全局配置或业务产品代码。两个实现分别调用真实的 `codex exec --json` 和 `dsh --profile headless --patch … --json -`；不把任意 command 冒充适配器，也不恢复/分叉会话。入口保持与 crew 的 `runtime.contextMode:"fresh-exec"`、预算结构和现有有限上下文/预算算法一致。可在 crew assignment 中调用本入口；wrapper 不提供第二套路由或任务引擎。

```sh
nuwax-devkit agent doctor --runtime codex --json
nuwax-devkit agent doctor --runtime deepseek-harness --json
nuwax-devkit agent prepare --spec /private/task.json --brief-file /private/brief.txt --state /private/new-task-state
# 审核 new-task-state 中的 request / command / doctor / budget-guard / context-manifest 后：
nuwax-devkit agent run --state /private/new-task-state
# 离线重算本次 stdout，0 次模型调用，不派发新任务：
nuwax-devkit agent reconcile --state /private/new-task-state
```

`--state` 必须是不存在的新目录，且在目标 Git checkout 和 devkit 安装目录之外；realpath 解析符号链接后再检查。`worktree` 必须是显式 Git 根目录。由调用方预先选择或创建隔离 worktree；本入口不修改分支、自动提交或 push。`runtime.binary` 可选，若给出必须为可信可执行文件绝对路径；不支持任意 argv、profile、patch、home 或 sessionId。

最小 task.json（短任务正文在独立 brief.txt 中）：

```json
{
  "schemaVersion": 1,
  "taskKey": "bounded-edit-001",
  "worktree": "/absolute/isolated-worktree",
  "runtime": {
    "kind": "codex",
    "contextMode": "fresh-exec",
    "model": "explicit-available-model"
  },
  "permissions": {"mode": "read-only"},
  "budget": {"maxTokens": 20000, "maxWallSeconds": 120, "maxAttempts": 1},
  "budgetSpec": {
    "schemaVersion": 1,
    "id": "bounded-edit-001",
    "mode": "model",
    "taskKind": "text-implementation",
    "model": {"name": "explicit-available-model"},
    "expectedCalls": 2,
    "initialContextTokens": 2000,
    "perCallOutputTokens": 1000,
    "budgetTokens": 20000
  },
  "context": {"maxBytes": 65536, "maxTokens": 16000, "maxFiles": 4, "contextFiles": ["src/target.ts"]}
}
```

DSH 将 runtime 换成以下声明；模型/provider 由本次 patch 明确指定，必须已由当前发行版支持。认证只用启动环境中已有的 provider 环境变量，例如原生 DeepSeek 的 `DEEPSEEK_API_KEY`；wrapper 不读取、复制或打印用户凭据。不从桌面端 credential store 导入认证。缺认证由客户端失败并保存真实证据，不能靠文件存在宣布登录成功。

```json
{"kind":"deepseek-harness","contextMode":"fresh-exec","provider":"deepseek-official","model":"deepseek-flash"}
```

当前 run 仅支持 POSIX 进程组（macOS/Linux）；Windows doctor 报 unsupported，未做 Windows 终止树验收。权限只支持显式 `read-only` / `workspace-write`，不支持 danger-full-access 或审批绕过。Codex 传 `--sandbox` 和 `approval_policy=never`；DSH 本次 patch 固定 sandbox-policy.workspaceRoot、sandbox mode 和 never 审批，并设置单一 bounded permission preset。`never` 表示拒绝需要提升权限的操作，不授权提升。读权限和平台临时目录遵循客户端 sandbox 的真实行为；contextFiles 是预交付与哈希核对边界，不是完整的 OS 读白名单。客户端运行后可能读取额外源码、工具输出和系统提示，预测无法给这些成本作硬上界。

## 本机协议依据与版本边界

- Codex 0.165.0 的本机 `exec --help` 已确认 `--json --ephemeral --ignore-user-config --ignore-rules --sandbox --cd`。新 exec 不继承当前对话；不使用 resume/fork。忽略用户 config/rules、禁用自动项目说明注入和 multi_agent；显式指定模型。保留内置客户端系统说明。使用 `--ephemeral`，只采本次 stdout JSONL，**不读取 ~/.codex/sessions，也不与 rollout 监督混用**。认证仍使用 Codex 自身授权；支持此路径的默认 OpenAI provider，不装载用户自定义 provider/MCP/hooks。不覆盖 `model_providers.openai` 等内置 provider：Codex 0.165.0 会在启动时拒绝该配置。保留原生 provider/认证路由；请求/流的内部重试由 Codex 自身管理，外层按 maxWallSeconds 监督终止，wrapper 仍只启动一次且永不自动重试。因此 maxAttempts=1 不表示 provider 请求恰好一次，预算也不是 provider token 硬上限。[官方非交互文档](https://learn.chatgpt.com/docs/non-interactive-mode) 描述 thread.started、turn.started、item.*、turn.completed.usage。
- DSH **0.2.1-rc.5** 的当前安装源码 `@deepseek-ai/dsh-headless` 明确创建 `session-${randomUUID()}`；`--session-id` 会采用已有会话，因此适配器从不传此参数。headless 无 Host/HTTP/browser；stdout 的 session、status(step_start/step_end/turn_end)、final 是本轮投影。当前实现只准入此已核对版本，其它版本 doctor 报 unsupported 并在 run 前阻断。每任务的 `DSH_HOME=state/dsh-home` 使用发行版 stock profile，隔离全局模型设置、插件和历史；launcher 可能在这个私有目录创建 profile、索引和会话文件。
- DSH patch 禁用 llm-retry、自动标题模型、compaction 模型、subagent、goal round driver、PTC、工作目录切换和插件管理工具，避免旁路模型任务/扩权。原生/内置 pi-ai 路径已在当前源码核对；pi-ai SDK 的 maxRetries 为 0。本入口不支持额外自定义插件/provider 配置。

## 准入、实耗与结果

prepare 用既有 `prepareExecution` 生成 context manifest 和 HIGH 预算；模型名必须一致。缺预算、unknown 预测、预算 HIGH 过大，在派发前 blocked。run 会再次核对 guard、CLI 和输入哈希，实际 contextFiles 变化会 blocked；工件 state 视为调用方受信私有输入。`maxAttempts` 只支持 1，`retries` 只能为 0。原子 run.claim 抵御同 state 的重复派发与崩溃重跑；不同 state 仍是独立配额，不能保证跨 state 全局上限。派发模型前先运行固定可信 Node 的零模型终止探针：同 cwd、启动环境、detached 进程组及监督/信号路径，探针 3 秒自行退出，不给 Codex/DSH 发 prompt。它验证外层宿主进程权限，不证明 Codex/DSH 内部 sandbox、provider 或未来权限仍然有效；失败直接 blocked，modelDispatched=false。探针结果保存 termination-probe.json。任务超时/中断/日志超过 8MiB/观测超预算后，先用 ps 元数据确认自有进程组与已知后代存活，再 TERM；等候 grace 后仍存活才 KILL。正常退出且无后代不发信号，TERM 成功后不补发 KILL。每轮检查有期限，清理只等待两次 250ms grace 和最后 250ms close drain（另加有界 ps 检查），不无限 await close。信号 EPERM、检查失败、仍有存活进程或 close 未到均如实标 cleanupFailed；返回 remainingPids，不宣称已清理，实耗保持 unknown。记录过的脱组后代尽力清理；未能观察的自行守护进程不在保证内。

预算为执行前/步间/观测后相位门，**不是 provider 硬 token cap**。在途、未上报调用和客户端固有系统提示仍可能超预测；maxWallSeconds 是本次客户端执行阶段的墙钟限制（前置探针和有界清理另计），不能撤销已发出的模型请求。expectedCalls 是估算维度，不是 provider 请求硬限制。

Codex 的 turn.completed.usage.input_tokens 已含缓存子集，缓存不能再次加到 total。必须有恰好一次 turn.started、完成事件、最终 agent_message 和有效输入/输出数字；否则实耗 unknown。DSH rc.5 的 step_end.usage.totalTokens 是已累计本 step attempts 的精确总量（源码 json-stream 的 addUsage）；当前 native DeepSeek 与 pi-ai 把 cacheRead/cacheWrite 包含在此 total 中。本实现只加一次 total，规范输入以 total-output 表示，原始桶同时保留。重复的同 turn/step 快照去重，冲突、截断、缺 step 或缺 total 记 unknown，不拿 final/exit0 冒充用量完整。缺缓存拆分保留 null。step/turn 数不当作 provider 调用数，calls 保持 unknown。

只解析本次 `stdout.jsonl`，不扫描、复制或读取旧会话。缺失/不支持实耗、进程失败/超时、scope 不完整都使 usageScope=unknown、chargedTokens=null、budgetPassed=false；既有 settleExecution 负责归一与结算。`usage.json` 保留 rawUsage，可复核缓存口径。独立 reconcile 重算同一段数据，不追加消耗或重复写校准。

结果拆开记录 processPassed、agentCompleted、budgetPassed、acceptancePassed。只有前三项通过才 `status:completed`，`acceptancePassed` 始终 null；产品验收需消费者另行提供确定性验证。退出码：0=doctor 支持/prepare 完成/本次执行及预算完成，1=执行或结算失败，2=用法/路径/重复运行错误，3=blocked/版本不支持。

本次业务功能验证覆盖真实安装 CLI 的 doctor/prepare/DSH patch 组合，以及本地 marker 子进程的完整 dispatch、结算、拒绝、超时、TERM 成功不 KILL、EPERM 探针阻断和清理拒绝有界返回路径。validationBusinessModelCalls=0 仅说明这些验证没有调用业务模型；实现执行器本身的模型 usage 未在这里聚合。**未做付费模型 smoke、产品/GUI 验收或性能对比**；doctor 不证明授权可用，也不证明模型任务已完成。
