# 验证结果接入（v1）

固定验证优先使用目标仓已有配方。仓内脚本负责执行与清理，crew 负责有限调用和阶段记账，TaskStore 负责完成条件与可恢复状态。

已明确配方的工作可直接走有限桥接，内部无需模型调用：

```sh
python3 -B scripts/run_verification.py --repo <目标仓> --crew-root <nuwax-crew源码目录> --state <仓外状态工件目录> --task-key <任务键> --node <可信node绝对路径>
```

桥接消费目标仓 .sdlc.json 的 verification 绑定，经过 crew 路由与执行、证据校验后再导入 TaskStore。加 --reuse 会检查已完成证据，仍有效时不重新执行。它不创建调度服务或后台循环。

Node 运行器必须显式可信：--node 传入的绝对路径一路用于配方执行、validatorArgv、TaskStore 导入与恢复复检，校验结果不依赖调用者 PATH；manifest 里的 environment.nodeExecutable 只是记录，验证器绝不按它执行。未提供 --node 时才回退 PATH 解析；两者都缺时直接报失败。

同任务并发安全靠每次运行的唯一 owner：并发者抢不到租约会以 JSON failure 如实退出，不误报通过；正常结束（含失败路径）都会释放租约。桥接可对同任务重复执行；--reuse 仅在现有证据通过全部复检时跳过重跑。

配方运行器产出 `verification.json`，格式见 [verification-v1.schema.json](verification-v1.schema.json)。`passed=true` 只表示声明的 level 和 predicates；source-tooling 不代表 Electron 界面、安装包、真机或线上通过。

验证器不执行 manifest 中的 command。它重新核对实际 HEAD、声明输入的完整文件集合与内容指纹、当前 Node/主机环境、每阶段结果和日志哈希。日志、脏工作树或目录新增文件变化，旧证据均不能用于完成。

独立检查：

```sh
python3 -B scripts/verification.py --repo <目标仓> --manifest <证据目录/verification.json> --level source-tooling --node <可信node绝对路径>
```

实施循环通过 TaskStore.accept_verification(task_id, owner, expected_revision, manifest_path, expected_level, node_executable) 导入。manifest 及日志应已位于该 TaskStore 的仓外工件区；现有租约、revision 和任务完成条件继续生效。重新接手时重新校验现有证据，有效则复用，失效才重跑对应配方。

crew 的 processPassed 与 acceptancePassed 分开；退出 0、全 skipped、缺证据均不能代替最终验收。历史任务的旧证据格式继续兼容，新配方使用本契约。运行配置和配方引用必须通过真实消费者接线，不能仅写入任务提示词。
