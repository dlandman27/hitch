import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMcp } from './mcp.mjs';

const now = Date.now();
const history = {
  stalls: [{ type: 'stall', id: 1, at: now - 5000, ms: 240, culprits: [{ key: 'k', name: 'useRows', kind: 'app', file: 'src/useRows.ts', line: 12, count: 1 }], snapshots: [] }],
  hot: [],
  console: [{ type: 'console', id: 2, at: now - 3000, lastAt: now - 1000, level: 'error', text: 'save failed\nstack…', count: 3 }],
  requests: [
    { type: 'request', id: 3, at: now - 2000, ms: 80, url: 'https://api.example.com/ok', method: 'GET', status: 200, issue: false },
    { type: 'request', id: 4, at: now - 1500, ms: 2400, url: 'https://api.example.com/slow', method: 'POST', status: 200, issue: true },
  ],
  startups: [],
  alerts: [{ type: 'leak', id: 5, at: now - 500, kind: 'heap', from: 100e6, to: 150e6, mbPerMin: 6.5 }],
  logs: [{ type: 'log', id: 6, at: now - 4000, lastAt: now - 4000, level: 'info', text: 'Loaded BetSlip', count: 1 }],
  vitals: [{ at: now, heapUsed: 50e6, rss: 400e6, threads: 40 }],
};

function setup() {
  const calls = [];
  const engine = {
    status: () => ({ state: 'live', appId: 'com.example', device: 'iPhone', settings: { stallMs: 50 } }),
    history: () => history,
    clear: () => calls.push('clear'),
    reloadApp: async () => calls.push('reload'),
    writeReport: () => '/tmp/report.md',
  };
  const all = [history.stalls, history.console, history.requests, history.alerts].flat();
  const serve = createMcp({ engine, findEvent: id => all.find(e => e.id === id) ?? null, withContext: e => e, root: () => '/nowhere' });
  // Drive the handler the way server.mjs does, with a fake req/res.
  const rpc = async (body, headers = {}) => {
    const res = { status: 0, body: '', writeHead(s) { this.status = s; }, end(b) { this.body = b ?? ''; } };
    await serve({ method: 'POST', headers }, res, async () => body);
    return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
  };
  const tool = async (name, args = {}) => (await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } })).json.result;
  return { rpc, tool, calls };
}

test('initializes, lists tools and acknowledges notifications', async () => {
  const { rpc } = setup();
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(init.json.result.protocolVersion, '2025-06-18');
  assert.ok(init.json.result.capabilities.tools);
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const names = (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json.result.tools.map(t => t.name);
  assert.deepEqual(names, ['hitch_status', 'hitch_findings', 'hitch_finding', 'hitch_top_offenders', 'hitch_logs', 'hitch_requests', 'hitch_request', 'hitch_renders', 'hitch_profile', 'hitch_heap_snapshot', 'hitch_heap_diff', 'hitch_run_start', 'hitch_run_stop', 'hitch_run_scenario', 'hitch_runs', 'hitch_clear', 'hitch_reload_app', 'hitch_save_report']);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 3, method: 'nope' })).json.error.code, -32601);
});

test('refuses requests from a web page', async () => {
  const { rpc } = setup();
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'http://localhost:3000' })).status, 200);
});

test('lists findings with filters, skipping requests that were fine', async () => {
  const { tool } = setup();
  const all = (await tool('hitch_findings')).content[0].text;
  assert.match(all, /#1 .*JS stall 240ms — useRows · src\/useRows.ts:12/);
  assert.match(all, /#2 .*console.error ×3: save failed/);
  assert.match(all, /#4 .*slow 2400ms — POST https:\/\/api.example.com\/slow/);
  assert.match(all, /#5 .*JS heap climbing 6.5 MB\/min/);
  assert.doesNotMatch(all, /#3 /);
  assert.equal((await tool('hitch_findings', { kind: 'console' })).content[0].text.split('\n').length, 1);
  assert.match((await tool('hitch_findings', { search: 'USEROWS' })).content[0].text, /^#1 /);
  assert.doesNotMatch((await tool('hitch_findings', { after_id: 2 })).content[0].text, /#1 |#2 /);
  assert.equal((await tool('hitch_findings', { kind: 'bogus' })).isError, true);
});

test('hides dev-only freezes by default and groups bursts', async () => {
  const { tool } = setup();
  const extra = [
    { type: 'stall', id: 20, at: now - 900, ms: 100, burst: 20, devOnly: 'Reactotron', culprits: [{ name: 'diff', kind: 'lib', file: 'node_modules/reactotron/x.js', line: 1, count: 1 }], snapshots: [] },
    { type: 'stall', id: 21, at: now - 700, ms: 300, burst: 21, devOnly: null, culprits: [{ name: 'Feed', kind: 'app', file: 'src/Feed.tsx', line: 9, count: 1 }], snapshots: [] },
    { type: 'stall', id: 22, at: now - 300, ms: 200, burst: 21, devOnly: null, culprits: [], snapshots: [] },
  ];
  history.stalls.push(...extra);
  try {
    const text = (await tool('hitch_findings', { kind: 'stall' })).content[0].text;
    assert.match(text, /1 freezes in dev-only tooling hidden/);
    assert.match(text, /#21 .*burst of 2 JS stalls — 500ms blocked/);
    assert.match(text, /ids: 21, 22/);
    assert.match((await tool('hitch_findings', { kind: 'stall', dev_only: 'only' })).content[0].text, /#20 .*Reactotron/);
  } finally {
    history.stalls.splice(1);
  }
});

test('status, offenders, logs and actions', async () => {
  const { tool, calls } = setup();
  assert.match((await tool('hitch_status')).content[0].text, /app: com.example on iPhone[\s\S]*findings: stall 1 · hot 0 · console 1 · request 1 · startup 0 · leak 1 · jank 0 · screen 0/);
  assert.match((await tool('hitch_top_offenders')).content[0].text, /240ms blocked · +1 stalls · worst +240ms — useRows/);
  assert.match((await tool('hitch_logs', { search: 'betslip' })).content[0].text, /console.info: Loaded BetSlip/);
  assert.equal((await tool('hitch_finding', { id: 99 })).isError, true);
  await tool('hitch_clear');
  await tool('hitch_reload_app');
  assert.deepEqual(calls, ['clear', 'reload']);
  assert.match((await tool('hitch_save_report')).content[0].text, /report.md/);
});
