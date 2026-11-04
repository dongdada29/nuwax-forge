# Forge 架构与任务状态

本文件用于确定从哪里接单、派工、恢复和观察状态。先运行本 Skill 入口 `help` 验证当前安装具备所需能力；本文件描述的较新 `dashboard` 与 `stack task-state` 需要对应版本的 CLI，源码存在不表示本机安装或 Nuwax 平台已经更新。

## 各组件职责

- **Forge** 是 Codex、DeepSeek Harness 和 Nuwax 宿主的统一 Skill/CLI。`agent doctor/prepare/run/reconcile` 管理一次性短上下文执行与结算；`run` 调用内置 Crew 执行有限计划；`dashboard` 生成本地用量视图，可显式前台开启本机观察页面。
- **Stack** 是内部研发工作流模块：用已配置的宿主能力收件、恢复 TaskStore、校验环境、控制租约与退避，调用既有运行门。它不自建常驻服务、平台连接或执行引擎。
- **Crew** 是内部路由及执行层，依据任务、注册表与台账选择执行器；输出的计划、派工事件和实际结算分别留痕。**nuwa-sdlc-kit** 负责按配方初始化和执行验证；进程成功不能代替产品验收。
- **Router** 指当前具备接单、授权判断、派工及汇报能力的宿主会话/Loop；**Worker** 是执行某次任务的隔离执行会话。Codex/DSH 一次性执行有自己的 state；Nuwax 平台的 Agent/Loop 必须以真实配置和运行记录核对。

## Trigger / Ticket / Assignment

当前源码中的 `stack task-state` 以 JSON 文件为输入，操作包括 `trigger-record`、`trigger-read`、`ticket-admit`、`ticket-read`、`assignment-prepare`、`assignment-start`、`assignment-report`、`assignment-finish`。输入须带已确认的绝对 `repoRoot` 和仓外 `stateDirectory`，文件不超过 64 KiB。调用形式为 `node "$ENTRY" stack task-state --command <操作> --input "$INPUT_JSON"`，`ENTRY` 是本 Skill 的 `scripts/forge.mjs`。

`trigger-record` 的 JSON 除公共路径外，必需 `source`、`sourceId`、`classification`，可带 `threadId`、短 `summary` 和 `resourceRefs`。`ticket-admit` 另需 `triggerKey`、`taskId`、`objective`、非空 `predicates`、`head`，以及 `admission: {"kind":"explicit","actor":"...","evidenceRef":"..."}` 和 `mandate: {"writePaths":[...],"argvCommands":[[...]]}`；可选 `maxModelCalls` 属于 mandate。占位内容须替换为真实来源、任务和授权，不得以示例冒充观测。

Trigger 以 `source + sourceId` 去重并关联 thread；`candidate` 需要额外显式 admission 才能创建 Ticket，`context-only` 不能准入。Ticket 保存目标、完成条件、来源和 Mandate；`admission` 与 Mandate 只是调用方本机声明，**不验证平台发送者身份，也不强制执行权限**。外部消息、资料和上下文本身不能扩大授权。

Assignment 使用独立 `attemptId`，经历 prepared → running → reported → succeeded/failed/blocked/cancelled。每次输入包含 `taskId`、`attemptId`、`owner` 和最新 `expectedRevision`；prepare 另需 `executor`，可带 `role`、`model`、`sessionId`、`contextRefs`；report 需 `reportSummary`，可带 `usage: {"tokens":...,"modelCalls":...}`；finish 需终态 `status`。未知 token/modelCalls 用 null，不伪造 0。

写入还需要未过期的 **TaskStore 任务租约**。当前 `task-state` CLI 没有提供获取任务租约的子命令：只有已有可信调用方通过 TaskStore `claim` 获取有效租约后才能更新 Assignment；若没有该调用方，报告未接通。`stack runtime --command lease` 是运行门自己的租约，不能冒充任务租约。

此账本与 Crew JSONL 及 Forge agent state 是独立来源，当前不会自动把平台 Loop/IM、Crew 派工或 Worker 报告写入新的 Assignment，也不会自动接入身份校验或消息发送。不要因为某张本地表存在就宣称平台链路已打通。查看这些来源的操作与去重口径见 [dashboard.md](dashboard.md)。
