# 实施结果

> 历史归档：2026-10-27 的初期实施记录；下文“待终验”、五包、未提交/未推送等均是当时状态。 当前状态见[文档导航](docs/README.md)，历史资料见[归档索引](docs/archive/README.md)。

日期：2026-10-27（第三轮：独立终验发现的配方父目录 symlink 逃逸漏口已修）。状态：**已交付，待 Codex 独立终验。退出 0 只表示交付完成，不是验收结论。**

环境：Node v24.18.0 / Python 3.15.0 / git 2.54.0 / npm 10.9.2。**默认 install/test/pack/verify 无模型、无 GUI、无登录、无发布**；但本次多包仓实现本身由 Claude Code 真实调用模型完成——这是一次性研发投入，与固定验收段"内部模型调用 0"分开计量：首轮 955.454 秒、Claude CLI `num_turns=91`；第一次返修 751.224 秒、`num_turns=62`。`num_turns` 是原始 CLI 字段，不等同去重模型响应数或供应商请求总量（Codex 已观察首轮 49 个不同 assistant message id；供应商内部重试未知）。只引用上述已给数字与边界，不估算成本。本轮无权限拒绝；未引入外部依赖；三源码包（stack/crew/kit）源代码保持原样（kit 仍仅版本字段改动）。

## 第四轮：终验组合反例修复（记录见 evidence/monorepo-independent-185022/review.json，总状态 false 因本缺陷，保留不改）

**缺陷**：`evaluateProduct({fixture: null/空对象/空 scripts, expectations: {…, requireKnownModelUsage: true}})` 在 `parsed.modelObservation.known` 处抛 TypeError——parseFixture 早退对象缺 `modelObservation`，而此前 null 反例未开启严格计量，缺组合覆盖。

**修复**：`parseFixture` 所有早退统一携带 `tasks: []` 与 `NO_OBSERVATION` 默认形状（known=false + reason"fixture 无效…未观察到"，note 明确 0 指"本无效输入中未观察到"，非真实执行零调用）；`evaluateProduct` 字符串/超限/expectations 早退同样带 summary.modelObservation，主路径 `?? NO_OBSERVATION` 兜底。计量要求与正向断言**均未删减**。

**新增矩阵反例**：6 类无效 fixture（null/空对象/空 scripts/错 schemaVersion/数字/字符串）× 严格与非严格两模式 = 12 组合，全部结构化 `passed:false` 不抛；**对照测试**：完整正确 fixture（具名 groupId/executionId、Boolean=true、完整 usage）在两种模式下都真实 `passed:true`、`known:true`。

## 第三轮：独立终验漏口修复（记录见 evidence/monorepo-independent-184625/review.json，其总状态 false 即本缺陷所致，保留不改）

**缺陷**：`init --recipe 'recipe dir alias/recipe.json'`——最终文件非 symlink，但父目录是指向项目外目录的 symlink；旧 `validateRecipeFile` 只 lstat 最终文件，导致 exit 0 并写入 `.sdlc.json`/runner（违反初审第 9 项仓内配方边界）。

**修复**：`packages/cli/lib/recipe.mjs` 在最终文件 symlink/普通文件检查后，用 `realpathNearestExisting` 把**配方完整 realpath** 与**规范化项目根**比对，`isInside` 不满足即拒绝（init 与 verify 共用该校验，两入口同时收口）；最终文件 symlink 拒绝逻辑不变。

**反例**（`review-fixes.test.mjs` 新增，真实临时 fixture）：仓外目录放合法配方 → 仓内 symlink 父目录 alias → 非零退出、报"逃逸出项目仓"、既有 `.sdlc.json` **字节不变**、不生成 scripts/runner。

**本轮实测**（日志 `evidence/monorepo-author-review/`：`cli-tests-r3-parent-symlink-fix.log`、`npm-test-r3.log`、`pack-r3.log`、`consumer-smoke-r3.log`）：

- CLI suite 18/18；全量 `npm test` **155/155**（55/47/19/16/18），exit 0。
- 干净目录重打包 `/tmp/nuwax-devkit-tarballs-r3`：仅 cli tarball 变化（9.9 KiB，entries=12，sha256=a5c3b71928b5…）；**r2 的旧 cli tgz 已过时**，其余 4 个与 r2 字节一致（contracts 103853c8fa50、crew 94ad0fc010d2、stack 027719c323bb、kit 10983615d9c5）。
- 全新 tmp 消费者离线装 r3 5 tgz → help/doctor/fixture init+verify 全过，exit 0。

## 第二轮：Codex 初审 13 项逐项结果

| # | 反馈 | 结果 |
|---|---|---|
| 1 | evaluateProduct(null) 抛 TypeError | **已修**：null/undefined/数组/数字/字符串 fixture、非字符串 documentTitle、损坏嵌套全部结构化失败；测试 `gui-negative.test.mjs` |
| 2 | Query 空 output 误判通过 | **已修**：只支持 Boolean/Assert，Query 等明确拒绝（"未实现，不虚构"）；期望配置缺 subType/expectOutput 或 expectOutput 非布尔均判无效 |
| 3 | output 与 log 交叉值冲突未检出 | **已修**：Boolean/StatementIsTruthy 两处交叉值存在且冲突即失败；身份内 type/subType 变化即失败 |
| 4 | retry/负数/缺字段的 usage 仍 known=true | **已修**：缺字段/负数/非整数/retry>0/孤儿副本（缺 callId）都判不完整；known=false 时保留 uniqueCalls/tokens 原始观察下界（不伪记 0）；known=true 附注"不表示网络请求硬计量"；跨快照与两处 usage 副本去重保留 |
| 5 | 任务匹配只按 taskId 取首个 | **已修**：同 taskId 多 group/execution 判身份歧义拒绝，需 groupId/executionId 具名；groupId 缺失不能形成产品通过；文档明确本模块仅合成 fixture 判定，不替代真实 target/login 验证 |
| 6 | import 重跑会覆盖整合改动 | **已修**：一次性导入（目标非空即拒绝）；新增只读 `--check` 模式对照 provenance 逐文件复核（kit 版本字段的预期漂移会如实报 1 并退出 1）；`.env`/`.env.*` 全排除仅放行 `.env.example`；源 symlink 跳过并记录（不搬入）；packfiles 由 pack.mjs `tar -tvf` 元数据再查 |
| 7 | bin 传原始 opts 导致 verify 缺 task-key | **第一轮后段已修**（verify.mjs 解构 `'task-key'`），本轮复核实证：fresh/reuse/tamper 集成测试全部通过 |
| 8 | state 检查先于 mkdir + symlink 别名 | **已修**：逐组件 realpath 归一（悬空 symlink 结构化拒绝、指向仓内/devkit 目录的别名拒绝），先于任何 mkdir；禁止 state 写入/覆盖任何 devkit 包目录；测试用**真实 symlink**（非字符串用例）+ 无副作用断言（仓内不留 usage.jsonl） |
| 9 | init 不验配方结构 | **已修**：写入前验证 JSON/最小结构（schemaVersion/id/level/inputs/stages.argv/predicate）/symlink/越界；失败零副作用（.sdlc.json 与 scripts/ 不变），测试断言 |
| 10 | --node/--python 版本未查实际解释器 | **已修**：实际 spawn 探测版本（Node>=22/Python>=3.10），失败发生在创建 state 之前；python 接受 PATH 命令或绝对路径（显式沿 PATH 搜索，不从 cwd 解析）；测试用真实可执行假解释器（v18/乱码/Python 3.9） |
| 11 | pack 的 tar -tf 看不到链接目标、registry 正则漏 mbp128.json | **已修**：`tar -tvf` 元数据核对并**拒绝一切符号链接**（无论目标相对/绝对）；registry 正则改 `registries/mbp[^/]*`（不限目录后缀）；out 按 realpath canonical 校验仓外；npm pack 带 `--ignore-scripts --offline`；只认本轮产物（mtime≥启动时刻 + 目录内预存同名 tgz 即失败，实测该隔离检查确实拦下脏目录重跑） |
| 12 | GUI level 可被普通脚本冒充 | **已修**：CLI 的 init/verify 从 contracts 显式 level 注册取"已实现"集合（当前仅 source-tooling）；gui-* 与未知 level 在**创建 state 之前**拒绝并说明未实现原因；kit/stack 自身通用性不动；反例测试断言失败时 state 目录不存在 |
| 13 | 文档数字与措辞 | **已修**：DSH 两报告 tokens 修正为"每 call 约 3.6k、单报告 2 calls 合计 7310/7297"；"registry 上不存在"改为"本次未发布"（不做查询断言）；CAPABILITIES 计数同步（contracts 16、cli 17、合计 154）；新增"全局方案尚待验证指标"（上下文 fresh/输入 token 下降、外部执行器兼容与跨机、真实构建缓存对比、硬模型预算、远程 CI/真机/打包） |

## 实际执行的命令（全部真实运行，日志在试点 evidence/monorepo-author-review/）

```sh
npm install --ignore-scripts --offline --no-audit --no-fund   # up to date, exit 0
npm test                                                       # 154/154，exit 0
npm run contracts:check                                        # 字节一致 aaebb78c7d5e，exit 0
npm run pack -- --out /tmp/nuwax-devkit-tarballs-r2            # 5 tarball 核对通过，exit 0
node scripts/consumer-smoke.mjs --tarballs /tmp/nuwax-devkit-tarballs-r2   # 全部通过，exit 0
python3 -I scripts/import_from_pilot.py --check                # 只读复核：kit 版本字段 1 处预期漂移，exit 1（按设计）
```

日志：`npm-install.log`、`npm-test.log`、`contracts-check.log`、`pack.log`、`consumer-smoke.log`。

## 测试计数（实测）

| 工作区 | 通过/总数 | 说明 |
|---|---|---|
| nuwax-stack | **55/55** | 源码未动，与试点独立审核一致 |
| nuwax-crew | **47/47** | 源码未动 |
| nuwa-sdlc-kit | **19/19** | 仅版本字段改动 |
| contracts | **18/18** | 原 10 项 + 复审反例 6 项 + 终验矩阵反例与通过对照 2 项 |
| cli | **18/18** | 原 12 项 + 复审反例 5 项 + 终验反例 1 项（配方父目录 symlink 逃逸零副作用） |
| 合计 | **157/157** | 无失败、无跳过（r4 日志 npm-test-r4.log） |

## 打包与消费者（实测）

- 5 tarball → `/tmp/nuwax-devkit-tarballs-r2`（本轮干净目录）：cli 9.8KiB/12 项、contracts 8.7KiB/7、crew 30.2KiB/28、stack 64.7KiB/44、kit 38.8KiB/35；`tar -tvf` 逐条核对：无 registries/mbp*、无 .git、无 .env、无 node_modules、**无任何符号链接**。
- 全新 tmp 消费者（含空格路径）离线装 5 tgz → 已安装 bin：help / doctor 全过 / init 输出实际入口 / verify passed=true、internalModelRequests=0。

## 修改范围（第二轮增量）

- `packages/contracts/gui/midscene-report.mjs`（判定/计量重构）+ `test/gui-negative.test.mjs`（新增）+ 原 contracts 测试同步。
- `packages/cli`：新增 `lib/recipe.mjs`（配方结构+level 门，level 注册来自 contracts）、`lib/env.mjs`（解释器探测）、`lib/paths.mjs`（resolveStateReal 逐组件 realpath）；`verify.mjs`/`init.mjs`/`doctor.mjs` 重排校验顺序（state 创建前完成全部拒绝）；`test/review-fixes.test.mjs`（新增）。
- `scripts/import_from_pilot.py`（一次性导入 + --check + .env.* + symlink 跳过）、`scripts/pack.mjs`（tar -tvf 拒链接、正则、canonical out、本轮产物隔离、--ignore-scripts --offline）。
- 文档：CAPABILITIES/DSH/MIGRATION 按第 13 项修正；README 无需改命令面。

## 限制与不声称（不变项 + 本轮补充）

- 未生产安装、未发布、未推送；新仓 git init 无 commit/remote；源仓与试点目录除授权日志目录外未动。
- GUI live driver 未实现、无 live 命令；GUI level 被统一 CLI 显式拒绝（原因写明）；fixture 校验器仅合成数据，不替代真实 target/origin/login 验证。
- maxModelRequests 仍仅观测预算；usage 计量只保留观察下界，known 语义不含网络请求硬计量。
- client 全量非全绿（基线 404 项 5 失败）；打包/设备/GUI 未验；构建提速未证明；远程 CI 未运行。
- 源三仓无 LICENSE：新包 UNLICENSED，不虚构。
