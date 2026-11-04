# Dashboard 的 Forge run 预算观察

通过既有 `--agent-state` 或 `--agent-state-root` 显式读取 Forge 状态目录后，每条 run 详情独立展示 `manifest.observedBudget` 的已报告 token 下界、预算上限与观测判定，并显示状态目录以区分同任务的多次运行。

示例：`reportedTokensLowerBound=25050`、`maxTokens=20000`、`verdict=exceeds` 显示“已证实超限”。若 `usageKnown=false`，完整结算继续显示 `unknown`。报告下界独立展示，不填入 `tokens`，不进入现有已结算 token 汇总，不与已结算 token 再相加。

低于或等于限额的下界、无下界均显示 `unknown（部分报告不能证明预算达标）`。不会因为来源 `budgetPassed=true`、进程退出成功或下界较低就展示预算通过；在途或未报告的消耗仍未知。

观测数字仅接受非布尔的非负安全整数（预算上限需大于零）。负数、字符串、浮点、超出 JavaScript 安全整数范围和畸形对象会显示“观测字段无效或冲突”，观察值与判定降为 unknown。以下冲突同样不能作为可信判定展示：

- manifest 观察上限与 request 中声明上限不同，或 request 的预算字段无效。
- 来源 verdict 与观察数字不一致（例如低于上限却报 exceeds，或声明 within）。
- 已知完整结算总量小于所报下界；此时完整结算也降为 unknown，避免把矛盾总量计入汇总。

无 `observedBudget` 的旧 manifest 保持原有展示和结算汇总；有效、无冲突的已结算数字继续按原规则统计。来源自带的 note 不作为可信判定或 HTML 内容；界面采用固定解释文本，状态目录与任务文本经过原有 HTML 转义。

实现仅读取原有 manifest/request 文件，不执行 reconcile、启动模型、访问网络或写回状态。测试采用合成临时文件，覆盖超限加 unknown、低下界 unknown、旧 manifest、多 run 隔离、畸形/冲突数字、转义和无输入写入。

```sh
python3 -B -m unittest discover -s packages/dashboard/tests -v
```
