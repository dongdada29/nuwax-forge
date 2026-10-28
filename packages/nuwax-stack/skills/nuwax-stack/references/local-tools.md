# 本地工具接入契约

优先使用平台向 Agent 实际暴露的工具 schema 和已选电脑/工作区。工具名、端口、鉴权、参数或 tunnel 地址以当前运行时为准。

本说明基于 nuwa-cli 随装 `nuwax-platform-access/references/gateway-local.md` 与 `nuwax-file-server/src/routes/computerRoutes.js` 的接口清单（2026-10-20 阅读）。它是接入参考，不证明当前服务在线或云侧有执行权限。

| 能力 | file-server 路由参考 | M1 用法 |
| --- | --- | --- |
| 列目录 | `GET /api/computer/get-file-list` | 限定选定仓和子目录 |
| 搜索路径 | `GET /api/computer/search-files` | `kw`，有界 `limit/maxVisit/timeoutMs`；实际 schema 为准 |
| 读文件 | `GET /api/computer/resolve-file` | 只取所需文件和行段 |
| 运行命令 | `POST /api/computer/execute-command` | 仅在当前工具支持且任务允许时跑明确的只读命令；没有执行能力就用文件工具 |
| 写文件 | `POST /api/computer/files-update` | M1 禁用 |

常见本机端口为 file-server 60015、gateway 60016、lanproxy 10076。不要把默认端口当运行证据，也不要将文件服务暴露到公网来修复连通性。

`customTargetDir` 可指向本机已有仓，但需要版本和权限支持。云侧工作区目录与用户日常开发仓可能不同；必须实际读取根目录/HEAD 确认。不要自动 fallback 到另一个同名目录。

只读命令不是按二进制名称放行：`git` 有写操作，`python` 可执行任意代码，`npm test` 可能迁移数据库。先看完整参数和实际副作用。缺少可证明的只读能力时停在接入缺口。
