# Forge × DSH 插件兼容与设备连接设计（U2）

需求来源（dong，Codex 线程 01a1a503 原话意图）：开发**既兼容 DSH 插件体系、又能跑在 Forge 框架下**的插件；首批场景是设备连接——开发调试验证需要真机/模拟器，覆盖 windows/linux/macos/android/ios，经局域网 ssh/tailscale、adb、applescript 等方案打通。本文是该项工作的设计文档（U2），U3 起按此实现。

## 现状（2026-11-05，main 含 #27/#28）

已有的可复用资产：

- **DSH 宿主侧启动证据**：`dsh-task-observer`（observer 插件，loader 快照）+ `evaluateTaskEvidence`（`packages/cli/lib/dsh-task-evidence.mjs`，结构化验证结果）+ `dsh-plugin run --startup-binding`（#28，按证据门控退出码）。边界见 [DSH-PLUGIN-OBSERVATION.md](DSH-PLUGIN-OBSERVATION.md)：不实现运行时、派发器、进程监督、任务库、预算算法。
- **Forge 宿主侧插件先例**：`integrations/personal-agent-forge`（`apply(ctx, config)` + `ctx.tools.register` 原生工具合同）、`integrations/ds-bot-forge`（Bot 桥）。配置校验、错误码、unknown 保留的纪律已在两处成型。
- **DSH 版本锚**：上游 tag `dsh-v0.2.1-rc.5`（SHA `b830ec95…`），固定引用不追新。

缺口（Codex 线程 01a1a500/01a1a503 盘点，编号沿用）：

1. ~~启动失败退出码仍 0~~ → U1 已修（#28）。
2. 受管 Agent 未开放自定义插件装载。
3. 插件 ↔ Forge 任务/预算/看板无接口。
4. Dashboard 未嵌入 packages/dashboard 的任务工作台 UI（另列切片，不在本文）。
5. 安装版 CLI（98c5d60 基线）不含新能力，待下次发版分发。

## 设计原则

1. **同一份插件代码，双宿主可加载**：插件不 import 任何宿主内部；宿主差异全部收敛在「宿主适配层」。
2. **Forge 不做运行时**：连接的进程监督、生命周期由既有宿主机制或插件自管会话承担，Forge 只做声明、校验与门控（沿用观察文档边界）。
3. **校验在边界，unknown 保留**：外部输入（设备回执、SSH 输出）在入口结构化校验，非法整响应拒绝；拿不到的数据留 unknown/null，不硬填。
4. **验证结果可门控**：任何「就绪/通过」的结论必须来自结构化证据（启动证据机制的模式推广），不以日志或退出码推断。

## 四公共接口

四个接口是「共享连接核心」对两个宿主的全部公开面。签名用 JSDoc 级伪码，落点标现有/新建。

### ① 设备能力声明 `declareCapabilities`

```js
/** 返回静态能力清单，宿主据此决定能派什么活。纯函数，不触网。 */
declareCapabilities(config) => {
  deviceId,            // 操作者配置的稳定别名
  platform,            // 'macos'|'linux'|'windows'|'android'|'ios'
  transport,           // 'ssh'|'adb'|'applescript'|'wda'
  abilities,           // ['shell','file-push','screenshot','ui-drive',...] 枚举
  limits,              // {maxSessions, commandTimeoutMs, ...}
}
```

落点：新建 `packages/device-core/src/capabilities.mjs`。宿主用它生成工具描述与就绪检查依据；不允许运行中变更。

### ② 连接生命周期 `connect / health / disconnect`

```js
connect(config)    => handle   // 幂等：已有同参连接则返回既有 handle
health(handle)     => {alive, latencyMs?, detail?}   // 轻量探活，unknown 允许
disconnect(handle) => void     // 幂等，重复调用无害；崩溃后残留由宿主清理策略兜底
```

约束：所有调用带超时上限（config 强制）；句柄不透明（核心外不可拆）；任何一步失败返回结构化错误（code/message），不抛裸异常穿透宿主。

落点：新建 `packages/device-core/src/lifecycle.mjs`；传输适配器 `packages/device-core/src/transports/{ssh,adb,applescript}.mjs`。U3 只实现 ssh。

### ③ 结构化验证结果

启动验证已存在：`evaluateTaskEvidence(binding, outcome)`（observer + #28 门控）。运行期验证是它的推广：

```js
evaluateStepEvidence(expectedStep, outcome) => {
  schemaVersion, kind:'forge-device-step-result', scope:'step',
  processPassed,          // 真实 exit/signal/error
  stepPassed,             // 语义校验（如文件确实送达、截图尺寸匹配）
  evidence: {...},        // 结构化回执；拿不到的字段 null，不硬填
}
```

落点：`packages/cli/lib/dsh-task-evidence.mjs` 同目录新增 `device-step-evidence.mjs`，复用绑定/污染/大小限制纪律（safeParent、O_NOFOLLOW、排他发布）。观察文档明确的边界继续有效：acceptancePassed/usage/budget 不从装载状态推算。

### ④ 宿主适配就绪检查 `hostReadiness`

```js
hostReadiness(host) => {
  host: 'dsh'|'forge',
  ready,                  // 本插件在该宿主可运行
  checks: [{name, passed, detail?}],   // 逐项：入口可加载/版本匹配/依赖在场
}
```

- DSH 宿主判据：loader.entries 含目标且 observer 报 active（即现有启动证据），版本经 getDshRuntimeVersion 核对。
- Forge 宿主判据：`ctx.tools.register` 成功 + 组合报告（`bots check --json` bridge 段模式推广）。

落点：`packages/device-core/src/host-readiness.mjs`，纯函数，输入由各宿主适配层采集。

## 双宿主加载

```
packages/device-core/          # 纯核心：接口①②③④ + 传输适配器，零宿主依赖
integrations/device-ssh/       # Forge 宿主适配：apply(ctx,config) → ctx.tools.register
packages/cli/lib/dsh-device-*.mjs  # DSH 宿主适配：observer/bundle 入口 + 证据桥
```

插件作者只写 device-core + 一个宿主适配层；不重复实现协议逻辑。DSH 侧装载沿用 profile bundle/cordis.patch 既有机制（缺口 ② 的「受管 Agent 开放插件装载」是该机制的配置暴露，单列切片）。

## 设备打通顺序与理由

**SSH → ADB → iOS/GUI（applescript/WDA）**。SSH 最通用（macos/linux/windows 三平台同协议）、证据链最干净（命令/退出码/输出天然结构化），且 tailscale 网络层与传输层正交。ADB 次之（设备在场检测成熟）。iOS/GUI 最后（权限与稳定性成本最高）。

## U3 试点范围（SSH 连接插件）

- device-core：capabilities/lifecycle 的 ssh 传输 + host-readiness。
- Forge 适配层：`integrations/device-ssh` 注册 `device_ssh_exec` 等最小工具集（声明、执行、探活），配置校验比照 personal-agent-forge 纪律（绝对路径、known_hosts 策略、凭据只经操作者运行时回调，不落盘不进聊天）。
- 验收：真实本机回环 SSH 一台（m1）+ 注入异常单测；启动/步骤证据全链路走 ③ 的门控；模型调用 0。
- 明确不做：多机并发调度、windows openssh 特例调优、凭据管理服务。

## 缺口映射与不做清单

| 缺口 | 去向 |
| --- | --- |
| ① 启动退出码 | U1，#28（已复核） |
| ② 受管 Agent 开放插件装载 | 独立切片（DSH profile 配置暴露），不在 U3 |
| ③ 任务/预算/看板接口 | 本档接口③ + 后续任务系统导入切片 |
| ④ Dashboard UI 嵌入 | 独立切片 |
| ⑤ 安装版分发 | 随下次发版 |

不做：DSH 上游修改（pinned）；运行时/派发器；超出四接口的插件间直接调用。
