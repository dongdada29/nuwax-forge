# Nuwax Forge Dashboard

`forge_dashboard/` 为本地服务、数据适配和页面渲染；`web/` 为样式与交互脚本。由 `nuwax-forge dashboard` 启动，服务仅绑定 loopback。Crew 保留任务路由和审批账本；适配器读取显式提供的数据源。未来桌面容器可复用本地服务与 Web 客户端。

静态 HTML 输出保留自包含样式；服务模式加载同包 Web 脚本。当前没有 Electron 客户端。

## 扩展和 DSH

内建来源通过 `forge_dashboard.adapters.AdapterRegistry` 显式注册；调用方可注册读取器返回统一记录，不会自动搜索或执行外部插件。DSH 插件依赖 Cordis 和 DSH 的服务，应由真正的 DSH 宿主运行，不能直接当成 Python 适配器。Forge 的 `dsh-plugin` 命令将插件管理和运行委托给已安装的 DSH，插件界面仍在 DSH 中，尚未嵌入 Forge 看板。已有浏览器和未来 Electron 可复用本地 Web 客户端与 loopback 服务；当前未实现 Electron 容器。
