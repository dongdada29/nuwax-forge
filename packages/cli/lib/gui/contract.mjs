// GUI 配方契约（guiRecipeSchemaVersion=1）：与 source-tooling 的 verification-v1 是**独立契约**，
// 不导入 TaskStore、不复用其完成态；仅由显式 `nuwax-devkit gui run` 消费。
// 目标锁定必须显式 shell vs 商业 guest + 预期 origin；登录/就绪前提显式声明；
// 模型只承担视觉语义（aiBoolean），固定选择/输入/清理必须是确定性 DOM 操作。
// 占位符（含 <…>、TODO、PLACEHOLDER）一律拒绝——不允许拿模板冒充可运行配方。

const LEVEL_IDS = ['gui-toolchain-smoke', 'gui-product-scenario'];
const PLACEHOLDER_RE = /[<>]|\bTODO\b|PLACEHOLDER/;

function isPlainObject(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }
function isSelector(v) { return isNonEmptyString(v) && !PLACEHOLDER_RE.test(v) && !/[。：；，]/.test(v) && !/^\s*note\b/i.test(v.trim()); }
function isRegexString(v) { return isNonEmptyString(v) && validRegex(v); }
function validRegex(v) { try { new RegExp(v); return true; } catch { return false; } }

function stepProblems(step, at, bindings) {
  const problems = [];
  if (!isPlainObject(step)) return [`${at} 必须是对象`];
  if (!isNonEmptyString(step.id)) problems.push(`${at}.id 必须是非空字符串`);
  switch (step.op) {
    case 'fill':
      if (!isSelector(step.selector) && !bindings.has(step.selector)) problems.push(`${at}.selector 必须是有效 CSS 选择器或已声明的绑定名`);
      if (typeof step.value !== 'string') problems.push(`${at}.value 必须是字符串`);
      if (step.value && PLACEHOLDER_RE.test(step.value)) problems.push(`${at}.value 含占位符`);
      break;
    case 'domValueEquals':
      if (!isSelector(step.selector) && !bindings.has(step.selector)) problems.push(`${at}.selector 必须是有效 CSS 选择器或已声明的绑定名`);
      if (typeof step.expected !== 'string') problems.push(`${at}.expected 必须是字符串`);
      break;
    case 'aiBoolean':
      if (!isNonEmptyString(step.instruction)) problems.push(`${at}.instruction 必须是非空字符串`);
      if (typeof step.expect !== 'boolean') problems.push(`${at}.expect 必须是 boolean（模型探测值必须与期望比较）`);
      break;
    default:
      problems.push(`${at}.op 仅支持 fill/domValueEquals/aiBoolean（收到 ${JSON.stringify(step.op)}）；Query 等值判断未实现，明确拒绝`);
  }
  return problems;
}

// 返回 null（通过）或问题数组。这是结构最小契约：不验证页面真实性——目标真实性由 live driver 锁定。
export function validateGuiRecipe(recipe) {
  const problems = [];
  if (!isPlainObject(recipe)) return ['GUI 配方必须是 JSON 对象'];
  if (recipe.guiRecipeSchemaVersion !== 1) problems.push(`guiRecipeSchemaVersion 必须为 1（收到 ${JSON.stringify(recipe.guiRecipeSchemaVersion)}）`);
  if (!isNonEmptyString(recipe.id)) problems.push('配方 id 必须是非空字符串');
  if (!LEVEL_IDS.includes(recipe.level)) problems.push(`配方 level 必须是 ${LEVEL_IDS.join('/')}（收到 ${JSON.stringify(recipe.level)}）`);
  if (!Number.isInteger(recipe.scenarioVersion) || recipe.scenarioVersion < 1) problems.push('scenarioVersion 必须是正整数');

  const build = recipe.declaredBuild;
  if (!isPlainObject(build)) {
    problems.push('declaredBuild 必须是对象（声明式身份，driver 只记录不核实；实际身份以 manifest 运行时观测为准）');
  } else if (isNonEmptyString(build.repo) && isNonEmptyString(build.head)) {
    if (build.asarSha256 !== undefined && !/^[0-9a-f]{64}$/.test(build.asarSha256)) problems.push('declaredBuild.asarSha256 必须是 64 位十六进制');
  } else if (isNonEmptyString(build.installVersion) && /^[0-9a-f]{64}$/.test(build.asarSha256 ?? '')) {
    // 安装版身份：{ installVersion, asarSha256 }（声明式；Codex 另行核对安装包哈希）
  } else {
    problems.push('declaredBuild 必须声明源码身份 {repo,head} 或安装身份 {installVersion,asarSha256}；不得用源码 HEAD 冒认安装版证据');
  }

  const target = recipe.target;
  if (!isPlainObject(target)) {
    problems.push('target 必须是对象：shell vs guest、预期 origin 必须显式');
  } else {
    if (target.kind !== 'guest' && target.kind !== 'shell') problems.push(`target.kind 必须是 guest 或 shell（收到 ${JSON.stringify(target.kind)}）`);
    if (!isNonEmptyString(target.expectedOrigin) || PLACEHOLDER_RE.test(target.expectedOrigin)) problems.push('target.expectedOrigin 必须是非占位符非空字符串（如 https://agent.example.com）');
    if (target.urlPattern !== undefined && !isRegexString(target.urlPattern)) problems.push('target.urlPattern 必须是可编译正则字符串');
    if (target.type !== undefined && target.type !== 'page' && target.type !== 'webview') problems.push('target.type 仅支持 page/webview（安装版商业 guest 实测为 webview）');
  }

  const ready = recipe.ready;
  if (!isPlainObject(ready) || !isRegexString(ready.titlePattern)) problems.push('ready.titlePattern 必须是可编译正则字符串（如 \\S，空标题=加载页不算就绪）');
  if (ready.settleMs !== undefined && (!Number.isInteger(ready.settleMs) || ready.settleMs < 0)) problems.push('ready.settleMs 必须是非负整数');

  const login = recipe.loginPrecondition;
  if (!isPlainObject(login) || !isSelector(login.selector)) {
    problems.push('loginPrecondition.selector 必须是有效非占位符 CSS 选择器（登录前提显式声明，未满足即 blocked，不伪造登录）');
  }

  const scenario = recipe.scenario;
  if (!isPlainObject(scenario) || !Array.isArray(scenario.steps) || scenario.steps.length === 0) {
    problems.push('scenario.steps 必须是非空数组');
  } else {
    const bindings = new Map(Object.entries(isPlainObject(recipe.selectorBindings) ? recipe.selectorBindings : {}));
    for (const [name, css] of bindings) if (!isSelector(css)) problems.push(`selectorBindings.${name} 必须是有效非占位符 CSS 选择器`);
    scenario.steps.forEach((step, i) => problems.push(...stepProblems(step, `scenario.steps[${i}]`, bindings)));
    const ids = scenario.steps.map(s => s?.id);
    if (new Set(ids).size !== ids.length) problems.push('scenario.steps.id 必须唯一');
    const aiCount = scenario.steps.filter(s => s?.op === 'aiBoolean').length;
    if (recipe.level === 'gui-product-scenario' && aiCount < 1) problems.push('gui-product-scenario 至少需要 1 个 aiBoolean 视觉核对步骤');
  }

  const model = recipe.model;
  if (!isPlainObject(model)) {
    problems.push('model 必须是对象');
  } else {
    if (model.authMode !== 'siwc') problems.push(`model.authMode 仅支持 siwc（收到 ${JSON.stringify(model.authMode)}）`);
    if (!isNonEmptyString(model.name) || !isNonEmptyString(model.family)) problems.push('model.{name,family} 必填');
    if (!Number.isInteger(model.maxAiOperations) || model.maxAiOperations < 1) problems.push('model.maxAiOperations 必须是正整数（driver 对 ai* 操作计数并硬中止）');
    if (model.maxModelRequestsObserved !== undefined && (!Number.isInteger(model.maxModelRequestsObserved) || model.maxModelRequestsObserved < 1)) problems.push('model.maxModelRequestsObserved 必须是正整数（观测预算，不是硬请求限制）');
    if (!Number.isInteger(model.maxWallSeconds) || model.maxWallSeconds < 1 || model.maxWallSeconds > 3600) problems.push('model.maxWallSeconds 必须是 1..3600 整数（runner 子进程组的真实硬超时）');
  }
  return problems.length ? problems : null;
}
