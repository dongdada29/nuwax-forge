# 原生宿主到本地模型服务的验收

`bots-provider-host.test.mjs` 使用真实 DSH `0.2.1-rc.5`、固定原版 `ds-bot@0.2.7` 和仅监听 `127.0.0.1` 的 OpenAI-compatible 模拟服务。它补上原来“模型未配置”验收没有覆盖的传输链路，不调用外部模型。

测试通过原 `/api/bot` 的 `provider-add` 注册本地 provider 和两个不同模型，再由 `create-bot`、`send`、`chat` 完成两份独立私聊。请求经过 DSH 原生 provider adapter；测试不替换宿主、Bot 模块、Session 或模型路由实现。

```sh
FORGE_BOT_TEST_PROVIDER_HOST=1 \
FORGE_BOT_TEST_DSH='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' \
FORGE_BOT_TEST_TARBALL=/absolute/path/ds-bot-0.2.7.tgz \
node --test packages/cli/test/bots-provider-host.test.mjs
```

默认跳过，不下载、不运行宿主。显式开启时，准备过程验证原包 SRI 和核心文件 hash；依赖安装仍可能访问包仓库。全新 root 不导入原有凭据。临时 provider 使用无外部效力的固定测试 key，退出时删除整个临时 root。认证令牌、cookie、请求内容和宿主原始日志不进入测试输出。

2026-11-04 本机实测通过：

- 原生用户 API 新建两个 Bot，各自绑定 `route-a` / `route-b`。
- 本地服务观察到两个模型路由，累计 4 次请求（问候和用户消息）。
- 通过原聊天 API 回读每个用户消息对应的模拟回复；问候回复有不同标记，不能替代此断言。
- 私聊 A 的标记没有进入 B 模型请求，反向亦然。
- Bot 未被宿主标记为 blocked；测试结束后停止自建宿主和模拟服务并删除临时数据。

测试服务拒绝未知路由/模型、超过 12 次请求及过大请求，仅返回固定文本，不产生工具调用。模拟 usage 数字仅用于协议解析，不能作为真实 token 使用量、费用或 Forge 预算结算证据。

此结果不证明付费 provider 兼容性、真实模型推理/工具选择、记忆写入、群隐私或 `@` 行为。尤其两份私聊未串模型不等于群不读取私聊；群原生行为须由独立验收确认。
