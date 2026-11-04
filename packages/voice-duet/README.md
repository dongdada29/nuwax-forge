# dsh-duet 固定版本安全适配

将本地已有的 **YuMS/dsh-duet v0.1.10**（commit `143de3f30c61d323568b3863d2e5badeb47123e7`）生成独立、可审阅的插件副本。只修改真实 host trace、端点发现、设置验证和 WebSocket 连接前的 TLS 检查。原 `package.json`、DSH 注册声明、host 入口、client、配置和语音资源保持原样；不会执行插件、启动 DSH、安装依赖或连接服务。

此目录是源码适配工具，不是新增 npm workspace，也未接入 Forge CLI、安装包或自动部署。保持原插件运行方式，由 DSH 加载生成副本；实际宿主启动、真实语音与正式部署另行验收。

## 准备与回滚

在 Forge 仓库根目录运行，要求 Node 22.19+ / 24+、Git 和一个已存在的上游仓库：

```sh
# 显式填写本机上游仓库的路径；HEAD 必须为上述固定 commit。
export DUET_UPSTREAM=/path/to/dsh-duet
node packages/voice-duet/prepare.mjs "$DUET_UPSTREAM" packages/voice-duet/prepared
```

准备工具只从固定 Git commit 读取全部已提交文件（包括配置、脚本、测试和音频教学资源），不复制源工作树中的修改、node_modules、运行数据或凭据。检查 HEAD、源仓根路径、关键文件 SHA-256、补丁唯一上下文及文件类型后，才创建目标目录。Git 全局配置和 replace objects 被禁用。源仓保持只读；目标必须不存在，且父目录已存在并位于调用时的当前工作目录内，目标与源仓不能重叠。

生成目录中的 `FORGE-MODIFICATIONS.json` 记录上游来源、固定版本和所有修改文件。原入口与包声明没有被替换，不存在停用入口或永久禁网开关。生成目录按本目录 `.gitignore` 排除，不应提交到 Forge。回滚仅删除自己生成的 `prepared` 目录，或让 DSH 重新加载之前的插件副本；工具不修改现有 DSH 配置。

## 行为变化

- 实际 trace API 保留 `event/frame/snapshot/close`，默认只在内存计数；显式传入 `root` 时只记录受限数值元数据。二进制音频、任意字符串、嵌套内容、base64、非法 JSON 原文和任意事件名均不会序列化，没有启用音频落盘的开关。每个实例最多写 1 MiB，日志失败会反映在 snapshot 中而不阻断语音。上游 TRACE_DIR 的隐式落盘行为不再使用；需要元数据日志时由宿主明确设置 traceOptions.root。
- 外部语音服务必须使用 `wss`，相关 metadata 地址必须使用 `https`。推荐地址、保存设置、proxy 初始化和所有候选连接前均校验；公共试用服务和 `insecure_origin` 不再豁免。已保存的外部明文地址将报错，需要改为服务提供的 TLS 地址。仅数字 loopback `127.0.0.1` / `[::1]` 允许明文，方便本地开发；`localhost` 名称不豁免。
- 保留原有安全端点的发现、连接和备用路由逻辑；包含不安全备用候选时，在任何连接开始前拒绝整组候选，不发生 TLS 降级。
- 客户端播放/打断、RPC、任务控制源码均未修改。这一批没有实现或证明“语音回合打断与后台研发任务取消隔离”，不能据此宣称任务取消已经受 Forge 统一协议约束。

## 离线验证

无需 npm install、网络、麦克风或模型：

```sh
# 默认：本地单元 fixture；完整上游验证明确显示 skipped。
node --test packages/voice-duet/tests/pilot.test.mjs

# 可选：显式提供本地固定上游后，额外验证完整插件副本。
DUET_UPSTREAM=/path/to/dsh-duet node --test packages/voice-duet/tests/pilot.test.mjs
```

默认测试使用 `tests/fixtures/upstream-excerpts.json`：从固定 commit 提取的 endpoint 函数、settings 验证函数及 proxy 初始化片段；proxy 只测试到连接初始化前的校验，并非完整宿主。测试同时覆盖实际 trace 的 payload 排除、配额与日志失败、明文/凭据拒绝、离线注入的安全候选连接、备用候选验证和补丁漂移拒绝。注入的 socket 是 EventEmitter，不验证真实 TLS 握手。

显式上游验证会在仓库内创建临时副本，验证入口/client/RPC/stop-task/注册配置/许可逐字节未变，执行补丁后的真实 endpoint/settings/proxy 拒绝路径及注入式安全连接，并运行上游 `scripts/check-package.mjs`、`audio-interruption` 与 `audio-lifecycle` 单元测试。临时目录结束自动删除。不会安装 ws、启动宿主或调用线上服务。

2026-11-04 本机验证：默认 **6 pass / 1 skipped**；显式固定上游 **7 pass / 0 skipped**。后者包含上述上游检查。未验证：真实 TLS 握手/服务器兼容性、DSH 运行时加载、真实麦克风/播放/听感、连续语音端到端、后台任务取消隔离、上游完整测试套件。上述离线检查通过不等于产品已发布或端到端验收通过。

## 许可与归属

上游 https://github.com/YuMS/dsh-duet 为 Apache-2.0，Copyright 2026 YuMS。本目录保留其完整 LICENSE、NOTICE、HEROICONS-LICENSE.txt；Heroicons 使用独立 MIT 许可。新增适配代码为 Apache-2.0。修改文件包含提示，生成副本附完整修改清单。Fixture 为该固定版本的节选，完整性/行为保证限于测试说明的范围。
