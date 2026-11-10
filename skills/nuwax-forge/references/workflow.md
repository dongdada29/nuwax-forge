# 原生宿主任务推进与审批闭环

适用于 Nuwax 的既有 Agent/Loop，也可由 Codex/DSH 主控显式调用。不新增轮询服务或执行引擎。`ENTRY` 是当前 Skill 的 `scripts/forge.mjs`；平台部署可以使用其已注册的稳定 launcher。每次先从当前 profile 读取路径，不沿用消息里的旧版本号。

每次唤醒先真实环境 check、获取运行租约，再调用：

```sh
node "$ENTRY" stack workflow --command sync --profile "$PROFILE"
node "$ENTRY" stack workflow --command next --profile "$PROFILE"
```

`sync` 只把真实人工审批决定同步到原任务检查点，不做审批。`next` 只读原 TaskStore 与正式审批库，最多给出一个业务动作。没有新群消息也必须检查积压任务；环境 check、轮换复查、SAME、更新时间和写摘要不能当作业务推进。

| next.action | 本轮动作 |
| --- | --- |
| prepare-approval | 先核对任务现场、目标仓、基线 HEAD、已存在 PR/实施成果、WIP 与任务授权，避免重复开发。补齐验收条件；创建隔离工作区、短 brief 和包含 taskKey/attemptId 的 plan，提交正式审批。不得仅写“待本人审批”就结束。 |
| run-approved | 使用已保存 requestFile 调用 workflow run。它复核真实审批、任务定义与文件哈希，调用既有 Crew 和预算门并回写原 TaskStore。不得直调 Worker 绕过。 |
| verify-delivery | 读取 receipt/真实日志、分支、提交与 PR，逐项验证原完成条件；通过后 workflow finish。退出 0、Worker 自报通过或有 PR 都不能单独标完成。 |
| inspect-running | 检查已有有限任务与回执；不重跑、不改 attemptId 伪装新任务。进程消失但结果未知时报告恢复需求，不自动重试。 |
| review-failure | 读取该次 receipt、Crew execution 和 Worker manifest/实际输出，区分目录、依赖、代码、权限与预算阻塞；用 workflow review 写具体原因和恢复下一步，只记录一次。可继续做只读环境准备；修改方案或重新派模型仍需新的审批，不能自动重跑。 |
| wait-blocked | 仍有阻塞或待决策任务，读取返回的 blockers 与具体 nextAction；按已有授权解决可修复的执行条件或准备新的审批材料，不能报告为“没有任务”。不能解冻产品待决策项。 |
| wait-approval / no-ready-task | 报告真实等待原因后可以继续收件或已授权只读核对；不生成虚假审批、事件或“进展”。冻结/待决策任务保持冻结。 |

## 提交正式审批

`workflow submit --profile "$PROFILE" --input "$REQUEST"` 的 input 沿用 runtime dispatch request：`taskKey`、`attemptId`、`runtime.kind`、`plan`、`briefFile`、`worktree`、`approval:{summary,scope,acceptance}`。可带 `timeoutSeconds`（1–3300），`deliveryKind` 缺省 `pull-request`，只读分析可明确写 `analysis`。

plan、brief 必须在 profile 授权的 worktrees 下；原任务必须已入同一 TaskStore、处于待处理阶段，有目标仓和非空 predicates。任务仓必须在 profile.repositories 白名单中。缺产品决定或冻结项不能伪装成待实施任务。验收方案/任务范围/输入变化必须重新审批。

模型代码任务提交前还必须给 request 增加 `preflight:{cwd,requiredFiles,executables}`。cwd 是工作区内真实包目录，requiredFiles 是相对工作区的非空源文件列表，executables 是可运行的测试工具绝对路径列表。submit/run 都被动核对存在性和执行权限，不在审批前执行任意项目命令。主控须另外实跑一个获准的基线验证，确认工具实际可用；doctor 的 CLI 版本探测不能代替测试环境。依赖可在明确的外部构建缓存中准备，不把 node_modules 留到要求清理的工作台里。brief 写明仓库根、包目录、文件路径与已核验验证命令。

“无自动重试”指不重复派工、不恢复/重启模型会话；同一已批准会话在范围、权限、预算和时限内修正命令、修复实现和重跑必要测试属于正常工作，不因一次相对路径错误就放弃。

代码任务的 brief 和 scope 写清目标仓、基线/目标分支、拟用工作分支、改动文件范围、验收命令与 PR 交付要求。只暂存获批源文件，不把 plan/brief、凭据或会话原文提交到业务仓。准备审批不调用模型执行器。返回 `approval-pending`（退出 3）是正常等待；本人在看板按钮批准后才可执行。Agent 不得替本人决定。

审批一并保存显式 taskRef，把原生 TaskStore、审批与同一 taskKey+attemptId 的 Crew 记录关联；不会按名称猜测跨来源关系。重复提交和重复唤醒不重复执行。

尚未决定的方案需要修订时，保留旧输入，使用新的 attemptId/plan/brief，request 增加 `supersedesApprovalId` 指向原审批后再次 submit。旧方案仅变为“被替代（未审批）”，新方案仍须本人批准。不得替换已批准、已拒绝或正在执行的方案，也不能把修订当作审批通过。

## 执行、验收与恢复

`workflow run --profile "$PROFILE" --input "$REQUEST"` 是有限前台命令，真实执行既有 Crew。宿主如支持后台工具，可使用该宿主的已有后台能力，但必须保留本次回执与 PID；不另建 daemon。运行期间持有任务租约；崩溃未知不自动重试。失败写 blocked；进程和预算通过只写 verifying，不自动 done。

失败后调用 `workflow review`，input 包含 taskKey、attemptId、summary 和 nextAction（各不超过1000字）。它保留 blocked 与原审批，保存回执原因和一次恢复检查点，不做审批、不启动模型、不把失败任务改成 queued。预算参数应包含真实宿主上下文与工具回包；已报告的缓存输入仍按既有总量口径计入，不能扣掉缓存或把 unknown 写成0。

`workflow finish` 的 input 带 taskKey、attemptId、evidence 数组。每条证据带 predicate、当前真实 Git HEAD、实际执行 command、状态工件目录内的 artifact、文件 sha256、passed:true；所有 predicates 必须覆盖。代码任务还要求执行器交付真实 PR 引用。主控独立核查 PR 与实际验证结果后才调用 finish；TaskStore 验证文件/哈希/HEAD，再写 done 事件。原 Crew 台账保持追加式，未知用量仍为 unknown，不靠更新文件时间制造工作记录。
