# 公共 Bot 入口组合 Forge 原生桥

`nuwax-forge bots prepare --forge-config /absolute/operator-config.json` 显式启用已有的 [Bot → Forge 原生桥](BOT-FORGE-BRIDGE.md)，自动初始化或核对桥状态根，并把固定插件 row 组合进隔离 Bot profile。默认 `bots prepare/check/run` 不加载桥。独立入口 `node packages/cli/lib/bots/entry.mjs` 使用同一参数解析与实现。

桥仍只有 `forge_status` 和 `forge_prepare`，复用原来的 Forge prepare、预算门和状态投影。Bot 没有 run、approve 或 reconcile 工具；prepare 返回给操作者的 `agent run` argv 不构成运行授权。这里没有新增任务库、审批库、后台服务或预算算法。

## 操作者流程

先按 [操作者配置与新状态根](BOT-FORGE-BRIDGE.md#操作者配置与新状态根) 创建完整 JSON。配置必须由操作者提供绝对文件路径，不能来自聊天/工具参数或环境变量；不能用符号链接代替文件。JSON 上限 256KiB，不包含凭据。以下能力全部在这份配置中固定：

- `schemaVersion: 1`、真实可信的 `nodeBinary`、`forgeRoot` 和其中的 `forgeEntry`。
- 独立的 `stateRoot`；其父目录已存在且使用规范路径。新根会调用既有 `initializeBridge`；以前通过旧 `setup.mjs` 初始化的根只有 marker 与同一配置完全匹配才可复用，任意已有目录不能被接管。
- 非空 `workspaces` 别名 allowlist，以及每个模板的真实工作区、可信 runtime、显式模型、`fresh-exec`、权限和一次尝试预算。`allowPrepare: true` 才允许准备；false 保留原桥的只读边界。

```sh
FORGE_DSH_BINARY='/absolute/trusted/dsh'
FORGE_BOT_ROOT='/absolute/private/new-bot-team'

nuwax-forge bots prepare \
  --root "$FORGE_BOT_ROOT" --dsh "$FORGE_DSH_BINARY" \
  --forge-config '/absolute/operator-config.json' --json

nuwax-forge bots check \
  --root "$FORGE_BOT_ROOT" --dsh "$FORGE_DSH_BINARY" --json

nuwax-forge bots run \
  --root "$FORGE_BOT_ROOT" --dsh "$FORGE_DSH_BINARY" --open
```

prepare 仍可传 `--tarball /absolute/ds-bot-0.2.7.tgz`，并执行原来的 npm SRI 与安装文件校验。`run` 是显式前台 DSH web host，Ctrl-C 停止；它不发送消息或派发模型。`--open` 沿用已有浏览器打开行为。

首次启用需要新 Bot root。已经 ready 且未绑定桥的旧 root 不能通过重跑 prepare 静默增加工具。已绑定 root 的 check/run/重复 prepare 无需再传 `--forge-config`；如再次传入，必须是同一规范配置路径。不要删除原配置文件，后续操作会重新读取它。

## 受管绑定与漂移拒绝

prepare 会保留原 Bot 配置 row，在受管 `dsh/profiles/forge-bots/cordis.patch.yml` 末尾插入固定 `forge-bot-bridge` row。原始 DS-Bot 包、SRI、profile 名称、隔离 HOME/环境和每根 prepare/check/run 锁保持原有机制。DSH `0.2.1-rc.5` 的前台 web 入口不接受 `--patch`，因此启动使用既有 profile patch，不额外传该参数。

root 内有三处可供操作者核对的私有记录：

| 文件 | 用途 |
| --- | --- |
| `forge-bots.json` 的 `bridge` 字段 | 绑定规范配置路径、原文 SHA256、规范化配置 SHA256、固定插件入口、七文件 SHA256、patch SHA256 |
| `forge-bridge.patch.json` | 固定插件入口和完整规范化配置的组合快照；不需要手工创建或传给 DSH |
| `dsh/profiles/forge-bots/cordis.patch.yml` | 实际交给 DSH 加载的原 Bot row 与桥 row；整体指纹被绑定 |

check/run 会重读操作者配置，核对配置原文、组合快照、完整 profile patch、桥状态 marker、可信路径和七文件组；再要求 DSH dump 中恰好存在一个启用的固定桥入口及相同根/可信入口配置。JSON 的空白变更也算原文漂移。配置删除、路径替换、符号链接、patch 或插件文件变化均拒绝，不自动更新绑定。修改模板、主动切换桥代码或增加能力需要操作者使用另一个新 Bot root；显式迁移尚未实现。

CLI 升级到新的 `versions/<hash>` 目录不会重建既有团队。已有团队继续加载 marker 中已授权的原绝对入口，并逐文件核对原七文件组、包身份、真实目录与无符号链接边界；不把新 CLI 的桥代码自动用于旧团队。原受管版本和原配置中固定的 Forge 安装/入口须继续保留。旧入口缺失或发生内容漂移时拒绝，不静默回退当前版本。新团队使用当前 CLI 内的桥。团队 root、Bot 身份、记忆与配置绑定保持原位置。

`check --json` 的 `bridge` 包含 `enabled`、配置路径/指纹、入口、文件组、patch 指纹、stateRoot、allowPrepare、workspace 别名和固定工具名，便于审阅。它不打印完整操作者模板或凭据。配置文件及可信路径应由操作者控制；与原桥相同，此机制不防御同一 OS 账户恶意并发修改可信文件的竞态。

## 源码和安装包寻址

安装包使用 CLI 内固定 `lib/bots/bridge-runtime/`。打包从唯一源码 `integrations/ds-bot-forge/` 搬运以下七个运行文件，目录不包含测试、开发机配置或 native smoke：

```text
package.json
index.mjs
bridge.mjs
projection.mjs
locale/en.json
locale/zh.json
icon.svg
```

源码运行在上述打包目录不存在时，才回退到同一仓库的固定 `integrations/ds-bot-forge/`。不存在环境变量覆盖、自选插件路径、任意 npm 解析或下载逻辑。打包目录存在但缺文件或已漂移时直接失败，不回退源码。不启用桥的旧入口无需这些运行文件。

## 无模型验收

离线测试：

```sh
node --test packages/cli/test/bots-composition.test.mjs \
  packages/cli/test/bots-profile.test.mjs packages/cli/test/bots-launch.test.mjs
node --test integrations/ds-bot-forge/bridge.test.mjs
```

真实 DSH 组合验收（显式 opt-in；使用原始归档和全新临时根）：

```sh
FORGE_BOT_TEST_DSH='/absolute/DSH/Resources/runtime/cli/bin/dsh' \
FORGE_BOT_TEST_ELECTRON='/absolute/DSH/MacOS/DeepSeek Harness' \
FORGE_BOT_TEST_RESOURCES='/absolute/DSH/Resources' \
FORGE_BOT_TEST_TARBALL='/absolute/ds-bot-0.2.7.tgz' \
node --test packages/cli/test/bots-composition-host.test.mjs
```

该测试把 CLI 和原生桥实际复制到两个 `versions/.../node_modules/@nuwax-ai/devkit-cli` 目录：先由旧版本公共 CLI prepare/check，再由新目录公共 CLI check/重复 prepare/run 同一 root，保留原桥入口、配置、marker 和 Chief ID。两次均不传配置地前台启动原生 DSH，核对未认证请求拒绝、原版 DS-Bot client 挂载与 Chief 等待模型。随后从自动生成的同一旧版本 row 在安装版 Electron 内加载真实 Cordis 与 `dsh-tools@0.2.1-rc.5`，执行原生 prepare/status、guard 拒绝、取消和卸载。只有 systemPrompt owner、调用 Session 与阻止模型派发的 runtime 是 fixture；任何模型命令都会写失败 marker。测试不复制凭据、不启动 Agent loop、不测试 Chief 自主工具选择或浏览器渲染。

2026-11-04 首轮本机执行：CLI 全部 155 项中 139 通过、16 个显式宿主验收按预期跳过；既有桥 12 项离线测试通过。另显式运行组合宿主、旧 Bot host 和 launch 三组原生验收，10 项全部通过，模型调用为 0。升级连续性修正后，组合离线 8 项通过，真实 DSH 两版本目录复制/旧入口加载/Chief ID 保持与原生工具执行再次通过，模型调用仍为 0。安装包的 runtime 搬运与从安装包运行的验收由打包接线单独覆盖，源码测试不能替代该层结果。

2026-11-04 安装层验收已通过：现用 release `0.1.0-devkit-local.1-98c5d60aecb43ab0` 的受管注册入口经 skill doctor 六包与 artifacts 一致性核对，`bots --help`/`bots plan` 只读可用；`defaultBridgeDisabled=true` 确认未配置实例默认不加载桥；新装的七文件桥运行组与旧装逐字节一致（各文件 SHA256 已入验收收据），按其复用范围沿用既有安装验收（原生 prepare/status、SRI/client、无模型 SIGINT 关闭），未重复全量测试。本次 `dshStartedThisCheck=false`、模型调用 0、provider 根未改动；收据不构成新的 PA intake 或 provider 验收。
