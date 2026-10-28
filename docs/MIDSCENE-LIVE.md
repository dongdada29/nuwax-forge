# Midscene 可选 GUI 驱动

入口为 `nuwax-devkit gui run`，独立于 source-tooling 的 `verify` 与 TaskStore。
默认安装、测试和打包不访问模型、不启动应用，也不自动安装 Midscene。

```sh
MIDSCENE_MODEL_AUTH_MODE=siwc MIDSCENE_MODEL_NAME=gpt-6.1-sol MIDSCENE_MODEL_FAMILY=gpt-6 \
node packages/cli/bin/nuwax-devkit.mjs gui run \
  --recipe <场景.json> --state <仓外状态目录> --budget-spec <预算.json> \
  --cdp http://127.0.0.1:19222 --sdk <@midscene/web目录> --runtime <puppeteer-core目录> --json
```

登录和 CDP 开启须由使用方事先完成；仅支持本机回环 CDP 附着。`--launch-config` 当前 unsupported。
缺少 SDK/runtime 为前置错误；认证或登录前提不满足为 blocked。驱动不自动授权、不猜测首个 HTTP 页面。

配方显式锁定 shell/guest、origin、URL、登录与 ready 前提。Electron guest 支持 page/webview，
webview 经 Puppeteer `asPage()` 绑定。确定性输入与读取不调用模型；aiBoolean 的实际值须与期望比较，
并与 SDK 报告交叉核对，false、缺报告、usage 冲突和恢复失败都不通过。外部应用只 disconnect，不 close。

每次写入新的仓外 attempt，保留场景、结果、耗时、目标身份、模型观测、HTML 和工件 SHA256。
`maxWallSeconds` 对驱动进程组设定硬超时；`maxAiOperations` 限制配方 AI 操作数；
`maxModelRequests` 是观测预算，无法硬中止 SDK 内部重试。缺失 token/cache 字段保留 unknown，重试保留下界。
GUI 动态证据默认不复用。

真实验收见 [client GUI/token 验收报告](CLIENT-GUI-TOKEN-ACCEPTANCE-20261027.md)。
每次真实运行先检查 `--budget-spec`，缺预算、unknown、HIGH 超限均不派发 runner；结束后自动 reconcile，unknown/超限不通过。预测自身不调用模型。阈值、有限上下文、取消和观测局限见 [执行预算](../packages/cli/lib/budget/README.md)；独立估算见 [budget 命令](TOKEN-BUDGET.md)。
