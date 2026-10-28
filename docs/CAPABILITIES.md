# 能力与验收边界

最新执行预算与拆分证据：[执行预算验收](EXECUTION-BUDGET-ACCEPTANCE-20261027.md)。

GUI阶段结论与证据入口：[2026-10-27 client GUI/token 验收](CLIENT-GUI-TOKEN-ACCEPTANCE-20261027.md)。
原 source-tooling 对比保留在 [前期报告](../ACCEPTANCE-REPORT.md) 与 [试点基线](PILOT-BASELINE.md)。

| 能力 | 当前范围 |
|---|---|
| stack / crew / kit | 任务证据、有限执行器路由、固定配方执行及 source-tooling 复用 |
| CLI / contracts | doctor/init/verify，契约与路径边界校验，五包离线分发 |
| 可选 Midscene live driver | `gui run`，本机 CDP 附着，显式 shell/guest 选择，确定性操作及 AI 断言交叉核对，仓外工件 |
| 真实产品 GUI | macOS 已安装 Nuwax 3.0.23 的首页草稿输入、视觉核对、清空恢复；3 次正向通过，1 次 false 反例正确失败 |
| 内置 token 预算 | `budget estimate/reconcile` 离线零模型调用；真实 `run`/`gui run` 执行前 HIGH guard、crew 多步共享余额、有限 context manifest、自动实耗复核 |
| client CDP 配置 | 源码默认关闭、只准 127.0.0.1、重启生效；17 项单测通过，尚未打入安装包验收 |

## 验证 level

| level | 机器状态 | 能声明什么 |
|---|---|---|
| source-tooling | implemented | 固定源码/脚本验收及与输入指纹绑定的证据复用 |
| gui-toolchain-smoke | optional-live-driver | CDP/截图/模型/报告链路可用 |
| gui-product-scenario | optional-live-driver | 记录身份、时间和登录前提下的具名产品谓词成立 |

GUI 使用独立 `gui-verification-v1`，不导入旧 TaskStore；`verify` 仍只放行 source-tooling。
false、空报告、未知观测、恢复失败或预算超限均不得标记 passed；finished 和进程 exit 0 不代表产品验收。
缺失缓存与失败请求的 token 保留 unknown，不能假报为零。GUI 动态证据默认不复用。

## 运行环境与分发

核心五包无 Midscene 外部依赖；默认 install/test/pack 离线，不访问模型、不打开应用。
可选 GUI 运行时须显式指定已有 SDK/Puppeteer、认证和本机 CDP；当前 `--launch-config` 为 unsupported。
驱动只断开外部应用连接，硬超时清理其自有驱动进程组。详见 [用法](MIDSCENE-LIVE.md)。

本地预发布五包无 commit/remote，未发布 registry；远程 CI 未运行。
真实 GUI 的 client 安装包是既有包，不等于新 CDP 源码的整包验收。

## 尚未证明的指标

- 新 GUI 无同场景旧流程 A/B，不能声称 GUI 提速或 token 降幅。
- 产品构建/重复构建 0→0，未证明构建缓存收益；前期 client 全套测试仍有既有失败。
- `run`/`gui run` 已强制声明的模型任务先通过 HIGH 预算；旧 Python 未声明任务仍 legacy-unmanaged，不声称全量治理。仅前置/步间边界，不自动切账号或模型，未接供应商内部硬 token 上限。见 [执行预算](../packages/cli/lib/budget/README.md)。
- 样本量小，视觉 token 为显式宽假设；历史预测准确度不等于稳定生产分位数。
- 本次 Claude Code 为真实执行器；omp/agy/cursor/dsh/zcode 适配、DSH 替换 TaskStore、跨机及 Windows/Linux 新安装包未验。
- 编排、返修、审核的一次性成本另列；不能把固定脚本的零模型调用描述成整个开发过程零 token。

契约正本位于 `packages/contracts`；task/runtime v2 运行时以 crew 校验器为准；kit 引擎为 1.5.0。
