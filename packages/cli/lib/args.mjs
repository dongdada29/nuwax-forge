// 严格参数解析：未知命令/未知 flag/缺值一律拒绝；不猜测、不静默默认。
export class UsageError extends Error {}

export const USAGE = `用法：
  nuwax-forge crew <route|patrol|trigger|usage|ledger|health|verify> [参数；子命令 --help 查看]
  nuwax-forge stack module --name <runtime-guard|triage|autonomous-run|...>
  nuwax-forge stack runtime --command <check|lease|context|backoff|dispatch|record> --profile <profile.json> [--input <JSON>]
  nuwax-forge stack task-state --command <trigger-record|trigger-read|ticket-admit|ticket-read|assignment-prepare|assignment-start|assignment-report|assignment-finish> --input <JSON 文件>
  nuwax-forge help
  nuwax-forge dsh-plugin <add|remove|inspect|run> --profile <DSH profile> [--package <npm包或路径>] [--binary <dsh>]
            run 可加 --startup-binding <绝对路径绑定JSON>：宿主 exit 0 不足以证明插件就绪，
            按启动证据评估，未就绪时退出码置 1（详见 lib/dsh-task-evidence.mjs）
  nuwax-forge bots <plan|prepare|check|run> --root <独立绝对目录> --dsh <DSH绝对路径> [--json]
  nuwax-forge bots run --root <已准备目录> --dsh <DSH绝对路径> [--port <0..65535>] [--open]
  nuwax-forge dashboard --ledger <JSONL> --registry <JSON> (--out <HTML> | --serve) [--port <0..65535>] [--refresh-seconds <5..3600>] [--health <JSON>] [--matrix <JSON>] [--task-store <tasks.sqlite>] [--agent-state <state目录>] [--agent-state-root <目录>] [--host-budget <guard.json>] [--approval-store <approvals.sqlite>] [--personal-agent-snapshot <PA 导出 JSON>] [--embed-origin <DSH Web origin>] [--python <解释器>]
  nuwax-forge doctor [--json]
  nuwax-forge agent doctor --runtime <codex|deepseek-harness> [--binary <可信绝对路径>] --json
  nuwax-forge agent prepare --spec <agent JSON> --brief-file <短任务书> --state <新仓外目录>
  nuwax-forge agent [run|reconcile] --state <已准备仓外目录>
  nuwax-forge agent [start|status|cancel] --state <同一已准备仓外目录>
  nuwax-forge init --project <外部项目目录> --recipe <仓内相对配方路径>
  nuwax-forge verify --project <外部项目目录> --state <仓外状态目录> --task-key <任务键>
                      [--node <可信node绝对路径>] [--python <python解释器>] [--reuse]
  nuwax-forge client-workflow [run|seal] --spec <JSON> --state <fresh仓外目录>
  nuwax-forge client-verify --project <client目录> --state <仓外状态目录>
                              [--node <可信node绝对路径>] [--python <python解释器>]
  nuwax-forge run --plan <plan JSON> --project <工作目录> --state <仓外状态目录>
                   --brief-file <有限任务正文> [--python <python解释器>] [--timeout N]
  nuwax-forge gui run --recipe <GUI 配方 JSON 文件> --state <仓外状态目录>
                       (--cdp <CDP http 端点> | --launch-config <自有实例 JSON>)
                       [--sdk <@midscene/web 位置>] [--runtime <puppeteer-core 位置>]
                       [--budget-spec <预算 JSON>] [--budget-history <仓外校准 JSONL>]
                       [--max-wall-seconds N] [--json]
  nuwax-forge budget estimate --spec <spec JSON> [--history <校准 JSONL>] [--out <输出 JSON>] --json
  nuwax-forge budget reconcile --estimate <估算 JSON> --actual <GUI manifest|usage|Claude result JSON>
                               [--history <校准 JSONL>] [--out <输出 JSON>] --json
  nuwax-forge budget guard --sessions <codex 会话 JSONL 文件或目录> --budget <预算 JSON>
                            [--marker <起点标记文本>] [--parent-id <宿主线程 id>] --json

说明：
  dashboard  从显式本地数据生成 HTML；--serve 前台只监听 127.0.0.1，页面按访问读取最新数据；未知实耗单列。
  dsh-plugin  委托已安装的 DSH 宿主管理/运行插件；插件仍在 DSH 中运行，不注入 Forge 进程。
  bots    原版 DS-Bot 的隔离团队；prepare 可加 --tarball <原始tgz>。run 前台启动，Ctrl-C 停止；
          仅显式 --open 打开浏览器，run 不支持 --json。首次使用见 docs/BOT-QUICKSTART.md。
          prepare --forge-config <操作者绝对JSON> 显式组合既有 Forge 原生桥；默认关闭。
          后续 check/run 自动复用绑定配置并拒绝漂移，见 docs/BOT-BRIDGE-COMPOSITION.md。
  doctor  检查 Node>=22 / Python>=3.10 与 6 个包绑定，不联网、不改全局；有问题退出非 0。
  init    显式 opt-in：调用 nuwa-sdlc-kit verify:init 接线 verification，保留既有 hook/profile。
  verify  调用本包 stack 的 run_verification.py（crew-root 为同安装的 @nuwax-ai/devkit-crew）。
          state 强制在项目仓之外。桥接 JSON 透传；进程 exit 0 不等于产品验收通过。
  stack task-state  单次本机 SQLite Trigger/Ticket/Assignment 记账；只读写状态，不执行 argv、模型或平台操作。
                    输入是至多 64 KiB JSON 文件，含仓外 stateDirectory 与 repoRoot；授权字段仅作本机记录。
  client-verify  固定 client source-tooling 配方，新鲜执行并输出短 JSON；完整日志位于 state。
  run     显式执行 crew plan。mode=model/modelTask=true 的任务必须有 budgetSpec 和
          budget.maxTokens；HIGH 超限/预测 unknown 在 spawn 前 blocked。步间未知实耗
          阻断后续模型步骤；公开 run 必需 model/no-model 声明，旧 Python 未声明命令
          标 legacy-unmanaged；显式固定配方标 declared-no-model。
  gui     显式 live GUI 验证（gui-product-scenario / gui-toolchain-smoke）：与 verify 分开，
          默认安装/测试不触发、不装 Midscene、不联网、不自动登录。SDK 与 puppeteer 运行时
          由 --sdk/--runtime（或 NUWAX_MIDSCENE_SDK/NUWAX_MIDSCENE_PUPPETEER）显式指定；
          认证用环境 MIDSCENE_MODEL_AUTH_MODE=siwc 等既有声明，缺失→blocked 交用户完成。
          退出码 0=passed（仅本次实际执行+断言校验）1=failed 2=用法 3=blocked 4=前置错误。
          runner 子进程组有 maxWallSeconds 真实硬超时；外部附着应用不会被关闭。
          含 AI 步骤必需 --budget-spec，缺预算/预测 unknown/HIGH 超限不派发 runner。
  budget  离线 token 预算（预测自身 0 次模型调用、不联网）：estimate 按 spec 做多轮增长/
          缓存子集/视觉 unknown 建模（unknown 不冒充 0、不放行预算）；reconcile 对照实耗并区分
          cache 口径（Claude excludes-cache vs usage includes-cache），把脱敏校准样本（数字/ids/
          模型/任务类型/来源 hash，无 prompt/截图/凭据）按 estimateId+sourceHash 去重追加进 --history。
          只读显式给出的文件；--out 不允许覆盖任何输入/源文件（realpath/inode 别名同样拒绝）。
  budget guard  宿主 Codex 会话 token 守卫（离线、0 模型调用、只读、绝不隐式读 ~/.codex）：
          解析会话 JSONL 的 token_count 事件（取最后值），宿主自 marker 起差额 +
          parent_thread_id 匹配的 worker 会话合计，与预算相位阈值（stopBefore/parent/
          executor/reserve/wall）比对；归一口径复用 actual.mjs（includes-cache：total=
          input+output）。这是相位门不是供应商硬顶：快照尾部与在途调用未知。退出码：
          0=within，2=超限（over），3=数据不足/unknown；1=预算 JSON/路径等数据错误。`;

export function parseArgs(argv, commands) {
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    return ['help', {}];
  }
  const name = argv[0];
  const spec = commands[name];
  if (!spec) throw new UsageError(`未知命令 ${name}`);
  // Modules with an established strict parser keep their command-specific rules.
  if (spec.parse) return [name, spec.parse(argv.slice(1))];
  const options = {};
  const flags = spec.flags ?? {};
  let i = 1;
  for (; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      // 仅允许命令声明的第一个子命令词（如 `gui run`），其余位置参数一律拒绝
      if (i === 1 && spec.subcommands?.includes(token)) { options.subcommand = token; continue; }
      throw new UsageError(`未知位置参数 ${token}`);
    }
    const key = token.slice(2);
    const kind = flags[key];
    if (kind === undefined) throw new UsageError(`${name} 不支持 --${key}`);
    if (kind === 'boolean') {
      options[key] = true;
    } else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--') || value.length === 0) {
        throw new UsageError(`--${key} 需要一个非空值`);
      }
      options[key] = value;
      i++;
    }
  }
  return [name, options];
}
