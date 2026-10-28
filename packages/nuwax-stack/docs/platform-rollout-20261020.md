# 平台接入记录（2026-10-20）

> 本文保留合并前七技能的发布和行为验收历史。当前已收敛为单个 `nuwax-stack`，最新管理方式与绑定见[统一技能迁移](unified-skill-20261020.md)。

## 测试环境的实测结果

目标：`https://testagent.xspaceagi.com`，个人空间 `752`，来源提交 `b368845`。

该轮在用户明确生产域名前已发出同步请求；请求随后完成。三个技能先创建草稿，经 export ZIP 逐文件字节比对，再发布并读取详情确认 `publishStatus=Published`。

| 技能 | 测试 skill ID | 状态 |
| --- | --- | --- |
| nuwax-analyze-repo | 980 | Published，导出内容与本地一致 |
| nuwax-decision-log | 981 | Published，导出内容与本地一致 |
| nuwax-triage | 982 | Published，导出内容与本地一致 |

当前未将它们绑定到现有 Agent，未向团队发送消息。测试状态记录位于未跟踪的 `.local/platform-state.json`，不含 AK。

## 生产环境接续

用户指定 **`https://agent.nuwax.com`**，并要求使用 **ego-browser**。该浏览器已有罗东的生产登录态；读取到个人空间 `53245350`，角色 Owner。生产操作通过同源 Cookie 请求完成，未将浏览器凭据导出到本地脚本；nuwa-cli 仍保持原测试域登录。

先按名称查重，未发现同名技能。随后创建三个生产草稿，下载 export ZIP，六个文件与本地 `skills/` 正本逐字节一致。发布后读取技能详情及发布项列表，确认如下：

| 技能 | 生产 skill ID | publish ID | 状态与范围 |
| --- | --- | --- | --- |
| [nuwax-analyze-repo](https://agent.nuwax.com/space/53245350/skill-details/13547) | 13547 | 126100 | Published；Space / 53245350 |
| [nuwax-decision-log](https://agent.nuwax.com/space/53245350/skill-details/13548) | 13548 | 126101 | Published；Space / 53245350 |
| [nuwax-triage](https://agent.nuwax.com/space/53245350/skill-details/13549) | 13549 | 126102 | Published；Space / 53245350 |

三个发布项的分类均为 `dev`（开发部署），`allowCopy=1`、`onlyTemplate=0`，没有发布到系统广场或其他团队空间。

生产状态为 `.local/production-state.json`，核验收据为 `.local/production-verification.json`，导出文件为 `.local/production-exports/`；这些文件均不跟踪到 Git。可供导入的本地包及 SHA256 清单位于 `dist/production/`。未复用测试空间或测试 skill ID。

## 生产联调修正

生产首次发布返回业务码 `4000`。按线上发布表单补齐 Space 发布项的 `spaceId` 后，服务端明确返回 `Please select a category`。读取生产技能分类列表，选择开发部署 `dev`，补齐分类后发布成功。

同步脚本现要求发布时显式提供 `--category`，并始终为 Space 发布项传入目标 `spaceId`。本地假服务也增加分类与空间契约检查，17 项测试通过；缺分类会在创建草稿前停止。

## 自主套件接续

同日将套件扩展为七个技能，三个原有技能同步修订，全部重新导出逐文件核对并确认 Published。新增 ID：`nuwax-autonomous-run=13550`、`nuwax-session-pickup=13551`、`nuwax-task-ledger=13552`、`nuwax-verify=13553`。当前完整核验收据为未跟踪的 `.local/production-suite-verification.json`，此前三技能收据仅代表早期版本。

新建专用[罗东研发助理](https://agent.nuwax.com/space/53245350/agent/33302412)，ID `33302412`，绑定七个技能，均为 ON_DEMAND / 默认选中。未修改原有 Agent。该 Agent 的个人空间发布申请已提交，目前读取状态为 Applying；不能将审核申请视为发布完成。

云端实际加载技能、命令执行和跨会话恢复已取得工具与终态证据；独立台账已保存 59 项。完整结果与群触发、电脑接入、通知身份等剩余缺口见[自主验收记录](autonomy-acceptance-20261020.md)。
