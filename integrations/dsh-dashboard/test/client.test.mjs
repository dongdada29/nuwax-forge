import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
function load() {
  let registration;
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: (row) => { registration = row; } } }, URL });
  assert.equal(registration.id, manifest.name);
  return registration.factory((id) => { assert.equal(id, 'react'); return {}; });
}

test('ships a DSH web module and additive real slot registrations', () => {
  const plugin = load();
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.exports['./client'], './client.js');
  const rows = [];
  const scopes = [];
  plugin.apply({ slots: {
    inject(name, callback) { scopes.push(name); callback(); },
    register(options, component) { rows.push({ options, component }); return () => {}; },
  } });
  assert.deepEqual(scopes, ['main', 'sidebar.panellist']);
  assert.equal(rows[0].options.key, rows[1].options.id);
  assert.equal(typeof rows[0].component, 'function');
});

test('only explicit local dashboard root URLs are accepted', () => {
  const { dashboardUrl } = load();
  for (const value of ['http://localhost:1234/', 'http://127.0.0.1:3000', 'https://[::1]:443/']) assert.ok(dashboardUrl(value));
  for (const value of ['https://example.com/', 'http://127.0.0.1.evil/', '//localhost/', 'file:///tmp/index.html',
    'http://user:pass@localhost/', 'http://localhost/path', 'http://localhost/?token=x', 'http://localhost/#x',
    ' http://localhost/', 'http://localhost/\n', 'http://localhost\\@evil/']) assert.throws(() => dashboardUrl(value), value);
});

test('DSH origin preserves protocol, hostname, and port and rejects opaque origins', () => {
  const { hostOrigin } = load();
  assert.equal(hostOrigin({ href: 'https://dsh.example:444/path?x=1' }), 'https://dsh.example:444');
  assert.equal(hostOrigin({ href: 'http://127.0.0.1:3080/' }), 'http://127.0.0.1:3080');
  assert.throws(() => hostOrigin({ href: 'file:///app.html' }));
});
