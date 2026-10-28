# 迁移与来源（provenance）

状态：**已执行**。导入工具与排除规则固化在 [scripts/import_from_pilot.py](../scripts/import_from_pilot.py)，
逐文件 SHA256 记录在 [provenance/provenance.json](../provenance/provenance.json)。

## 源与目标

| 源（只读） | 目标 | 源 HEAD | dirty 项 |
|---|---|---|---|
| `client-efficiency-pilot/worktrees/nuwax-stack`（分支 codex/client-efficiency-pilot） | `packages/nuwax-stack` | `ac083fcf7823a983be520d13083ea98bb555ca40` | 8（含 6 个未跟踪实现/测试文件） |
| `client-efficiency-pilot/worktrees/nuwax-crew`（同分支） | `packages/nuwax-crew` | `5aaf05ca1d23f87c1908d0a025f12eb74d2910a2` | 11（含 observability 等未跟踪实现） |
| `client-efficiency-pilot/worktrees/nuwa-sdlc-kit`（同分支） | `packages/nuwa-sdlc-kit` | `1660abfed2136353f05d766ee7771e3d73b19de8` | 4（含 kit/engine/verify.mjs 未跟踪实现） |

源仓是含重要未跟踪实现的 worktree，**不能只 git archive**；导入按文件系统复制（含 dot 配置：
`.githooks/`、`.gitignore/`、`.github/`）。原仓、原试点目录、client 与全局配置**均未修改**；
原仓历史不动。新仓 `git init`，**无 commit、无 remote**。

## 排除规则

复制时排除：`.git`、`node_modules`、`dist`、`__pycache__`、`*.pyc`、`.DS_Store`、`debug-shots`、
`midscene_run`、运行证据目录、凭据类 env 文件、真实 registry（`registries/` 下非 example 文件，
即 mbp128-20261022.json 一类）。合成 examples（`examples/*.json`、`registry.example.json`）保留。
排除明细逐条记录在 provenance.json 的 `excluded` 数组。

## 为整合做的最小改动（全部列尽）

1. 新增根 `package.json`（workspaces）与 `packages/nuwax-stack`、`packages/nuwax-crew` 的
   `package.json`（仅元数据 + 测试脚本，源码零改动）。
2. `packages/nuwa-sdlc-kit/package.json`：仅 `version` 从 `1.5.0` 改为 `1.5.0-devkit-local.1`
   （`kit/VERSION` 保持 1.5.0，发布线兼容；其余字段含授权声明/repository 原样保留）。
3. 新增 `packages/contracts`、`packages/cli`、根 `scripts/`、`docs/`、`provenance/`、
   `.github/workflows/ci.yml`、`.gitignore`、根/包 README。
4. **没有**修改 stack/crew/kit 的任何 Python/JS 源码、测试或文档内容；
   55/47/19 三套测试与源仓逐一相同地通过。

## LICENSE 边界

源三仓未包含 LICENSE 文件，**不得虚构**：新包 license 记为 `UNLICENSED`（不发布前提下的占位，
非授权声明）。kit 自带 MIT 声明字段随源保留。试点验收文档中的授权与执行边界声明在迁入文档中保留原文引用。

## provenance 复核

```sh
python3 -I scripts/import_from_pilot.py --check   # 只读：对照 provenance.json 逐文件复核 sha256，报告漂移
shasum -a 256 <文件>                              # 与 provenance.json 的 fileSha256 抽查比对
```

导入是**一次性**的：目标包目录非空即拒绝重跑，防止覆盖整合后的改动；复核一律走只读 `--check`
（整合改动会显示为预期内漂移）。源 symlink 不搬入新仓（跳过并记录）；`.env`/`.env.*` 全部排除，
仅放行合成 `.env.example`。
