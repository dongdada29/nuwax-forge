# DSH 客户端消费 Forge Dashboard

`integrations/dsh-dashboard/` 是 DSH 0.2.1-rc.5 的独立、无需构建的本地插件。DSH 原生侧栏的 **Nuwax Forge** 入口打开主面板，用户输入已经启动的 Forge 看板 URL 并点击连接后，面板通过 iframe 消费原来的页面。导航、React、插件生命周期和资源服务全部复用 DSH；没有复制看板渲染，也没有新客户端、任务或审批运行时。

插件不启动或替换看板，不扫描数据源，不读取 DSH 会话，不自动连接地址，不持久化地址。Node 半部只是正常 Cordis Loader 行；浏览器半部承担可用的入口和面板。

## 固定的宿主契约

本次实现和实测以 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/` 中的实际 **0.2.1-rc.5** 文件为准：

| 实际包 / 文件 | 复用的机制 |
| --- | --- |
| `dsh-client-modules/package.json`、`lib/index.js` | 扫描已启用的 Cordis 行；识别 `dsh.client.platform: web` 和 `exports["./client"]`；注入 boot graph 并服务 JS 资源 |
| `dsh-client-modules/lib/client.js` | `window.__ModuleLoader__.load({ id, factory(require) })` 懒 CJS 注册契约；React 由宿主提供 |
| `dsh-client-ui-schedule/lib/client.js` | `ctx.slots.inject/register` 注册 `main`（`key`）和 `sidebar.panellist`（同名 `id`）的现成示例 |
| `dsh-client-ui-layout/lib/client.js`、`dsh-client-ui-sidebar/lib/client.js` | 原生主面板选择和侧栏条目呈现 |

注意发布内 API 已与本机另一个源码 checkout 有差异，例如该 checkout 的 layout 没有这里使用的 `main` 面板契约。实测 boot graph 自报 `{ version: "0.2.1-rc.5", commit: "d4db512" }`。给定上游参考 `b830ec950faba0a46dda564be3e2d854afed94f1` 未在本次验证为同一构建；不以该参考或 master 代替安装版证据。实际 API 文件 SHA-256 记录在 [host-evidence.json](../integrations/dsh-dashboard/test/host-evidence.json)。升级 DSH 后应重跑验收。

## 显式接入

插件目前为本仓库内的本地包，未发布 npm。先选择自己要修改的 DSH profile，再按 DSH 的正常包管理机制安装本地目录：

```sh
dsh plugin --profile <明确选择的profile> add /absolute/path/nuwax-forge/integrations/dsh-dashboard
```

安装包和启用 Loader 行是两步。在该 profile 的 `cordis.patch.yml` 中显式追加：

```yaml
- insert:
    - id: forge-dashboard
      name: '@nuwax-ai/dsh-forge-dashboard'
```

重启该 profile 的 Web 宿主后，侧栏会出现 **Nuwax Forge**。在面板查看实际的完整 DSH origin；使用自己的明确数据源启动 Forge 服务：

```sh
node packages/cli/bin/nuwax-forge.mjs dashboard \
  --ledger /absolute/path/crew-usage.jsonl \
  --registry /absolute/path/executors.json \
  --serve --port 0 \
  --embed-origin http://127.0.0.1:3080
```

上例 origin 只是示例，必须替换为面板显示的 `scheme://hostname:port`，端口改变也须重新显式启动看板。将看板打印的完整 `url` 原样填入面板，点击连接；断开只移除 iframe，不停止原服务。当前 Forge 服务打印并校验 `127.0.0.1` 地址，请直接复制该地址，避免用 `localhost` 或 IPv6 别名替换它。

## 边界与限制

- 输入仅接受 HTTP(S) loopback 根地址，不接受凭据、路径、查询、片段或外部主机。DSH 必须是 HTTP(S) Web 页面；HTTPS DSH 拒绝连接 HTTP iframe。
- iframe 明确使用 `allow-scripts allow-same-origin` 和 `no-referrer`；没有父子页面消息桥、代理请求或放宽 CORS。审批继续在看板自己的 origin 内执行，原服务的 Host、Origin、CSRF 校验保持有效。
- `--embed-origin` 只允许单一精确祖先。默认不允许嵌入，origin 不一致时浏览器仍拒绝 iframe。iframe 的 load 事件不能证明 CSP 或业务成功，因此面板不显示虚假的“连接成功”状态；保留直接打开链接和诊断提示。
- loopback 是**浏览器所在设备**。远程 DSH 的服务器 loopback 不是用户设备地址；插件不会建立隧道、开放公网或发现远端数据。服务是否可达和是否信任该 DSH origin 由使用者显式决定。
- 本次未验证 DSH Electron 原生窗口专有路径、HTTPS/TLS 部署、远程设备或真实审批写入；不把这些标为已验收。浏览器验收使用安装版 DSH 自己提供的真实 Web 应用。

## 可重复的无模型验收

契约和 URL 验证：

```sh
node --test integrations/dsh-dashboard/test/*.test.mjs
```

安装版宿主 smoke（需要 Node 22+、Python 3、DSH 0.2.1-rc.5）：

```sh
DSH_BINARY='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' \
  node integrations/dsh-dashboard/test/host-smoke.mjs
```

脚本仅传临时 `HOME/DSH_HOME/TMPDIR` 与 PATH，不继承 provider 凭据；初始化临时 Web profile，显式禁用 `llm-deepseek`、`llm-deepseek-account`、`llm-pi-ai`，不提交 prompt。通过绝对 `file:` Loader 行加载本插件，不安装包、不修改全局 profile。它验证真实 boot graph 中的插件和宿主 JS 资源、fixture 看板内容、两种 `frame-ancestors`、无 CORS、错误 Host 与跨来源审批 POST 的 403，然后停止自己启动的进程并删除临时目录。HTTP smoke 不代表浏览器渲染实测。

要验证真实浏览器，追加 `--keep`。脚本打印临时 `connection.json` 的路径；其中包含仅本次临时宿主使用的登录 URL，应保持私有。用独立浏览空间打开该文件的 `hostUrl`：

1. 若出现 DSH 预览版说明，点击继续。打开原生 **Nuwax Forge** 入口，确认显示完整宿主 origin。
2. 填入 `allowed` 地址并连接；确认 iframe 内出现 `dsh-host-fixture` 和看板页面。
3. 填入 `denied` 地址并连接；浏览器应拒绝嵌入。确认 CSP 日志，或 CDP 子 frame 为 `chrome-error://chromewebdata/` 且 `unreachableUrl` 对应 denied 地址。不要以 iframe 标签存在或 load 事件通过此项。
4. 断开并关闭测试浏览空间；在 smoke 终端 Ctrl-C 清理进程与数据。不要发送任何 DSH 聊天消息。

2026-11-04 的真实宿主浏览器验收已经执行了上述允许/拒绝路径：原生入口存在、允许 iframe 的子 frame URL 为真实 Forge URL，读取 iframe DOM 得到 `dsh-host-fixture`；拒绝 iframe 的子 frame 为 Chromium 错误页且保留目标 `unreachableUrl`。结构化结果见 [host-evidence.json](../integrations/dsh-dashboard/test/host-evidence.json)。
