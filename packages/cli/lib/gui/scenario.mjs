// 场景执行引擎：真实输入路径 + 条件恢复。
// 依赖接口（与 runner 的真实 Puppeteer 适配、测试的 fake 完全一致，不做镜像假值）：
//   page.locateEditor(selector) -> { kind:'input'|'textarea'|'contenteditable', read(): Promise<string>, focus(): Promise<void> }
//     唯一可见元素：0 个/多个/不可见都抛错；read 是只读 DOM（value 或 textContent）。
//   keyboard.insertText(text)：focus 后的真实输入（CDP Input.insertText / keyboard.type 级别）；
//   keyboard.selectAllDelete()：全选删除（真实键盘级操作）。未 focus 时两者必须失败。
//   agent.aiBoolean(instruction)：模型视觉语义，返回值必须与 expect 比较。
// 语义：
//   - fill = focus → selectAllDelete → insertText；任何一步失败都尝试把原文写回（有限补偿），
//     且该选择器不计入"已写入"，恢复阶段不碰它（未开始成功写入不得清空原草稿）。
//   - 恢复只在"当前值仍是我们最后一次写入的值"时执行（并发被用户/页面改过 → fail 不覆盖他人输入）。
//   - aiBoolean 前后各校验一次目标身份（origin 不变），变了即失败。
//   - maxAiOperations 对 ai* 操作硬中止（执行前拦截）。
// 通过判定只看 expected vs actual 显式比较；false 即失败；恢复失败整体不许记 passed。

function resolveSelector(sel, bindings) {
  return bindings && Object.hasOwn(bindings, sel) ? bindings[sel] : sel;
}

export async function runScenarioSteps({ steps, bindings = {}, page, keyboard, agent, maxAiOperations = 1, expectedOrigin = null, checkTargetIdentity = null, registerRestore = null }) {
  const results = [];
  let aiUsed = 0;
  let failure = null;
  let status = 'passed';
  const wrote = new Map(); // selector -> { original, lastWritten }（仅成功 fill 过的选择器）

  const assertIdentity = async at => {
    if (!checkTargetIdentity) return;
    const id = await checkTargetIdentity();
    if (!id || id.origin !== expectedOrigin) {
      throw new Error(`${at}: 目标身份变化（期望 origin=${expectedOrigin}，实际 ${id ? id.origin : '无法读取'}）：不继续在未知页面上操作`);
    }
  };

  // 条件恢复闭包：finally 与 SIGTERM 有限清理共用
  const restoreAll = async () => {
    let ok = true;
    for (const [sel, { original }] of wrote) {
      const editor = await page.locateEditor(resolveSelector(sel, bindings));
      const cur = await editor.read();
      if (cur !== wrote.get(sel).lastWritten) {
        results.push({ id: `restore:${sel}`, op: 'restore', mechanism: 'conditional-restore', expected: wrote.get(sel).lastWritten, actual: cur, passed: false, note: '内容已被并发修改（用户/页面）：不覆盖他人输入' });
        ok = false;
        continue;
      }
      await editor.focus();
      await keyboard.selectAllDelete();
      if (original) await keyboard.insertText(original);
      const after = await editor.read();
      if (after !== original) {
        results.push({ id: `restore:${sel}`, op: 'restore', mechanism: 'conditional-restore', expected: original, actual: after, passed: false });
        ok = false;
      } else {
        results.push({ id: `restore:${sel}`, op: 'restore', mechanism: 'conditional-restore', expected: original, actual: after, passed: true });
      }
    }
    return ok;
  };
  if (registerRestore) registerRestore(restoreAll);

  for (const step of steps) {
    try {
      if (step.op === 'fill' || step.op === 'domValueEquals') {
        const editor = await page.locateEditor(resolveSelector(step.selector, bindings)); // 唯一可见，否则抛错
        if (step.op === 'domValueEquals') {
          const actual = await editor.read();
          const passed = actual === step.expected;
          results.push({ id: step.id, op: step.op, mechanism: `dom-read(${editor.kind})`, expected: step.expected, actual, passed });
          if (!passed) { failure = `步骤 ${step.id}: DOM 实际值 ${JSON.stringify(actual)} ≠ 期望 ${JSON.stringify(step.expected)}`; status = 'failed'; break; }
        } else {
          const original = await editor.read();
          await editor.focus();
          await keyboard.selectAllDelete();
          if (step.value) await keyboard.insertText(step.value);
          const actual = await editor.read();
          const passed = actual === step.value;
          results.push({ id: step.id, op: step.op, mechanism: `real-input(focus+selectAllDelete+insertText, ${editor.kind})`, expected: step.value, actual, passed });
          if (passed) {
            const prev = wrote.get(step.selector);
            wrote.set(step.selector, { original: prev ? prev.original : original, lastWritten: step.value }); // original 只记第一次 fill 前的值，后续 fill 不覆盖
          } else {
            // 写入未成功：有限补偿——把原文写回，且不计入已写入（不得清空原草稿）
            try {
              await editor.focus();
              await keyboard.selectAllDelete();
              if (original) await keyboard.insertText(original);
            } catch { /* 补偿失败由恢复阶段与 failures 如实呈现 */ }
            failure = `步骤 ${step.id}: 真实输入后回读值 ${JSON.stringify(actual)} ≠ 写入值 ${JSON.stringify(step.value)}`; status = 'failed'; break;
          }
        }
      } else if (step.op === 'aiBoolean') {
        if (!agent) { failure = `步骤 ${step.id}: 无可用视觉 agent（SDK 未加载）`; status = 'failed'; break; }
        if (aiUsed + 1 > maxAiOperations) { failure = `步骤 ${step.id}: ai* 操作数将达 ${aiUsed + 1}，超过配方 maxAiOperations=${maxAiOperations}，硬中止（该次不执行）`; status = 'failed'; break; }
        await assertIdentity(`步骤 ${step.id} 前`);
        aiUsed++;
        const actual = await agent.aiBoolean(step.instruction);
        await assertIdentity(`步骤 ${step.id} 后`);
        const passed = typeof actual === 'boolean' && actual === step.expect;
        results.push({ id: step.id, op: step.op, mechanism: 'midscene-aiBoolean(模型视觉语义)', expected: step.expect, actual, passed });
        if (!passed) { failure = `步骤 ${step.id}: aiBoolean 实际值 ${JSON.stringify(actual)} ≠ 期望 ${step.expect}（模型视觉核对不通过）`; status = 'failed'; break; }
      } else {
        failure = `步骤 ${step.id}: 未知 op ${step.op}`; status = 'failed'; break;
      }
    } catch (error) {
      results.push({ id: step.id, op: step.op, mechanism: step.op === 'aiBoolean' ? 'midscene-aiBoolean(模型视觉语义)' : 'real-input/dom', expected: step.expected ?? step.value ?? null, actual: null, passed: false, error: String(error?.message ?? error) });
      failure = `步骤 ${step.id}: 执行异常 ${error?.message ?? error}`;
      status = 'failed';
      break;
    }
  }

  // 恢复：无论成败，对成功写入过的选择器做条件恢复
  let restoreAttempted = wrote.size > 0, restoreOk = true;
  try {
    restoreOk = await restoreAll();
  } catch (error) {
    restoreOk = false;
    results.push({ id: 'restore', op: 'restore', mechanism: 'conditional-restore', expected: null, actual: null, passed: false, error: `恢复执行异常: ${error?.message ?? error}（有限清理未能完成，无法保证恢复）` });
  }
  if (restoreAttempted && !restoreOk && status === 'passed') { status = 'failed'; failure = '场景主体通过但副作用未按条件恢复（并发修改或恢复失败）：不允许记通过'; }
  return { status, steps: results, restoreAttempted, restoreOk, aiOperationsUsed: aiUsed, failure, wrote: [...wrote.entries()].map(([sel, w]) => ({ selector: sel, original: w.original, lastWritten: w.lastWritten })) };
}
