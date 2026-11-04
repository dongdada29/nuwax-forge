# 外层监督器拥有的 Forge 执行

PA 等已有进程监督器需要在自身登记的 POSIX 进程组内运行一个 Forge Worker。直接包装普通 `agent run` 会让内层另建进程组；外层被强杀后，仅清理外层组不能保证模型子进程退出。

`packages/cli/lib/agent/owned-entry.mjs <absolute-state>` 是显式受管入口：外层先按原流程持久登记 owner，再将此 Node 进程作为自己的进程组 leader 启动。入口通过 `ps` 核对当前 PID 等于 PGID 后调用既有 `run(state, {detached:false})`。终止探针、实际执行器及正常继承组的后代均位于同一组；独立公共 `agent run` 保持原有分组行为。

任务仍通过既有 `agent prepare` 准备，所有预算、上下文、一次性 claim、结算和产品验收边界沿用原实现。受管入口不提供 prepare、approve 或 retry，不创建任务库，不证明外层已经登记其 owner，也不扩大任何权限或模型授权。外层必须继续承担原生登记、取消、异常恢复和最终清理核验；自行逃离进程组且从未被观察到的守护进程不在保证范围内。Windows 明确不支持此入口。

成功或运行失败时，stdout 输出单个原生 run JSON，附加 `state` 与 `processOwnership:{mode:'inherited-posix-group',ownerPid,processGroupId}`。退出码为 0=completed、3=blocked、1=failed、2=用法或组所有权拒绝。`acceptancePassed` 仍为 null；进程成功不等于产品验收。被强杀时可能没有最终输出，外层应按原 attempt 恢复事实并离线 reconcile，不再次 run。

验证：`node --test packages/cli/test/owned-agent.test.mjs packages/cli/test/client-agent.test.mjs`。19 项离线测试通过，使用 marker CLI，无模型：拒绝未拥有的组且不创建 claim；完整运行的内层 PGID 与外层 owner 相同；强杀外层整组后 marker 及子进程全部停止；保留 claim、未知用量与不可重放状态。此证据验证 Forge 组策略，尚不能替代 PA 实际数据库登记、取消或重启集成验收。
