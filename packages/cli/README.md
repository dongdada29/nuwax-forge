# @nuwax-ai/devkit-cli（bin: nuwax-devkit）

零依赖 Node ESM（>=22）。定位安装后的同级包用 `require.resolve`，**不硬编码试点/源码绝对路径**；
子进程一律 argv 数组，不经 shell。**本地预发布，不发布。**

```sh
nuwax-devkit help
nuwax-devkit doctor [--json]     # Node>=22 / Python>=3.10 / 5 包绑定；问题非 0 退出；不联网不改全局
nuwax-devkit init --project <外部项目> --recipe <仓内相对配方路径>
nuwax-devkit verify --project <外部项目> --state <仓外状态目录> --task-key <任务键> \
  [--node <可信node绝对路径>] [--python <python解释器>] [--reuse]
nuwax-devkit client-verify --project <client目录> --state <仓外目录> [--node <node>] [--python <python>]
nuwax-devkit run --plan <plan.json> --project <工作目录> --state <仓外目录> --brief-file <有限正文文件>
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

- `nuwax-devkit gui run --recipe <场景.json> --state <仓外目录> --budget-spec <预算.json> --cdp http://127.0.0.1:19222 --sdk <Midscene目录> --runtime <Puppeteer目录> --json`
- `nuwax-devkit budget estimate --spec <预算spec.json> --history <校准.jsonl> --out <预测.json> --json`
- `nuwax-devkit budget reconcile --estimate <预测.json> --actual <本次实耗.json> --history <校准.jsonl> --out <对账.json> --json`

GUI 是显式可选入口，需已有 SDK、认证与授权 CDP；只支持本机附着。默认 install/test/pack 不运行模型。
`budget` 自身离线、零模型调用，输出预测区间、unknown、建议、预算复核及脱敏历史校准；不是供应商硬 token 上限。
实耗可为 GUI manifest、规范分段 usage JSON 或 Claude result。Claude 累计 result 默认只展示；先按同会话 baseline 扣减并明确 run-segment，才能用于单任务预算与校准。

`run` 的声明模型任务与 `gui run` 真实派发前必须通过 HIGH 预算 guard；缺预算、unknown、超限阻断。crew 多步共享余额，未知实耗阻断后续模型步骤；旧未声明模型命令标 `legacy-unmanaged`。有限 context manifest、取消/失败、maxAttempts、安装路径与局限见 [执行预算文档](lib/budget/README.md)。



## 执行预算拦截

`nuwax-devkit run --plan <plan.json> --project <项目> --state <仓外目录> --brief-file <有限交接.txt>`
提供受治理的真实有限执行入口。模型任务必须显式预算与上下文声明；GUI 使用 `--budget-spec`。
启动前按预测 HIGH 拦截，串行步骤共享余额，实耗 unknown 阻断后续；同 taskKey 首版仅一次 attempt，不自动返修续跑。
完整 plan、scope 与取消边界见随包 `lib/budget/README.md`。这不提供供应商内部流式硬 token 上限。
