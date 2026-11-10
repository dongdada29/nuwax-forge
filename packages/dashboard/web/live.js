(() => {
  const controls = document.querySelector('.live-controls');
  const button = document.querySelector('#refresh-now');
  const status = document.querySelector('#refresh-status');
  const interval = Number(controls.dataset.interval);
  const filterIds = {q: 'task-search', state: 'task-state', source: 'task-source', executor: 'task-executor', period: 'task-period'};
  let busy = false;
  let refreshPromise = Promise.resolve();
  let view = 'tasks';
  let selectedTask = '';
  let dialogContent = '';
  let filters = {};
  let contentHash = document.querySelector('#dashboard-content').dataset.contentHash;
  const pages = {};
  const automaticStatus = '自动刷新：每 ' + interval + ' 秒';
  document.body.classList.add('live-dashboard');

  const setText = (element, text) => { if (element.textContent !== text) element.textContent = text; };
  const setHidden = (element, hidden) => { if (element.hidden !== hidden) element.hidden = hidden; };
  const owned = node => node.nodeType === Node.ELEMENT_NODE && node.hasAttribute('data-live-owned');
  function nodeKey(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    for (const name of ['id', 'data-task-row', 'data-task-detail', 'data-approval-card']) {
      if (node.hasAttribute(name)) return name + ':' + node.getAttribute(name);
    }
    return '';
  }
  // Keep existing controls, task rows and details mounted. Polling must not
  // reset focus, text selection, expanded plans or the reader's scroll position.
  function patchChildren(current, next) {
    const keyed = new Map([...current.childNodes].filter(node => nodeKey(node)).map(node => [nodeKey(node), node]));
    let cursor = current.firstChild;
    for (const wanted of next.childNodes) {
      while (cursor && owned(cursor)) cursor = cursor.nextSibling;
      const key = nodeKey(wanted);
      let node = key ? keyed.get(key) : cursor && !nodeKey(cursor) ? cursor : null;
      if (!node || node.nodeType !== wanted.nodeType || node.nodeName !== wanted.nodeName) {
        node = wanted.cloneNode(true); current.insertBefore(node, cursor);
      } else {
        if (node !== cursor) current.insertBefore(node, cursor);
        if (node.nodeType === Node.ELEMENT_NODE) {
          const local = name => name === 'open' || name === 'hidden' || (name === 'disabled' && node.hasAttribute('data-approval'));
          for (const attribute of [...node.attributes]) {
            if (!local(attribute.name) && !wanted.hasAttribute(attribute.name)) node.removeAttribute(attribute.name);
          }
          for (const attribute of wanted.attributes) {
            if (!local(attribute.name) && node.getAttribute(attribute.name) !== attribute.value) node.setAttribute(attribute.name, attribute.value);
          }
          patchChildren(node, wanted);
        } else if (node.nodeValue !== wanted.nodeValue) node.nodeValue = wanted.nodeValue;
      }
      cursor = node.nextSibling;
    }
    while (cursor) {
      const nextNode = cursor.nextSibling;
      if (!owned(cursor)) cursor.remove();
      cursor = nextNode;
    }
  }

  const dialog = document.createElement('dialog');
  dialog.className = 'task-dialog';
  dialog.setAttribute('aria-labelledby', 'task-dialog-title');
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'task-dialog-close'; close.textContent = '关闭详情';
  const detail = document.createElement('div');
  dialog.append(close, detail); document.body.append(dialog);

  function readLocation() {
    const params = new URLSearchParams(location.search);
    const requested = params.get('view') || 'tasks';
    view = [...document.querySelectorAll('.view-nav button')].some(b => b.dataset.target === requested) ? requested : 'tasks';
    filters = Object.fromEntries(Object.keys(filterIds).map(key => [key, params.get(key) || '']));
    selectedTask = params.get('task') || '';
    pages.workbench = Math.max(1, Number.parseInt(params.get('page'), 10) || 1);
  }

  function saveLocation(push = false) {
    const url = new URL(location.href);
    const values = {view: view === 'tasks' ? '' : view, ...Object.fromEntries(Object.keys(filterIds).map(key => [key, filters[key] || ''])), task: selectedTask, page: pages.workbench > 1 ? String(pages.workbench) : ''};
    for (const [key, value] of Object.entries(values)) {
      if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    }
    history[push ? 'pushState' : 'replaceState'](null, '', url);
  }

  function restoreControls() {
    for (const [key, id] of Object.entries(filterIds)) {
      const field = document.getElementById(id);
      if (!field) continue;
      if (field.tagName === 'SELECT' && filters[key] && ![...field.options].some(o => o.value === filters[key])) {
        const option = document.createElement('option'); option.value = filters[key];
        option.textContent = filters[key] + ' · 当前无记录'; field.append(option);
      }
      field.value = filters[key] || '';
    }
    document.querySelectorAll('[data-task-state]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.taskState === filters.state)));
  }

  function taskMatches(row) {
    const names = key => JSON.parse(row.dataset[key]);
    if (filters.q && !row.dataset.search.includes(filters.q.trim().toLowerCase())) return false;
    if (filters.state && row.dataset.state !== filters.state) return false;
    if (filters.source && !names('sources').includes(filters.source)) return false;
    if (filters.executor && !names('executors').includes(filters.executor)) return false;
    if (filters.period) {
      const now = new Date();
      const since = filters.period === 'today' ? new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() : now.getTime() - 7 * 86400000;
      if (!row.dataset.at || Number(row.dataset.at) * 1000 < since) return false;
    }
    return true;
  }

  function renderView() {
    restoreControls();
    document.querySelectorAll('.view-nav button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.target === view)));
    document.querySelectorAll('#dashboard-content section[data-view]').forEach(section => setHidden(section, section.dataset.view !== view));
    document.querySelectorAll('#dashboard-content table[data-paginate]').forEach(table => {
      const key = table.dataset.paginate;
      const rows = [...table.querySelectorAll('tr')].filter(row => row.querySelector('td'));
      const matches = key === 'workbench' ? rows.filter(taskMatches) : rows;
      const total = Math.max(1, Math.ceil(matches.length / 10));
      pages[key] = Math.min(Math.max(pages[key] || 1, 1), total);
      const visible = new Set(matches.slice((pages[key] - 1) * 10, pages[key] * 10));
      rows.forEach(row => setHidden(row, !visible.has(row)));
      let pager = [...table.parentElement.querySelectorAll('.pager')].find(element => element.dataset.table === key);
      if (key === 'workbench') {
        setText(document.querySelector('#task-results'), '显示 ' + matches.length + ' / ' + rows.length + ' 个任务');
        setHidden(document.querySelector('#task-no-match'), matches.length > 0 || rows.length === 0);
      }
      if (matches.length <= 10) { pager?.remove(); return; }
      if (!pager) {
        pager = document.createElement('div'); pager.className = 'pager'; pager.dataset.table = key; pager.setAttribute('data-live-owned', '');
        const previous = document.createElement('button'); previous.type = 'button'; previous.textContent = '上一页';
        const next = document.createElement('button'); next.type = 'button'; next.textContent = '下一页';
        previous.addEventListener('click', () => { pages[key]--; renderView(); saveLocation(); });
        next.addEventListener('click', () => { pages[key]++; renderView(); saveLocation(); });
        pager.append(previous, document.createElement('span'), next); table.insertAdjacentElement('afterend', pager);
      }
      pager.firstElementChild.disabled = pages[key] === 1;
      pager.lastElementChild.disabled = pages[key] === total;
      setText(pager.querySelector('span'), '第 ' + pages[key] + ' / ' + total + ' 页 · ' + matches.length + ' 条');
    });
  }

  function renderDialog() {
    const source = [...document.querySelectorAll('[data-task-detail]')].find(item => item.dataset.taskDetail === selectedTask);
    if (!selectedTask) { if (dialog.open) dialog.close(); return; }
    const scroll = dialog.scrollTop;
    if (source) {
      const body = source.querySelector('.task-detail-body');
      const signature = selectedTask + ':' + body.innerHTML;
      if (signature !== dialogContent) {
        patchChildren(detail, {childNodes: [body]});
        detail.querySelector('h3').id = 'task-dialog-title';
        dialogContent = signature;
      }
    } else {
      dialogContent = '';
      const heading = document.createElement('h3'); heading.id = 'task-dialog-title'; heading.textContent = '任务已不在当前数据范围';
      detail.replaceChildren(heading);
    }
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = scroll;
  }

  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    const previous = selectedTask;
    selectedTask = ''; saveLocation();
    const trigger = [...document.querySelectorAll('[data-task-open]')].find(item => item.dataset.taskOpen === previous);
    if (trigger && !trigger.closest('tr')?.hidden) trigger.focus({preventScroll: true});
  });
  addEventListener('popstate', () => { readLocation(); renderView(); renderDialog(); });

  function filterChanged(event) {
    const entry = Object.entries(filterIds).find(([, id]) => event.target.id === id);
    if (!entry || (filters[entry[0]] || '') === event.target.value) return;
    filters[entry[0]] = event.target.value; pages.workbench = 1; renderView(); saveLocation();
  }
  document.addEventListener('input', event => { if (event.target.id === 'task-search') filterChanged(event); });
  document.addEventListener('change', filterChanged);

  function refresh({manual = false} = {}) {
    if (busy) return manual ? refreshPromise.then(() => refresh({manual: true})) : refreshPromise;
    busy = true;
    if (manual) { button.disabled = true; setText(status, '正在刷新…'); }
    refreshPromise = update(manual).finally(() => { busy = false; if (manual) button.disabled = false; });
    return refreshPromise;
  }

  async function update(manual) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch('./', {cache: 'no-store', signal: controller.signal});
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const next = new DOMParser().parseFromString(await response.text(), 'text/html');
      const content = next.querySelector('#dashboard-content');
      const meta = next.querySelector('.meta');
      const source = next.querySelector('#source-time');
      if (!content || !meta || !source) throw new Error('invalid response');
      if (content.dataset.contentHash !== contentHash) {
        const active = document.activeElement;
        const focus = active?.id;
        const selection = active?.id === 'task-search' ? [active.selectionStart, active.selectionEnd] : null;
        const scroll = {left: window.scrollX, top: window.scrollY};
        const anchor = document.elementFromPoint(window.innerWidth / 2, Math.min(120, window.innerHeight / 2))?.closest('[data-task-row], [data-approval-card], .summary-card, section');
        const anchorTop = anchor?.getBoundingClientRect().top;
        patchChildren(document.querySelector('#dashboard-content'), content);
        contentHash = content.dataset.contentHash;
        renderView(); renderDialog(); saveLocation();
        const field = focus && document.getElementById(focus);
        if (!active?.isConnected && field) { field.focus({preventScroll: true}); if (selection) field.setSelectionRange(...selection); }
        if (anchor?.isConnected && anchor.getClientRects().length) scroll.top = window.scrollY + anchor.getBoundingClientRect().top - anchorTop;
        window.scrollTo({...scroll, behavior: 'instant'});
        patchChildren(document.querySelector('.meta'), meta);
      }
      if (manual) patchChildren(document.querySelector('.meta'), meta);
      setText(document.querySelector('#source-time'), source.textContent);
      setText(status, automaticStatus);
      status.title = '最近成功读取：' + new Date().toLocaleTimeString() + '；数据来源时间见下方';
    } catch (_) {
      setText(status, '刷新失败，保留上次数据；将自动重试');
    } finally { clearTimeout(timeout); }
  }
  button.addEventListener('click', () => refresh({manual: true}));
  document.addEventListener('click', async event => {
    const target = event.target.closest('button, a[data-task-open]');
    if (!target) return;
    if (target.dataset.taskOpen) {
      event.preventDefault(); selectedTask = target.dataset.taskOpen; saveLocation(true); renderDialog(); return;
    }
    if ('taskState' in target.dataset) {
      filters.state = filters.state === target.dataset.taskState ? '' : target.dataset.taskState;
      pages.workbench = 1; renderView(); saveLocation(); return;
    }
    if (target.id === 'task-reset') {
      filters = {}; pages.workbench = 1; renderView(); saveLocation(); return;
    }
    const destination = target.dataset.target || target.dataset.goView;
    if (destination) {
      if (dialog.open) dialog.close(); selectedTask = ''; view = destination; renderView(); saveLocation(); return;
    }
    if (!target.dataset.approval || !target.dataset.decision || target.disabled) return;
    target.disabled = true;
    try {
      const response = await fetch('./api/approvals/decision', {method: 'POST', headers: {'Content-Type': 'application/json',
        'X-Forge-CSRF': document.querySelector('meta[name="forge-csrf"]').content},
        body: JSON.stringify({id: target.dataset.approval, decision: target.dataset.decision})});
      if (!response.ok) throw new Error('decision failed');
      await refresh();
    } catch (_) { status.textContent = '审批提交失败，请刷新后重试'; }
    finally { target.disabled = false; }
  });
  readLocation(); renderView(); renderDialog();
  setInterval(refresh, interval * 1000);
})();
