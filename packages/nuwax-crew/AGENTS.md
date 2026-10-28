# nuwax-crew

本项目做执行器路由与显式的有限调用：route 为纯函数，run 执行已给定的命令并记录阶段结果。不常驻，不自建 Agent 引擎，不读取密钥。

- 语言：Python 3 标准库，无第三方依赖。
- 验证入口：`python3 -B -m unittest discover -s tests -v`。
- 路由决策必须是纯函数（registry + task + ledger 状态 → plan），可测试、可复现。
- 注册表（executors.json）是执行器唯一事实来源：`verified=false` 不接生产任务；调用模板未经真实核验一律标注 `proposed`。
- 不引入轮询、daemon 或独立执行引擎；一切执行由调度入口驱动。
- 中文优先；关键决策写进 docs/。
- **红线（最高优先级）**：任何修改系统配置的派工（平台配置、账号/凭据/AK/imVars、本机系统设置与软件安装等），路由结果一律标注 `requires-owner-approval`，未经罗东明确同意不得执行。
- 派工计划的 assignments（执行器/角色）与台账记录是提交署名 Agent-Executor 行的数据来源；执行器实际所用模型一并写入该行。
