(() => {
  const controls = document.querySelector('.live-controls');
  const button = document.querySelector('#refresh-now');
  const status = document.querySelector('#refresh-status');
  const interval = Number(controls.dataset.interval);
  const filterIds = {q: 'task-search', state: 'task-state', source: 'task-source', executor: 'task-executor', period: 'task-period'};
  let busy = false;
  let view = 'tasks';
  let selectedTask = '';
  let filters = {};
  let contentHash = document.querySelector('#dashboard-content').dataset.contentHash;
  const pages = {};
  document.body.classList.add('live-dashboard');

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
    document.querySelectorAll('#dashboard-content section[data-view]').forEach(section => { section.hidden = section.dataset.view !== view; });
    document.querySelectorAll('#dashboard-content table[data-paginate]').forEach(table => {
      const key = table.dataset.paginate;
      const rows = [...table.querySelectorAll('tr')].filter(row => row.querySelector('td'));
      const matches = key === 'workbench' ? rows.filter(taskMatches) : rows;
      const total = Math.max(1, Math.ceil(matches.length / 10));
      pages[key] = Math.min(Math.max(pages[key] || 1, 1), total);
      rows.forEach(row => { row.hidden = true; });
      matches.slice((pages[key] - 1) * 10, pages[key] * 10).forEach(row => { row.hidden = false; });
      table.parentElement.querySelectorAll('.pager').forEach(element => element.remove());
      if (key === 'workbench') {
        document.querySelector('#task-results').textContent = '显示 ' + matches.length + ' / ' + rows.length + ' 个任务';
        document.querySelector('#task-no-match').hidden = matches.length > 0 || rows.length === 0;
      }
      if (matches.length <= 10) return;
      const pager = document.createElement('div'); pager.className = 'pager';
      const previous = document.createElement('button'); previous.type = 'button'; previous.textContent = '上一页'; previous.disabled = pages[key] === 1;
      const next = document.createElement('button'); next.type = 'button'; next.textContent = '下一页'; next.disabled = pages[key] === total;
      previous.addEventListener('click', () => { pages[key]--; renderView(); saveLocation(); });
      next.addEventListener('click', () => { pages[key]++; renderView(); saveLocation(); });
      const label = document.createElement('span'); label.textContent = '第 ' + pages[key] + ' / ' + total + ' 页 · ' + matches.length + ' 条';
      pager.append(previous, label, next); table.insertAdjacentElement('afterend', pager);
    });
  }

  function renderDialog() {
    const source = [...document.querySelectorAll('[data-task-detail]')].find(item => item.dataset.taskDetail === selectedTask);
    if (!selectedTask) { if (dialog.open) dialog.close(); return; }
    const scroll = dialog.scrollTop;
    if (source) {
      detail.replaceChildren(source.querySelector('.task-detail-body').cloneNode(true));
      detail.querySelector('h3').id = 'task-dialog-title';
    } else {
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

  async function refresh() {
    if (busy) return;
    busy = true; button.disabled = true; status.textContent = '正在刷新…';
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
        const expandedSources = document.querySelector('.source-health details')?.open;
        document.querySelector('#dashboard-content').innerHTML = content.innerHTML;
        contentHash = content.dataset.contentHash;
        renderView(); renderDialog(); saveLocation();
        const sourceDetails = document.querySelector('.source-health details');
        if (sourceDetails) sourceDetails.open = Boolean(expandedSources);
        const field = focus && document.getElementById(focus);
        if (field) { field.focus({preventScroll: true}); if (selection) field.setSelectionRange(...selection); }
      }
      document.querySelector('.meta').innerHTML = meta.innerHTML;
      document.querySelector('#source-time').textContent = source.textContent;
      status.textContent = '页面读取成功 ' + new Date().toLocaleTimeString() + ' · 来源时间见下方';
    } catch (_) {
      status.textContent = '刷新失败，保留上次数据；将自动重试';
    } finally { clearTimeout(timeout); busy = false; button.disabled = false; }
  }
  button.addEventListener('click', refresh);
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
