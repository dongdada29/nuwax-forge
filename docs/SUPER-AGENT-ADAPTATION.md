# Nuwax Forge Super-agent 适配方案

日期：2026-11-03

基线：`f08c232`，Nuwax Forge 多包仓库

范围：只扩展 Forge/Stack，不修改 `agent-platform`，不改已部署 Agent、Loop、游标或任务数据。

## 目标

借鉴 DeepSeek Harness Super-agent 的 Router/Worker、事件身份、任务授权、上下文按需召回和异常恢复设计，解决 Nuwax Agent 的主对话承载过多执行上下文、跨会话任务关联不稳、重启后难以准确恢复的问题。保留 Nuwax 平台作为 Agent 与 Loop 宿主，保留 Forge 作为 Codex、DeepSeek Harness 和 Nuwax 本机执行入口。

DeepSeek 的 `dsh-superagent-prototype` 将 Source 事件规范化为 Trigger，通过 Thread 关联上下文，再以 Ticket/Mandate 和 Assignment 表达授权工作及执行尝试。它是单仓库研究原型，不是生产产品；本方案借鉴数据边界和生命周期，不直接移植插件代码。[官方原型说明](https://github.com/deepseek-ai/dsh-superagent-prototype) · [Domain model](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md) · [Authorization](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md)

## 对应关系

| Super-agent 概念 | Nuwax Forge 对应 | 原则 |
|---|---|---|
| Router | 现有 Nuwax Agent 主会话与 Loop | 接收、判定、派工、汇总；不承载长时间实现过程 |
| Source / Trigger | 平台 Loop、IM 或其他已配置入口产生的事件 | 保留来源身份与稳定事件键；先按已配置规则准入 |
| Thread | IM 会话/主题、平台会话或代码评审线程 | 持续跟进须能关联到原任务；只供参考的 Thread 不增加权限 |
| Ticket / Mandate | 现有 TaskStore 任务行及其授权范围 | 任务目标、来源、授权依据、可写范围和完成条件随任务持久化 |
| Assignment / Worker | Forge dispatch attempt 与 Codex、DSH、Nuwax 执行会话 | 每次执行单独编号、上下文隔离、报告回到同一任务 |
| Watchdog / recovery | 现有 lease、backoff、checkpoint 与 reconcile | 优先使用确定性状态检查；不新增常驻轮询或默认模型巡检 |

## 分阶段实现

### 第一阶段：可恢复的任务与执行尝试账本（受限本机实现）

- 将现有 TaskStore 任务行作为 Ticket 的稳定身份，不搬迁或重建任务数据库。
- 增加稳定 Trigger 去重、Thread 关联和 Ticket 授权元数据；同一来源事件重放不得创建第二个任务。
- 增加 Assignment 的准备、开始、报告和终态记录；attempt 与 task 分离，进程重启后能看见最后一次状态。
- 每个状态变化经过 TaskStore 的 revision/lease 校验，并保留 append-only 事件证据。
- 通过 `nuwax-forge stack task-state` 暴露单次本地 JSON 操作；只读写本机状态，不启动模型、消息发送、子进程或后台服务。
- 旧任务行、旧调用方式和现有运行门保持兼容；新增字段可缺省，首次打开既有 SQLite 只允许 additive schema 初始化。

**当前源码范围（未完成行为验收）：** 两份 `task_state.py` 均以 additive 表保存 Trigger 与 Assignment；Trigger 按 `source + sourceId` 稳定去重，准入仅接受 candidate；Ticket 的 admission/Mandate 作为 task payload 可选 metadata；Assignment 操作校验 revision 和有效 lease，并在同一 SQLite 事务内更新当前记录及追加事件。一次性命令为 `trigger-record|trigger-read|ticket-admit|ticket-read|assignment-prepare|assignment-start|assignment-report|assignment-finish`，输入为不超过 64 KiB 的 JSON 文件，必须含绝对路径 `stateDirectory` 和 `repoRoot`。例如：

```sh
nuwax-forge stack task-state --command trigger-record --input trigger.json
nuwax-forge stack task-state --command ticket-admit --input admission.json
nuwax-forge stack task-state --command assignment-prepare --input attempt.json
```

Ticket 准入要求 `admission: {"kind":"explicit","actor":"...","evidenceRef":"..."}` 和 `mandate: {"writePaths":["src/..."],"argvCommands":[["python3","-B","..."]]}`；`maxModelCalls` 可省略。Assignment usage 的 token/modelCall 缺值保持 `null`。Admission 与 Mandate 当前是本机声明记录，不替代 Nuwax 身份校验或执行时权限强制；此实现没有平台接入、消息送达、daemon、模型调用或命令执行。DeepSeek 原型仅为设计参考，本阶段不代表生产化。

当前已通过 Stack 既有自主状态测试，以及临时 SQLite 上 Trigger、Ticket、Assignment 接入看板的测试；尚未进行平台 Loop/IM 真实链路验收，下方验收条件仍需在实际运行环境复核。

Forge 的 `dashboard` 命令可从 Crew 台账、Stack Assignment、Forge agent 状态和显式 Codex budget guard 快照生成本地看板，也支持前台本机页面按请求刷新。各来源分开计数；未知消耗不作零值，跨来源不直接求和。已部署平台自动写入新账本仍属于后续阶段。

### 第二阶段：接入现有平台路由

- 由现有 Loop/IM source 提交已规范化 Trigger；派工前显式记录 decision 与 Mandate。
- 强身份消息可建立 Ticket；未明确授权的推断候选仅记录为候选，不自动执行。
- Ticket 的 follow-up 与 context-only subscription 分开；context-only 输入不能扩大授权。
- Router 只将短任务卡、最近摘要和资源 ID 交给 Worker，Worker 按 Ticket 读取相关细节。

### 第三阶段：可靠送达与看门恢复

- 为通知和 Worker 结果增加事务 outbox 与幂等回执，失败重试不重复发送或重复创建 Assignment。
- 由现有调度机制检查超时、无进展和未结算状态；先用脚本规则，只有确有判断价值时才使用受预算约束的模型检查。
- 事件源具备稳定增量或 webhook 后再缩短轮询；不在 Stack 内添加 daemon 或私建 IM 连接。

## 本次不做

- 不复制 DeepSeek 的 GitHub/飞书插件、面板、Sessions 管理或它的数据库实现。
- 不变更 Nuwax Agent 平台 API、模型、Hook、Agent、Loop、分享权限或现有任务数据。
- 不修改 `agent-platform` 项目代码或从该项目创建提交；平台后端变更如有需要，另交后端团队。
- 不把任务“能并发”当成提升单个模型任务速度的承诺；后续要另用真实同口径任务测量。

## 第一阶段验收条件

1. 现有 TaskStore 构造、create/read/claim/checkpoint 行为保持兼容。
2. 相同 source + trigger ID 幂等；同一 Thread 可关联多个已授权 Ticket。
3. Assignment 有独立 attempt ID 和明确状态；过期 lease 或旧 revision 不能写入新报告。
4. context-only Thread 只作为上下文保存，不修改 Mandate 或任务授权。
5. CLI 输入输出是有界 JSON；操作不会调用模型、shell、平台 API 或通知通道。
6. 初次打开现有 SQLite 只添加新结构，不删除、重写或迁移旧任务行。

## 参考资料

- [DeepSeek dsh-superagent-prototype README](https://github.com/deepseek-ai/dsh-superagent-prototype)：研究原型范围与限制。
- [Domain model](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md)：Trigger、Thread、Ticket、Assignment、Subscription。
- [Authorization](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md)：Admission、Mandate、跟进与上下文订阅边界。
- [Execution](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md)：Worker 会话、重启恢复、任务输入与报告。
- [Architecture](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md)：事务、outbox、effects 和事件流。
