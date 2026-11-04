# task / runtime 字段声明（v2，只列已实现）

本文只声明**已在代码中实现并运行校验**的字段（正本实现：`packages/nuwax-crew/crew/contract.py`
的 `validate()`；恢复/证据侧：`packages/nuwax-stack/skills/nuwax-stack/scripts/task_state.py`）。
不提供 JSON Schema 冒充完整强校验——真实校验以运行中的 Python 为准；本文件是消费者接线参考。

## task（schemaVersion 1|2）

| 字段 | 类型 | 约束（已实现） |
|---|---|---|
| `taskKey` | string | 必填非空，strip 后使用 |
| `kind` | string | 必须在 registry VALID_KINDS 内（implementation 类另要求 repo 与非空 acceptance） |
| `risk` | string | 可选，`high|normal|low`，默认 normal |
| `objective` | string | 必填非空 |
| `acceptance` | string[] | 字符串列表；implementation 必须非空 |
| `repo` | string | implementation 必填 |
| `budget.maxExecutors` | int>0 | 可选 |
| `budget.maxWallSeconds` | int>0 | 可选；**观测上限语义** |
| `budget.maxModelRequests` | int>0 | 可选；**仅观测预算，不是硬中止** |
| `attemptId` | string | 透传保留 |
| `runtime` | object | 只允许下方白名单字段，值均为非空短字符串 |
| `verification.manifest` | string | 必填非空（如 `{artifacts}/verification.json`） |
| `verification.validatorArgv` | string[] | 必填 argv 数组，元素非空 |

## runtime 白名单（仅这些字段被接受）

`profileId`、`engineExecutable`、`engineVersion`、`model`、`reasoning`、`contextMode`、`domain`。
任何白名单外字段或非字符串值都会被 `ContractError` 拒绝。敏感信息（令牌/凭据）不得写入 runtime。

## level（verification）

`source-tooling` 由既有 verify/TaskStore 校验链支持；`gui-toolchain-smoke` 与 `gui-product-scenario`
由可选 live driver 使用独立 GUI 契约，不导入旧 TaskStore。当前范围见 [能力说明](../../../docs/CAPABILITIES.md)。
`passed=true` 只覆盖声明的 level 与 predicates；source-tooling 不代表 GUI/安装包/真机/线上通过。

## verification manifest

格式正本是本包 `schemas/verification-v1.schema.json`（stack 技能内有字节同步副本）。
栈侧独立复核实际 HEAD、输入文件集合与指纹、阶段结果与日志哈希；validator 不执行 manifest 里的 command。
