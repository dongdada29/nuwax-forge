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

用户需要持续观察时，将 `--out "$REPORT_HTML"` 换成 `--serve --port 0 --refresh-seconds 30`。命令前台运行，只监听 `127.0.0.1`，输出 JSON 中的 `url`；页面每 30 秒请求并重新读取指定来源。`port=0` 由系统分配端口，刷新间隔允许 5–3600 秒。停止前台进程即可关闭看板；host-budget 等输入文件本身是快照，除非其生产方更新，否则内容不会变化。

## 如何解释结果

- 按**来源、执行器、角色、声明模型**展示尝试/记录及已知 token；模型字段是任务运行声明，不能当作服务商账单或实际模型身份的独立证明。记录表按来源顺序显示最多 200 条，任务列可能是任务键或宿主会话 ID。
- Crew 同一 `taskKey + attemptId + executor + role + stepIndex` 的派工与终态归并；旧记录缺 `stepIndex` 时按同键顺序配对；缺 `attemptId` 无法可靠去重。历史计数区显示的是**台账记录数**，不是模型请求数。
- Stack 来源读取 Assignment 当前行；旧任务库没有 `assignments` 表时显示未接入，不会迁移库。Forge agent state 仅在 `modelDispatched=true` 时计入，prepare/doctor 不计为调用。
- `host-guard` 的 router/worker 消耗是指定时间窗的观测快照，不含快照之后的调用或最终回复尾部；其他宿主和未提供的运行不会自动出现。
- 未知 token 或调用数显示 `unknown`；真实 0 保留为 0。已知 token 是部分合计；跨来源可能表示同一次运行，**不能直接相加**。来源不全、授权未确认、快照不完整或缺失时，说明覆盖范围，不宣称总量、最终封账或预算通过。

静态 HTML 需要显式重新生成。是否发布、分享或修改平台/安装配置仍取决于用户已授权的范围。
