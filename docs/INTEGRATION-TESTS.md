# 默认离线集成测试

根 `npm test` 依次执行离线安装测试、所有 npm workspace 的测试，以及 `npm run test:integrations:offline`。现有 `.github/workflows/ci.yml` 已运行根 `npm test`，因此这些非 workspace 套件也纳入 push/PR CI，无需再新增一次重复测试步骤。

```sh
npm test
# 只运行下面四组非 workspace 离线测试：
npm run test:integrations:offline
```

离线入口为 `scripts/test-integrations-offline.mjs`，只使用 Node 内置测试框架和仓库已有文件，不安装或下载依赖、不调用模型、不读取凭据、不启动真实 DSH 或浏览器。任一套件失败会使入口和根 `npm test` 返回非零。该脚本从任何工作目录调用时，都在仓库根目录解析测试路径。

| 套件 | 默认覆盖 | 默认排除 |
| --- | --- | --- |
| `packages/voice-duet/tests/pilot.test.mjs` | 本地固定片段的补丁、TLS 策略、模拟连接回退、trace 脱敏、补丁漂移与错误 Git revision 拒绝 | 完整固定上游的准备/注册验收 |
| `integrations/dsh-dashboard/test/client.test.mjs` | 编译 Web 模块注册、原生 slot 注册契约、本地 Dashboard URL 校验、DSH origin 保留 | 浏览器渲染、iframe 体验及真实 DSH 装载 |
| `integrations/ds-bot-forge/bridge.test.mjs` | 本地工具注册、prepare/status、marker 防派发、离线 reconcile 与账本一致性反例 | 真实 DSH 原生宿主 `native-smoke`、模型执行 |
| `integrations/personal-agent-forge/test/bridge.test.mjs` | 本地 HTTP fixture 的只读查询、认证、请求预览、超时/取消/大小与来源校验 | 真实 PA 实例、数据库、HTTP 写入及原生 DSH smoke |

Bot CLI 的测试已由 `packages/cli` workspace 进入根测试链，离线补充入口不再调用它们。

当前补充入口共 39 项：默认 38 项通过（其中 Bot bridge 12 项、PA 查询桥 17 项）、1 项完整上游验收跳过。桥测试只操作本地 marker、reconcile 夹具和临时 loopback HTTP 服务，不派发模型、不连接实际 PA；`native-smoke` 不在默认入口中。跳过项是预期的 opt-in 边界；其余项失败仍会返回非零。

## 显式验收仍分开运行

离线入口会移除子进程的 `DUET_UPSTREAM`，即使调用者已经导出它，也不会把默认 CI 切换为上游验收。需要完整上游验收时，显式运行原测试文件：

```sh
DUET_UPSTREAM=/absolute/path/to/pinned-dsh-duet \
node --test packages/voice-duet/tests/pilot.test.mjs
```

此命令需要准备好的固定上游 checkout，并受该插件原有前提约束。它不会自动进入根离线入口。原生 DSH 的 Bot 测试仍按 [Bot 接入文档](BOT-INTEGRATION.md) 显式配置 `FORGE_BOT_TEST_DSH`；浏览器与模型体验继续按各集成自身的验收方式运行。

离线测试通过仅证明已有本地片段与客户端契约，不代表实时语音、真实模型、DSH 宿主或浏览器产品体验通过。
