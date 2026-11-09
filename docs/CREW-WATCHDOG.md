# Watchdog V0：离线巡查台账

`crew patrol` 读派工台账（ledger JSONL），按规则抓行为异常，告警追加写 JSONL。纯函数、零模型、零执行、零第三方依赖；不常驻，由调度入口（cron / Bot / 手动）驱动。规则设计与数据边界见本文，实现 [watchdog.py](../packages/nuwax-crew/crew/watchdog.py)。

## 使用

```bash
python3 -B -m crew.cli patrol \
  --ledger  path/to/ledger.jsonl \
  --alerts  path/to/alerts.jsonl
```

退出码恒 0（巡查是建议性输出，不算失败）；`--alerts` 文件只增不改，与台账同纪律。所有阈值可用 CLI 参数覆盖：`--window-days / --spin / --fail-streak / --executor-fail-streak / --burn-seconds / --suppress-hours`。

## 规则（默认阈值）

| 规则 | 触发条件 | 说明 |
| --- | --- | --- |
| `task-spin` | 同 taskKey 窗口内 `dispatched` ≥ 3 且无成功 | 反复重试原地打转 |
| `attempt-fail-streak` | 同 taskKey 窗口内 `failed` ≥ 2 且无成功 | 验证连败 |
| `time-burn-no-output` | 同 taskKey 窗口内累计 `elapsedSeconds` ≥ 3600 且无成功 | 耗时零产出（token 口径见下） |
| `executor-fail-streak` | 同 executor 窗口内失败 ≥ 3 且成功为 0 | 疑似配额/挂死，可配合 `crew health` 冷却 |

- 窗口默认 7 天，按台账行 `ts` 过滤；status ∈ {completed, success} 视为成功，{failed} 视为失败（与 usage 聚合同口径）。
- 告警结构：`{schemaVersion:1, kind:"crew-watchdog-alert", rule, subject, severity:"warn", ts, evidence, key}`，`key = rule:subject`。
- 去重：同 `key` 在抑制窗口（默认 6 小时）内不重复写，由 `patrol` 对既有告警文件回读实现。
- 一次任务可同时命中多规则（如连败 + 耗时零产出），各发一条。

## 边界与 V1 方向

- **token 级烧穿**：台账行不含 token 计数，本版用 `elapsedSeconds` 代理。token 口径（reportedTokensLowerBound / observedBudget，保留 unknown）数据源在 Forge 观测，V1 经 delivery/usage 事件接入后加规则。
- **PR 循环重跑**：需要 GitHub 轮询数据源，归 Trigger-V0/V1，不在此版。
- **看板展示**：使用 `dashboard --alerts /absolute/alerts.jsonl` 接入巡查告警页，随页面刷新读取最近 200 条。群提醒由已授权调度入口消费巡查摘要。
- **不做**：不自动 kill/重派任务（Watchdog 只报不治；处置仍走审批流）。

公共入口为 `nuwax-forge crew patrol`，子命令 `--help` 列出阈值参数。
