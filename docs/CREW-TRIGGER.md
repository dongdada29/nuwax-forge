# Trigger V0：外部事件 → 任务草稿

`crew trigger` 把外部事件（V0：GitHub 开放 PR 状态）按规则筛成 crew 任务草稿，可直接走 `router.route` 派工落台账。纯函数筛事件、零模型、零第三方依赖；**不常驻、不轮询**——每次执行是一次性调用，由调度入口（cron / Bot / 手动）驱动。设计与边界见本文，实现 [trigger.py](../packages/nuwax-crew/crew/trigger.py)。

## 使用

```bash
# 离线事件文件（可测试）
python3 -B -m crew.cli trigger \
  --rules  packages/nuwax-crew/trigger-rules.example.json \
  --state  path/to/trigger-state.json \
  --events path/to/events.json \
  --registry registry.json --ledger ledger.jsonl   # 可选：route + 落台账

# gh 现场拉取（凭据由 gh 自管，本模块不读不传 token）
python3 -B -m crew.cli trigger \
  --rules  packages/nuwax-crew/trigger-rules.example.json \
  --state  path/to/trigger-state.json \
  --github dongdada29/nuwax-forge
```

## 数据流

```
gh pr list --json … 一次性子进程调用          （或离线 events JSON）
        ↓ collect_github：归一化为事件行 {source,repo,number,title,isDraft,state,updatedAt,rollup}
screen：事件 × 规则 → 任务草稿（task 形状即 router.route 输入，附 sourceEvent）
dedup ：按 taskKey 抑制窗口（默认 24h）去重，状态 JSON 落盘（30 天剪枝）
route+dispatch（可选）：planned 的计划落台账，status=dispatched
```

## 规则（trigger-rules.example.json）

| 规则 | 触发 | 任务 |
| --- | --- | --- |
| `pr-checks-failed` | 开放非 draft PR，checks 归类为 failure（FAILURE/TIMED_OUT/ACTION_REQUIRED/CANCELLED） | triage：只读查 CI 失败原因 |
| `pr-stale` | 开放非 draft PR，updatedAt 超过 staleDays（默认 3） | triage：只读核查阻塞点 |

- 规则字段：`id / match{source,state,draft,checks,staleDays} / kind / risk / objective(模板) / acceptance`；objective 支持 `{number} {title} {headRefName} {repo} {staleDays}`。
- checks 归类：任一 failure 结论 → `failure`；否则任一未完成 → `pending`；否则全 SUCCESS → `success`；无检查 → `none`。
- taskKey 稳定：`ghpr:{repo}#{number}:{ruleId}`——同事件不换 key，台账 `dispatched_keys` 天然防重复派工；再触发节奏由抑制窗口控制。

## 边界与 V1 方向

- **调度**：本模块不含 cron/daemon（对齐 nuwax-crew AGENTS.md「不引入轮询/daemon」）。调度入口示例：crontab 每小时跑一次 `crew trigger --github …`，输出摘要由 Bot 转发到群。
- **凭据**：`gh` 子进程凭 gh 自身登录态（`GH_TOKEN` 环境变量由调度入口注入，不进代码不进台账不进日志）。
- **只触发不改状态**：V0 任务全部是只读 triage；对 PR 评论/合并等写操作属实施类，须走完整审批流。
- **事件源**：V0 只有 GitHub PR；CI run 级事件、issue、其他平台归 V1。
- **失败处理**：gh 拉取失败/超时/坏输出抛 TriggerError 退出 1，不产生半截状态。
