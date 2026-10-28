# 架构

状态：**已实现**（本仓库全部真实运行过；见 [IMPLEMENTATION-RESULT.md](../IMPLEMENTATION-RESULT.md)）。

## 仓库布局

```
nuwax-devkit/
├── package.json            # private、workspaces: packages/*、无发布脚本
├── packages/
│   ├── nuwax-stack/        # @nuwax-ai/devkit-stack（Python skill 资源，含 scripts）
│   ├── nuwax-crew/         # @nuwax-ai/devkit-crew（Python 标准库）
│   ├── nuwa-sdlc-kit/      # @nuwax-ai/nuwa-sdlc-kit（保留原名；kit/VERSION=1.5.0）
│   ├── contracts/          # @nuwax-ai/devkit-contracts（schema 正本 + level + GUI fixture 校验器）
│   └── cli/                # @nuwax-ai/devkit-cli（bin: nuwax-devkit）
├── scripts/                # import_from_pilot.py（导入+provenance）、pack.mjs（打包+核对）
├── provenance/provenance.json
├── docs/                   # 本文档与其余文档
└── IMPLEMENTATION-RESULT.md / .json
```

**文件夹名是契约的一部分**：stack 的集成测试用 `ROOT.parent / "nuwax-crew"`、
`ROOT.parent / "nuwa-sdlc-kit"` 定位兄弟包，因此 packages/ 下的目录名不可改。

## verify 数据流（source-tooling，已实现）

```
nuwax-devkit verify --project P --state S --task-key K [--node N] [--reuse]
  └─ require.resolve 定位本安装的 @nuwax-ai/devkit-stack 与 @nuwax-ai/devkit-crew
  └─ spawn(python3, [-B, stack/skills/nuwax-stack/scripts/run_verification.py,
        --repo P, --crew-root <crew包根>, --state S, --task-key K, --node N, ...])   # argv 数组，无 shell
       ├─ 读 P/.sdlc.json 的 verification 绑定（kit verify:init 接线产物）
       ├─ crew 路由（纯函数）→ runner 执行配方 stages（kit engine verify.mjs，经可信 Node）
       ├─ verification.py 复核 manifest：HEAD、输入指纹、阶段结果、日志哈希
       └─ TaskStore（S 下 sqlite）导入证据；--reuse 时复检旧证据，篡改即失效重跑
  └─ CLI 透传桥接 JSON；exit 0 还需 passed===true 才算通过
```

关键不变量：`processPassed` 与 `acceptancePassed` 分离；退出码 0、全 skipped、缺证据都不代表验收通过；
`--node` 显式可信绝对路径贯穿配方执行、validatorArgv、TaskStore 导入与复检。

## 契约与单正本

- `packages/contracts/schemas/verification-v1.schema.json` 是**唯一正本**（自原 stack references 迁入）。
- stack 技能分发携带**字节一致的自包含副本**（`skills/nuwax-stack/references/verification-v1.schema.json`），
  由 `npm run contracts:sync` 同步、`npm run contracts:check` 校验，contracts 测试含字节漂移断言。
- task/runtime 字段**只声明已实现的部分**（见 [contracts/docs/task-runtime-v1.md](../packages/contracts/docs/task-runtime-v1.md)），
  真实强校验仍是运行中的 `crew/contract.py` 与 `stack/scripts/verification.py`；
  不用空壳 schema 冒充完整强校验。level 边界见 [CAPABILITIES.md](CAPABILITIES.md)。

## CLI 定位方式

`packages/cli/lib/resolve.mjs` 以 CLI 自身安装位置为基准 `require.resolve(name + '/package.json')`，
向上走 node_modules 链找到安装后的同级包。**不硬编码旧试点或源码绝对路径**；
`NUWAX_DEVKIT_RESOLVE_ROOT` 只是缺依赖诊断的测试钩子。子进程一律 argv 数组。

## 版本与依赖策略

- 统一本地预发布：新包 `0.1.0-devkit-local.1`；kit 为 `1.5.0-devkit-local.1`
  （与 `kit/VERSION` 的 1.5.0 发布线兼容）。根 package.json `private: true`，无发布脚本。
- CLI 对 4 个兄弟包声明**精确同版本**依赖（非 `workspace:*`），monorepo 内 npm 以 workspace
  本地链接满足；5 个 tarball 同时安装时版本精确匹配、离线可解析。
- 各包 `files` 白名单分发；无 postinstall 副作用；`npm install --ignore-scripts --offline` 可装。

## 环境与边界

Node >= 22、Python >= 3.10（标准库）。不引入 Nx/Turbo/TS 构建；不重写 Python 引擎；
npm 分发只携带 Python 源码。`.github/workflows/ci.yml` 已写但**未在远程运行**。
