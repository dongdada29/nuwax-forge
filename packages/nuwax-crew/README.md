# nuwax-crew — 执行器路由与调度层

把「一屋子订阅、一排 Agent CLI」变成一个可解释的派工器：**输入任务，输出派给谁、怎么派、花多少预算**。route 保持纯函数；run 有界调用已经配置的执行器。不常驻，不另建 Agent 引擎。

## 结构化验收接入

任务契约 v2 支持 attemptId、非敏感 runtime、verification 引用及 maxWallSeconds 预算；route 保留这些字段。注册表可提供 invocation.argv，按参数数组调用，避免任务正文经过 shell 展开。旧 command 字符串继续兼容。

run 将输出保存在 artifacts/<attemptId>/，产生 execution.json。processPassed 只说明配置的命令全部执行成功；配置 verification 时还须由显式 validatorArgv 校验证据并返回 passed=true，acceptancePassed 才为真。全 skipped、缺 manifest、验证器退出 0 但 passed=false 都不算验收通过。验证器属于受信运行配置，不从外部文档自动生成并执行。

maxWallSeconds 是进程等待的实际时间上限；maxModelRequests 当前保留为观测预算，不宣称实时硬中止。nuwax-stack 的 TaskStore 继续负责最终任务完成与证据接手。

观测模块 crew.observability 从 Codex 原始 trace 和对应 rollout 分别统计用户 turn、去重的 token usage 更新（模型响应观测数）、工具调用和活跃/闲置时间。它不提供服务端请求耗时拆分；无 rollout 时模型响应数返回未知。

## 定位

```
东的助理MBP128（唯一调度入口：接单/验收/汇报）
        │ 任务 brief
        ▼
   nuwax-crew route  ←—— 本项目：谁来做、怎么派、预算
        │ dispatch plan（主执行器 + 复核 + 降级链）
        ▼
   执行器池（codex / gemini / claude / cursor / opencode / grok / ego-browser / 女娲A2A …）
```

与旧 `nuwax-swarm` 的关系：不再使用其 TOML/JSON 路由与服务栈。可继承的只有两条纪律——**先验证再上岗**（真实小任务核验，不凭印象）和**证据留痕**。本项目是纯 Python 标准库 CLI，一次调用一次退出。

## 路由原则（订阅分层）

| 层 | 订阅 | 承接 |
|---|---|---|
| S | Codex PRO、Gemini PRO、Claude Code | 高风险实施、难调试、交叉复核 |
| A | Cursor / Antigravity | 前端 UI、IDE 工作流 |
| B | 智谱 Max、MIMO、DeepSeek（经 opencode 等） | 分诊、批量、文档、小修 |
| C | Grok PRO | 调研、第二意见 |
| 固定 | ego-browser / 女娲Nuwax | 网页验证 / 平台查询 |

规则：

1. **按风险派工**：业务仓/发布分支改动 = S 实施 + 另一 S 交叉复核（不同提供商）；普通实施单跑；分诊批量走 B。
2. **不核验不上岗**：`verified=false` 的执行器不接生产任务（`--allow-unverified` 仅用于核验本身）。
3. **配额降级**：执行器达到日调用上限自动降级到备选，并在计划里写明原因。
4. **去重**：同一 `taskKey` 只派一次；重复派工需 `--force`。
5. **并发 ≤3**：计划最多包含 主执行器 + 复核 + 一条降级链。

## 任务 brief（contract）

```json
{
  "taskKey": "im-8a599f19660f8cc000590f02",
  "kind": "implementation",
  "risk": "high",
  "repo": "pc-web",
  "objective": "修复 NW-124 验证码倒计时反馈",
  "acceptance": ["原测试不回退", "ego-browser 实测"]
}
```

`implementation` 必须给 `repo` 与非空 `acceptance`；`web-verification` / `platform-query` 由固定执行器承接。

## 使用

```bash
python3 -B -m crew route --task task.json --registry ~/.nuwax-crew/executors.json --ledger ~/.nuwax-crew/usage.jsonl
python3 -B -m crew verify --registry ...           # 打印统一核验任务与各执行器命令
python3 -B -m crew ledger --today --ledger ...
python3 -B -m unittest discover -s tests -v         # 验证入口
```

输出的 `command` 是按注册表 `invocation` 模板填好的真实命令；执行由调度入口（东的助理MBP128）在独立 worktree 中进行，验收与汇报也归它。

## 实况注册表

`registries/mbp128-20261022.json` 是工作台实况注册表在 2026-10-22 复核后的同步快照（在池 12 / 下架 7，下架原因见各条 evidence）：订阅优先、本地 pi 最前、API 计费兜底的消耗策略由 `costClass` 表达。`registry.example.json` 仍是合成示例，供测试使用；实况以工作台 `executors.json` 为准，定期快照同步到本目录。

## 边界

- 不写团队源文档、不动 IM、不改平台配置；执行器只在自己的 worktree 内写。
- 不跨执行器共享凭据；注册表不含密钥。
- 路由结果是建议计划，最终执行与验收责任在调度入口。
