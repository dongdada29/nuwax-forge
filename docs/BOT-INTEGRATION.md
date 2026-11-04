# DS-Bot 接入切片

Forge 通过真实 DeepSeek Harness (DSH) 的插件管理器组合原版 DS-Bot，提供一个独立、可检查、可显式启动的 Bot 团队。入口暂时为 `packages/cli/lib/bots/entry.mjs`，尚未接入公共 CLI、Dashboard 或 personal-agent。没有复制 Bot 引擎、Cordis runtime、任务系统、SSH 层或 Electron 外壳。

Bot 是持久身份：Chief 管理团队，每个 Bot 的模型、Session、记忆和群成员关系由原 DS-Bot 保存。Forge Worker 仍是一次有界执行；本切片没有让 Bot 自动派 Worker，也没有新增审批通道。后续接线须复用 personal-agent 的用户任务和审批，才能把 Bot 请求转成 Forge 执行，不能把持续对话等同于一次任务。

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

node packages/cli/lib/bots/entry.mjs plan --root "$FORGE_BOT_ROOT" --dsh "$FORGE_DSH_BINARY" --json
node packages/cli/lib/bots/entry.mjs prepare --root "$FORGE_BOT_ROOT" --dsh "$FORGE_DSH_BINARY" --json
node packages/cli/lib/bots/entry.mjs check --root "$FORGE_BOT_ROOT" --dsh "$FORGE_DSH_BINARY" --json
node packages/cli/lib/bots/entry.mjs run --root "$FORGE_BOT_ROOT" --dsh "$FORGE_DSH_BINARY"
```

`run` 在前台运行真实 DSH web app，固定绑定 `127.0.0.1`，默认端口 `0` 由系统分配，也可显式传 `--port 3081`。宿主输出自己的本地访问链接；打开该链接进入原 DS-Bot 界面。Ctrl-C 停止宿主，团队数据保留，可用同一命令重启。此入口不自动打开浏览器，不发送消息，不创建 provider；新团队的 Chief 等待选择模型。用户在原界面配置自己的模型后，原插件的问候和后续操作可能调用模型，需单独完成体验验收。

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

## 可重复验收

默认测试不下载、不安装、不运行模型；真实宿主测试显式开启，使用全新临时 root 并在退出后清理。

```sh
node --test packages/cli/test/bots-*.test.mjs

FORGE_BOT_TEST_DSH='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' \
FORGE_BOT_TEST_TARBALL=/absolute/path/ds-bot-0.2.7.tgz \
node --test packages/cli/test/bots-*.test.mjs
```

2026-11-04 本机实测 DSH `0.2.1-rc.5`：8 项测试通过，包含真实宿主集成测试。真实测试用原生令牌换取会话 cookie，仅在内存中使用；只输出布尔值和计数。

| 层次 | 已观察证据 | 仍未证明 |
| --- | --- | --- |
| 安装/组合 | 固定归档 SRI、7 个原文件 hash、web+bot bundle、启用的原入口、独立数据路径 | 其它 DSH/DS-Bot 版本兼容性 |
| 真实宿主/客户端 | 原 DSH 启动；HTML 模块目录发现 `ds-bot`；原编译客户端 HTTP 200；无 cookie 的 Bot 请求 HTTP 401 | 浏览器渲染、交互布局和模型配置卡的视觉体验 |
| Chief/持久身份 | 原 `/api/bot` 返回 Chief、`waiting=true`、无模型；两个 Bot 各有不同 Session；重启后 IDs 保留 | 不同模型路由的实际回答 |
| 群数据 | 原 API 创建 3 成员群，Chief 为 admin、`mode=admin`；重启后群保留；不存在成员被拒绝 | admin-first 发言顺序、`@` 点名及并行派发 |
| 记忆读取边界 | 两 Bot 面板分别返回 own/team，群仅返回 group；不存在 Bot 被拒绝 | 写入/回读隔离、自动审查、跨 Bot 私有权限及重启后的非空记忆 |
| 失败对照 | 错误宿主版本、破损归档、禁用原入口、目录重定向、无认证及无效对象均拒绝 | 模型或工具运行时故障恢复 |

真实测试确认没有可用模型、所有 Bot 问候保持等待，未发送任何消息。原用户 API 的 `memory-ask` 会调用模型，测试没有调用它，也没有直接改记忆文件来代替产品路径。`modelCallsRequested=0` 表示测试没有请求模型调用，并非模型费用审计结果。完整验收仍需用户授权模型后，实际建模配置、消息、记忆写读、群管理与 `@` 调度。
