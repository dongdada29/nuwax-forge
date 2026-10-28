# Client GUI 与 token 预算独立验收（2026-10-27）

结论：可选 Midscene GUI 驱动与内置 token 预测/实耗对账已交付，具名真实产品场景通过。实现交给 Claude Code 执行器，最后的计量边界由收尾 subagent 补齐；Codex 独立核对代码、离线测试、真实应用、原始 SDK HTML 与工件哈希。CDP 配置源码按用户后续明确授权保留；没有为能力验证修改其它业务行为。

## 实际耗时与模型用量

测量边界：一次 CLI GUI 运行开始至 manifest 完成，包含附着、确定性输入、1 次视觉 Boolean、清空恢复与报告整理，不含模型/SDK 安装、应用启动、任务讨论及本次开发。

| 样本 | 判定 | 秒 | 可观测 callId | 输入 tokens | 输出 tokens | 合计 | 恢复成功 |
|---|---|---:|---:|---:|---:|---:|---|
| 04 | 通过 | 9.642 | 1 | 3720 | 44 | 3764 | 是 |
| 05 | 通过 | 10.464 | 1 | 3720 | 43 | 3763 | 是 |
| 06 | 通过 | 10.547 | 1 | 3720 | 43 | 3763 | 是 |
| 07 | 预期失败 | 9.437 | 1 | 3722 | 59 | 3781 | 是 |

三次正向中位 **10.464 秒 / 1 次调用 / 3,763 tokens**，总计 11,290 tokens。06 与 07 使用仓外离线安装的 tarball 消费者；后续修改只涉及预算口径，GUI 驱动不变。07 故意要求页面包含不存在的标记，SDK Boolean=false，整次正确失败且清空恢复成功。

全部含推理的试运行（含失败校准 02 和负例 07）共 **5 个 usage-bearing callId、至少 6 次 SDK 请求尝试、已报告 18,835 tokens**。02 的 retry_count=1 是真实重试。失败请求用量、供应商隐藏重试和 cached_tokens 未报告，均为 unknown；18,835 不是账单上限，也不能把 cached unknown 写成 0。

保留的失败：01（2.656 秒）序列化闭包问题、02（18.983 秒）清空与报告解析问题、03（0.547 秒）目标已离开首页而被前置门拒绝。01/03 未进入配方 AI 操作；02 有一次已知调用及重试。问题已修，失败文件和原预测没有覆盖。隔离 Electron 启动曾在 Chromium 嵌套沙箱下失败，也未记作产品通过。

## 产品与环境身份

- 已安装 `/Applications/Nuwax.app`，版本 3.0.23，Chrome/144.0.7559.236；ASAR SHA256 `23e7686a6107e9c1fbfe20494a3d0520b4354dde9ed1c8e3870d0a51f24703d6`。
- Node 24.18.0、Python 3.15.0、Midscene web 1.17.1、Puppeteer core 25.16.0；复用已有仓外显式运行时，未新增核心依赖。
- 模型 `gpt-6.1-sol` / family `gpt-6` / SIWC；SDK 使用已有认证并正常刷新，未复制、打印或手工改动凭据。
- 精确锁定登录中的 guest `https://agent.nuwax.com/home`，目标类型 webview 经 asPage 绑定；场景为首页编辑器为空→输入唯一安全标记→DOM 读取→视觉 Boolean→清空→DOM 为空。没有提交消息或创建任务。
- 动态远端前端部署 SHA 未锁定，证据仅代表记录时刻，不能跨部署/登录态复用。

## 内置 token 功能

```sh
nuwax-devkit budget estimate --spec <任务预算.json> --history <校准.jsonl> --out <预测.json> --json
nuwax-devkit budget reconcile --estimate <预测.json> --actual <本次实耗.json> --history <校准.jsonl> --out <对账.json> --json
```

两命令自身离线且 **0 次模型调用**。输入任务类型、模型键、预计调用次数、上下文、输出/工具回包增长、缓存比例、图像范围与预算；输出 low/median/high、来源假设、unknown、预算 verdict 和缩减建议。历史按模型+任务类型+场景匹配并去重。缓存作为输入子集，不能重复加总；未知值不补零；不完整/重试/口径未知的实耗不参与校准；累计/未知 scope 或显式不可校准的导入历史也会被拒绝。excludes-cache 的原始总量单独保留，可比总量加上已知 cache-read；未知输入口径即使有 raw total 也不放行预算。细节见 [TOKEN-BUDGET.md](TOKEN-BUDGET.md)。

原始调用前预测如实保留：

| 样本 | 当时预测中位 tokens | 实耗 tokens | 说明 |
|---|---:|---:|---|
| 04 | 7,078 | 3,764 | 初次使用显式视觉宽区间，无历史 |
| 05 | 3,764 | 3,763 | 1 个历史样本，低置信 |
| 06 | 5,419.545 | 3,763 | 暴露递归校准反馈回弹，原预测保留 |

已修复反馈回弹：保存未校准 baseline 与当时 predicted；比率始终对 raw baseline。修复后的**事后离线回测**依次预测 7,078 / 3,764 / 3,763.5，对应实耗 3,764 / 3,763 / 3,763；回测自身 0 次模型调用。不能把事后回测称为当时预测准确度。样本仅 3 个，没有稳定 P90、生产准确率或 token 降幅结论。

Claude `--resume` 的 result.modelUsage 被实测为整会话累计；单轮 num_turns 不能证明 usage 的计量区间。导入时必须明确区分 session 累计和 run-segment，未知/累计值保留原数字但不得放行本任务预算或校准本任务。使用同会话 baseline 扣减得到已确认分段用量后，再显式声明 run-segment。自定义 provider 的缓存口径也须另行确认。

当前功能是可调用的预测/对账工具，本次 QA 显式串接到每次实测前后；尚未强制所有执行器/GUI 运行自动调用，不自动切换账号/模型，不提供供应商硬 token 限额，也未估算货币费用。

## 前后对比的有效边界

| 指标 | 前期原流程 | 固定流程/本次结果 | 结论 |
|---|---:|---:|---|
| 前期 source-tooling 执行中位 | 105.171 秒、7 个模型响应 | 1.535 秒、0 个执行段模型响应 | 既有 3 对交替样本，引用原证据；不外推 GUI |
| 新增真实 GUI 场景 | 无同场景旧样本 | 10.464 秒、1 call、3,763 tokens | 新能力实测，不能声称同比下降 |
| 产品构建 / 重复产品构建 | 0 / 0 | 0 / 0 | 没有构建加速结论 |

前期数字和详细边界见 [PILOT-BASELINE.md](PILOT-BASELINE.md)。本次未重跑 client 全套测试，不把前期含既有失败的全套写成全绿。

## 一次性开发、返修与审核成本

本次投入不能藏到日常运行之外而不报告。从本次 GUI 请求到快照约 **110.6 分钟**（含讨论、实现、等待、返修、验收；并非纯执行时间）。父 Codex 计量快照截止 `2026-10-27T12:49:29.080Z`：观测 123 次模型响应、115 次外层工具调用，输入 **31,470,842** tokens（其中缓存 **30,688,512**，为输入子集；非缓存输入 782,330），输出 **172,215**（含 reasoning 子集 112,876，不再相加）。这是任务请求之后的累计差值快照，仍不包含最后尾部，不等于账单/套餐占用。

Claude Code 执行器另计 11 个阶段，观测 222 个去重 assistant message ID；按阶段时间窗读取 trace，原始字段和为 input 446,179、cache-read 17,077,184、output 249,060。自定义 provider 口径保持分列，不与父模型强凑一个账单。续跑 SDK 累计结果**没有逐阶段相加**；超时尾部可能缺 usage，视为观测下界。执行器墙钟合计存在并行，不能当项目总耗时。另有 1 个收尾 subagent 的实现/测试成本未取得独立完整 usage，记 unknown，未假报零。

本轮发生多次执行器超时及真实 Electron 适配返修，**不能宣称本次完整工程已节省 token 或耗时**。重复运行的约 3.76k token 和固定脚本零模型，是后续可测的成本单位；减少大上下文反复审核、固定配方以及有限任务派工仍是主要优化方向。

## CDP 配置与恢复

client 源码新增 `userData/diagnostics.json` 配置（macOS Nuwax 默认目录 `~/Library/Application Support/Nuwax`）：

```json
{"schemaVersion":1,"cdp":{"enabled":true,"port":19222,"host":"127.0.0.1"}}
```

默认/缺失/非法配置关闭，enabled 必须显式 true，只允许回环地址，重启生效；先移除外部 Chromium 调试参数，再按配置应用。应用不创建配置，不杀端口占用者。17 项独立源码单测通过。代码仅涉及诊断模块、main 早期接线和对应测试。当前文件已被并行工作纳入 client 提交 a717292c（只读核对；本验收未执行提交或推送），不覆盖其它任务后续改动。

**当前已安装包还没有新配置源码。**本次在用户授权下临时用启动参数打开旧包 CDP；测试结束后普通启动已恢复，19222 端口已关闭，IM 页面可见且草稿为空。新配置尚未完成新安装包开关验收，不能把单测当整包通过；本次没有产品构建。

## 回归与分发

工作区测试合计 **211/211**（各包计数 72, 18, 19, 47, 55），contracts 字节一致检查通过；client 诊断单测另计 17/17。五个 tarball 内容与哈希核对，拒绝符号/硬链接、凭据、node_modules、.git 及真实 registry；全新仓外消费者离线 ignore-scripts 安装，help/doctor/budget 命令通过。未发布、未推送、未运行远程 CI 或跨机/新包验收。

## 证据位置

原始证据：`/Users/apple/Documents/Codex/2026-10-27/client-midscene-live`。机器可读总表 `ACCEPTANCE-RESULT.json`；真实独立复核 `independent-gui-audit.json`；原预测 `budget-estimate-04/05/06.json`；离线回测 `calibration-backtest-release-verdict.json`；父模型快照 `parent-token-snapshot.json`；执行器逐阶段 `executor-token-audit.json` 与 `executor-token-summary.json`；恢复 `normal-app-restored.json`。失败试验和中间包继续保留供审计。
