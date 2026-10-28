# TOKEN-BUDGET — nuwax-devkit 内建 token 预估与实耗核对

目的：把"预测 token 消耗"做成 devkit 自身功能，帮助减少并均衡 token 消耗。**estimate 与 reconcile 自身 0 次模型调用、默认离线、零外部依赖**；只读显式给出的文件（不扫仓、不读凭据、不联网、不查价格）。

## 命令

```bash
nuwax-devkit budget estimate   --spec <spec JSON> [--history <校准 JSONL>] [--out <输出 JSON>] --json
nuwax-devkit budget reconcile --estimate <估算 JSON> --actual <实耗 JSON> [--history <校准 JSONL>] [--out <输出 JSON>] --json
nuwax-devkit budget guard     --sessions <codex 会话 JSONL 文件或目录> --budget <预算 JSON>
                               [--marker <起点标记文本>] [--parent-id <宿主线程 id>] --json
```

退出码：0=成功算出（verdict 含 within/exceeds/unknown，均属正常输出）；2=用法错误；1=数据错误（非法值/坏 JSON/total 不一致/路径冲突等）。guard 例外：**2=超限（over）、3=数据不足/unknown**（见下）。

## estimate 输入 spec（schemaVersion 1）

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✓ | 任务/估算 id，用于历史去重 |
| `taskKind` | ✓ | 如 `gui-visual` / `text-implementation` / `deterministic`；`gui*`/`*visual*` 视为需视觉输入 |
| `mode` | ✓ | `model` 或 `no-model`；`no-model` 必须 `expectedCalls:0` → 运行段 0 调用 0 token（明确不含发起任务/开发/上层对话） |
| `model.name` | mode=model 时 ✓ | 仅作历史匹配键，不触发任何模型访问 |
| `expectedCalls` | ✓ | 非负整数 |
| `initialContextTokens` | 二选一 | 首轮输入 token；或用 `inputs`（字符串数组）按 UTF-8/码点启发式估区间（非模型 tokenizer，输出带标注；不假设"中文 1 字=1 token"） |
| `perCallOutputTokens` / `perCallToolResultTokens` | 可选 | **缺省按 unknown 处理，绝不按 0**：输出/多轮回包增长进 `unknownDimensions`，totalTokens=partial-unknown、预算 verdict=unknown（guard 不放行）；不临时编默认值 |
| `cacheHitRatio` | 可选 | 0..1，缺省 0（不假设缓存命中） |
| `imageTokensPerCall` | 可选 | 非负数 / `[low,high]` / `"unknown"`；`imageTokensIncludedInContext:true` 表示已含于 initial，不重复叠加 |
| `budgetTokens` | 可选 | 预算上限 |
| `scenario` | 可选 | 历史匹配加严（model+taskKind+scenario） |
| `modelProfiles` | 可选 | `[{name, capabilities:{vision,text}, remainingQuotaTokens}]` → 离线候选推荐（仅说明，绝不自动改账号/模型） |

## 预测模型（透明公式）

```
context_k = initial + (k-1)×(perCallOutput + perCallToolResult)   [+ 每轮图像，未含于 initial 时]
totalInput = Σ context_k = n×initial + (out+tool)×n(n-1)/2
cachedRead = cacheHitRatio × totalInput        # 输入子集；totalTokens 绝不重复加缓存
totalTokens = totalInput + totalOutput
```

- 每维度输出 `{low, median, high}`；unknown 维度输出 `{status:"unknown"}`，**绝不冒充精确值或 0**。
- 视觉任务（gui/visual）未给图像 token 且无同模型+任务类型历史 → `imageTokens:unknown`，`totalTokens:{status:"partial-unknown", subtotal, unknownDimensions:["imageTokens"]}`，预算 verdict=`unknown`（**guard 不放行**）。有历史样本则给 `observedRange` 宽区间并标注样本数。
- 历史校准：**严格按 model+taskKind+scenario 精确匹配（双方均 null 才算匹配，不跨 scenario 回退）**，中位比率缩放；展示实际样本数与比率观测范围；样本 <4 只给低置信 + observedRange，**不声称 P90 稳定**。历史逐条校验：负数/NaN/缺 actual 数字维度/重复 record（estimateId+sourceHash）/无法识别的 inputSemantics → `historyDiagnostics`（行号+原因），不隐吞不伪 0、不参与校准、不重复计数。
- **校准口径 v2（防反馈回弹）**：估算输出同时保留 `baselineTokens`（未校准 raw，同 spec 重算即得）与 `calibration.appliedFactors`；校准样本的比率**始终以 baselineExpected（raw）为分母**，绝不对已校准输出再算 factor——否则同成本样本反复 reconcile 会把 0.5 与 1 取中位而回弹。`factor=0`（实耗为 0）是合法校准结果，不当作"无校准"跳过。旧历史记录无 `baselineExpected` → 明示 `legacySamplesWithoutBaseline`、不参与校准（不默默假定 `expected` 是 raw）；旧估算文件缺 `baselineTokens` 时优先用 `appliedFactors`/`confidence.history.*Ratio.factor` 还原 baseline（median ÷ factor，标注 `reconstructed-from-applied-factor`），无信息则 `missing`。
- confidence 的 medium 只代表显式参数下的算术确定（参数齐、无 unknown），**不代表预测准确度已经实耗验证**；含操作者提供的假设（如 imageTokens 区间）时以 assumptions/sources 呈现来源。
- 建议输出：预算是否足够、主导维度占比、`reduce-calls`/`compress-context`/`deterministic-recipe`/`vision-cost` 等针对性建议。

## reconcile 实耗格式（自动识别）

1. **GUI driver manifest**：`model.observation.{known, uniqueCalls, promptTokens, completionTokens, totalTokens, retryObserved, cachedReadTokens?, observedCounts}`。`known:false` 或重试 → `completeness.complete:false`，数值仅参考；`cachedReadTokens` 缺失=unknown 非 0；保留 `rawObserved`。prompt+completion ≠ total → 拒绝。
2. **Claude result JSON**：真实 CLI 结构为按模型名 keyed：`modelUsage:{"<model>":{inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costBasis, num_turns, ...}}`（单模型聚合、多模型保留 `perModel` 明细并求和）。`num_turns` 不当 calls、`costBasis` 等自定义字段忽略不估钱。flat 旧结构仍兼容且按官方字段名视为 `excludes-cache`（inputTokens 不含 cacheRead，与 Codex/OpenAI `input_tokens` 含 cached **不可混**）；**keyed 自定义 provider 不硬断言口径：无显式声明 → `unknown` 只分列不归一**，可用顶层/条目 `inputSemantics` 显式声明。可比输入（口径已知时）= input + cacheRead；cacheWrite 单列不并入。**usageScope（累计陷阱）**：`--resume` 返回的 `modelUsage` 是**整会话累计**而非本次调用（实测同 session 连续 final 只增不减：49319 → 90311 → 99472，本阶段 trace ≈ 相邻 final 之差，如 9161=99472−90311；CDP 恢复 final 30090 vs 本阶段 6094；`num_turns` 是本轮字段，不能据此推 usage 范围）。未显式声明 → `usageScope=session-cumulative`：原始各维度数字与 `perModel` 保留展示（notes 标注累计、**不归零**），但 `completeness.complete=false` + `scopeConfirmed=false` → 单任务预算 verdict=`unknown`（累计 SDK 汇总不当本次总量）、不写校准样本（`sample.calibrationEligible=false`）。仅显式 `usageScope:"run-segment"`（顶层或 modelUsage 内，需为已扣 baseline 的分段数据）才按本次运行段比对/校准/放行。`usageScope` 只接受 `run-segment|session-cumulative|unknown`，其他值拒绝。**不做自动扣 baseline**：要比对单次任务，先以同 session 上一次 final 为 baseline 相减（保证各字段非负），或改用规范 usage JSON（默认按 run-segment）。GUI driver manifest 为单次运行观测，亦按 run-segment。
3. **规范 usage JSON**：`{usage:{inputTokens|input_tokens, outputTokens|output_tokens, cachedReadTokens|cached_tokens, totalTokens?, cacheWriteTokens?}, inputSemantics?, usageScope?, calls?}`。snake 风格默认 `includes-cache`；其余未声明 → `unknown`：**只分列不给差值**。`inputSemantics` 只接受 `includes-cache|excludes-cache|unknown` 三值，不认识的写法直接拒绝（不默默归一）。`usageScope` 可在顶层或 `usage` 内声明，默认 `run-segment`；显式 `session-cumulative|unknown` 保留原始数字，但 `completeness.complete=false`、预算 `unknown`、不写校准历史；非法 scope 拒绝。

一致性/完整性：parts≠total 拒绝；`includes-cache` 下 cachedRead>inputTokens 拒绝（cached 是输入子集）；GUI manifest 需 known=true、无 retry 且 prompt/completion/uniqueCalls 齐全才算 `complete`（cachedRead 缺失=unknown 非 0，rawObserved 保留）；**不完整/口径未知的实耗不写入校准历史**（不得污染并隐性降低下次预测）；Claude result 未确认 `usageScope=run-segment`（默认整会话累计/未知）同样视为不完整：数值保留展示，预算 unknown、不写校准历史。

差值输出：每维度 `delta`、`ratio`（估算 0 而实耗 >0 会标"估算漏维度"）、总 percentError、按实耗的预算复核、建议。费用：仅在用户提供显式 rate card 时才有意义，本命令不估钱、不把任何 `costUSD` 当账单。

## 历史文件（脱敏 JSONL）

每行一个校准样本，按 `estimateId+sourceHash`（actual 文件 sha256）去重，重复 reconcile 不重复采样。**v2 样本（sampleVersion:2）**：

```json
{"kind":"token-budget-calibration","schemaVersion":1,"sampleVersion":2,"estimateId":"…","model":"…","taskKind":"…","scenario":null,
 "inputSemantics":"includes-cache","recordedAt":"…","sourceHash":"sha256…",
 "baselineExpected":{"calls":4,"inputTokens":7000,"outputTokens":800,"cachedReadTokens":3500},
 "baselineSource":{"inputTokens":"baselineTokens","outputTokens":"baselineTokens"},
 "predictedExpected":{"calls":4,"inputTokens":5415,"outputTokens":640,"cachedReadTokens":3500},
 "actual":{"calls":4,"inputTokens":7200,"outputTokens":820,"cachedReadTokens":null,"imageTokens":null}}
```

`baselineExpected`=未校准 raw 基准（下次比率的分母）；`predictedExpected`=本次真正预测（展示用；误差对它比较）；两者可为 null（无法还原时明示，不用 0 冒充）。旧 v1 样本只有 `expected`+`actual`：可解析、可去重，但**不参与校准**（`legacySamplesWithoutBaseline` 计数明示）。

只写数字/ids/模型/任务类型/来源 hash —— **不含 prompt、截图、完整会话、凭据**。

## 文件安全

- `--out` 不得覆盖任何输入/源文件（spec/estimate/actual/history）；realpath 符号链接别名与 inode 硬链接同样拒绝；`--out` 与 `--history` 互写拒绝。
- 写入原子（同目录 tmp + rename）；拒绝后源文件不被破坏。
- 只读显式传入的路径，不扫仓库、不读环境凭据。

## guard：宿主 Codex 会话守卫（phase gate）

`run`/`gui run` 的预算门只覆盖被派发的子进程；发起任务的**宿主 Codex 主对话**不受那层控制。`budget guard` 把仓外原型（budget_snapshot.py）产品化：离线、0 次模型调用、只读显式给出的会话文件（绝不隐式读 `~/.codex`，测试全部用临时目录伪造脱敏 JSONL）。

- **输入**：`--sessions` 为宿主会话 JSONL 文件或目录（目录递归扫 `*.jsonl`；多宿主歧义时用 `--parent-id` 指定）；`--budget` 为预算 JSON；`--marker` 可选文本起点。
- **计量**：解析 `event_msg type=token_count` 的 `info.total_token_usage`（取**最后值**）；宿主自差额 = 最后值 − marker 前最后一个快照（无 marker 按整会话、基线 0；marker 前无事件按 0 基线）；worker 会话按首行 `session_meta source.subagent.thread_spawn.parent_thread_id` 匹配宿主 id（marker 模式只计 marker 之后 spawn 的），各取其最后快照合计。
- **归一口径**：复用 `actual.mjs` 的规范 usage JSON 解析（includes-cache）：total = input + output，cached 为输入子集不重复加，parts≠total / cached>input 拒绝；计数回退（截断/重写）拒绝。**没有第二套公式**。
- **预算 JSON 字段**（结构同原型内嵌 budget）：`totalTokens`、`stopBeforeTotalTokens` 必填；`parentTokens`（宿主相位）、`executorTokens`（worker 合计相位）、`acceptanceReserveTokens`（observed > total − reserve 即占用验收预留）、`wallMinutes`（marker/会话起点→最后快照的墙钟）可选；`measurement` 口径字符串可选。stopBefore/reserve 不得大于 totalTokens。
- **判定与退出码**：0=within；**2=over**（任一相位阈值确定性超限，可立即止损）；**3=数据不足/unknown**（宿主无 token_count、marker 未找到、worker 快照缺数字、墙钟不可测等——unknown ≠ 0，不放行）；1=预算 JSON/路径数据错误。over 与 unknown 并存时按 over（确定性超限可行动），unknown 仍全部列出。
- **诚实边界（与原型一致，必须保留）**：`warning: snapshot tail and in-flight calls unknown; phase gate, not provider hard cap`——只计至最后一个 token_count 快照，其后尾部与在途调用未知；这是**相位门，不是供应商硬上限**，靠"超阈值即停止派发新工作"生效，不能阻止已发出请求的消耗。
- 坏行容错：坏 JSON 行跳过并计数（`badLines`），不中断也不伪 0；计量以最后一个可用快照为准。

## 界限

- 中位预测是估计不是硬上限；unknown 不构成预算放行依据。
- 文本启发式不是模型 tokenizer；图像/缓存写入口径不明确时按 unknown 分列。
- `run`/`gui run` 已实际接入执行前 HIGH 与步间共享预算 guard，不做 daemon/新调度平台；见 [执行预算契约与局限](../packages/cli/lib/budget/README.md)。离线 estimate/reconcile JSON 仍可独立消费（预测契约见 `packages/contracts/schemas/token-budget-v1.schema.json`）。


## 执行入口已接线（本轮）

独立 estimate/reconcile 仍为离线算术命令；公开 `run --plan --project --state --brief-file` 与 `gui run --budget-spec` 已在实际启动前调用同一算法，按预测 HIGH 与原始 baseline HIGH 中较高者预留。
缺预算/unknown/超限不启动模型；串行步骤共享剩余预算，未知实耗不当零。首版同 taskKey 只允许一次实际 attempt，无自动返修续跑。
显式上下文文件、brief 与内联命令文本均受字节/启发式 token 上限控制，回包只含有限摘要/工件路径。
详细 plan 及行为见 `packages/cli/lib/budget/README.md` 与 [本轮验收](EXECUTION-BUDGET-ACCEPTANCE-20261027.md)。
这是前置/步间拦截，不是供应商内部流式硬 token 上限；运行后执行器自行读入的文件及宿主 Codex 工具调用不受此层控制。
