// DSH 0.2.1-rc.5's lazy CJS client-module wire, used by its shipped UI plugins.
// This small bundle is hand-written: no build tools, duplicate React, or runtime.
window.__ModuleLoader__.load({
  id: '@nuwax-ai/dsh-forge-dashboard',
  factory(require) {
    const { createElement: h, useState } = require('react');
    const PANEL = 'nuwax-forge-dashboard';
    const field = { padding: '8px', font: 'inherit', minWidth: 0 };

    function dashboardUrl(value) {
      if (typeof value !== 'string' || value !== value.trim() || /[\s\\]/.test(value)) throw new Error('请输入完整的 loopback HTTP(S) 地址');
      let url;
      try { url = new URL(value); } catch { throw new Error('请输入完整的 loopback HTTP(S) 地址'); }
      if (!['http:', 'https:'].includes(url.protocol)
          || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
          || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('看板仅允许 localhost、127.0.0.1 或 [::1] 的 HTTP(S) 根地址；不含凭据、查询或片段');
      }
      return url.href;
    }

    function hostOrigin(location) {
      const url = new URL(location.href);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin === 'null') throw new Error('请在 DSH 的 HTTP(S) Web 页面使用此面板');
      return url.origin;
    }

    function DashboardPanel() {
      const [address, setAddress] = useState('');
      const [connected, setConnected] = useState(null);
      const [error, setError] = useState('');
      let origin;
      try { origin = hostOrigin(window.location); } catch (e) { origin = null; }
      const connect = (event) => {
        event.preventDefault();
        try {
          const target = dashboardUrl(address);
          hostOrigin(window.location);
          if (window.location.protocol === 'https:' && new URL(target).protocol !== 'https:') throw new Error('HTTPS DSH 需要 HTTPS 看板；浏览器会阻止 HTTP iframe');
          setConnected(target);
          setError('');
        } catch (e) { setError(e.message); }
      };
      return h('section', {
        'aria-label': 'Nuwax Forge Dashboard',
        style: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', font: 'inherit' },
      },
      h('header', { style: { padding: '16px', borderBottom: '1px solid #8885' } },
        h('h2', { style: { margin: '0 0 8px' } }, 'Nuwax Forge'),
        h('p', null, '连接已启动的本地看板。地址属于当前浏览器所在设备；远程 DSH 的 127.0.0.1 不是服务器地址。'),
        h('p', null, 'DSH 来源：', h('code', { 'data-testid': 'forge-host-origin' }, origin || '不支持的页面来源')),
        h('p', null, '启动看板时显式加入： ', h('code', null, origin ? `--embed-origin ${origin}` : '需要 HTTP(S) DSH 来源')),
        h('form', { onSubmit: connect, style: { display: 'flex', gap: '8px' } },
          h('input', {
            'aria-label': 'Forge 看板地址', type: 'url', placeholder: 'http://127.0.0.1:端口/',
            value: address, onChange: (event) => setAddress(event.target.value),
            style: { ...field, flex: 1 }, required: true,
          }),
          h('button', { type: 'submit', style: field, disabled: !origin }, '连接'),
          connected && h('button', { type: 'button', style: field, onClick: () => setConnected(null) }, '断开')),
        error && h('p', { role: 'alert' }, error),
        connected && h('p', null,
          h('a', { href: connected, target: '_blank', rel: 'noopener noreferrer' }, '在浏览器打开看板'),
          ' · 如果下方空白，请检查服务是否可达及 --embed-origin 是否与上方来源完全一致。')),
      connected ? h('iframe', {
        key: connected, src: connected, title: 'Nuwax Forge Dashboard',
        sandbox: 'allow-scripts allow-same-origin', referrerPolicy: 'no-referrer',
        style: { border: 0, width: '100%', flex: 1, minHeight: '320px' },
      }) : h('p', { style: { padding: '16px' } }, '尚未连接看板。'));
    }

    function Icon() { return h('span', { 'aria-hidden': true, style: { fontSize: '13px' } }, 'F'); }

    function apply(ctx) {
      // DSH owns navigation, lifecycle, slots, React, and rendering.
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, DashboardPanel));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL, order: 30, label: 'Nuwax Forge',
      }, Icon));
    }

    return { apply, inject: ['slots'], dashboardUrl, hostOrigin };
  },
});
