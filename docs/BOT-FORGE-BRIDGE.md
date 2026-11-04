# Bot → Forge 最小业务接线

`integrations/ds-bot-forge/index.mjs` 是 DSH 原生 Cordis host 插件。Chief 和普通 Bot Session 通过既有 `ctx.tools` 调用同一接口，无额外 Bot runtime、任务库、Worker 或审批库。它独立于 DS-Bot 安装 PR，可与原版 `ds-bot@0.2.7`、DSH `0.2.1-rc.5` 组合。

- `forge_prepare({workspace, taskKey, brief})`：读取操作者预先固定的模板，调用既有 Forge `agent prepare`，执行原有 doctor 和预算 HIGH 门。短 brief 上限 16KiB，不运行模型。
- `forge_status({attemptId})`：只读明确 attempt 的固定文件，不枚举任务、会话、目录或凭据。返回来源 taskKey、attempt=1、调用 Bot Session、实际执行 Session（未运行时 null）与独立状态/预算/验收字段。

没有 run、approve、reconcile 工具。`prepared` 仅提供带 `requiresOperatorAuthorization: true` 的既有 `agent run --state` argv，操作者需在已有授权范围内自行执行，然后用原有 `agent reconcile` 结算。Bot 不能替人批准；返回命令不构成授权。安装此插件不更改既有 DSH approval/permission，原生 pre-execute、guard、取消仍有效。

## 操作者配置与新状态根

先检查实际安装版支持 `agent doctor/prepare/run/reconcile`。将以下配置保存为操作者持有的绝对路径 JSON，并替换所有 `/absolute/...`。Node、Forge 安装目录/入口、工作区、runtime binary、模型、权限及预算仅来自这份配置，工具参数不能修改它们。配置不包含 provider 凭据。

```json
{
  "schemaVersion": 1,
  "nodeBinary": "/absolute/trusted/node",
  "forgeRoot": "/absolute/installed/forge",
  "forgeEntry": "/absolute/installed/forge/scripts/forge.mjs",
  "stateRoot": "/absolute/private/new-bot-forge-state",
  "allowPrepare": true,
  "workspaces": {
    "review": {
      "worktree": "/absolute/allowed/git-checkout",
      "runtime": {
        "kind": "deepseek-harness", "contextMode": "fresh-exec",
        "binary": "/absolute/trusted/dsh", "provider": "deepseek-official", "model": "deepseek-flash"
      },
      "permissions": {"mode": "read-only"},
      "budget": {"maxTokens": 20000, "maxWallSeconds": 120, "maxAttempts": 1},
      "budgetSpec": {
        "schemaVersion": 1, "id": "bot-bounded-review", "mode": "model", "taskKind": "text-implementation",
        "model": {"name": "deepseek-flash"}, "expectedCalls": 1,
        "initialContextTokens": 1000, "perCallOutputTokens": 1000, "budgetTokens": 20000
      },
      "context": {"maxBytes": 65536, "maxTokens": 16000, "maxFiles": 4, "contextFiles": []}
    }
  }
}
```

`stateRoot` 的父目录必须已存在且使用真实规范路径；根本身必须不存在，并与所有工作区、Forge 安装目录互不包含。可信路径必须是实际文件/目录，不接受末级符号链接；Node 可用 `process.execPath` 对应的真实文件路径。`runtimeContextTokens` 如已知可在 context 显式声明，未知时省略；桥不复制预算算法。

```sh
node integrations/ds-bot-forge/setup.mjs /absolute/operator-config.json
```

这一步由操作者执行，创建私有 marker 和配置指纹。既有目录不能被接管；模板变动必须使用另一个新根。每次 prepare 使用随机 UUID attempt，输入/state/HOME 都在根内。子进程只执行固定 argv，禁用 shell，环境不继承 provider keys、NODE_OPTIONS、用户 DSH_HOME 或配置。Prepare 30 秒超时/取消会停止其进程组；中断后的 attemptId 保留在错误中以供明确查询，不自动重试。

将本地插件作为明确的 Cordis row 加入**待启用的受管 profile patch**（不修改原版 DS-Bot）：

```json
[
  {"insert": [{
    "id": "forge-bot-bridge",
    "name": "/absolute/nuwax-forge/integrations/ds-bot-forge/index.mjs",
    "config": {"schemaVersion": 1, "...": "完整复制上述操作者配置，不能仅放配置文件路径"}
  }]}
]
```

上方 row 的 `config` 是形状示例，`...` 必须替换为完整配置。通过既有 DSH `--patch /absolute/bridge.patch.json` 组合到已授权 profile；不要复制旧 profile、密钥或会话。插件激活要求 marker 与配置完全匹配。`allowPrepare: false` 仅允许查询，且需在初始化时即固定为 false。

## 状态语义与边界

`prepared`、进程通过、Agent 完成、用量已知、预算结算和产品验收分别返回。缺失文件/未知状态不当作完成，缺失用量不记 0。完整预算与 chargedTokens 必须同时匹配 manifest、原始 usage、Forge settlement 的完整性/数值、预算上限与 usage sourceHash；单独 `usageKnown` 或 `within` 字段不能放行。缺失或冲突时 chargedTokens 为 null、完整预算为 unknown，`consistency` 标明证据状态。

完整预算 `unknown` 可以同时伴随 `observedVerdict: exceeds` 的已报告下界。下界必须是非负整数，其 maxTokens 与 request 一致，verdict 与数值关系一致；有 usage/manifest/settlement 时交叉核对。缺少 settlement 时可以谨慎展示 manifest 的合法 observedBudget，并以 `observedSource: manifest` 明示来源，仍不视作完整结算。未运行的执行 Session 为 null。任务来源冲突、越界、符号链接、超大 JSON 和未知字段均拒绝。查询只覆盖本桥明确准备的 attempt；不会扫描或采用其它执行根。

本切片不保证进程启动后 provider 总 token 硬上限，也不授予工作区之外的模型操作权限。工作区模板、入口文件及状态根应由操作者控制；它不防御同一操作系统账户同时恶意修改可信文件的竞态。原有 Forge run 的预算/上下文复核及一次性 claim 继续生效。

## 已执行验证（2026-11-04）

```sh
npm install --ignore-scripts --offline
node --test integrations/ds-bot-forge/bridge.test.mjs
ELECTRON_RUN_AS_NODE=1 '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' \
  integrations/ds-bot-forge/native-smoke.mjs \
  '/Applications/DeepSeek Harness.app/Contents/Resources' /absolute/trusted/node
```

12 个离线测试通过：实际 Forge prepare、预算阻断、未授权 prepare、已有根、越界/参数注入、缺失/未知结算、来源冲突、符号链接、大 JSON、已启动 prepare 的取消与缺失 request/guard；另用既有 Forge reconcile 生成真实完整结算与停止后超限结算，验证完整用量正常展示、冲突降级、下界与 manifest 回退。所有 runtime 均为 marker fixture，无模型调用。

安装版 Electron 内加载了实际 Cordis 与 `dsh-tools@0.2.1-rc.5`：原生注册、prepare、status、guard 拒绝、取消前拒绝及卸载清理通过。只有 systemPrompt owner 使用 fixture，不启动 Agent loop。未进行 Chief 自主调用、Bot 聊天端到端、模型/语音、已有 profile 或 UI 验收；注册与 prepare 成功不能代替这些业务验收。
