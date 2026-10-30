# Client 沙箱与预算验收（2026-10-30）

预算监督由全新 CLI 执行器实现，主代理独立验收。

- scripts/bounded-codex.py 用 thread.started 连接精确会话 token_count，启动前预留/拒绝，运行中观测上限、超时、缺测失败关闭，终止自己的进程组。9 项真实子进程测试通过。实现会话也实际因 aggregate-token-stop 退出 -15，观测 406,778 tokens。
- 命名权限由单进程 -c permissions.client-source-local-network.extends=":workspace"、显式 workspace_roots、network.enabled 定义，sandbox -P 选择；-p 是配置叠加。没有改全局配置。
- 独立实测 network=false：回环 bind EPERM；network=true：127.0.0.1 bind/request/close 成功。两者均允许工作目录写入且拒绝仓外 canary（EPERM）。network=true 范围更广，并非仅回环白名单。
- 实现器内层 seatbelt 无法再次 sandbox_apply，因此真实探针和完整任务在主代理宿主层启动被测具名沙箱；被测命令保留文件沙箱。

## 完整 source-tooling 任务

同一 client 试点源，具名沙箱内 fresh state，墙钟 1.872 秒，22/22，运行段 0 模型调用、0 tokens。manifest/artifact SHA、独立 validator 与 SQLite phase=done/owner=null/4条证据均通过。doctor ready=False、issues=15。配方不含产品构建/GUI/安装包，产品构建与重复产品构建均0。

历史模型参考（2026-10-28）：42.250秒、83,587tokens、3responses。本次额外读SQLite确认旧任务done；旧报告只搜索JSON而漏记SQLite是采集缺口，不是任务实际未完成。本轮因预算停止线没有启动新模型基准，不能提供严格同轮同口径降幅或整体工程节省结论。

独立采集首次误读不存在的inputDigest字段，任务本身已经通过；修正采集后仅重跑一次fresh零模型任务以留存完整wall，未重复产品构建。

## 预算与限制

总预算2,500,000，2,000,000停止派发。最近快照：宿主2,467,158 + 执行器406,778 = 2,873,936（含缓存输入子集，快照后尾部和在途未知）。真实模型基准0次。监控可实际停止所管理进程，不能硬截断供应商内部消耗或宿主对话；不能用本地token快照保证账单硬上限。

证据 `/Users/apple/Documents/Codex/2026-10-30/client-sandbox-budget/independent`：permission-probes.json、supervisor-tests.log、client-verdict.json、budget-snapshot.json、manifest.json；外层停止记录 `/Users/apple/Documents/Codex/2026-10-30/client-sandbox-budget/executor-result.json`。源码未提交；原有 README 和改进方案 WIP 保留。
