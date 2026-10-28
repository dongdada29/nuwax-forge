# 执行预算、上下文与返修验收（2026-10-27）

结论：已将预算预测和拦截接入真实 `run`、标准 task→route→run 以及 `gui run`。本轮只交给一个新上下文执行器实现，Codex 独立验收；未改 client 业务代码、系统配置、账号或模型默认配置。

## 旧消耗拆分

| 维度 | 实测 | 能确认的问题 |
|---|---|---|
| 父编排 | 123 次响应、115 次外层工具调用，输入31,470,842、输出172,215 | 固定检查、原始日志复核与长交接反复经过模型 |
| 上下文 | 输入缓存子集30,688,512，占97.51%；单请求输入中位281,296 | 缓存不等于免费，也不能全部当成可消除浪费；应缩短交接并减少轮次 |
| 执行器返修/复核 | 7阶段、102个assistant消息，原始input 218,237 / cache-read 10,802,688 / output 117,536 | 包含必要修复，不能全算浪费；应先锁接口、固定验证、有限attempt |
| 超时 | 执行器11阶段中7阶段超时 | 超时后多次续跑长会话、预算工具未接spawn门，是可改进的流程问题 |

以上是重叠维度，不能相加为“浪费总额”。旧 Claude 自定义 provider 的 input/cache 语义分列，不与 Codex 输入强凑账单。
曾怀疑的69万字节回包，核对为原生 input_image；相邻输入仅增加2,433 tokens，已排除“69万字节文本base64浪费”的错误解释。

## 已接入的实际规则

- 新公开入口 `nuwax-devkit run --plan <JSON> --project <项目> --state <仓外目录> --brief-file <交接>` 要求显式声明模型或固定任务；旧 Python 未声明路径保留兼容并标 unmanaged。
- 模型执行前复用原 Node 算法，以 `max(预测HIGH,未校准baseline HIGH)` 预留；缺预算、未知、超限或上下文超限均不spawn。标准 contract/router 不丢治理字段。
- 多 assignment 共享余额并自动结算。累计 Claude result 保留为 session-cumulative；实耗未知不当0、阻断后续。单步实耗超预算、失败、超时和取消均停止。
- 同 taskKey/ledger 首版只允许1次实际attempt；拒绝自动retry/resume及maxAttempts>1，不假支持跨attempt预算。
- brief、内联command、spec.inputs和显式contextFiles计入有限上下文。默认64KiB、启发式HIGH 16,000 tokens、16文件。返回命令hash/字节、工件路径及≤400字符摘要；原始输入/日志仅留仓外磁盘。
- GUI必须 `--budget-spec`；模型/视觉成本/AI操作覆盖均须匹配。预算前只resolve SDK，不加载或连接。运行后自动reconcile。

用法与完整plan见 [执行预算说明](../packages/cli/lib/budget/README.md)。规范usage由执行器适配器提供；不支持/缺失计量会停下，不假装自动读懂所有provider输出。

## 同任务真实模型对照

同一份既有 client GUI 证据，要求输出同一个4字段JSON。保留相同Codex CLI默认模型/账号、全新ephemeral会话、只读、零工具命令。前者给完整报告，后者给结构化摘要并经新公开run执行；答案完全相同。

| 指标 | 完整报告 | 摘要＋真实guard |
|---|---:|---:|
| 交接UTF-8字节 | 12,952 | 504 |
| 报告输入tokens | 27,402 | 23,864 |
| 输出tokens（含reasoning子集） | 78 | 85 |
| 输入＋输出tokens | 27,480 | 23,949 |
| 模型任务墙钟秒 | 30.654 | 30.246 |
| completed turn | 1 | 1 |

**真实报告token减少12.85%**，输入减少12.91%；交接字节减少96.11%不能冒充token同幅下降。两次cached_input_tokens均0。新执行段含guard/结算为 **30.347秒**，预留40,128、实扣23,949、余76,051，自动对账通过；预算计算自身零模型调用。
耗时差只有约0.4秒（模型任务1.33%），N=1不足以证明稳定提速。completed turn不等于供应商隐藏请求/重试计数。两次测量共51,429报告tokens，是本轮验证投入，未藏掉。

## 固定任务与拦截实证

22项既有测试＋doctor结构检查新跑3次：1.414 / 1.439 / 1.438秒，均真实verification/acceptance通过，0模型调用。
历史原模型流程3对基线中位105.171秒、7个模型响应、270,581输入＋输出tokens（原工件哈希重核）。固定流程的移除模型收益此前已建立，本次复测可用，不能把它当成这次guard新增的收益。

独立真实子进程探针：超预算、unknown、上下文超限均未触发marker；within确实执行并结算；共享余额不足和累计实耗unknown均拦住第二步。源码6项、全新五包消费者6项均通过，探针usage为合成数据，不冒充真实模型用量。
真实GUI公开入口预算1时 `prediction-high-exceeds-budget`，modelCalled=false、0HTML、未连接CDP；本轮未重启应用。正常模型放行路径由上面的真实Codex任务覆盖；本轮未重做真实GUI正向场景，旧3次产品场景证据保留原边界。

## 完整实施成本与边界

截至 `2026-10-27 21:40:24`（上海时间），本轮从请求到快照 **31.3分钟**，包括实现、等待、返修、真实对照和验收；尾部尚未计入。
父编排：输入9,527,692（缓存子集9,474,304）、输出49,355；单一实现执行器：输入5,920,625（缓存子集5,821,056）、输出49,600。两次CLI对照另计输入51,266/输出163。
本轮独立会话观测合计输入 **15,499,583**（缓存子集 **15,295,360**，非缓存输入 **204,223**）、输出 **99,118**；不重复加缓存和reasoning。执行器自报unknown后，主代理按parent_thread_id匹配本任务所属会话，取得独立计量指针，见subagent-token-snapshot.json。
与上轮工程任务量不同，不把两次工程总量变化当同任务因果降幅，也不声称这些数字等于账单。宿主Codex主对话/协作工具仍不受devkit进程guard硬控制，这部分缓存上下文占用仍高。

这是**启动前/步间guard＋wall timeout**，未提供provider内部流式硬token中止。单步可能超预测；执行器启动后自行读取的历史/文件不受交接manifest限制。修改taskKey/ledger/state属于新任务，不能充当全局账号配额控制器。

## 回归与分发

全工作区 **237/237**（80, 18, 19, 65, 55），contracts字节一致。五包新tarball哈希与内容边界通过、全新消费者离线ignore-scripts安装和6项实际run探针通过。默认test/install/pack不调用模型、SDK或GUI。
本轮未提交/推送/发布、未构建产品；产品构建与重复产品构建仍0→0。

证据目录：`/Users/apple/Documents/Codex/2026-10-27/client-token-guard`。机器总表 `ACCEPTANCE-RESULT.json`；旧拆分 `prior-waste-breakdown.json`；真实对照 `real-context-ab-verdict.json`；原始JSONL与答案在summary-before及summary-after-state；guard、固定配方、GUI、包和宿主用量均有独立JSON与原始日志。
