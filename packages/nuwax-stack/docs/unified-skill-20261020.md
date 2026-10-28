# 统一技能迁移（2026-10-20）

按用户要求，将七个分别发布的研发技能合并为一个 `nuwax-stack`。以后只维护一个版本、一个安装包和一个 Agent Skill 绑定；内部模块按任务读取，不把所有说明一次加载。

## 当前分发结构

```text
skills/nuwax-stack/
  SKILL.md                       唯一入口，版本 0.3.0
  references/
    triage.md                    分诊
    analyze-repo.md               代码分析
    autonomous-run.md             自主循环
    verify.md                     行为验证
    session-pickup.md             断点接手
    task-ledger.md                独立台账
    decision-log.md               决策记录
    grading.md / local-tools.md   模式细节
  scripts/
    append_record.py / ledger.py / task_state.py
```

原三个脚本的代码未改变，只迁入同一个包。旧技能的 SKILL 正文成为包内普通参考文件，保留来源只读、自有台账、授权范围、证据、租约与恢复规则，修正了相对引用。仓库不再保留七个独立技能目录。

## 生产迁移结果

- 新技能 [nuwax-stack](https://agent.nuwax.com/space/53245350/skill-details/13555)，ID `13555`，已 Published。平台 ZIP 导出与本地 13 个文件逐字节相同。
- [罗东研发助理](https://agent.nuwax.com/space/53245350/agent/33302412)现只有一个项目 Skill 绑定：组件 `398295` → `13555`，ON_DEMAND / 默认选中。七个旧绑定已移除，系统提示已改为只加载统一入口。
- 七个旧技能均已从个人空间下架，发布项列表为空、状态 Developing；旧草稿、Git 历史和本机导出保留用于回滚，不再作为日常发布入口。没有删除技能资源。
- Agent 本身仍为 Applying。绑定验证针对当前开发配置，不据此宣称 Agent 已通过发布审核或已进入全员群。

平台随装的 IM、资料库、文档等通用工具不属于这七个研发模块，保留平台原有管理。云端技能缓存可能仍有旧目录；“项目 Skill 绑定仅一个”不等于宿主全局只安装一个工具。

## 验证

1. 26 项原有回归通过，导入路径已迁移。打包测试确认只有一个 SKILL 入口且包含全部三个脚本；从真实 ZIP 解压后运行决策日志 CLI 成功。
2. 格式检查通过；默认预演只生成 `nuwax-stack.zip` 与一个 manifest 条目。旧生成包已移到忽略目录作为历史。
3. 新生产会话 `1741350` 只调用 Skill `nuwax-stack`，按路由读取包内接手、台账与决策模块，未调用旧子技能。
4. 新包 `task_state.py` 只读恢复既有任务 revision=2 / done，核对证据 SHA-256；旧数据库摘要前后一致。
5. 新包 `ledger.py` 实际允许个人页面 2852、拒绝来源 1652/1886/108；没有发文档写请求。新包 `append_record.py` 在临时目录连续运行，返回 appended / duplicate，最终只有一条记录。
6. 实际工具结果与成功 FINAL_RESULT 已保存至 `.local/unified-smoke-result.json`；平台最终绑定和下架结果记录于 `.local/unified-migration-verification.json`。这些文件不包含到 Git 分发中。

本轮完成的是技能管理方式合并。随后本机生产连接与执行已完成验收，见[MBP128 接入记录](work-computer-20261020.md)；@罗东 定向转交、Agent 身份私信和持续任务调度仍需完成，见[自主验收历史](autonomy-acceptance-20261020.md)与[群内接入设计](im-handoff-design.md)。

## 后续维护

只修改统一包内的入口、相关模块或脚本，统一升级 `SKILL.md` 的版本；离线预演、导出核对并发布 `nuwax-stack`。同一个平台技能 ID 与 Agent 绑定继续复用，不为每个模块新建技能。
