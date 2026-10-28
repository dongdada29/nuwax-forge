/**
 * SDLC 门禁（nuwa-sdlc-kit 的 ACP 层实现）。
 *
 * 定位：项目目录维度（读工作区根 .sdlc.json），对经 ACP `session/request_permission`
 * 进入的工具调用做两类确定性判定——秘钥护栏（guard-paths 同规则）与计划门禁
 * （plan-gate 同规则：源码区首改且无在途 plans/specs 工件时转 ask）。
 * 平台侧一次实现，所有经 nuwa-cli serve 接入的引擎（codex/zcode/claude/pi/opencode）统一生效；
 * 各 CLI 的 .claude hooks 与本模块互为冗余，规则同源不冲突。
 *
 * 安全缺省：.sdlc.json 缺失/解析失败/git 不可用 → 一律放行（fail-open，只服务不添乱）。
 * slim 档（kit v1.5.0+）：.sdlc.json 不写 srcPaths → isSrcEdit 恒 false，计划 ask 天然静默；
 * 秘钥/受保护路径拦截不受 profile 影响，始终生效。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, relative, isAbsolute, resolve, sep } from "node:path";

export interface SdlcGateInput {
  /** ACP request_permission.toolCall.rawInput（工具原始入参） */
  rawInput?: Record<string, unknown> | null;
  /** ACP request_permission.toolCall.title（rawInput 缺失时的兜底文本） */
  title?: string | null;
  /** ACP sessionId —— 用于 plan-gate 会话内只问一次的记账 */
  sessionId?: string | null;
  /** 工作区根（默认 process.cwd()；serve 多工作区时由调用方传入会话 cwd） */
  cwd?: string;
}

export type SdlcGateDecision = "deny" | "ask" | "pass";

export interface SdlcGateResult {
  decision: SdlcGateDecision;
  reason?: string;
}

interface SdlcConfig {
  name?: string;
  srcPaths?: string[];
  plansDirs?: string[];
  protectedWrite?: string[];
  envPrefix?: string;
  secrets?: { extraPatterns?: string[] };
}

const configCache = new Map<string, SdlcConfig | null>();

function loadConfig(cwd: string): SdlcConfig | null {
  if (configCache.has(cwd)) return configCache.get(cwd) ?? null;
  let cfg: SdlcConfig | null = null;
  try {
    cfg = JSON.parse(readFileSync(resolve(cwd, ".sdlc.json"), "utf8")) as SdlcConfig;
  } catch {
    cfg = null;
  }
  configCache.set(cwd, cfg);
  return cfg;
}

/** 测试与长驻进程可清缓存（.sdlc.json 变更后生效）。 */
export function resetSdlcGateCache(): void {
  configCache.clear();
}

function normRel(cwd: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  return relative(cwd, abs).split(sep).join("/");
}

const PATH_SECRET = [
  /(^|[\\/])\.env(\.[^\\/]+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.(pfx|p12)$/i,
  /(^|\/)(id_rsa|id_ed25519|id_ecdsa)$/i,
  /credential/i,
  /secret[s]?\.(json|ya?ml|txt)$/i,
];
const BUILD_NOISE =
  /(^|\/)(node_modules|buildtrees|vcpkg_installed|target|dist)\//;

/** 判定秘钥命中；rawInput.file_path 优先，其次 title 兜底（仅拦文本里像路径的那部分场景靠 file_path，title 只查独立 .env 令牌）。 */
function secretsHit(cfg: SdlcConfig, input: SdlcGateInput): boolean {
  const extra = (cfg.secrets?.extraPatterns ?? []).map((s) => new RegExp(s, "i"));
  const patterns = [...PATH_SECRET, ...extra];
  const fpRaw = typeof input.rawInput?.file_path === "string" ? input.rawInput.file_path : "";
  if (fpRaw) {
    const c = normRel(input.cwd ?? process.cwd(), fpRaw);
    if (!/\.(example|sample|template)$/i.test(c) && !BUILD_NOISE.test(c) && patterns.some((re) => re.test(c))) {
      return true;
    }
  }
  const title = typeof input.title === "string" ? input.title : "";
  if (title) return /(^|[\s'"=;|&(])\.env(\.[A-Za-z0-9_-]+)?(?=$|[\s'"|;&)])/.test(title);
  return false;
}

function protectedHit(cfg: SdlcConfig, input: SdlcGateInput): string | null {
  const list = cfg.protectedWrite ?? [];
  if (!list.length) return null;
  const fpRaw = typeof input.rawInput?.file_path === "string" ? input.rawInput.file_path : "";
  if (!fpRaw) return null;
  const c = normRel(input.cwd ?? process.cwd(), fpRaw);
  return list.includes(c) ? c : null;
}

function plansInflow(cwd: string, dirs: string[]): boolean {
  try {
    const out = execFileSync("git", ["status", "--porcelain", "--", ...dirs], {
      cwd,
      encoding: "utf8",
    });
    return out.trim().length > 0;
  } catch {
    return true; // git 不可用：宁放勿拦
  }
}

function sessionAsked(cwd: string, envPrefix: string, sessionId?: string | null): boolean {
  if (!sessionId) return false;
  const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_");
  const marker = resolve(cwd, ".claude/cache/plan-gate", `${safe}.flag`);
  if (existsSync(marker)) return true;
  try {
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, new Date().toISOString());
  } catch {
    /* 记不了账就每次都问，可接受 */
  }
  void envPrefix;
  return false;
}

/**
 * 主入口：对一次 ACP 权限请求做 SDLC 判定。
 * - deny：秘钥目标（含受保护写路径）——直接拒；
 * - ask ：源码区编辑但无在途 plans/specs 工件（同会话只问一次）——交由上层 onAsk/交互通道；
 * - pass：其余。
 */
export function evaluateSdlcGate(input: SdlcGateInput): SdlcGateResult {
  const cwd = input.cwd ?? process.cwd();
  const cfg = loadConfig(cwd);
  if (!cfg) return { decision: "pass" }; // 项目未装 kit：fail-open

  if (secretsHit(cfg, input)) {
    return {
      decision: "deny",
      reason: `[sdlc-guard:${cfg.name ?? cwd}] 疑似秘钥目标，凭证不得进入会话与 diff（规则源 .sdlc.json）。`,
    };
  }
  const prot = protectedHit(cfg, input);
  if (prot) {
    return {
      decision: "deny",
      reason: `[sdlc-guard:${cfg.name ?? cwd}] 「${prot}」为受保护路径（.sdlc.json protectedWrite），请人工评审后修改。`,
    };
  }

  const fpRaw = typeof input.rawInput?.file_path === "string" ? input.rawInput.file_path : "";
  const srcPaths = cfg.srcPaths ?? [];
  const isSrcEdit = fpRaw !== "" && srcPaths.some((p) => new RegExp(p).test(normRel(cwd, fpRaw)));
  if (isSrcEdit) {
    const prefix = cfg.envPrefix ?? "SDLC";
    if (process.env[`${prefix}_SKIP_PLAN_GATE`] === "1") return { decision: "pass" };
    const dirs = cfg.plansDirs ?? ["plans", "specs"];
    if (!sessionAsked(cwd, prefix, input.sessionId) && !plansInflow(cwd, dirs)) {
      return {
        decision: "ask",
        reason: `[sdlc-plan:${cfg.name ?? cwd}] 源码「${normRel(cwd, fpRaw)}」编辑但无在途 ${dirs.join("/")} 工件：新任务请先按 templates/plan.md 建计划；计划内小修重试即可放行（同会话一次）；停用 ${prefix}_SKIP_PLAN_GATE=1。`,
      };
    }
  }
  return { decision: "pass" };
}
