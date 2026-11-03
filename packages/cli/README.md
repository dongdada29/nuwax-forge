# @nuwax-ai/devkit-cli（bin: nuwax-forge）

零依赖 Node ESM（>=22）。定位安装后的同级包用 `require.resolve`，**不硬编码试点/源码绝对路径**；
子进程一律 argv 数组，不经 shell。**本地预发布，不发布。**

```sh
nuwax-forge help
nuwax-forge doctor [--json]     # Node>=22 / Python>=3.10 / 5 包绑定；问题非 0 退出；不联网不改全局
nuwax-forge init --project <外部项目> --recipe <仓内相对配方路径>
nuwax-forge verify --project <外部项目> --state <仓外状态目录> --task-key <任务键> \
  [--node <可信node绝对路径>] [--python <python解释器>] [--reuse]
nuwax-forge client-verify --project <client目录> --state <仓外目录> [--node <node>] [--python <python>]
nuwax-forge run --plan <plan.json> --project <工作目录> --state <仓外目录> --brief-file <有限正文文件>
```

- `init`：显式 opt-in，调用 `@nuwax-ai/nuwa-sdlc-kit` 的 `verify:init`；只接线 verification，
  保留既有 hook/profile/配方；成功后输出实际入口（绑定文件/配方/运行器）。
- `verify`：调用本安装 `@nuwax-ai/devkit-stack` 的 `run_verification.py`，crew-root 指向同安装
  `@nuwax-ai/devkit-crew`；`--state` 强制在项目仓外；`--node` 缺省用运行 CLI 的当前 Node。
  桥接 JSON 透传；**进程 exit 0 不等于产品验收通过**——CLI 核对 `passed===true` 才退出 0。
- `client-verify` 固定校验 client-tooling 配方，始终新鲜执行，校验日志及 TaskStore，输出短 JSON；
  完整日志在 state，源码工具层通过不代表 GUI、产品构建或打包通过；不启动模型。
- 未知命令/未知 flag/缺值一律拒绝（退出 2）。
- 环境变量 `NUWAX_DEVKIT_RESOLVE_ROOT`（仅诊断/测试：限定包解析根）、
  `NUWAX_DEVKIT_PYTHON`（doctor 的解释器候选）。

测试：`npm test`（单元 + 临时 Git 消费者集成：fresh/reuse/tamper、空格路径、显式 Node、
state 仓外、缺依赖、非法参数）。


## 可选 GUI 与离线 token 预算

- `nuwax-forge gui run --recipe <场景.json> --state <仓外目录> --budget-spec <预算.json> --cdp http://127.0.0.1:19222 --sdk <Midscene目录> --runtime <Puppeteer目录> --json`
- `nuwax-forge budget estimate --spec <预算spec.json> --history <校准.jsonl> --out <预测.json> --json`
- `nuwax-forge budget reconcile --estimate <预测.json> --actual <本次实耗.json> --history <校准.jsonl> --out <对账.json> --json`

GUI 是显式可选入口，需已有 SDK、认证与授权 CDP；只支持本机附着。默认 install/test/pack 不运行模型。
`budget` 自身离线、零模型调用，输出预测区间、unknown、建议、预算复核及脱敏历史校准；不是供应商硬 token 上限。
实耗可为 GUI manifest、规范分段 usage JSON 或 Claude result。Claude 累计 result 默认只展示；先按同会话 baseline 扣减并明确 run-segment，才能用于单任务预算与校准。

`run` 的声明模型任务与 `gui run` 真实派发前必须通过 HIGH 预算 guard；缺预算、unknown、超限阻断。crew 多步共享余额，未知实耗阻断后续模型步骤；旧未声明模型命令标 `legacy-unmanaged`。有限 context manifest、取消/失败、maxAttempts、安装路径与局限见 [执行预算文档](lib/budget/README.md)。



## 执行预算拦截

`nuwax-forge run --plan <plan.json> --project <项目> --state <仓外目录> --brief-file <有限交接.txt>`
提供受治理的真实有限执行入口。模型任务必须显式预算与上下文声明；GUI 使用 `--budget-spec`。
启动前按预测 HIGH 拦截，串行步骤共享余额，实耗 unknown 阻断后续；同 taskKey 首版仅一次 attempt，不自动返修续跑。
完整 plan、scope 与取消边界见随包 `lib/budget/README.md`。这不提供供应商内部流式硬 token 上限。

`client-workflow [run|seal] --spec /absolute/spec.json --state /absolute/fresh-state`
提供可安装的固定 client source-tooling 流程，默认 direct（0 模型请求）；显式 compare 才允许 fresh Codex 执行器和唯一模型基准。spec 必须显式声明解释器、Codex/session/host 标识及完整预算。seal 按指定 task_complete 手动幂等封账；pending/unknown 不写 final。详细配置、网络与验收边界见仓库 `docs/CLIENT-WORKFLOW.md`。

## 独立客户端 Agent（Codex / DeepSeek Harness）

`nuwax-forge agent doctor|prepare|run|reconcile` 提供两个真实的一次性 headless 适配器，复用现有 `budget/execution.mjs`。默认安装、测试、doctor 和 prepare 均不调用模型；只有显式 `agent run` 会派发付费模型任务。使用步骤、完整 spec、权限和用量边界见 [CLIENT-AGENTS.md](../../docs/CLIENT-AGENTS.md)。`completed` 表示本次执行完成且 token 结算通过，产品验收始终单列 `acceptancePassed:null`。

## 离线统一安装与薄 Skill

在源码仓运行 `node scripts/build-bundle.mjs --out <新的仓外绝对目录>`，将整个目录分发后使用 `node <bundle>/install.mjs install --host codex|deepseek-harness|nuwax`。可显式指定 `--root`、Codex/DSH 的 `--host-root` 或 Nuwax 的 `--workspace`。完整路径、发现机制、升级/rollback/uninstall 与保留备份规则见分发包 `docs/INSTALLATION.md`（源码为 `docs/INSTALLATION.md`）。安装只做本地 doctor，不运行模型，不发布平台技能。

## 运行看板

`nuwax-forge dashboard` 复用 Crew 本地 HTML 看板，显式传入数据源：

```sh
nuwax-forge dashboard --ledger /path/crew-usage.jsonl --registry /path/executors.json \
  --task-store /path/tasks.sqlite --agent-state-root /path/agent-runs --out /path/dashboard.html
```

`--task-store`、`--agent-state-root`、`--agent-state`、`--host-budget`、`--health`、`--matrix` 均可省略；agent-state-root 只读取一层直接子目录，agent-state 指向单次运行目录；host-budget 接受 `nuwax-forge budget guard --json` 的输出，按 router 与 worker 展示该快照。仅读本地文件，不调用模型或平台；输出不得覆盖输入。旧任务库没有 Assignment 表时显示未接入，不迁移数据库。

按来源、执行器、角色和声明模型展示任务与用量。Crew 同一尝试的派工及结果事件按 attempt/step 关联；没有 attemptId 的历史记录无法可靠去重。不同来源可能记录同一次执行，分别显示，不作跨来源总和。未知 token 和模型调用数显示 unknown，已知的 0 保留为 0；模型名是运行声明，不代表供应商账单或完整宿主消耗。host-budget 的任务列是宿主会话 ID，快照不含之后的消耗；看板不会自动发现其他主机会话，静态页面不会自动发布或刷新。

需要持续观察时，将 `--out` 换成 `--serve --port 0 --refresh-seconds 30`。该命令前台监听 `127.0.0.1`，输出 URL；页面请求时重新读取已指定来源，浏览器按间隔刷新。快照输入（例如 host-budget）只有文件本身更新才变化。结束前台进程即可关闭。
