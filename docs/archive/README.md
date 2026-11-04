# 历史文档索引

这里的文档保留采集时的版本、路径、用量、测试计数及问题。它们不是当前能力清单，也不能证明当前版本仍存在某个缺陷或已将其修复。当前使用方式见[文档导航](../README.md)，验收边界见[能力说明](../CAPABILITIES.md)。

| 历史记录 | 用途与归档方式 |
| --- | --- |
| [2026-10-29 实跑优化提案](2026-10/IMPROVEMENT-PROPOSAL-20261029.md) | 基线 `70c1c99` 的环境复用反例及建议；从主文档目录移入归档，不作为当前待办清单 |
| [初期实施结果](../../IMPLEMENTATION-RESULT.md) | 2026-10-27 交付和返修经过；保留原路径及关联 JSON，避免破坏证据引用 |
| [初期独立验收](../../ACCEPTANCE-REPORT.md) | 2026-10-27 五包/source-tooling 验收；保留原路径，顶部标注历史范围 |
| [源码迁移与 provenance](../MIGRATION.md) | 一次性导入的源 HEAD、文件排除和指纹；保留原路径供来源审计 |
| [试点基线数据](../PILOT-BASELINE.md) | 既有固定流程样本；不推广成当前全流程速度或 token 收益 |
| [2026-10-27 执行预算](../EXECUTION-BUDGET-ACCEPTANCE-20261027.md)、[GUI/token](../CLIENT-GUI-TOKEN-ACCEPTANCE-20261027.md)、[宿主上下文](../HOST-CONTEXT-CLIENT-ACCEPTANCE-20261027.md) | 具名场景和时间范围内的原始验收，保留原路径及标题日期 |
| [2026-10-30 client workflow](../CLIENT-WORKFLOW-ACCEPTANCE-20261030.md)、[沙箱预算](../CLIENT-SANDBOX-BUDGET-20261030.md) | 对应固定消费场景的历史证据，不替代当前产品或发布包验收 |

旧文档中的“无 commit/remote”“CI 未运行”“五包”等词描述原始记录时刻；当前仓库为六包、已有远端和主线 CI。未删除原测试结果或把未验项改写为已通过。
