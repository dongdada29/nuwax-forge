# Agent 预算观测与原生上下文开销

`agent prepare → run → reconcile` 的 HIGH 是阶段准入预测。原生客户端可能在一次 turn 内进行多次 provider 请求，且直到 `turn.completed` 才报告用量；外层收到报告后终止进程，无法撤回已经发生的 token 消耗。本改动不提供 provider 调用内硬限额。

## 已报告超限与完整结算

在已识别的新会话中，有效、无冲突的 usage 报告会产生 `usage.json.observation.reportedTokensLowerBound`。Codex 使用 input + output；input 已含 cached input 子集，不减去缓存，也不重复累加缓存。DSH 使用去重后的 step total。该下界与进程是否正常退出独立；数字和原始缓存桶继续保留。

`manifest.json` 与 `budget-reconcile.json` 增加 `observedBudget`：

```json
{
  "maxTokens": 20000,
  "reportedTokensLowerBound": 25050,
  "verdict": "exceeds"
}
```

该字段只给出 `exceeds` 或 `unknown`。局部报告低于限额不能证明总用量达标。无报告、会话身份/事件序列错误、冲突或损坏日志时下界为 null。它是本次 stdout 已报告 token 的保守下界，不是服务商账单或其他会话的用量。

超限后终止仍保留 `processPassed=false`、`usageKnown=false`、`chargedTokens=null`、完整结算 verdict 为 `unknown`，且不写校准样本。`observedBudget.verdict=exceeds` 独立记录已经证实的超限，不能被完整结算 unknown 掩盖，也不能使 `budgetPassed` 为 true。`agentCompleted` 与产品 `acceptancePassed` 继续独立。重复 reconcile 不重新派发模型。

## 显式声明固定原生上下文

可在任务 spec 中额外声明已知的系统说明、工具定义等固定开销：

```json
{
  "context": {
    "runtimeContextTokens": 8000
  },
  "budgetSpec": {
    "expectedCalls": 3,
    "initialContextTokens": 2000,
    "perCallOutputTokens": 500,
    "perCallToolResultTokens": 1000
  }
}
```

以上仅展示相关字段，其余必填任务字段沿用原 spec。数字是示例，不是某客户端的默认开销。

`runtimeContextTokens` 必须是 0..10000000 的整数，它**额外加到** `max(budgetSpec.initialContextTokens, 显式交付文本 HIGH)`，再交给现有 core 的 expectedCalls 与工具回包增长算法。它不是总输入的替代值，也不会绕过 HIGH 门或降低已有基线。请勿把同一固定开销同时计入 initialContextTokens 和此字段。显式声明会进入 context manifest/hash；prepare 后修改该值，run 会阻断。

省略该字段保留旧配置及已 prepare state 的 manifest/hash；省略表示原生固定开销未声明，不能据此声称真实开销为零。显式 0 是调用方声明，Forge 不会通过扫描会话或凭据来验证。`context.maxBytes/maxTokens` 仍只限制显式文本快照，不能限制运行后读取的文件或工具输出。

多轮增长继续通过已有 `expectedCalls`、`perCallToolResultTokens` 和 `perCallOutputTokens` 声明；不要把一个客户端 turn 当成恰好一次 provider 调用。该输入只能阻止已知开销被忽略，不能证明尚未观测的工具读取、重试或请求数量有硬上界。历史观测也不能直接充当任意模型/任务的精确开销。

## 离线验证

```sh
node --test packages/cli/test/client-agent.test.mjs packages/cli/test/execution-budget.test.mjs
```

测试使用本地 marker 进程和合成事件，不调用模型。覆盖已完成 turn 报超限后被终止、原始缓存口径保留、重复结算、损坏日志、局部低耗不得放行，以及显式固定开销按多轮计入并阻断 HIGH。
