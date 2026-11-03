# nuwax-devkit 实跑复盘与优化建议（2026-10-29）

本次用本地 devkit 为 Nuwax v3.0.26 的截图与 Computer Use 修复运行验收。固定脚本、任务状态和日志归档能够使用；最先应修复的是 `--reuse` 对环境依赖的遗漏：相同源码在应当失败的环境中，能够复用旧的通过结论。其次补齐工件声明、GUI 操作和项目就绪信息，再优化运行时间。

这是基于实际运行的改进方案，尚未修改 devkit 实现。核对基线为 `70c1c99`，实跑日期为 2026-10-28。项目根目录 `/Users/apple/workspace/nuwax-devkit`；client 验证使用仓外隔离副本，源码为 `8f34dbc1dc6ea40d1547c85f988e94b17a69d4ab`。

## 实跑结果与边界

| 实际运行 | 结果 | 可支持的结论 |
| --- | --- | --- |
| devkit doctor | Node 24.22.1、Python 3.15.0、5 包绑定通过 | devkit 自身运行环境可用 |
| client-tooling 固定配方 | 22/22 通过，1.998 秒，`reused=false`；client doctor `ready=false`，11 个问题 | 源码工具链通过；隔离副本尚未达到完整产品启动条件 |
| v3.0.26 自定义配方 | 55 项定向回归及独立 Electron 输入/PNG 测试通过，25.892 秒，`reused=false` | 指定源码的组件回归通过，level 仍为 `source-tooling` |
| GUI 配方能力探测 | `op: "click"` 被契约明确拒绝 | 当前内置 GUI 配方无法直接表达本次点击保存等完整操作 |
| 环境变更复用反例 | 环境从 allowed 改为 denied 后，`--reuse` 返回 `passed=true`；同一 denied 环境全新运行失败 | 旧证据复用缺少影响谓词的环境依赖 |

固定流程内记录的模型请求为 0；本报告的编写、调查和开发会话不包含在这个计数中。本次没有通过 devkit 的 live GUI driver 操作已安装客户端。独立 Electron 测试使用合成三屏和真实 Chromium 输入，原生保存选择器在测试进程内替换为隔离文件路径；不代表真实系统保存面板、飞书共存或安装包通过。

证据目录：`/Users/apple/Documents/Codex/2026-10-28/v3.0.26-audit/`。文件名、摘要和截图索引见该目录 `evidence-index.json`；它由本次审计补充生成，不是 devkit 已具备的自动媒体归档能力。

## 1. 先修复复用结论的环境依赖（P0）

### 已复现的反例

隔离消费项目 `devkit-env-consumer/` 的配方只有一个阶段，断言 JSON 的 `ready` 必须为 true。脚本如下，不依赖模型、凭据或外部服务：

```js
console.log(JSON.stringify({
  ready: process.env.NUWAX_DEVKIT_QA_MODE === 'allowed',
  mode: process.env.NUWAX_DEVKIT_QA_MODE
}));
```

| 运行顺序 | 环境变量 | 任务与选项 | 实际返回 | 应有行为 |
| --- | --- | --- | --- | --- |
| 1 | allowed | `env-probe`，全新运行 | exit 0，passed=true，reused=false | 通过 |
| 2 | denied | 同任务，`--reuse` | **exit 0，passed=true，reused=true** | 复用失效，重新执行并失败 |
| 3 | denied | 新任务 `env-probe-fresh-negative`，全新运行 | exit 1，passed=false | 失败 |

三次结果保存在 `devkit-reuse-environment-probe.json`；原始输出分别为 `devkit-fresh-allowed.log`、`devkit-reuse-denied.log`、`devkit-fresh-denied.log`。第二次返回了第一次的 manifest。第三次确认失败源自真实谓词，不是人为修改旧日志。

### 代码原因

- [kit/engine/verify.mjs](../packages/nuwa-sdlc-kit/kit/engine/verify.mjs) 第 80–94 行记录文件、HEAD 和 hostname/platform/arch/Node 等信息；第 106 行执行阶段却继承整个 `process.env`。配方无法声明哪些环境变量影响结果。
- [task_state.py](../packages/nuwax-stack/skills/nuwax-stack/scripts/task_state.py) 第 43–90 行校验当前证据，其中环境比较不含配方的环境依赖。
- [run_verification.py](../packages/nuwax-stack/skills/nuwax-stack/scripts/run_verification.py) 第 54–64 行在上述校验通过后直接返回复用成功，因此只修 Node 引擎的一条路径不足以解决 CLI 复用。

### 建议设计及验收

在配方中显式声明环境变量和外部工具依赖，生成统一的运行依赖指纹，由 Node 引擎和 Python 证据校验器共同校验。环境变量应区分未设置与空值，保存摘要而非敏感原文；低熵秘密即使取摘要也可能被枚举，应选择禁用跨会话复用或采用受控本地摘要方案。不要把整个环境原文写进日志。

对未声明完备、依赖动态服务/登录态/外部状态的阶段，默认不复用。显式的“可复用”声明需要包含依赖清单；仅提供环境变量白名单无法自动证明配方没有其他依赖。工具依赖至少覆盖显式解释器、实际运行器版本、Electron/原生二进制及其相关输入；子模块和产物 pin 需随项目配方声明。消费仓内已安装的 runner 也需要迁移或重新接线，不能只修 devkit 仓库模板。

验收必须同时覆盖 CLI bridge 和引擎直接入口：

1. 上述 allowed→denied 反例变为 `reused=false, passed=false`。
2. 声明依赖的环境变量、工具版本或二进制发生变化时失效；输入一致时才可复用。
3. 未设置与空字符串可区分，未声明完备的动态阶段拒绝复用。
4. 文件或日志被篡改仍拒绝，原有路径和源码变化校验继续成立。
5. 新增指纹契约同步 schema、Node producer、Python validator，并处理旧 manifest：旧证据不能默认升级为可信通过。

修复前，本次发布验收应使用全新任务和全新执行结果；已经完成的本次 22 项、55 项和 Electron 回归均为 `reused=false`，不受该反例直接影响。

## 2. 配方显式声明输出工件（P1）

本次产品回归 manifest 只登记了 3 个阶段日志的 SHA-256。测试另外生成了 10 张 PNG，能够查看，但没有纳入 manifest 的完整性校验。当前“日志未变”不能推出“截图和最终 PNG 未变”。

建议配方增加输出声明，由引擎统一收集：相对证据路径、必需/可选、媒体类型、大小上限、case ID 和来源问题 ID。原始测试媒体可以先写入专用输出目录，再按明确规则归档。校验器必须跟随契约变化，取消当前工件数量只能等于阶段数的假定，同时保持每个阶段必须有日志的要求。

验收：缺少必需 PNG、图片被替换、符号链接或越界路径均失败；日志、截图、最终文件和结构化断言能从同一用例定位。公开导出的 manifest 不携带浏览器凭据或附件 URL 的认证参数。

## 3. 扩展 GUI 操作与桌面适配（P1）

[GUI contract](../packages/cli/lib/gui/contract.mjs) 当前仅接受 `fill`、`domValueEquals`、`aiBoolean`。本次保存按钮 click 的离线契约探测被拒绝，记录见 `devkit-gui-capability-probe.json`。因此本次使用自定义固定脚本启动独立 Electron 测试，尚未形成内置 live GUI 场景。

建议分两步增加能力：

| 范围 | 首批能力 | 验收重点 |
| --- | --- | --- |
| DOM/键盘 | click、press、drag、条件/事件等待；明确组合键与输入法边界 | Enter 换行、Command/Ctrl+Enter 提交、Esc 取消，操作目标正确且超时可诊断 |
| 桌面边界 | 原生保存对话框/下载结果适配、窗口选择与生命周期记录 | 真实取消、写入失败、再次保存、多屏窗口和应用退出；替身与真实对话框的证据清楚区分 |

确定性操作不需要模型判断时，可以设计显式 `no-model` 路径；视觉语义断言继续要求模型认证和预算。此项是新契约建议，不能直接去掉现有 `gui-product-scenario` 的 AI 断言要求并沿用旧通过口径。仍须锁定 shell/guest、origin、安装版本/asar 身份，失败后的恢复也须可核对。

## 4. 补项目预检和场景预设（P1）

实跑中 `client-verify` 返回 22/22 通过，但 client doctor `ready=false`、11 个问题。这符合 source-tooling 的边界，输出也已提供 doctor 字段；顶层一个 `passed` 容易被上层报告误读为产品可运行。

建议汇总分别显示源码验证、产品就绪、GUI 场景和安装包验收的状态，未执行的项保留 `not-run`，不要合成一个全绿结论。`doctor --project --level` 应预检对应的基座/前端/产物 pin、依赖、MCP 资源、Node 子进程 PATH，以及可选 SDK/CDP。doctor 自身继续只读，不自动安装、授权或重启应用。

本次 init 依赖预先存在的配方；client 固定配方和截图自定义 wrapper 需要人工准备。可增加 `init --preset client-tooling/capture/desktop-guest`，生成可编辑配置并明确其覆盖范围。预设涉及的配置和脚本应登记到输入清单，避免接线完成但实际依赖未纳入指纹。

## 5. 缩短失败诊断与等待（P2）

denied 的全新运行正确失败，但 CLI 返回大段嵌套 execution JSON，外层为 `process-failed`、`verification: not-run`，具体 `predicate-failed` 藏在子日志和 summary 尾部。

建议保留原始工件，额外提供稳定的简短失败字段：阶段 ID、失败类别、谓词、经脱敏的期望/实测值、日志路径、manifest 路径。执行过程增加 JSONL 阶段开始/结束事件和可选简短进度，不破坏最终 JSON 的机器消费，也不自动重试。

验收使用本次反例：终端摘要能直接说明 `mode / environment-must-be-allowed / ready expected true, got false`，机器输出仍可解析，敏感值按配方策略遮蔽。

## 6. 按实测分解耗时后优化（P2）

| 本次全新产品回归阶段 | 时间 |
| --- | ---: |
| overlay 准备 | 9.788 秒 |
| 55 项定向回归 | 2.001 秒 |
| 独立 Electron 输入/PNG 回归 | 13.749 秒 |
| 引擎记录总时间（含阶段外开销） | 25.555 秒 |
| CLI/bridge 总时间 | 25.892 秒 |

另一次仅做准备的温热样本为 0.602 秒、0 文件变化。它不是完整流程 A/B；不能据此声称测试、构建或整体效率提升。全产品构建次数和重复构建次数均为 0。

先增加 setup / test / native / report / bridge 耗时分项；在准备链路保留完整性校验的前提下利用零变化路径。之后用相同源码、用例和机器做至少多轮冷/温热对照，报告中位数、波动和失败样本。当前单样本主要耗时在准备和 Electron 阶段，未显示出需要更换编排框架的证据。

## 建议落地顺序

1. 修复复用依赖及双入口反例，迁移旧证据和已生成 runner。
2. 添加输出工件声明、项目就绪分项和失败摘要，先让现有脚本证据完整可审计。
3. 增加 DOM 操作与桌面对话框适配，用 v3.0.26 保存/换行场景做首个验收消费方。
4. 在真实安装包完成后再记录对应身份下的 GUI/平台结果，最后做多样本时间与 token 对照。

相关 client 问题复查：`/Users/apple/Documents/Codex/2026-10-28/v3.0.26-audit/ISSUE-AUDIT-20261029.md`。本次没有修改禅道或团队问题表，也没有发布包、打开新的 CDP 权限或切换用户运行中的客户端。
