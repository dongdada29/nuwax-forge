# nuwax-forge

Nuwax Forge 提供有预算和短上下文约束的有限 Agent 执行、原版 DS-Bot 长期团队，以及本地任务与用量看板。Stack / Crew / Kit 保持内部模块；Bot 的持久身份与一次 Forge Worker 执行分别管理。当前为六包 npm workspace，包版本仍采用本地预发布版本号。

当前文档入口：[文档导航](docs/README.md) · [架构](docs/ARCHITECTURE.md) · [能力与验收边界](docs/CAPABILITIES.md)。

- 使用 Bot：[启动指引](docs/BOT-QUICKSTART.md)、[接入与验收汇总](docs/BOT-INTEGRATION.md)、[Bot → Forge 工具桥](docs/BOT-FORGE-BRIDGE.md)。
- 有限执行与看板：[Agent 适配](docs/CLIENT-AGENTS.md)、[Token 预算](docs/TOKEN-BUDGET.md)、[DSH 看板](docs/DSH-DASHBOARD-INTEGRATION.md)、[Personal Agent 只读快照](docs/PERSONAL-AGENT-ADAPTER.md)。
- 安装与验证：[离线安装](docs/INSTALLATION.md)、[集成测试入口](docs/INTEGRATION-TESTS.md)。早期试点数据和旧版改进提案归入[历史文档索引](docs/archive/README.md)，仅代表采集时的版本与环境。

## 包

| 包（packages/） | npm 名 | 角色 |
|---|---|---|
| nuwax-stack | `@nuwax-ai/devkit-stack` | 任务状态、恢复、验收证据（Python skill 资源，含 scripts） |
| dashboard | `@nuwax-ai/devkit-dashboard` | 本地看板服务、数据适配器与 Web 客户端 |
| nuwax-crew | `@nuwax-ai/devkit-crew` | 有限调用路由与执行验收（Python 标准库） |
| nuwa-sdlc-kit | `@nuwax-ai/nuwa-sdlc-kit`（保留原名） | 仓内规则层 + 固定配方运行器（kit/VERSION 1.5.0） |
| contracts | `@nuwax-ai/devkit-contracts` | verification-v1 正本 schema、level 边界、GUI 合成 fixture 校验器 |
| cli | `@nuwax-ai/devkit-cli` | `nuwax-forge` 统一入口：安装诊断、验收、有限执行、预算、Bot 团队和看板 |

要求：**Node >= 22，Python >= 3.10（标准库）**；npm 分发只携带 Python 源码，运行仍需本机 Python。
核心六包使用仓内依赖，不引入 Nx/Turbo/TS 构建。DS-Bot、DSH 和可选 GUI 运行时需单独准备。版本策略统一为 `X.Y.Z-devkit-local.N` 本地预发布；
CLI 对 5 个兄弟包用**精确同版本**依赖（workspace 内本地链接，tarball 消费者离线可装）。

## 快速开始（真实命令）

新远端：[dongdada29/nuwax-forge](https://github.com/dongdada29/nuwax-forge.git)。

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
  --budget-spec <任务预算.json> --cdp http://127.0.0.1:19222 --sdk <Midscene包目录> --runtime <Puppeteer包目录> --json
node packages/cli/bin/nuwax-forge.mjs budget estimate --spec <任务预算.json> --out <预测.json> --json
node packages/cli/bin/nuwax-forge.mjs budget reconcile --estimate <预测.json> --actual <GUI-manifest.json> \
  --history <校准.jsonl> --out <对账.json> --json
```

`budget` 自身离线、0 次模型调用；提供区间、unknown、预算判断和历史校准。它是估算与复核工具，
不是模型供应商硬配额控制器。`run` 与 `gui run` 的模型执行必须通过预测 HIGH 及上下文界限；缺失、未知或超限会在启动前阻断。串行步骤共享余额，实耗未知阻断下一步；同 taskKey 首版只允许一次实际 attempt，不自动返修续跑。GUI driver 使用独立契约，不把 GUI 证据冒充 source-tooling TaskStore 完成。
真实 `run`/`gui run` 已接执行前 HIGH 预算与自动结算；crew 多步共享额度，unknown 阻断后续模型步骤。新 `run` 要求显式 model/no-model 声明，旧 Python 未声明命令标 legacy-unmanaged；详见 [执行预算契约](packages/cli/lib/budget/README.md)。

## 边界（如实）

- source-tooling 固定流程可复用；GUI 动态证据默认不复用。Nuwax 3.0.23 的具名 GUI 场景属于 2026-10-27 历史样本，不能代表当前客户端或发布包验收，见[历史记录](docs/archive/README.md)。
- Midscene 是显式可选运行时；默认 install/test/pack 不安装 SDK、不调用模型、不打开应用。当前支持附着，`--launch-config` 明示 unsupported。
- Bot 的真实宿主和本地模拟 provider 路由已验证；记忆与群协作有原生模块契约证据。真实模型自主调用、完整群详情布局和系统默认浏览器启动仍未验，见 [Bot 汇总](docs/BOT-INTEGRATION.md)。
- Bot → Forge 桥仅提供 prepare/status；PA 接入仅展示操作者导出的本地快照。任务、审批、恢复和人工交付仍由原系统管理。
- 2026-11-04 主线基线 `c5327dd` 的[远程 CI](https://github.com/dongdada29/nuwax-forge/actions/runs/41788073227) 已通过测试、契约校验与打包。这不代表已升级用户安装、部署平台或完成产品/跨平台验收；缺失用量仍为 unknown，预算不提供供应商 token 硬上限。
