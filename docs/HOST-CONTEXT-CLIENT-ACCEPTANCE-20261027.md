# 宿主上下文优化与 client 任务验收（2026-10-27）

本轮目标是减少主对话编排，完整执行 client 开发工具链验收并核算总耗时和 token。执行器新增 `client-verify`，将预检、22 项测试、doctor、证据验证、TaskStore 导入和有限 JSON 结果收敛到一个入口。CLI模型预算与原 `run` / GUI guard 保持独立；原始日志与证据留在仓外。

## 总预算与实际用量

事先约定总预算 5,000,000 tokens（输入含缓存子集＋输出；reasoning 不重复加），父对话2,000,000、执行器2,500,000、验收预留500,000；4,000,000为停止新阶段的预警线。宿主没有真正的模型调用硬截止，本预算靠阶段快照检查。

截至 `2026-10-27T13:50:48.802Z` UTC（上海时间＋8小时），观测总量 **4,695,405**：父对话 3,150,047、执行器 1,462,111、真实 Codex 对照 83,247。父对话已超过2,000,000分项，整体也越过4,000,000预警线；因此没有继续启动模型试验。快照未含最后尾部与供应商隐藏重试/账单，不能称为硬配额。

## 真实 client 完整任务

独立直接入口本次结果：**通过**，总墙钟 1.643 秒，22项测试通过，TaskStore `done`，证据SHA256及独立manifest校验通过；doctor ready=False，有 15 项问题。模型调用0。原始结果见 `direct-independent-verdict.json`。执行器对安装版也完成同一任务，1.682秒、22/22、TaskStore done。

**范围是 client source-tooling 任务本身**，包含接收后的四类配方阶段、证据和完成状态；并非 client 全套404项、产品构建、GUI或真机验收。此次没有修改 client 业务代码。

## 真实 Codex 全程对照

与历史执行段相同的 Codex CLI 0.164.0、gpt-6.1-sol、medium 档位，全新会话完成一次真实任务指令到最终答复。实际耗时 **34.993秒**，**83,247 tokens**（输入82,817、含缓存62,080、输出430），观测3次模型响应、1个工具命令。

此样本 **未通过**：内层 workspace-write 沙箱中 dev 阶段3项失败，fixture监听未启动；manifest passed=false，模型如实报告失败。原始失败信号：["Error: listen EPERM: operation not permitted 127.0.0.1", "at Server.setupListenHandle [as _listen2] (node:net:1987:21)", "at listenInCluster (node:net:2066:12)", "code: 'EPERM',", "syscall: 'listen',", "Error: listen EPERM: operation not permitted 127.0.0.1", "at Server.setupListenHandle [as _listen2] (node:net:1987:21)", "at listenInCluster (node:net:2066:12)", "code: 'EPERM',", "syscall: 'listen',"]。开发环境中既有试点也记录过嵌套沙箱阻断回环监听；本次未绕过沙箱重跑模型。直接入口在本会话宿主权限下新鲜执行通过，不能抹掉这次失败。

历史3个有效样本的同任务执行段中位为 **105.171秒、270,581 tokens、7次模型响应**，但历史指标不含本轮主对话和实现成本；本次Codex样本又未完成验收。不能据此计算成功任务的端到端耗时或总token降幅。只能声明已实现单入口与短输出，且直接非模型执行段在本轮验证通过。

## 回归与保留证据

工作区测试 **239/239**，contracts一致检查通过。执行器已验证5包离线安装；本次未构建产品、发布、推送或重启应用。

证据目录 `/Users/apple/Documents/Codex/2026-10-27/client-host-efficiency`：`budget-snapshot.json`，`direct-independent-verdict.json`，`benchmark-result.json` 与原始JSONL/failed manifest、`ACCEPTANCE-RESULT.json`、`review-workspace.log`。失败记录完整保留，不伪造成功样本。
