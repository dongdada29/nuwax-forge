# DS-Bot 接入与验收汇总

状态核对：2026-11-04，main `c5327dd` 已包含本页汇总的 Bot 接入、公共入口、工具桥及专项测试。首次使用见 [BOT-QUICKSTART.md](BOT-QUICKSTART.md)，全仓文档见[导航](README.md)。

Forge 通过真实 DeepSeek Harness (DSH) 的插件管理器组合原版 DS-Bot，提供独立、可检查、可显式启动的 Bot 团队。公共入口为 `nuwax-forge bots plan|prepare|check|run`；独立入口 `packages/cli/lib/bots/entry.mjs` 保留。Bot 身份、群、模型、Session 和记忆仍由原 DS-Bot 管理。

Bot 是持久身份，Forge Worker 是一次有界执行。[Bot → Forge 桥](BOT-FORGE-BRIDGE.md) 已提供原生 prepare/status 工具，需操作者单独配置，不随 `bots prepare/run` 自动启用；未开放 run/approve/reconcile 工具。已有 [DSH 看板插件](DSH-DASHBOARD-INTEGRATION.md) 展示 Forge 任务，[PA 快照适配](PERSONAL-AGENT-ADAPTER.md) 只读显示原任务与交付。这些分别可用的入口不构成 Bot → PA → Forge 的完整自动业务链；原任务、审批与恢复仍由原系统管理。

## 固定来源

| 项目 | 固定值 |
| --- | --- |
| DS-Bot | npm `ds-bot@0.2.7`，Apache-2.0 |
| 上游提交 | [`71d344bf193f3f18185f25de3d8e5c483046910a`](https://github.com/Fei2411/DS-Bot/tree/71d344bf193f3f18185f25de3d8e5c483046910a)；npm 元数据的 `gitHead` 与之相同 |
| npm 归档 | [原始 tarball](https://registry.npmjs.org/ds-bot/-/ds-bot-0.2.7.tgz)，下载后安装前校验 SHA-512 SRI，见 `lib/bots/pin.mjs` |
| 真实宿主 | DSH `0.2.1-rc.5`；版本不符时拒绝安装/启动 |
| 宿主参考 | [DSH 固定提交的 CLI 插件操作](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/apps/cli/src/plugin.ts) |

原包声明 `main: index.js`、`dsh.bundle.patch: ./cordis.patch.yml`、`dsh.client.platform: web`、`./client: ./client.js`，依赖 `deep-view@0.1.0`。DSH 提供其 Cordis、llm、scope、tools、web peer 服务。`prepare` 直接调用 `dsh plugin --profile forge-bots add <已校验的原始tgz>`，由宿主自动把 bundle 纳入 profile；Forge 不在自身进程里加载插件。安装禁用生命周期脚本，运行检查会核对原 host、编译客户端、bundle 以及四个核心模块的 SHA-256。

复用原功能的拥有者均在上游固定提交：

- [roster.js](https://github.com/Fei2411/DS-Bot/blob/71d344bf193f3f18185f25de3d8e5c483046910a/ds-bot/src/host/roster.js)：Chief、Bot 身份及各自 DSH Session。
- [tools.js](https://github.com/Fei2411/DS-Bot/blob/71d344bf193f3f18185f25de3d8e5c483046910a/ds-bot/src/host/tools.js)：Main Bot/群管理员权限与 Bot 工具。
- [groups.js](https://github.com/Fei2411/DS-Bot/blob/71d344bf193f3f18185f25de3d8e5c483046910a/ds-bot/src/host/groups.js)：群、admin-first、`@Name` 和群内独立 Session。
- [memory.js](https://github.com/Fei2411/DS-Bot/blob/71d344bf193f3f18185f25de3d8e5c483046910a/ds-bot/src/host/memory.js)：Bot/群/团队三个记忆范围与持久化。
- [SECURITY_MODEL.md](https://github.com/Fei2411/DS-Bot/blob/71d344bf193f3f18185f25de3d8e5c483046910a/SECURITY_MODEL.md)：原权限、私有 Bot、文件夹和秘密边界。

上游 [README](https://github.com/Fei2411/DS-Bot/blob/71d344bf193f3f18185f25de3d8e5c483046910a/ds-bot/README.md) 声明测试宿主为 `0.2.1-rc.5`。这些功能声明不代表 Forge 已完成对应产品验收。

## 准备和启动

在仓库根目录运行，Node >=22。下面的 `team-demo` 必须是尚不存在的新目录；父目录需已存在。`plan` 不写文件，不运行宿主。

```sh
mkdir -p "$HOME/.local/share/nuwax-forge/bots"
FORGE_BOT_ROOT="$HOME/.local/share/nuwax-forge/bots/team-demo"
FORGE_DSH_BINARY='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'

node packages/cli/bin/nuwax-forge.mjs bots plan --root "$FORGE_BOT_ROOT" --dsh "$FORGE_DSH_BINARY" --json
node packages/cli/bin/nuwax-forge.mjs bots prepare --root "$FORGE_BOT_ROOT" --dsh "$FORGE_DSH_BINARY" --json
node packages/cli/bin/nuwax-forge.mjs bots check --root "$FORGE_BOT_ROOT" --dsh "$FORGE_DSH_BINARY" --json
node packages/cli/bin/nuwax-forge.mjs bots run --root "$FORGE_BOT_ROOT" --dsh "$FORGE_DSH_BINARY" --open
```

`run` 在前台运行真实 DSH web app，固定绑定 `127.0.0.1`，默认端口 `0` 由系统分配，也可显式传 `--port 3081`。宿主输出自己的本地访问链接；打开该链接进入原 DS-Bot 界面。仅显式加 `--open` 才调用系统默认浏览器，失败时保留前台宿主并提示手动打开。Ctrl-C 停止宿主，团队数据保留，可用同一命令重启。入口不发送消息、不创建 provider；新团队的 Chief 等待选择模型。原 UI 建群会尝试自动问候，无 Key 时被缺凭据阻断；配置模型后问候和后续操作可能调用模型。

源码检出先按[启动指引](BOT-QUICKSTART.md)绑定本地 workspace 包。已安装且包含此功能的 CLI 可用 `nuwax-forge bots <子命令> ...`；独立入口为 `node packages/cli/lib/bots/entry.mjs <子命令> ...`，两种入口复用相同严格参数校验。源码已合并不等于原有安装自动升级。

已有原始 npm 归档时，可给 `prepare` 加 `--tarball /absolute/path/ds-bot-0.2.7.tgz`。该文件仍必须通过同一固定 SRI；此选项只避免 DS-Bot 归档下载，DSH 插件管理器解析/安装依赖仍可能需要网络。`prepare` 不会运行模型。

## 隔离和检查边界

每个 root 有自己的 `forge-bots.json` 所有权标记与互斥锁。既有普通目录、既有用户 HOME、全局 DSH profile 和符号链接重定向会被拒绝。`prepare` 可在本入口创建的目录内重试；ready 后仅复查，不重建或重置团队。不要删除标记来让入口接管其它目录。

| root 内路径 | 用途 |
| --- | --- |
| `home/`、`agents/` | 子进程 HOME 与独立 Agent 目录 |
| `dsh/profiles/forge-bots/` | 从原 web 模板创建的自定义 profile、原插件依赖及 lockfile |
| `dsh/` | DSH Session、存储、用户在此实例中配置的凭据 |
| `team/` | 原 DS-Bot 团队、群与记忆数据 |
| `workspace/` | 默认 Bot 工作目录 |
| `artifacts/` | 固定原始 npm 归档 |
| `cache/`、`state/`、`config/`、`pnpm/`、`tmp/` | 包管理、XDG、临时文件与独立 npm 配置 |

子进程环境只继承 PATH、语言/终端和必要系统启动变量，显式替换 HOME、DSH_HOME、DSH_AGENTS_HOME、XDG、npm/corepack/pnpm 路径。provider keys、token、Node 注入参数及其它 DSH 环境不会继承。pnpm 的 store/cache/state 也显式指向 root，避免 macOS 默认落到用户 Library。没有读取、迁移或输出原有凭据。

原 `bot` 和 `web-search-auto` 入口保持启用，记忆保持启用；自动更新检查关闭以保持版本固定。保留宿主原生 workspace-write/ask 权限流程，不设置全访问或自动同意。检查会拒绝版本变更、原入口禁用、核心文件变更，以及 Bot home/workspace 逃出 root。原模型配置可在这个实例的原界面中设置；原插件仍可按其权限请求其它工作目录，本入口不是额外的 OS 沙箱。

`check` 使用 DSH 自己的 `--dump-config` 验证组合结果，并且不回显完整配置。它未挂载 web 宿主，结果中 `host`、`ui`、`modelBehavior` 始终为 `not-run`。启动令牌、cookie 不写入 Forge 报告。插件安装失败时只返回原生诊断文件路径，位于该 root 下。

若进程被强制杀死而留下 `.forge-bots-lock`，先确认本 root 的宿主已完全退出，再移除此单个锁目录；入口不会替用户抢锁或终止其它实例。

## 验收状态与复验

以下是 2026-11-04 本批验收的范围汇总；默认测试、fixture、真实宿主与真实模型分别解释，不将任一层等同于全部产品通过。

| 层次 | 已观察证据 | 仍未证明 |
| --- | --- | --- |
| 安装/配置组合 | 固定归档 SRI、7 个核心文件 hash、启用的原入口、独立数据路径 | 其他 DSH/DS-Bot 版本兼容性；用户既有安装已升级 |
| 真实宿主/原客户端 | 原客户端 HTTP 200、未认证请求 401、原 API 身份/群持久化；原生链接捕获、SIGINT 停止与解锁 | 系统默认浏览器实际打开、跨平台生命周期 |
| 原生浏览器操作 | Chief 等待卡、模型设置、新建 Bot/群、群详情控件与 @ 候选可访问 | 完整群详情面板布局、移动布局、真实模型交互；见[启动指引记录](BOT-QUICKSTART.md) |
| 真实宿主模型传输 | 两个 Bot 绑定不同本地模拟模型，经原 API 发送并从原 chat 回读对应回复，私聊标记未串路由 | 付费 provider、推理/工具选择、模型语义；见[provider 专项](BOT-PROVIDER-HOST-ACCEPTANCE.md) |
| 原生记忆 + fixture 服务 | 非空 own/team/group、私有权限、角色/成员拒绝、独立 home、journal、正常关闭后的跨进程回读 | 真实 DSH 非空面板、memory-ask、模型提取/总结/审查、崩溃恢复；见[记忆专项](BOT-MEMORY-ACCEPTANCE.md) |
| 原生群路由 + fixture 服务 | 成员独立 Session/模型、admin-first、@ 并发/去重、Bot 回复派发与权限拒绝 | 真实 DSH 完整循环、真实模型群协作与信息分享行为；见[群专项](BOT-GROUP-ROUTING-ACCEPTANCE.md) |
| Bot → Forge 桥 | 12 项离线测试；真实 Cordis/tools 注册、prepare/status、guard、取消及卸载 | Chief 自主选择工具、聊天业务端到端；见[工具桥](BOT-FORGE-BRIDGE.md) |

群成员的 Session 独立，但首次群提示会注入该成员自己的私聊摘要。fixture 没有观察到直接读取其他 Bot 私聊；不能由此推断真实模型不会复述自身信息。该语义与记忆工具的私有权限测试分别判断，见群专项的完整调用链。

默认无 opt-in 环境变量时，下列命令不下载、不安装、不运行宿主或模型；需要真实宿主的项明确跳过：

```sh
node --test packages/cli/test/bots-*.test.mjs
```

完整复跑本批 Bot 证据需显式提供真实 DSH 和固定原始 npm 归档。`FORGE_BOT_ROUTING_TARBALL` 启用群模块契约，`FORGE_BOT_TEST_PROVIDER_HOST=1` 启用真实宿主到本地模拟服务的传输；仅设置 DSH 变量并不会启用全部专项。

```sh
FORGE_BOT_TEST_DSH='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' \
FORGE_BOT_TEST_TARBALL=/absolute/path/ds-bot-0.2.7.tgz \
FORGE_BOT_ROUTING_TARBALL=/absolute/path/ds-bot-0.2.7.tgz \
FORGE_BOT_TEST_PROVIDER_HOST=1 \
node --test packages/cli/test/bots-*.test.mjs
```

2026-11-04 组合验收：上述 Bot 测试 27/27；另含记忆子进程 8/8。追加 `packages/cli/test/dashboard-personal-agent.test.mjs` 的 Bot/PA 检查为 28/28；全量 CLI 132 通过、15 项按默认边界跳过。这些是本批基线记录，不是每次运行应固定不变的计数。主线 `c5327dd` 的[CI](https://github.com/dongdada29/nuwax-forge/actions/runs/41788073227) 已通过测试、契约校验和打包；文档整理未重跑模型或产品验收。

真实宿主测试使用全新临时 root，启动令牌和 cookie 仅在内存中使用，结束停止自建实例并清理。显式原生测试的依赖安装仍可能联网。固定 fixture 的 usage 数字不作费用证据，完整真实用量未知时仍记 unknown。

原无模型 API 测试没有发送消息，`modelCallsRequested=0` 仅适用于那组测试。原 UI 建群会尝试自动问候，缺凭据时被 `MISSING_CREDENTIAL` 阻断；本地 provider 测试也实际产生模拟模型请求，均不能套用零请求结论。真实模型验收还需在获授权的独立实例中完成对话、工具选择、记忆与群协作。
