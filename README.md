# nuwax-forge

独立验收：source-tooling、五包离线分发及 Nuwax client 的具名 GUI 场景通过。新增内置 token 预测与实耗对账，并接入执行前/步间拦截。最新见 [执行预算与浪费拆分验收](docs/EXECUTION-BUDGET-ACCEPTANCE-20261027.md)；GUI阶段见 [本次 GUI/token 验收](docs/CLIENT-GUI-TOKEN-ACCEPTANCE-20261027.md)；前期固定流程对比见 [原验收报告](ACCEPTANCE-REPORT.md)。

nuwax 全局效率方案的**可运行多包仓库**：把 2026-10-27 client-efficiency-pilot 验收通过的
stack / crew / kit 三条源码线（含未跟踪实现与 dot 配置）整编为 npm workspaces，并新增
共享契约包与统一 CLI。**本地预发布，不发布到任何 registry。**

文档唯一入口是本 README；细节见 [docs/](docs/)：
[架构](docs/ARCHITECTURE.md) · [能力分级](docs/CAPABILITIES.md) · [迁移与来源](docs/MIGRATION.md) ·
[试点基线数据](docs/PILOT-BASELINE.md) · [DSH/GUI 评审（脱敏）](docs/DSH-GUI-DRIVER-REVIEW.md) ·
[交付结果](IMPLEMENTATION-RESULT.md) · [Token 预算功能](docs/TOKEN-BUDGET.md) · [GUI 驱动用法](docs/MIDSCENE-LIVE.md)。

v3.0.26 修复场景实跑发现了环境变化后仍复用旧通过结论的问题；复现证据、验收边界和改进顺序见 [2026-10-29 实跑优化方案](docs/IMPROVEMENT-PROPOSAL-20261029.md)。该修复批次现调整为 v3.1.0，历史证据保留采集时版本标识。修复复用问题前相关验收应使用全新执行结果。

## 包

| 包（packages/） | npm 名 | 角色 |
|---|---|---|
| nuwax-stack | `@nuwax-ai/devkit-stack` | 任务状态、恢复、验收证据（Python skill 资源，含 scripts） |
| dashboard | `@nuwax-ai/devkit-dashboard` | 本地看板服务、数据适配器与 Web 客户端 |
| nuwax-crew | `@nuwax-ai/devkit-crew` | 有限调用路由与执行验收（Python 标准库） |
| nuwa-sdlc-kit | `@nuwax-ai/nuwa-sdlc-kit`（保留原名） | 仓内规则层 + 固定配方运行器（kit/VERSION 1.5.0） |
| contracts | `@nuwax-ai/devkit-contracts` | verification-v1 正本 schema、level 边界、GUI 合成 fixture 校验器 |
| cli | `@nuwax-ai/devkit-cli` | `nuwax-forge` 命令（doctor / init / verify / run / gui run / budget estimate / budget reconcile） |

要求：**Node >= 22，Python >= 3.10（标准库）**；npm 分发只携带 Python 源码，运行仍需本机 Python。
零外部依赖，无 Nx/Turbo/TS 构建。版本策略统一为 `X.Y.Z-devkit-local.N` 本地预发布；
CLI 对 5 个兄弟包用**精确同版本**依赖（workspace 内本地链接，tarball 消费者离线可装）。

## 快速开始（真实命令）

新远端：[nuwax-ai/nuwax-forge](https://github.com/nuwax-ai/nuwax-forge.git)。

```sh
cd nuwax-forge # 新 clone 目录；已有 checkout 继续使用原目录
npm install --ignore-scripts --offline --no-audit --no-fund   # 已验证：6 包本地链接
npm test                                                      # 全部工作区测试
npm run contracts:check                                       # 契约正本 ↔ stack 副本字节一致
npm run pack                                                  # 6 个 tarball 到新的仓外临时目录；--out 需选未使用目录
```

CLI（帮助 / 体检 / 接线 / 验收）：

```sh
node packages/cli/bin/nuwax-forge.mjs help
node packages/cli/bin/nuwax-forge.mjs doctor            # Node/Python 版本 + 6 包绑定；--json 输出 JSON
node packages/cli/bin/nuwax-forge.mjs init --project <外部项目> --recipe <仓内相对配方路径>
node packages/cli/bin/nuwax-forge.mjs client-verify --project <client项目> --state <仓外状态目录>
node packages/cli/bin/nuwax-forge.mjs verify --project <外部项目> --state <仓外状态目录> \
  --task-key <任务键> [--node <可信node绝对路径>] [--python <python解释器>] [--reuse]
```

- `init` 是显式 opt-in：调用 kit `verify:init`，只接线 verification，**保留既有 hook/profile**。
- `verify` 调用本安装 stack 的 `run_verification.py` 与同安装 crew-root；`--state` 强制仓外；
  桥接 JSON 透传，**进程 exit 0 不等于产品验收通过**（CLI 会核对 `passed=true`）。
- `client-verify` 仅接受绑定的 client-tooling 固定配方，每次使用全新任务键，零内部模型调用；
  标准输出为短 JSON（含测试计数、doctor 就绪状态、TaskStore 与证据索引），完整日志和工件在仓外 state。
  需已有配方及 runner；它验证源码工具链，不代表产品构建、GUI、发布包或真机通过。
- 未知/缺值参数一律拒绝。doctor 不联网、不授权、不启动应用、不改全局。

## 有限执行、GUI 与 token 预算入口

```sh
# 显式有限派工：模型任务必须有预算与上下文声明
node packages/cli/bin/nuwax-forge.mjs run --plan <plan.json> --project <项目> --state <仓外目录> --brief-file <有限交接.txt>
# 显式附着已授权的本机 CDP；SDK、Puppeteer、登录和模型环境需提前就绪
node packages/cli/bin/nuwax-forge.mjs gui run --recipe <场景.json> --state <仓外目录> \
  --budget-spec <任务预算.json> --cdp http://127.0.0.1:19222 --sdk <Midscene包目录> --runtime <Puppeteer包目录> --budget-spec <预算.json> --json
node packages/cli/bin/nuwax-forge.mjs run --plan <plan.json> --project <工作目录> --state <仓外目录> --brief-file <有限正文.txt>
node packages/cli/bin/nuwax-forge.mjs budget estimate --spec <任务预算.json> --out <预测.json> --json
node packages/cli/bin/nuwax-forge.mjs budget reconcile --estimate <预测.json> --actual <GUI-manifest.json> \
  --history <校准.jsonl> --out <对账.json> --json
```

`budget` 自身离线、0 次模型调用；提供区间、unknown、预算判断和历史校准。它是估算与复核工具，
不是模型供应商硬配额控制器。`run` 与 `gui run` 的模型执行必须通过预测 HIGH 及上下文界限；缺失、未知或超限会在启动前阻断。串行步骤共享余额，实耗未知阻断下一步；同 taskKey 首版只允许一次实际 attempt，不自动返修续跑。GUI driver 使用独立契约，不把 GUI 证据冒充 source-tooling TaskStore 完成。
真实 `run`/`gui run` 已接执行前 HIGH 预算与自动结算；crew 多步共享额度，unknown 阻断后续模型步骤。新 `run` 要求显式 model/no-model 声明，旧 Python 未声明命令标 legacy-unmanaged；详见 [执行预算契约](packages/cli/lib/budget/README.md)。

## 边界（如实）

- source-tooling 固定流程可复用；GUI 动态证据默认不复用。真实通过范围是 macOS 已安装 Nuwax 3.0.23 的首页草稿输入、视觉确认与清空恢复；三次正向样本及一次失败对照见验收报告。
- Midscene 是显式可选运行时；默认 install/test/pack 不安装 SDK、不调用模型、不打开应用。当前支持附着，`--launch-config` 明示 unsupported。
- client CDP 配置代码已加入源码，默认关闭、只允许本机、重启生效。当前已安装包尚未包含该源码；本次真实验证临时使用启动参数，用后已恢复并关闭端口。
- client 全量测试的前期基线存在 5 项既有失败；本次没有进行产品构建、发布、跨机器或 Windows/Linux 产品验收。重复产品构建仍是 0→0，不能声称构建提速。
- 新仓为本地多包预发布，无 commit、无 remote；本次未发布 registry。源仓仅含用户明确接受的 client CDP 诊断开关改动，其余业务改动不属于本任务。
