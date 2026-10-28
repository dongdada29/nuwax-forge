# 技能同步

接口参考 nuwa-cli 随装 `nuwax-platform-access/references/platform-skill-sync.md`。路径前缀为 `/api/v1/4sandbox`，成功必须同时满足 HTTP 成功及业务 `code="0000"`。脚本无运行时第三方依赖。

## 离线预演

```bash
python3 -B scripts/sync_platform.py --dry-run
```

默认就是预演。生成 ZIP、SHA256 清单、`skill/add` 请求体；没有真实空间 ID 时标为 `null`。此模式不查登录态、不读取 AK、不发请求。可选 `--space-id 123` 提前填入已确认的空间 ID。

## 草稿与发布

以下命令会写目标平台，只有用户授权对应动作后才执行。凭据仅取 `SANDBOX_ACCESS_KEY`，不自动读取本机凭据缓存。`PLATFORM_BASE_URL` 或 `--base-url` 必须显式指定并核对环境。

```bash
# 环境变量通过当前终端安全注入，勿把值写入仓库或命令历史。
python3 -B scripts/sync_platform.py --apply --space-id 123
# 首次草稿会记住 ID；再次执行按同一 ID 更新并核验。
python3 -B scripts/sync_platform.py --apply --publish --category dev --space-id 123
```

当前仅分发一个技能 `nuwax-stack`，可在命令末尾显式指定该名称。脚本将 `usageScenarios` 设置为 `TaskAgent` 与 `ChatBot`，不配置 Agent、不发团队消息。

流程为 add/update → export ZIP 逐文件字节比对 → 可选 publish/apply → 确认详情 `publishStatus=Published`。文件差集使用 create/modify/delete。ZIP 内容不一致时不发布。`--publish` 需同时 `--apply` 和 `--category`；分类从目标平台当前技能分类列表读取。生产实测“开发部署”代码为 `dev`，平台会拒绝未传分类的发布。Space 发布项显式携带对应 `spaceId`。

`.local/platform-state.json` 保存环境、空间和技能 ID，不保存 AK，也不写进技能正本。切换环境使用不同 `--state` 文件；已有状态与环境不符会拒绝执行。

本项目当前指定的生产域为 `https://agent.nuwax.com`。生产同步显式传 `--base-url https://agent.nuwax.com --state .local/production-state.json`，空间 ID 从生产登录后的个人空间读取。当前 nuwa-cli 的登录域可能是测试环境，不能将其 AK、空间 ID 或 skill ID 自动用于生产。

## 通过 ego-browser 的生产登录同步

没有生产 AK、但 ego-browser 已登录时，可在其 `nodejs` 运行环境导入 [scripts/ego_sync.mjs](../scripts/ego_sync.mjs)，传入已有 Page、绝对仓路径、生产 origin 和空间 ID。`syncSkills(page, {root, baseUrl, spaceId, category:'dev', publish:true})` 使用同源 Cookie，先检查空间所有权，再同步与导出逐字节核验；凭据留在浏览器。

该模块默认只同步草稿；`publish:true` 才发布。它与 Python 脚本共用本机生产状态文件，并在平台业务失败时立即停止。不会循环重试，也不操作团队源文档。

## 中断恢复

创建前先记 `pending_create`。若请求超时或返回结果不明，脚本保留此状态并停止；再次运行不会自动 add，以免产生重复技能。去目标平台查该次草稿：确认已有 ID 后，核对名称、空间、内容，再把该技能状态改成 `{"id":真实ID}`；确认服务端未创建后才删除该技能的 pending 状态。状态文件只在本机操作。

更新、导出或发布失败时保留已知 ID，修复原因后可按 ID 重跑。脚本不自动重试写请求。HTTP 200 的业务错误也判失败。发布状态尚未可见时停止并报告，不宣称已发布成功。

自动化用本地假服务验证契约和失败分支；另外已完成测试环境的真实技能同步、export 核验及发布，见 [接入记录](platform-rollout-20261020.md)。当前生产统一技能的导出核对、发布与 Agent 绑定见[统一技能迁移](unified-skill-20261020.md)。
