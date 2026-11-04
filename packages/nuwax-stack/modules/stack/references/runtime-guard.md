# 一次调用一次退出的宿主协议（0.4.7）

只用包内 `scripts/runtime_guard.py`，不创建 daemon、不安装软件、不修 DNS、不云端或沙箱外回退。`runtime.kind` 必须显式为 `nuwax-platform`、`codex`、`deepseek-harness`。所有输入是本地编排方审核的结构化 JSON，绝不从消息提取命令执行。平台原生 Loop 每轮是否先调用模型由平台决定，提示词和本脚本不能承诺零模型唤醒。

固定入口（PY 为 profile 中绝对 Python 路径；GUARD 为安装技能脚本；PROFILE 为工作台配置）：

```
PY -B GUARD check --profile PROFILE --input observed.json
PY -B GUARD lease --profile PROFILE --owner <真实runId> --seconds 120
PY -B GUARD context --profile PROFILE --input recent.json
PY -B GUARD backoff --profile PROFILE --input observation.json
PY -B GUARD dispatch --profile PROFILE --input approved-dispatch.json
PY -B GUARD record --profile PROFILE --input result.json
PY -B GUARD lease --profile PROFILE --owner <真实runId> --action release
```

check 输入 `{"kind":"nuwax-platform","agentId":33300105,"sandboxId":4256}` 的值必须来自实际宿主元数据，不能把 profile 复制为观测。hostname 来自系统。工具依赖必须绝对路径，unknown 阻断相关工作，游标冻结。check 不写盘；首次故障以 backoff 指纹落盘，重复故障不向 cursor 增加 note。租约 busy 立即安静退出，超过租期前续租；操作间 flock + 原子 replace 防竞争。租约是调用方协作契约，任务执行继续使用 TaskStore 自有 claim；未经租约不能启动业务步骤。TaskStore 仅绑定 `state/tasks/tasks.sqlite`，不可创建 `state/tasks.sqlite`。

backoff 输入：`key`（依赖/issue 单独分桶），`outcome`（blocked/404/permission/unchanged/changed/ok），显式 `issueFingerprint`、`sourceFingerprint`、`conditionFingerprint`；每个指纹为稳定规范数据 hash，不放时间、runId、无语义变化的 raw hash。实际探测后才设 `attempted:true`。首次故障5分钟；到期且真实重复探测后15、60、360分钟封顶；提前唤醒不延长时间。指纹变化立即 ready 并重置。`newMessage:true` / `authorizedTaskReady:true` 只绕过外部 issue 退避，不绕过环境检查、授权或预算。各 key 退避只挡对应重复探测；永不全局挡新收件/可推进任务。无语义变化使用规范 issue 列表指纹，不周期性 GH404 重新求证。

context 输入仅显式最近内容 `{"runId":"...","pending":["最多3项"],"summary":"最多600字且2400字节","legacyDigest":"原progress-digest.md绝对路径"}`。程序只读 cursor 白名单字段，保留原有所有 note，产生 `state/runtime/cursor-view.json` ≤4096字节，`digest-current.md` ≤4096字节（机器meta含 sourceHash/updatedAt）。原 digest 内容寻址原样归档并保留源文件；后续输入不再带 legacyDigest，避免反复扫描历史。禁止 cat 全量 cursor/digest。机器 meta sourceHash 无旧 digest 时为显式 recent JSON hash；recentHash 始终为该 JSON hash。新状态索引上限256，满后明确受阻，人工归档不能丢去重信息；旧档和原文不删。

## 派工与预算：复用 devkit，不写第二套引擎

`dispatch` 只生成可审阅的固定 argv/cwd/env，不执行模型。审核 request 包含 taskKey、attemptId、runtime.kind、plan、briefFile、worktree、timeoutSeconds（1..3600）。plan/brief 必须在已授权 worktrees 子目录，brief ≤8KiB；计划 assignments.command 必须 argv 数组。模型 plan 必须 mode=model、budget/maxAttempts=1、budgetSpec，完整规格沿用 devkit `packages/cli/lib/budget/README.md`；现有 core/actual + crew.execution_budget 在真实 spawn 前/步间执行预测与准入。不得把 mode=no-model 用于模型 CLI。

工作台 profile 显式启用 `runtimeGuard.humanApprovalRequired: true` 后，所有 dispatch 均需先经过本机看板审批。plan 中 `attemptId` 必须与 request 一致；request 新增 `approval: {"summary":"任务目标", "scope":"目标仓库和改动范围", "acceptance":"可检查的验收标准"}`。首次调用登记审批并返回 `approval-pending`、`approvalId` 和 `executeAllowed=false`，不返回可执行命令；拒绝后保持阻断。罗东本人通过本机看板决定，Agent 不得自行审批或修改审批记录。通过后再次用原 request 调用，只有方案和简报的哈希、工作区、任务和尝试均未变化时才返回带审批校验的 argv；执行时 `crew run` 会再次核对。修改方案或简报会产生新的待审批申请。看板不可用、审批未知或拒绝时禁止执行，保留原任务和检查点。只读收件、现状调查及准备审批材料可继续。

该机制校验 Forge 受管派工入口；平台 Agent 能直接调用的其他工具不受此脚本强制约束，必须结合平台侧工具权限和 Agent 指令。看板仅限本机并限制跨站请求，但与 Agent 同一系统用户的其他本机进程不是独立身份边界，不能将本地按钮等同于平台账户认证。运行或批准一次方案不等于永久授权同名任务。

本机部署使用 devkit 随包 crew（profile.devkitCrewRoot），通过同一 `crew run` 协议把 `--ledger` 指向原 crew-usage.jsonl；不覆盖 executors.json/原 ledger，不另造主账。profile 同时明确 devkit CLI、Node、Python 路径。执行方逐项复核返回 argv/env、计划内容与 hash 后执行，未知结果先查原账，不重复派发。重复 task/attempt 返回 executeAllowed=false；同 task 新 attempt 也拒绝自动重跑，必须人工核销后登记新的真实任务。prepared 是预留，不能视为 dispatched；实际 dispatched/completed/failed 由 crew.run 追加原账，completed 只代表进程。

record 把 crew 真实结果与人工验收证据统一为 taskKey/attemptId/runtime.kind/processPassed/acceptancePassed/usage；原账仍由 crew 写，旁路 reconciliation 原子写独立事件文件并保留索引。进程通过不自动验收，通过必须显式 acceptanceEvidence。usage 默认 unknown/null，native/DSH 无适配器不得造0。仅明确 adapter=structured-v1、usageScope=run-segment、inputSemantics=includes-cache、inputTokens/outputTokens/cachedInputTokens 合法时可归一，total=input+output，cache 是 input 子集。未知 usage 不得继续模型步骤，交给 devkit 已有预算 guard 阻断。Codex token_count 仅供已有 Codex 专用 budget guard 读取，不是通用宿主协议。平台/native/DSH 目前不提供主对话实耗适配器，宿主预算未知；这是执行前/步间门与有限等待，绝非 provider 硬限额。

Codex/DSH 接入同一固定命令，仅替换 runtime.kind 和显式观测 JSON；本轮不扩展新 harness、不改 devkit/crew 源码。环境前置和这些纯数据处理可零模型运行；平台 Loop 自身仍可能消耗模型。
