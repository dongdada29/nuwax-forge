# Client workflow 产品化验收记录

本次不提交、不推送，未更改根 README 和改进方案 WIP。入口与 Python runtime 随 CLI tarball 安装，原 bounded-codex.py 保留薄包装。

上一轮独立验收证据位于 `/Users/apple/Documents/Codex/2026-10-30/client-same-round-budget/`：pair-result.json、independent-audit.json、TOTAL-FINAL.json。已验收的同轮结果：模型 gpt-6.1-sol medium，3 responses、22.041 秒、82,402 tokens；direct 1.722 秒、0 tokens。两组同 named permissions、相同 source/inputDigest，22 tests、validator、hash 及 SQLite done/owner=null/4 证据通过。最终封账含 host final reply：1,117,940 tokens、290.504 秒，预算 2,000,000 内。此处引用已有结果，没有重跑模型；N=1 不外推整体工程收益。

本次产品化证据根：`/Users/apple/Documents/Codex/2026-10-30/devkit-workflow-productization/`。

- `real-direct.log` 和 `real-direct-state/run-result.json`：真实 client 经新入口、相同具名文件沙箱 fresh 执行；22/22、validator、hash、SQLite done/owner=null/4 证据通过，模型请求 0。doctor.ready=false 保留，并不建立产品可用性结论。
- `direct-spec.json`、`host-fixture.jsonl`：此次为可控 0-token host fixture，故本次封账仅证明工具的截断/重入行为，**不代表产品化开发对话总 tokens 或总 wall**。
- `offline.log`：host 时序、最终 reply usage、坏数字、0 与 unknown、下一 turn 污染、重复 session、子 session 截断、预算 reserve、路径别名/缺失父路径、seal pending/幂等，加原有 9 项真实进程 supervisor 测试。
- `npm-test.log`、`contracts-check.log`：全仓测试与 schema 字节一致检查。
- `pack.log`、`tarball-runtime.log`：五包 tarball 核对，CLI 内包含 workflow.py、bounded.py 和 JS 入口。

明确限制：compare 的新产品入口未做真实模型 benchmark；只引用上一轮真实实验和本次离线监督证据。未执行产品构建或部署。主代理独立验收尚未执行。无后台自动 seal；手动 seal 为唯一入口。宿主/provider 不受本地硬 token 配额约束，预算检查的粒度见 CLIENT-WORKFLOW.md。

## 独立终验补充

原始会话复算上一轮最终封账为 1,117,940 tokens / 290.504 秒，预算 2,000,000，余量 882,060。主代理补测启动首个 usage 快照前不得注册为已计量 owned session；清理进程组如遇系统 EPERM，必须保留失败报告，不得冒充已终止或成功。上述反例、完整工作区测试、contracts 一致性与 tarball runtime/无 pycache 检查通过。根 README 及原改进提案 WIP 保留。
