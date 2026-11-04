# Bot 真实场景验收（2026-11-04）

本次从 main `d7f80024d54f668365b6b537422ec5c69b3ac098` 开始，仅使用全新独立 root。固定 DSH `0.2.1-rc.5`、原版 `ds-bot@0.2.7` 与既有 SRI 校验；没有复制旧 profile、凭据或用户聊天。此前的[模块与模拟 provider 证据](BOT-INTEGRATION.md) 保持原有范围，本报告不把它们改写为真实模型通过。

## 真实模型接入前置

`scripts/bot-real-preflight.mjs` 创建全新临时团队，使用原宿主认证，在内存中调用原 Bot `state` / `providers` 与原生 `account/getState` 元数据接口，再停止自建宿主并删除临时目录。它不发送消息、不创建 provider、不读取旧授权文件；输出仅包含固定字段的布尔值、计数与账号状态枚举，不打印原生访问令牌、cookie、key、provider 错误或原始响应。

```sh
node scripts/bot-real-preflight.mjs \
  --dsh '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' \
  --tarball /absolute/path/ds-bot-0.2.7.tgz
```

此脚本在源码仓运行；显式准备依赖仍可能访问包仓库。它不接收既有 root、凭据或发送消息的参数；无参数只显示帮助。

本机实测结果：

| 字段 | 观察 |
| --- | --- |
| DSH / DS-Bot | `0.2.1-rc.5` / `0.2.7` |
| 团队 | 1 个 Bot，Chief 等待选择模型 |
| 目录中的模型 / 未标 needsKey 的模型 / 已选 Bot 模型 | 0 / 0 / 0 |
| 已配置 provider key | 0 |
| 原生账号状态 / 本地账号 grant | `signed-out` / 不存在 |
| 原生 provider 设置接口 | 可用 |
| 脚本主动发送的模型消息 | 0 |
| 真实模型验收 | 未运行，需在独立实例中完成模型设置 |
| 真实费用与完整用量 | unknown；不是供应商费用审计 |

`modelMessagesSent=0` 只描述此脚本没有发消息，不是全宿主网络调用审计。目录是启动时刻的元数据；脚本始终返回 `authorization=not-validated`，不会根据 needsKey 缺省或 key 存在认定模型授权成功。临时团队在退出时删除，不能在这个已退出的实例里继续登录；真正授权时需另建并保留待用实例。

## 需要的授权与输入

用户可选择以下任一路径，在待用的新实例原生界面完成设置，勿把 key 发到聊天或写入仓库：

1. **DeepSeek 账号**：在新实例 Account 页面点击 Sign in，通过系统浏览器完成该实例的授权。原生流程使用 PKCE/state，经 callback 与 token exchange 把新 grant 提交给当前实例。浏览器已有登录可能减少手动步骤，但不等于新 HOME 已获授权。
2. **自定义 provider**：提供协议（`openai-completions`、`openai-responses` 或 `anthropic-messages`）、baseURL、至少一个 model ID，并由用户在新实例原生表单输入所需 key。不要假设省略 key 就能访问供应商。

未发现已证实可跨 HOME 委托原账号的入口。凭据组件的可配置文件路径只是存储重定向，不是授权机制，本验收没有指向旧 store。Forge 的隔离环境不继承旧 DSH_HOME、HOME 或 provider keys。

原生 `POST /api/account/getState` 返回的 `signed-out` / `credential-stored` 只反映当前实例的本地账号记录。预检只取状态与 `accountGrantStored` 布尔值；即便记录存在，也不等于供应商已验证有效或有可用额度。

选择模型会释放 Chief 等待中的问候；自动记忆审查默认开启。因此“授权并选模型”可能已经产生模型请求，不能描述成零调用准备。真实实验开始前还需核实该实例的实际授权、选定模型，并明确允许首次问候和实验请求及可接受用量；本轮尚未验证独立实例具备可调用的模型授权，未进入此步骤。

## 调用与预算限制

不能用“一次 UI 操作等于一次模型调用”规划费用：原 `memory-ask` 可按 2048 → 8192 输出参数重试，再回退默认 route，单个操作最多进入四次 `llm.stream`；每次使用 120 秒信号。后台审查、工具循环和解析不构成整个操作固定 480 秒的保证。

provider 的 `maxTokens` 是默认值，可被请求显式输出参数覆盖；关闭 provider retry 也不会取消记忆模块自身的重试、工具后的下一步或群调度。目前公共 Bot 启动入口没有全局模型调用数上限。外部墙钟监护可以停止自建实例，但不能撤销已发请求或承诺供应商停止收费。

若下一轮要求严格一次调用或总 token 硬限制，须先验证覆盖全部相关 `llm.stream` 路径的准入约束，或选用已证明可控的单请求产品路径。不能以设置 provider 默认输出参数代替这一证明。当前没有运行真实模型、无限重试或基准跑分。

## 源码审查依据

下列安装版模块来自 DSH `0.2.1-rc.5` 的 `app.asar/dsh/node_modules/@deepseek-ai/`；行号只适用于本次安装版快照。审查仅阅读代码，没有打开现有凭据或聊天数据。

| 判断 | 代码位置 |
| --- | --- |
| 新实例原生 PKCE 登录与 grant 提交 | `dsh-deepseek-account-platform/lib/types/index.js` 的 `startSignIn`（374、507–601）；`dsh-client-ui-settings-account/lib/client.js:4671` 使用当前窗口 origin |
| 原生只读账号状态，无 grant 值进入报告 | `dsh-api-account-controller/lib/typert.host.js:385–398`、`lib/types/index.js:81–89`；`dsh-deepseek-account-platform/lib/types/index.js:131–142` |
| 凭据存储范围与显式 path | `dsh-credentials-local/lib/index.js:13–31、51–58`；Forge `packages/cli/lib/bots/profile.mjs:66–86` 的隔离环境 |
| 自定义 provider 原生输入与保存 | 固定 DS-Bot `src/host/providers.js:151–181`、`channel.js:203–215` |
| 记忆重试/输出与模型选择后问候 | 固定 DS-Bot `memory.js:52–56、1302–1349、471、2004`；`roster.js:233–250、419` |
| 请求参数优先于 provider 默认输出 | `dsh-llm-pi-ai/lib/index.js:1915–1922、1986`；`dsh-llm-deepseek/lib/index.js:1730` |

## 独立目录观察与对照

首次系统默认浏览器实验中，由公共 CLI 子进程启动链接确定的本机 origin，经原生令牌换 cookie 后，Node fetch 原 `state` 观察到 6 个未标 needsKey 的模型；Chief 仍 waiting、没有选择模型。没有点击登录、同意或模型，没有发消息；观察后立即停止该实例。该实验未采集浏览器打开前的状态，也未读取账号 getState，因此不能把目录状态归因于浏览器。

这些目录包括 `deepseek-account` 的两个型号与 `zai-coding-cn` 的四个型号。源码审查表明：Zai 内置目录可能在无 key 的情况下照常列出；DeepSeek account 适配器列出型号前会解析本地 grant，但 `/models` 失败仍可能回退内置目录，不能据此断言供应商授权有效。该次 grant 的来源未确定，停止后没有重启该 root 或读取凭据值，也没有据此调用模型。

第二个全新 no-open 对照实例在浏览器打开前后均为 0 模型，所有 Bot 等待且未选模型；同时 `.credentials.yaml` 文件已经存在。安装版 `dsh-client-connection/lib/index.js:273、391–433、1034` 会在宿主启动时初始化本实例 `client-connection/browser-session` 签名记录，足以解释文件创建，不能用文件存在认定模型凭据导入。另一个预检实例的原生账号状态为 signed-out。

一次未复现的目录观察不作为跨 HOME 授权可复用的依据，也不认定发生了浏览器自动授权或跨 Bot 数据访问。后续若需复查，应先比较新实例前后原生账号状态与配置来源，不读取或记录 grant 值。本轮保留该不确定项，未把它包装成真实模型通过。

## 无模型界面与浏览器

系统默认浏览器和布局分别使用新的独立 root；没有配置 provider、选择模型或发送用户消息。

| 场景 | 本次实际观察 | 边界 |
| --- | --- | --- |
| 系统默认浏览器 | macOS NSWorkspace 查询到 `ego lite.app`，真实公共 `bots run --open` 打开原生 Chief/预览说明页面；原生窗口截图已查看 | 不是 mock opener 或仅检查 open 进程退出；仅证明本机默认应用与该次页面加载，不代表其他默认浏览器或平台 |
| 完整群详情 | 新实例通过原 API 创建两成员群（`greet:false`），在隔离浏览器点击群详情；等待稳定后两次采样，1274×666 视口内 `aside.bt-panel` 为 x=954、y=0、width=320、height=666、right=1274、bottom=666，transform:none | 标题、成员、管理员、目标和记忆入口完整可见；上次裁切未复现，不据此声称已定位或修复缺陷；其他视口/移动布局未验 |
| 模型前置对照 | 布局实例在浏览器前后均无目录模型，最终 2 个 Bot 均 waiting 且无 model、1 个群 | 原 API 创建测试数据与原 UI 渲染分别说明；不是模型调度或对话验收 |
| 停止与锁 | 两次自建宿主均经 SIGINT 退出，退出码 130，root 锁释放；布局浏览器 Space 已关闭 | 既有用户实例与聊天未访问；不代表断电/崩溃恢复 |

本机工件位于 `/Users/apple/.codex/visualizations/2026/11/04/01a1a53d-5767-7082-90f3-e9cf547cae98/bot-real-ui/`。`result.json` 保存结构化观察，`group-details-stable.png` 已人工复看且不含访问令牌或凭据。系统默认浏览器页面当时通过原生窗口截图和匹配本 origin 的 Target 元数据观察，未保留该窗口截图文件。工件属于本机验收附件，不作为打包运行时资源。

最小复验脚本 `scripts/bot-real-ui-acceptance.mjs` 负责显式默认浏览器打开、前后原 API 计数和退出；完整布局仍以本次实际浏览器采样为准。该脚本的离线边界测试与上述手工真实执行分开报告，不将脚本存在当作每条现场操作已自动复跑。

脚本目前仅支持 macOS 默认浏览器为 `ego lite.app`，需要已安装 `ego-browser` CLI。root 和输出文件均必须是新路径；若默认应用不同应改用原生观察，不套用本脚本结论。它不配置模型或执行布局点击，默认模型目录基线不是空团队时会停止。该脚本本轮未再次实机执行，以免重复触发尚未解释的目录变化：

```sh
mkdir -p "$HOME/.local/share/nuwax-forge/acceptance"
node scripts/bot-real-ui-acceptance.mjs --open \
  --root "$HOME/.local/share/nuwax-forge/acceptance/new-team" \
  --dsh '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' \
  --tarball /absolute/path/ds-bot-0.2.7.tgz \
  --output "$HOME/.local/share/nuwax-forge/acceptance/new-report.json"
```

新预检和浏览器脚本的离线测试：

```sh
node --test packages/cli/test/bots-real-preflight.test.mjs packages/cli/test/bots-real-ui.test.mjs
```

5 项预检边界与脱敏测试、2 项浏览器脚本参数/元数据测试已通过。以本批源码运行全量 CLI 为 139 通过、15 项默认 opt-in 跳过、0 失败。真实 preflight 已实际运行并读到 signed-out；浏览器脚本本身的端到端自动复跑仍未验证，不能与上表实际手工页面观察混为一谈。

## 本轮结论

已补齐本机系统默认浏览器实际打开、1274×666 下完整群详情以及正常停止/解锁的证据。新预检通过原生接口确认其独立实例没有本地账号 grant；真实模型对话、模型记忆写读/重启回读、Chief 自主选择 Forge 工具仍未运行。下一步需要在待用的新实例完成原生授权或由用户配置 provider，并在考虑自动问候、记忆重试和后台审查后明确实验范围与停止条件。
