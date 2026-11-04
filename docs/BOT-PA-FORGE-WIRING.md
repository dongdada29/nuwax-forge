# 专用实例接线：Bot → PA → Forge

本手册把三段既有能力接成一条链，且**只在专用 Bot 实例上开启**：日用 Bot 实例不开桥、不开 PA intake。三段的默认边界都保持合并时的状态，本手册不新增任何执行、审批或凭据读取能力。

| 段 | 能力 | 默认 | 开启方式 |
| --- | --- | --- | --- |
| Bot → Forge | `forge_status`、`forge_prepare` 原生桥 | 关 | `bots prepare --forge-config`，见 [BOT-FORGE-BRIDGE.md](BOT-FORGE-BRIDGE.md) |
| Bot → PA | `personal_agent_*` 查询/预览/受限 intake | 关 | 受信任 DSH bootstrap 装载插件，见 [PA-TASK-BRIDGE.md](PA-TASK-BRIDGE.md) |
| 模型 provider | 原生模型路由 | 空 | 专用实例原生设置页，操作者本人配置 |

## 前置状态（2026-11-04）

- 代码基线：`dongdada29/nuwax-forge` main `90ae4cfe`（#25 已合并），安装版 release `0.1.0-devkit-local.1-98c5d60aecb43ab0` 已含 `bots` 入口与桥运行文件（[验收记录](BOT-BRIDGE-COMPOSITION.md#无模型验收)）。
- 原 PA 扩展 `db33b3f`+`8240f5e`（任务准入 + Forge Worker）已在隔离 clone 交付并通过原 UI 验收（[证据](PA-TASK-BRIDGE.md#验证与边界)）；**尚未部署到现用 PA 实例**。第 2 跳的 intake 提交在这步完成前不可用。
- 模型密钥轮换未完成：旧 key 曾出现在聊天记录中。未轮换前不要在第 3 跳配置任何凭据。

## 第 1 跳：专用 Bot 实例绑定 Forge 桥

按 [BOT-FORGE-BRIDGE.md#操作者配置与新状态根](BOT-FORGE-BRIDGE.md#操作者配置与新状态根) 准备操作者 JSON（`schemaVersion`、可信 `nodeBinary`/`forgeRoot`/`forgeEntry`、独立 `stateRoot`、非空 workspace 别名、`allowPrepare`），然后在新 root 上执行：

```sh
nuwax-forge bots prepare \
  --root /absolute/private/dedicated-bot-team \
  --dsh /absolute/trusted/dsh \
  --forge-config /absolute/operator-config.json --json
```

边界重申（与 #21 合并行为一致）：必须新 root；已 ready 的旧 root 不能补绑；`check`/`run` 校验配置原文、七文件、patch 与 profile 指纹，任一漂移即拒绝；`allowPrepare: false` 保持只读。核对输出：

```sh
nuwax-forge bots check --root … --dsh … --json
# bridge.enabled=true；tools=["forge_status","forge_prepare"]；workspaces 为操作者别名
```

不传 `--forge-config` 的实例（包括日用实例）维持 `bridge.enabled=false`，这是默认关的验收口径。

## 第 2 跳：专用实例装载 PA intake 插件

PA 扩展带运行时凭据回调，不能走标准 JSON 插件配置：由操作者在专用实例的受信任 DSH bootstrap 中装载 `integrations/personal-agent-forge/`。配置形状见 [PA-TASK-BRIDGE.md#操作者配置与凭据](PA-TASK-BRIDGE.md#操作者配置与凭据)，专用实例的差异只有两处：

1. `auth.mode: 'intake'` + 操作者供应的 `credentials` 回调（只返回 `{ intakeToken }`）。回调是操作者自己的代码：本包与 Forge 仓库都没有、也不接受 token 文件、凭据路径或环境变量读取 helper。PA 服务端的 `PERSONAL_AGENT_INTAKE_ID/TOKEN` 由操作者配置。
2. `submission.enabled: true` + 预设 workspace 别名映射。缺省仍为 `false`（纯查询/预览）。

提交行为保持 #25 契约：`personal_agent_request` 仅显式 intake + enabled + 允许别名才提交；任务强制 paused，只有原 PA 工作台已配对的人类能批准；Bot 无批准/控制工具。`origin` 固定为精确的 `http://127.0.0.1:<port>`。

## 第 3 跳：专用实例配置模型 provider

由操作者在专用实例原生界面「设置 → 自定义模型」配置。规矩：

- **新 key 只填原生设置页**；不写入本仓库、PR、聊天、`forge-config` JSON 或任何环境文件。轮换完成前此跳保持为空。
- 该隔离实例不带入其它 DSH 安装的账号或 key（[BOT-QUICKSTART.md](BOT-QUICKSTART.md) 已验收此隔离）。

## 验证清单

| 命令 | 证明 |
| --- | --- |
| `bots check --json` | 桥绑定、指纹、workspace 别名、默认关实例 `enabled=false` |
| `npm --prefix integrations/personal-agent-forge test` | intake/预览/提交契约（28 项离线） |
| [native-intake-smoke](PA-TASK-BRIDGE.md#验证与边界) | 安装版 DSH 内 preview/guard/取消不产生 POST |
| [isolated-pa-smoke](PA-TASK-BRIDGE.md#验证与边界) | 真 HTTP：提交→paused→人工批准→Worker→验证→接收 |
| 原生 UI 操作 | 配对→批准→单 Worker→验证 exit 0→接收（2026-11-04 已过 marker 级） |

模型调用 0 的验收一律用 marker/fixture，真实模型业务验收须在第 3 跳完成后单独进行。

## 仍待验收（接线完成后）

1. 真实模型全流程：提交→人工批准→真实 Forge Worker（真实模型调用）→验证→接收，含短编码回复业务验收（此前仅问候通过）。
2. 记忆与群协作：真实模型写记忆、重启回读、跨 Bot 隔离、群内 `@` 派发与管理员优先。
3. 成本对账：PA Worker 实际模型与用量回传 Bot 与看板；查询投影当前保留 `unknown`（见 [PA-TASK-BRIDGE.md#查询投影](PA-TASK-BRIDGE.md#查询投影)），补齐导入前不硬填数。
