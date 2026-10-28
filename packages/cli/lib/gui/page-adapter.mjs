// Puppeteer 真实适配层（runner 与测试共用；测试用序列化边界 fake 复刻浏览器执行环境）。
// 关键边界：handle.evaluate 的函数体在**浏览器**执行——Node 闭包变量（如 selector）不存在，
// 必须作为实参传入 `(el, sel) => {...}, selector`；依赖闭包=ReferenceError（live-01 实测踩过）。
// 键盘：实测缓存 puppeteer-core 25.16.0 CDPKeyboard 只有 down/up/sendCharacter/type/press，
// **没有 insertText**（那是 Playwright 接口）→ 文本输入用 keyboard.type（逐字符真实按键），
// marker 为纯 ASCII 安全串，不含 Enter/控制字符，不会发送消息。
// 全选删除：**不用平台快捷键**（macOS Electron guest 实测 Meta+A 不选全、Backspace 只删最后一字，
// 导致残留 44 字）。采用 Codex 实测成功机制：DOM Range/select 选区 + 真实 Backspace——
// 只改选区，不给 value/textContent 赋值；且必须作用于**当前已 focus 的编辑器**（拒绝在 body 盲按）。
export function makePageAdapter(page) {
  let activeHandle = null, activeKind = null;
  const adapter = {
    // 最近一次 focus 的编辑器（键盘选区删除的作用对象；非 body）
    get active() { return activeHandle ? { handle: activeHandle, kind: activeKind } : null; },
    locateEditor: async selector => {
      const handle = await page.$(selector);
      if (!handle) throw new Error(`选择器 ${selector} 找不到元素（需唯一可见编辑器）`);
      const meta = await handle.evaluate((el, sel) => ({
        editable: el.isContentEditable === true || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA',
        kind: el.isContentEditable === true ? 'contenteditable' : el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName === 'INPUT' ? 'input' : null,
        visible: el.offsetParent !== null,
        duplicates: document.querySelectorAll(sel).length,
      }), selector);
      if (meta.duplicates !== 1) throw new Error(`选择器 ${selector} 匹配 ${meta.duplicates} 个元素（需唯一）`);
      if (!meta.visible) throw new Error(`选择器 ${selector} 元素不可见`);
      if (!meta.editable || !meta.kind) throw new Error(`选择器 ${selector} 不是可编辑元素（input/textarea/contenteditable）`);
      return {
        kind: meta.kind,
        read: async () => handle.evaluate(el => el.isContentEditable ? (el.textContent ?? '') : (el.value ?? '')),
        focus: async () => { await handle.focus(); activeHandle = handle; activeKind = meta.kind; },
      };
    },
  };
  return adapter;
}

export function makeKeyboardAdapter(page, pageAdapter) {
  return {
    // 真实 Puppeteer API：type 逐字符按键（无 insertText 方法）
    insertText: async text => page.keyboard.type(text),
    selectAllDelete: async () => {
      const active = pageAdapter?.active ?? null;
      if (!active) throw new Error('selectAllDelete 需要先 focus 一个编辑器（当前无活动编辑器，拒绝在 body 上盲按删除）');
      const { handle, kind } = active;
      if (kind === 'contenteditable') {
        // DOM Range 选中编辑器全部内容（只改选区），再真实 Backspace 删除
        await handle.evaluate(el => {
          const r = document.createRange();
          r.selectNodeContents(el);
          const s = getSelection();
          s.removeAllRanges();
          s.addRange(r);
        });
      } else {
        // input/textarea：原生选全（select 或 setSelectionRange 兜底）
        await handle.evaluate(el => {
          if (typeof el.select === 'function') el.select();
          else el.setSelectionRange(0, el.value.length);
        });
      }
      await page.keyboard.press('Backspace');
    },
  };
}
