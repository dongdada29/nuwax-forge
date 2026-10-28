# nuwax-devkit 独立验收

2026-10-27。审核人 Codex。结论：**本地 source-tooling 与五包离线分发验收通过**。实现由用户允许的 Claude Code 执行；Codex 负责退回缺陷、独立测试、安装包检查和本记录。GUI live 和全局剩余指标未随本结论放行。

## 已交付

多包仓库位于 `/Users/apple/workspace/nuwax-devkit`：保留 `nuwax-stack`、`nuwax-crew`、`nuwa-sdlc-kit` 三包，加 `contracts` 与统一 CLI。client 作为外部消费者，不复制进工作区。统一入口为 `doctor / init / verify`；显式选择 Node/Python，配方与状态路径在写入前检查。原试点源码指纹复核未变化。新仓已 git init，未提交、远程推送、生产安装或发布。

## 独立结果

| 检查 | 结果 |
|---|---|
| 工作区回归 | stack 55、crew 47、kit 19、contracts 18、CLI 18；合计 **157/157** |
| 契约 | 正本与 stack 技能内副本逐字节一致 |
| 五包分发 | 五 tgz 安装到全新仓外消费者；doctor 绑定均来自消费者 node_modules，无历史、真实 registry、凭据文件或链接入包 |
| 真实外部 client | 安装后 CLI 执行 22 项既有回归与 doctor 结构检查；source-tooling 通过 |
| 安装后 CLI 完整墙钟 | 新鲜 1.581s；复用 0.124s；篡改日志后重跑 1.645s |
| 失败路径 | GUI/未知 level、坏参数、缺解释器、仓内/别名状态目录、父目录链接逃逸配方均拒绝；关键写入前保持零副作用 |
| GUI 离线契约 | 独立正向对照及 9 个坏输入/断言/计量反例通过；不启动 GUI 或模型 |

本轮独立原始记录：[monorepo-independent-185421/review.json](/Users/apple/Documents/Codex/2026-10-27/client-efficiency-pilot/evidence/monorepo-independent-185421/review.json)。最新完整 client 证据：[verification.json](</Users/apple/Documents/Codex/2026-10-27/client-efficiency-pilot/evidence/monorepo-independent-185421/client state/artifacts/2e34fbdc-bf97-498e-b28b-2b9079757f0d/verification.json>)。五份 tgz 的完整 SHA256 与内容检查在独立记录内；最终代码指纹见 [monorepo-final-code-snapshot.json](/Users/apple/Documents/Codex/2026-10-27/client-efficiency-pilot/evidence/monorepo-final-code-snapshot.json)。

client doctor 本次仍准确报告 `ready=false`：隔离检出未具备完整桌面子模块。通过的是 JSON 输出结构和选定脚本回归，不能当成桌面已就绪。

## 既有前后对照与本轮投入

| 指标 | 原流程中位数 | 固定执行中位数 |
|---|---:|---:|
| 墙钟（3 对样本） | 105.171s | 1.535s |
| 执行器内部模型响应观测 | 7 | 0 |
| 产品构建 / 重复产品构建 | 0 / 0 | 0 / 0 |

对照测的是相同固定验收段，未包含首次配方开发、实施或上层对话。固定流程省去模型编排，不能声称模型推理提速或产品构建已优化。本轮安装后 CLI 时间是单次集成确认，不能替代原三对中位数。详见 [原试点验收](/Users/apple/Documents/Codex/2026-10-27/client-efficiency-pilot/ACCEPTANCE-REPORT.md)。

多包仓库一次性实现与返修另外计量：

| 阶段 | 执行器墙钟秒 | CLI num_turns 原始值 | 唯一 assistant message.id |
|---|---:|---:|---:|
| 首次实现 | 955.454 | 91 | 49 |
| 首轮返修 | 751.224 | 62 | 42 |
| 配方路径修复 | 114.745 | 15 | 7 |
| 严格计量组合修复 | 151.535 | 20 | 11 |

各阶段使用配置中的 `glm-5.3[1m]`，没有另改全局模型。CLI num_turns 与去重模型响应不是同一口径；消息 ID 是本地观测，供应商内部重试未知。本表是实施子进程投入，不含 Codex 审核/对话时间，不属于运行闭环的零模型指标。原始执行记录与观测在 [monorepo-implementation-observation.json](/Users/apple/Documents/Codex/2026-10-27/client-efficiency-pilot/evidence/monorepo-implementation-observation.json)。

## DSH 探索的接入判断

指定会话实际探索 Midscene + SIWC + Electron CDP。纳入可选 GUI driver 方向、验证层级与合成离线反例；**未实现 live driver，也不能据此宣称 DSH SDK 接入完成**。现有 smoke 只选 shell；两份报告 Query 均空、Assert/Boolean 为 false，finished/exit0 不能证明产品成功。报告分别有 2 个唯一 callId、7310/7297 tokens，不能混入固定验收的零模型指标。

Codex 独立读取 smoke 判定段与两份 HTML 的惰性结构数据，哈希、任务结果与子代理报告一致；未运行原 smoke、GUI、登录或模型。详见 [子代理完整评审](/Users/apple/Documents/Codex/2026-10-27/client-efficiency-pilot/DSH-EXPLORATION-REVIEW.md)、[独立复核数据](/Users/apple/Documents/Codex/2026-10-27/client-efficiency-pilot/evidence/dsh-independent-review.json) 与 [仓内接入契约](docs/DSH-GUI-DRIVER-REVIEW.md)。

## 缺陷与保留边界

初审退回了错误成功判定、身份/usage 合并、版本预检、路径/配方检查、层级冒充和打包/import 问题。独立终验又发现父目录链接逃逸，以及坏报告配合严格计量时抛异常，均由原实现者修复并新增反例。两次失败记录原样保留：[第一次](/Users/apple/Documents/Codex/2026-10-27/client-efficiency-pilot/evidence/monorepo-independent-184625/review.json)、[第二次](/Users/apple/Documents/Codex/2026-10-27/client-efficiency-pilot/evidence/monorepo-independent-185022/review.json)。

仍待验证：商业 guest 的 target/origin/ready/login 与产品场景、真实安装包/真机、真实构建缓存收益、Windows/Linux与跨机、远程CI、外部执行器兼容矩阵、fresh上下文/输入token收益和硬模型预算。当前 client 全套脚本基线仍是404项中5项既有失败；通过的22项配方不能写成全量全绿。最小解释器版本门槛已实现，实际本机验收使用 Node v24.18.0 / Python 3.15.0，未覆盖所有支持版本组合。

默认 install/test/pack/verify 不调用模型、不自动登录、不启动产品应用；本次研发执行者确实使用模型。最终签收范围以本报告与 [ACCEPTANCE-REPORT.json](ACCEPTANCE-REPORT.json) 为准，交付者的 IMPLEMENTATION-RESULT 保留其送审状态。
