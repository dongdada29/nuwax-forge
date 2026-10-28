# DSH 会话只读评审（脱敏版）与可选 GUI driver 契约

日期：2026-10-27。完整原始评审在试点目录 `DSH-EXPLORATION-REVIEW.md`（只读，未复制进本仓）。
本文是**脱敏改写**：不含本机绝对路径、真实会话文本、截图、报告原文或任何凭据；
结论与证据定位（行号/seq）与原文一致。评审方式：读取原始会话、现有脚本、两份运行报告与
试点契约实现；未重跑模型、GUI、登录或业务测试，未修改业务仓、原会话或全局配置。

## 结论

**可以纳入 nuwax-devkit 的可选 GUI 验证 driver 设计，但现有 smoke 不能充当产品 GUI 验收入口。**

评审对象 `session-b80777b3-0385-4b8d-ab4c-0c6119b15082` 由 DeepSeek Harness 承载，实际探索内容是
**Midscene 1.17.1 + ChatGPT SIWC + Electron CDP**，并非 DSH SDK、任务引擎或执行器编排架构。
不能据此把 DSH 引擎并入新仓，或宣称已具备 DSH 执行器接入。

责任划分不变：stack 管任务状态/恢复/验收证据，crew 管有限调用与执行观测，kit 管仓内规则与
可选验证入口。Midscene 只补充被明确选中的 GUI 判断/操作。默认安装、打包、测试与
source-tooling 配方**不自动登录、不调用模型、不把该 smoke 计为产品 GUI 通过**。

## 关键事实（节选自原评审证据表）

- 会话中两次 smoke 均选择 localhost shell target：**标题为空**、Query 输出空字符串；
  `aiAssert` 失败后改为 `aiBoolean`，输出 **false 只打印诊断**；第二次 smoke 同样空标题、
  `aiBoolean=false`，**仍 exit=0**。→ 工具链调用成功 ≠ 输入框或产品流程通过。
- 报告任务 `status=finished` 与断言成立是两回事：Assert=false 的任务也 finished。
  **报告任务完成与断言成立必须分别解析。**
- 两次报告各含 2 个唯一模型 callId，**每次调用约 3.6k tokens，单份报告合计 7310 / 7297 tokens**
  ——真实发生了模型调用，不能混入 source-tooling 的"内部模型调用 0"指标。
- 授权链路：凭据文件存在被误报为授权成功，后纠正为超时——**文件存在不能作为授权成功证据**。
- README 声称的"完整应用主界面"比实际证据宽（商业主界面嵌入 PC 站点，观察到的只是加载提示）。

## 与现有方案的关系

| 能力 | 判断 |
|---|---|
| GUI 视觉判断、非固定 UI 交互 | 互补：作为可选 driver 补充明确场景 |
| 启动/等待/证据收集脚本化 | 重复：kit/client 已有确定性入口，不为 Midscene 另建生命周期 |
| runtime/任务状态/租约/恢复/调度 | 不构成替代：该会话无 DSH 接入验证 |
| 固定工作内部零模型调用 | 保持边界：Query/Boolean 均真实调用模型，单独计量，不混入 105.171→1.535 秒 |
| exit=0 / HTML 生成即成功 | 冲突：crew 已区分 processPassed/acceptancePassed |
| 按源码哈希复用证据 | GUI 需加约束：实时部署/登录态/目标页面可变，默认不复用 GUI 动态证据 |

## 接入分级（本仓落点）

1. **已落**（低代价）：level 边界（`gui-toolchain-smoke` 与 `gui-product-scenario` 分级，见
   [CAPABILITIES.md](CAPABILITIES.md)）、driver 能力/契约文档（本文）、
   **合成离线反例测试**（`packages/contracts/gui/midscene-report.mjs` + tests：空标题、
   Boolean=false、Assert=false、finished、exit0、缺报告、篡改冲突、重复快照去重——全部虚构数据）。
2. **pending**（中等代价）：live 工具链 driver（目标锁定、独立输出/退出码、生命周期、报告归一化、
   模型观测、版本锁定、消费者接线）。**未实现，无 live 命令，不声称已接入。**
3. **暂缓**：宣布产品 GUI/真机/安装包验收通过、并入默认质量门、自动 SIWC 凭据复制/授权、
   Jev/Windows 铺开。

## live driver 契约要点（实现时必须满足）

- **目标选择显式**：配方区分 shell 与 guest webview，声明预期 origin/URL、产品标识、目标类型、
  ready 条件；找不到或多候选都失败，禁止回落"第一个 HTTP page"。shell 截图像素不等于 guest
  DOM/交互上下文。
- **断言独立判定**：确定性 selector/可观察状态优先；`aiBoolean` 是模型探测值必须与期望比较，
  必需谓词 false 即失败；加载页/缺登录是前置未满足或阻塞，不静默降级为通过。
- **复用业务启动入口**：由消费者提供受信 launch/attach 配置，复用其 doctor/dev/产物 pin 规则；
  CDP 端口正常 ≠ 目标进程身份正确。
- **生命周期加固**：单一连接、finally 释放、明确自有进程树清理；外部附着应用不杀。
- **证据归一化**：仓外 attempt 专属结构化结果 + manifest（报告哈希、目标身份、场景版本、
  driver/模型版本、断言机制与实际值）；parser 按 taskId/callId 去重，finished/HTML 存在不当 passed；
  脱敏元数据与原始截图/日志分开，账号令牌禁入 runtime。
- **模型观测与预算**：driver 提供独立观测，缺失记 unknown；maxModelRequests 仅观测预算，
  硬限制需调用前计数并控制重试，否则只承诺 maxWallSeconds。
- **离线默认**：核心包测试用合成 fixture；真实 Midscene 依赖与 live 命令由消费者显式启用；
  不开全局 daemon、不动模型账号/默认服务、不自动 `model siwc login`。

## 报告字段定位（SDK 1.17.1 实测，非通用保证）

fixture 外壳与解析语义（身份合并键、终态冲突、usage 去重、安全默认失败）已在
`packages/contracts/gui/midscene-report.mjs` 按原评审第 6 节实现并有测试覆盖：
任务按 `(报告身份, data-group-id, execution.id, taskId)` 合并、usage 按
`(报告身份, data-group-id, _midscene_call_id)` 去重（含 `log.taskInfo.usage` 兼容副本不重复计数）、
`T.output` 类型不符/缺失不通过、finished 退回 running 与终态冲突均记异常、
只解析精确 `type=midscene_web_dump` 的惰性文本（不 eval、不执行 HTML、不访问报告内 URL）。
