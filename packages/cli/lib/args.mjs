// 严格参数解析：未知命令/未知 flag/缺值一律拒绝；不猜测、不静默默认。
export class UsageError extends Error {}

export const USAGE = `用法：
  nuwax-devkit help
  nuwax-devkit doctor [--json]
  nuwax-devkit init --project <外部项目目录> --recipe <仓内相对配方路径>
  nuwax-devkit verify --project <外部项目目录> --state <仓外状态目录> --task-key <任务键>
                      [--node <可信node绝对路径>] [--python <python解释器>] [--reuse]
  nuwax-devkit client-verify --project <client目录> --state <仓外状态目录>
                              [--node <可信node绝对路径>] [--python <python解释器>]
  nuwax-devkit run --plan <plan JSON> --project <工作目录> --state <仓外状态目录>
                   --brief-file <有限任务正文> [--python <python解释器>] [--timeout N]
  nuwax-devkit gui run --recipe <GUI 配方 JSON 文件> --state <仓外状态目录>
                       (--cdp <CDP http 端点> | --launch-config <自有实例 JSON>)
                       [--sdk <@midscene/web 位置>] [--runtime <puppeteer-core 位置>]
                       [--budget-spec <预算 JSON>] [--budget-history <仓外校准 JSONL>]
                       [--max-wall-seconds N] [--json]
  nuwax-devkit budget estimate --spec <spec JSON> [--history <校准 JSONL>] [--out <输出 JSON>] --json
  nuwax-devkit budget reconcile --estimate <估算 JSON> --actual <GUI manifest|usage|Claude result JSON>
                               [--history <校准 JSONL>] [--out <输出 JSON>] --json

说明：
  doctor  检查 Node>=22 / Python>=3.10 与 5 个包绑定，不联网、不改全局；有问题退出非 0。
  init    显式 opt-in：调用 nuwa-sdlc-kit verify:init 接线 verification，保留既有 hook/profile。
  verify  调用本包 stack 的 run_verification.py（crew-root 为同安装的 @nuwax-ai/devkit-crew）。
          state 强制在项目仓之外。桥接 JSON 透传；进程 exit 0 不等于产品验收通过。
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
          只读显式给出的文件；--out 不允许覆盖任何输入/源文件（realpath/inode 别名同样拒绝）。`;

export function parseArgs(argv, commands) {
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    return ['help', {}];
  }
  const name = argv[0];
  const spec = commands[name];
  if (!spec) throw new UsageError(`未知命令 ${name}`);
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
