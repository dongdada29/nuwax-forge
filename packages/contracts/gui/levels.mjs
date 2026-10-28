// 验证 level 边界（正本）。level 决定一份证据能声明什么，不决定证据真伪。
// source-tooling 使用原 TaskStore；GUI 为独立的可选 live driver，不放宽 source verify 的 level 门。
export const LEVELS = [
  {
    id: 'source-tooling',
    status: 'implemented',
    meaning: '仓内源码/脚本层的固定验收：配方 stages 的 argv 执行 + manifest 复核 + TaskStore 导入',
    canClaim: ['测试/doctor/脚本回归通过', '证据与输入指纹绑定，可离线复用'],
    cannotClaim: ['Electron GUI、安装包、真机、线上通过'],
  },
  {
    id: 'gui-toolchain-smoke',
    status: 'optional-live-driver',
    meaning: 'GUI 工具链冒烟：仅声明 CDP 附着/截图/模型调用/报告产出链路可用',
    canClaim: ['driver 连接、目标选择、报告与模型观测链路存在'],
    cannotClaim: ['任何产品谓词通过', '替代 gui-product-scenario'],
    requires: ['显式 target 声明（shell 或 guest，含预期 origin/URL）', '模型观测：缺失记 unknown，不得记 0'],
  },
  {
    id: 'gui-product-scenario',
    status: 'optional-live-driver',
    meaning: '产品场景验收：具名完成条件 + 独立判定的断言值',
    canClaim: ['声明的产品谓词在记录的目标/构建/登录前提下成立（live driver 已实现）；具名验收范围见 docs/CLIENT-GUI-TOKEN-ACCEPTANCE-20261027.md'],
    cannotClaim: ['源码哈希不变即可跨部署/登录态复用（默认不复用 GUI 动态证据）'],
    requires: [
      '显式 shell/guest 目标 + 预期 origin',
      '页面 ready 条件与登录前提显式声明',
      'Boolean/Assert 的 output 必须与配方期望比较：false 即失败',
      'finished / exit=0 / HTML 存在均不构成通过',
      '模型观测缺失记 unknown；maxModelRequests 仅观测预算，不是硬中止',
    ],
  },
];

export const LEVEL_IDS = LEVELS.map(l => l.id);

export function levelById(id) {
  return LEVELS.find(l => l.id === id) ?? null;
}
