(() => {
  const controls = document.querySelector('.live-controls');
  const button = document.querySelector('#refresh-now');
  const status = document.querySelector('#refresh-status');
  const interval = Number(controls.dataset.interval);
  let busy = false;
  let view = 'overview';
  let contentHash = document.querySelector('#dashboard-content').dataset.contentHash;
  const pages = {};
  function renderView() {
    document.querySelectorAll('.view-nav button').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.target === view));
    });
    document.querySelectorAll('#dashboard-content section[data-view]').forEach(section => {
      section.hidden = section.dataset.view !== view;
    });
    document.querySelectorAll('#dashboard-content table[data-paginate]').forEach(table => {
      const key = table.dataset.paginate;
      const rows = [...table.querySelectorAll('tr')].filter(row => row.querySelector('td'));
      const total = Math.max(1, Math.ceil(rows.length / 10));
      pages[key] = Math.min(Math.max(pages[key] || 1, 1), total);
      rows.forEach((row, i) => { row.hidden = Math.floor(i / 10) + 1 !== pages[key]; });
      table.parentElement.querySelectorAll('.pager').forEach(element => element.remove());
      if (rows.length <= 10) return;
      const pager = document.createElement('div'); pager.className = 'pager';
      const previous = document.createElement('button'); previous.type = 'button'; previous.textContent = '上一页';
      previous.disabled = pages[key] === 1;
      previous.addEventListener('click', () => { pages[key]--; renderView(); });
      const label = document.createElement('span'); label.textContent = `第 ${pages[key]} / ${total} 页 · ${rows.length} 条`;
      const next = document.createElement('button'); next.type = 'button'; next.textContent = '下一页';
      next.disabled = pages[key] === total;
      next.addEventListener('click', () => { pages[key]++; renderView(); });
      pager.append(previous, label, next); table.insertAdjacentElement('afterend', pager);
    });
  }
  document.querySelectorAll('.view-nav button').forEach(button => button.addEventListener('click', () => {
    view = button.dataset.target; renderView();
  }));
  renderView();
  async function refresh() {
    if (busy) return;
    busy = true; button.disabled = true; status.textContent = '正在刷新…';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch('/', {cache:'no-store', signal:controller.signal});
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const next = new DOMParser().parseFromString(await response.text(), 'text/html');
      const content = next.querySelector('#dashboard-content');
      const meta = next.querySelector('.meta');
      const source = next.querySelector('#source-time');
      if (!content || !meta || !source) throw new Error('invalid response');
      if (content.dataset.contentHash !== contentHash) {
        document.querySelector('#dashboard-content').innerHTML = content.innerHTML;
        contentHash = content.dataset.contentHash;
        renderView();
      }
      document.querySelector('.meta').innerHTML = meta.innerHTML;
      document.querySelector('#source-time').textContent = source.textContent;
      status.textContent = '已更新 ' + new Date().toLocaleTimeString() + ' · 每 ' + interval + ' 秒自动刷新';
    } catch (_) {
      status.textContent = '刷新失败，保留上次数据；将自动重试';
    } finally { clearTimeout(timeout); busy = false; button.disabled = false; }
  }
  button.addEventListener('click', refresh);
  document.addEventListener('click', async event => {
    const action = event.target.closest('button[data-approval][data-decision]');
    if (!action || action.disabled) return;
    action.disabled = true;
    try {
      const response = await fetch('/api/approvals/decision', {method:'POST', headers:{'Content-Type':'application/json',
        'X-Forge-CSRF':document.querySelector('meta[name="forge-csrf"]').content},
        body:JSON.stringify({id:action.dataset.approval, decision:action.dataset.decision})});
      if (!response.ok) throw new Error('decision failed');
      await refresh();
    } catch (_) { status.textContent = '审批提交失败，请刷新后重试'; }
    finally { action.disabled = false; }
  });
  setInterval(refresh, interval * 1000);
})();