# 能力与验收边界

状态核对：2026-11-04，main `c5327dd`。本批源码已合并，[主线 CI](https://github.com/dongdada29/nuwax-forge/actions/runs/41788073227) 的测试、契约校验、打包通过；这不代表用户安装已升级或所有业务场景通过。当前用法从[文档导航](README.md)进入，历史样本见[归档索引](archive/README.md)。

## 当前能力

| 能力 | 已有证据与范围 | 仍有的边界 |
| --- | --- | --- |
| 六包分发与统一 CLI | Stack/Crew/Kit/Contracts/CLI/Dashboard；离线本地工作区绑定、测试、打包及安装流程 | 版本仍为本地预发布；每个宿主的已装版本需另查，CI 不做用户升级 |
| source-tooling | 固定配方、输入指纹、日志核验、TaskStore、既有复用检查 | 原有证据边界不等于产品可启动；历史问题不能仅凭文档认定在当前版本仍复现或已修复 |
| Codex / DSH 有限执行 | fresh headless 适配、prepare/run/reconcile、预算 HIGH 和有限上下文门，见 [CLIENT-AGENTS.md](CLIENT-AGENTS.md) | 任务 completion 与产品验收分开；不宣称其他未接执行器已兼容 |
| 预算与用量 | 离线预测/对账、执行前与步间拦截、停止后观测下界和已证实超限保留 | 完整结算可能 unknown；无供应商内部硬 token 上限，不以模拟 usage 计费 |
| Bot 长期团队 | 原版 DS-Bot + DSH；公共 CLI、认证、独立身份、群与重启持久化；原生浏览器首屏/设置/创建操作 | 真实模型自主行为、完整群详情布局、系统默认浏览器启动仍未验 |
| Bot 模型路由 | 真实 DSH 原 API → 本地模拟 provider → 两个 Bot 对应模型 → 原 chat 回读回复 | 证明传输与绑定，不证明付费 provider、推理质量或真实模型工具选择 |
| 记忆与群协作 | 原版模块 + fixture 服务验证非空 own/team/group、私有权限、进程持久化、admin-first 和 @ 调度 | 不等于真实 DSH/模型/浏览器完整链路；首次群输入含成员自己的私聊摘要，实际信息分享语义另验 |
| Bot → Forge 桥 | 原生工具 prepare/status；离线反例和真实 Cordis/tools 注册、guard、取消、卸载 | 不开放模型 run/approve；Chief 自主选择工具和聊天业务链路未验 |
| 本地与 DSH 看板 | 显式来源只读展示、预算下界/unknown 分开；DSH 侧栏/面板与 iframe origin 允许/拒绝有浏览器证据 | 不推断路由关系，不跨来源求总耗；不等于所有 Agent 业务已接通 |
| PA 快照 | 本地导出到看板，多实例隔离、任务执行与交付状态分开；见 [适配说明](PERSONAL-AGENT-ADAPTER.md) | 不连接 PA API/数据库，不控制其实例或替代原任务/审批/恢复 |
| 可选 GUI driver | 本机 CDP 附着与独立 GUI 契约；历史具名场景见 [2026-10-27 报告](CLIENT-GUI-TOKEN-ACCEPTANCE-20261027.md) | 不等于当前客户端、真机或发布包验收；`--launch-config` 仍 unsupported |

Bot 各层证据、复验开关和未验项集中在 [BOT-INTEGRATION.md](BOT-INTEGRATION.md)。默认测试和 opt-in 原生验证须分别报告，不能把 skipped 算为产品通过。

## 验证 level

| level | 运行支持 | 能声明什么 |
| --- | --- | --- |
| source-tooling | 已实现 | 固定源码/脚本验证及与输入指纹绑定的证据 |
| gui-toolchain-smoke | 可选 live driver | 在明确 SDK/CDP/模型前提下，记录工具链观测 |
| gui-product-scenario | 可选 live driver | 在具名场景、版本、身份和时间下记录产品谓词 |

GUI 使用独立 `gui-verification-v1`，不导入旧 TaskStore；`verify` 仍只放行 source-tooling。false、空报告、未知观测、恢复失败或预算超限均不能标 passed。进程退出、插件就绪、任务完成、PA 人工接收及产品验收分别报告。

## 不能由这些结果推出的结论

- 没有同场景、多轮、同口径样本时，不宣称整体提速、token 降幅或构建缓存收益。早期三对样本只代表其固定流程。
- 缺失 token/模型调用数不记 0；模型声明、模拟 usage、宿主报告下界不替代供应商完整账单。跨来源记录也可能重叠。
- Bot 的模块权限测试不证明真实模型不会复述自身信息，群独立 Session 不等于完全不使用自身私聊上下文。
- macOS 上的具名观察不代表 Windows/Linux、移动布局、发布包、跨机、生产部署或崩溃恢复通过。
- 默认离线验证段的零模型调用不包括开发本仓的 Agent 会话和一次性研发投入。
