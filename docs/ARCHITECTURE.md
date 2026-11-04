# 架构

核对基线：2026-11-04，main `c5327dd`。本页描述当前源码的模块关系；验收范围见 [CAPABILITIES.md](CAPABILITIES.md)，早期导入结果见[历史索引](archive/README.md)。

## 仓库布局

```text
nuwax-forge/
├── packages/
│   ├── cli/                # @nuwax-ai/devkit-cli，公共命令 nuwax-forge
│   ├── dashboard/          # @nuwax-ai/devkit-dashboard，本地只读投影与 Web 页面
│   ├── nuwax-stack/        # @nuwax-ai/devkit-stack，任务状态与验收证据
│   ├── nuwax-crew/         # @nuwax-ai/devkit-crew，有限执行器路由
│   ├── nuwa-sdlc-kit/      # 固定配方与仓内规则，保留原包名
│   └── contracts/          # 契约正本与校验模块
├── integrations/
│   ├── dsh-dashboard/      # DSH 原生侧栏/面板，嵌入显式本地 Forge URL
│   └── ds-bot-forge/       # DSH 原生工具桥，仅 prepare/status
├── skills/nuwax-forge/     # 统一薄 Skill
├── scripts/                # 安装、打包、离线集成测试与来源复核
├── docs/                   # 当前用法、专项证据及历史索引
└── provenance/             # 一次性源码导入的历史指纹
```

Stack 集成依赖 `nuwax-crew` 与 `nuwa-sdlc-kit` 兄弟目录名，不能只为统一命名而更改包目录。六包版本见各自 `package.json`；CLI 精确依赖五个兄弟包。兼容命令 `nuwax-devkit` 转发到同一公共入口。

## 身份、执行与原有任务系统

| 对象 | 拥有者与职责 | Forge 接线 |
| --- | --- | --- |
| Chief、Bot、群、记忆、持久 Session | 固定原版 DS-Bot，运行在真实 DSH | `bots plan/prepare/check/run` 准备和启动隔离团队；不复制 Bot 引擎 |
| 一次 Worker 执行 | Forge `agent prepare/run/reconcile` 与既有预算/上下文门 | Codex / DSH fresh headless 适配；进程、用量、预算和验收分别记录 |
| Bot 提出的有限任务 | 操作者预置可信模板；DSH 原生工具注册 | `forge_prepare` 准备新 attempt，`forge_status` 查询明确 attempt；未开放 run/approve/reconcile 工具 |
| PA 用户任务、审批、恢复与交付 | 原 Personal Agent | 看板仅接收显式导出的 TaskSnapshot，不写 PA、不建立第二任务库或审批链 |

Bot 团队不会因安装 Forge 桥而自动获得执行授权。现有桥和 PA 快照适配也不构成 Bot → PA → Forge 的完整业务流程。群成员有独立 Session，但首次群提示会包含该成员自身私聊摘要；[群专项](BOT-GROUP-ROUTING-ACCEPTANCE.md) 记录了这一行为与证据边界。

## 执行与证据流

- `verify`：CLI 按安装位置解析 Stack/Crew → Python runner 读取消费项目的 verification 绑定 → Kit 执行固定配方 → 复核 HEAD、输入指纹、日志和阶段结果 → 既有 TaskStore 导入证据。`--reuse` 仍须通过原有证据复检。
- `agent`：doctor 检查适配协议 → prepare 验证预算 HIGH 和有限上下文 → 显式 run 启动一次执行 → reconcile 记录已有观测。缺失完整用量保持 unknown；已报告下界超限可以与完整结算 unknown 同时成立。
- Bot：Forge 校验固定归档 → DSH 插件管理器安装原包 → 原客户端/roster/groups/memory 管理团队。`check` 只证明版本、文件和配置组合，输出的 host/UI/modelBehavior 保持 not-run。
- 看板：Crew 台账、Stack Assignment、Forge agent 状态、预算快照及 PA 导出 → 显式来源适配 → 本地只读页面。只按结构化证据关联；不跨来源直接求和或从名称猜关系。DSH 插件只展示已允许的 Forge iframe 来源。

`processPassed`、`pluginReady`、任务执行完成、人工交付接收与产品验收是不同证据。退出 0、全 skipped、模拟回复和快照新鲜都不能替代真实产品验收。

## 契约、分发与运行边界

`packages/contracts/schemas/verification-v1.schema.json` 是 verification 契约正本；Stack 分发的自包含副本由 `contracts:sync/check` 保持字节一致。task/runtime 的已实现字段及实际校验器见 [task-runtime-v1.md](../packages/contracts/docs/task-runtime-v1.md)，不以 schema 声明代替运行校验。

CLI 以自身安装位置 `require.resolve` 定位兄弟包，子进程使用 argv 数组。核心依赖 Node >=22、Python >=3.10；六包使用本地预发布版本号。DSH、DS-Bot 和 GUI SDK 属于单独准备的可选运行时，源码具备入口不等于用户已有安装包含它。

默认无 opt-in 环境变量时，安装/测试/打包不运行模型或真实宿主。真实 DSH、固定上游、浏览器与模型验收另行显式运行；[集成测试入口](INTEGRATION-TESTS.md) 列出默认覆盖范围。远程 CI 已运行并覆盖测试、契约校验与打包，不代表部署、安装升级或供应商 token 硬配额。
