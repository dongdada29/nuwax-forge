# 运行看板与用量口径

当用户需要查看任务、Router/Worker、模型或订阅的使用分布时，使用此流程。看板可生成一次性本地 HTML，也可显式 `--serve` 在前台开启本机页面；不调用模型、不访问外网、不自动发布。只读取已授权且明确指定的本机数据；不要默认扫描其他会话或主机。

## 先确认能力与输入

1. 使用当前宿主加载的 `nuwax-forge` Skill 目录下 `scripts/forge.mjs`，运行 `node <本Skill>/scripts/forge.mjs help`，确认存在 `dashboard`。旧安装可能不支持；如不存在，报告当前安装未具备该能力，不把源码工作树或其他机器的路径当作已安装版本，也不自行修改受管安装。
2. 至少确定 Crew JSONL 台账、执行器注册表 JSON、HTML 输出路径。路径来自用户或已核对的工作台配置；不要硬编码某个机器、Agent ID、版本目录或账号。输出不得覆盖输入，也不要包含或发送凭据、会话正文和未经授权的内容。
3. 按需补充：`--health` 执行器健康 JSON、`--matrix` 任务矩阵 JSON、`--task-store` Stack 的 `tasks.sqlite` 文件、`--agent-state` 单次 Forge agent state 目录、`--agent-state-root` 包含多次 state 的目录（仅直接子目录）、`--host-budget` Codex `budget guard --json` 输出。各项都显式指定；不存在或未接入的来源要单独说明。

例如，将 `ENTRY` 设为技能加载器提供的本 Skill 的 `scripts/forge.mjs` 路径，将其余变量设为当前工作台已确认的路径：

```sh
node "$ENTRY" dashboard --ledger "$CREW_LEDGER" --registry "$CREW_REGISTRY" --out "$REPORT_HTML" \
  --task-store "$TASKS_SQLITE" --agent-state-root "$AGENT_RUNS" --host-budget "$HOST_GUARD_JSON"
```

上例的可选参数只在对应来源真实存在时传入。`--host-budget` 是独立产生的 guard JSON 快照；guard 的 `over` 或 `unknown` 不等于通过预算门。任务矩阵未提供时，原任务看板为空，但台账仍可显示任务键。

用户需要持续观察时，将 `--out "$REPORT_HTML"` 换成 `--serve --port 0 --refresh-seconds 5`。命令前台运行，只监听 `127.0.0.1`，输出 JSON 中的 `url`；页面每 5 秒重新读取指定来源，也可点击“立即刷新”，并显示刷新结果与台账最后写入时间。`port=0` 由系统分配端口，刷新间隔允许 5–3600 秒。停止前台进程即可关闭看板；台账或 host-budget 等输入本身未更新时，刷新不会产生新记录。

服务看板默认展示运行总览和执行器分布图；可切换路由、任务、模型与执行器及派工明细，表格超过 10 条时分页，刷新保留当前视图和页码。进行中仅表示来源记录的状态，不证明对应进程仍存活。一次性静态 HTML 展示全部区块，不提供实时刷新和视图切换。

已授权工作台可显式传入 `--approval-store <state/runtime/approvals.sqlite>`。启用后看板有“任务审批”页，展示目标、范围、验收、简报、执行器及方案指纹；只有本人通过看板按钮进行决定。Agent 不得调用接口替用户审批或修改审批账本；待审批、拒绝及未知状态均不得开工。审批只绑定该次方案和简报，方案变化须重新审批。该本机协作门不是平台身份认证，也不能单独限制平台直接工具调用。

## 如何解释结果

- 按**来源、执行器、角色、声明模型**展示尝试/记录及已知 token；模型字段是任务运行声明，不能当作服务商账单或实际模型身份的独立证明。记录表按来源顺序显示最多 200 条，任务列可能是任务键或宿主会话 ID。
- Crew 同一 `taskKey + attemptId + executor + role + stepIndex` 的派工与终态归并；旧记录缺 `stepIndex` 时按同键顺序配对；缺 `attemptId` 无法可靠去重。历史计数区显示的是**台账记录数**，不是模型请求数。
- Stack 来源读取 Assignment 当前行；旧任务库没有 `assignments` 表时显示未接入，不会迁移库。Forge agent state 仅在 `modelDispatched=true` 时计入，prepare/doctor 不计为调用。
- `host-guard` 的 router/worker 消耗是指定时间窗的观测快照，不含快照之后的调用或最终回复尾部；其他宿主和未提供的运行不会自动出现。
- 路由关系仅在 host-guard 明确提供宿主和 Worker 时展示具体关联；其他来源没有 Router 身份时显示“未记录”，不要根据任务名推测父子关系。
- 引擎列表从当前注册表的启动命令识别载体并展示配置提供方；历史执行标签、当前配置和历史实际模型是不同字段。OMP、DSH 等显示“已登记”不代表 Forge 的 `agent` 入口已实现其适配或当前调用成功。
- Crew 一次执行的分支、提交、PR 可由执行器在 `NUWAX_CREW_STEP_ARTIFACTS/delivery.json` 写入，例如 `{"branch":"feature/example","commit":"abc1234","prUrl":"https://github.com/org/repo/pull/1"}`，字段可省略。仅该次执行明确报告的结果被采集，属于未独立验证的执行器声明；不从任务名、当前工作区 HEAD 或其他来源推断，也不自动执行提交、推送或创建 PR。其他来源只有明确存储同名结构化字段时才展示。
- 未知 token 或调用数显示 `unknown`；真实 0 保留为 0。已知 token 是部分合计；跨来源可能表示同一次运行，**不能直接相加**。来源不全、授权未确认、快照不完整或缺失时，说明覆盖范围，不宣称总量、最终封账或预算通过。

静态 HTML 需要显式重新生成。是否发布、分享或修改平台/安装配置仍取决于用户已授权的范围。

看板实现位于独立的 `packages/dashboard`，`web/` 是可复用客户端资源，本地服务保留 loopback 边界；数据源通过显式适配器注册，不自动加载外部代码。当前未实现 Electron 客户端或将 DSH 的插件界面嵌入看板。
