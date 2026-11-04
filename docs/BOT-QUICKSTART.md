# 启动原版 DS-Bot 团队

Forge 使用固定的 `ds-bot@0.2.7` 和真实 DSH `0.2.1-rc.5`。界面、Bot、群聊、模型设置和记忆面板均来自原插件；这里提供隔离安装和前台启动入口。公共命令已合入主线，原有安装需检查是否包含此功能。完整来源、各层已验范围及未验项见 [BOT-INTEGRATION.md](BOT-INTEGRATION.md)。

## 第一次准备

需要 Node >=22 和已安装的指定 DSH 版本。在 Forge 仓库根目录运行；源码检出先运行 `npm install --ignore-scripts --offline --package-lock=false` 绑定本地工作区包。

```sh
mkdir -p "$HOME/.local/share/nuwax-forge/bots"
FORGE_BOT_ROOT="$HOME/.local/share/nuwax-forge/bots/my-team"
FORGE_DSH_BINARY='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'

node packages/cli/bin/nuwax-forge.mjs bots plan --root "$FORGE_BOT_ROOT" --dsh "$FORGE_DSH_BINARY" --json
node packages/cli/bin/nuwax-forge.mjs bots prepare --root "$FORGE_BOT_ROOT" --dsh "$FORGE_DSH_BINARY" --json
node packages/cli/bin/nuwax-forge.mjs bots check --root "$FORGE_BOT_ROOT" --dsh "$FORGE_DSH_BINARY" --json
```

`my-team` 必须是尚不存在的新目录，父目录需存在。`plan` 不写文件；`prepare` 安装原插件，默认需要网络且不运行模型。已有原始归档时，可在 `prepare` 后加 `--tarball /absolute/path/ds-bot-0.2.7.tgz`，仍会校验固定 SRI，依赖安装仍可能联网。已准备的同一 root 可重用，不会重置团队。

已安装 Forge CLI 时，把示例中的 `node packages/cli/bin/nuwax-forge.mjs` 换成 `nuwax-forge`。独立入口 `node packages/cli/lib/bots/entry.mjs` 继续可用，省略其中的 `bots` 单词。

## 打开和关闭

```sh
node packages/cli/bin/nuwax-forge.mjs bots run --root "$FORGE_BOT_ROOT" --dsh "$FORGE_DSH_BINARY" --open
```

只有显式 `--open` 才在宿主输出完整本地认证链接后打开系统默认浏览器。省略它，则手动打开终端中 DSH 给出的链接。默认使用随机端口，可加 `--port 3081`；始终绑定 `127.0.0.1`。链接带本次宿主的认证令牌，不要分享或复制到报告中。Forge 不保存它，也不替换原认证。

终端始终留在前台；按 **Ctrl-C** 停止宿主，同一 root 的团队数据保留。关掉浏览器标签不会停止宿主。下次运行同一命令继续使用团队；若系统浏览器打开失败，终端会提示手动打开，宿主仍运行。

## 首次进入原生界面

1. 首次可能显示 DSH「预览版说明」和「开始使用」弹窗。确认说明后，可以关闭登录弹窗先查看界面。
2. 左侧出现主 Bot **Chief**，对话显示「还没有可用的模型」。点击「打开设置配置自定义模型」进入原 DS-Bot 的模型设置。这个隔离实例不会带入其它 DSH 安装的账号或 Key。
3. 需要模型时，由用户在这个实例的原生界面配置自己的服务商。配置完成后的问候、消息和记忆总结可能调用模型。
4. 左上角 **＋ → 新建 Bot** 可设置名字和模型。未配置模型时可以先创建身份，随后仍显示模型等待卡。点击顶部 Bot 名称打开详情，查看模型、工作目录、权限和记忆入口。
5. **＋ → 新建群聊** 选择成员，第一位为管理员，再点「新建群聊」。详情显示成员、管理员与「管理员主持」；输入框键入 `@` 可以查看成员候选，选择候选不等于已经发送消息。

原版 UI 新建群聊会尝试自动问候：无 Key 时显示「模型还没有 API Key」，尝试被 `MISSING_CREDENTIAL` 阻断。模型问候与调度属于原插件行为；不要把无凭据建群当作“没有模型尝试”。

## 本次验收记录（2026-11-04）

在 macOS、nuwa-browser、全新隔离 root 和上述原版组合上，实看 Chief 模型等待卡与模型设置页；通过原 UI 创建 Bot、创建两成员群、访问群详情控件、展开 `@` 成员候选。群详情截图存在边缘裁切，完整面板布局仍未验收。未配置服务商凭据，未发送用户消息；建群的自动问候尝试被缺凭据阻断。自己的宿主已通过 SIGINT 关闭，root 锁已释放。

测试覆盖公共/独立参数解析、默认不打开浏览器、分块宿主链接只打开一次、拒绝非本地链接、打开失败的手动回退、信号转发与退出清理。真实 DSH 测试另验证原客户端 HTTP 服务、未认证请求 401、重启保留身份和群。测试命令：

```sh
FORGE_BOT_TEST_DSH="$FORGE_DSH_BINARY" \
FORGE_BOT_TEST_TARBALL=/absolute/path/ds-bot-0.2.7.tgz \
node --test packages/cli/test/bots-*.test.mjs packages/cli/test/cli.test.mjs
```

本次不证明真实模型回答、记忆写入/总结、群内实际 `@` 派发、系统默认浏览器打开、完整群详情面板或移动端布局。浏览器验收使用 nuwa-browser；自动化测试只验证原生宿主发出打开请求，不启动系统默认浏览器。上述浏览器记录与默认 API 测试是两组验收；API 测试的 `modelCallsRequested=0` 不适用于建群自动问候的 UI 记录。

此节只描述原生浏览器与启动验收；另有[非空记忆](BOT-MEMORY-ACCEPTANCE.md)、[群调度](BOT-GROUP-ROUTING-ACCEPTANCE.md)的原模块契约，以及[真实宿主到本地模拟 provider](BOT-PROVIDER-HOST-ACCEPTANCE.md)的专项证据。需要 Bot 准备有限 Forge 任务时，另按[工具桥说明](BOT-FORGE-BRIDGE.md)配置；`bots prepare/run` 不会自动加载桥或连接 PA。
