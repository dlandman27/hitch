import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { laneName, parseDevices, parseStat } from './android.mjs';
import { diffHeap, summarizeHeapSnapshot } from './heap.mjs';
import { hotFunctions, profileSamples, stacksBetween } from './profile.mjs';
import { compareRuns, createRuns, describeComparison, summarizeRun } from './runs.mjs';
import { calibrateOffset, offsetAt } from './symbolicate.mjs';

test('profile samples become timed stacks without Hermes bookkeeping frames', () => {
  const cf = (functionName, url = 'http://x/index.bundle') => ({ functionName, url, scriptId: '1', lineNumber: 1, columnNumber: 2 });
  const profile = {
    nodes: [
      { id: 1, callFrame: cf('[root]', ''), children: [2, 4] },
      { id: 2, callFrame: cf('render'), children: [3] },
      { id: 3, callFrame: cf('Row'), children: [] },
      { id: 4, callFrame: cf('(idle)', ''), children: [] },
    ],
    samples: [3, 4, 3, 2],
    timeDeltas: [0, 10000, 10000, 10000],
    startTime: 5000000,
  };
  const samples = profileSamples({ profile, startedAt: 1000, scripts: new Map() });
  assert.deepEqual(samples.map(s => [s.at, s.frames.map(f => f.functionName).join('<')]), [[1000, 'Row<render'], [1020, 'Row<render'], [1030, 'render']]);
  assert.equal(stacksBetween(samples, 1010, 1040, 5).length, 2);
  const described = samples.map(s => s.frames.map(f => ({ name: f.functionName, kind: 'app', file: 'src/a.tsx', line: 3 })));
  const hot = hotFunctions(described, 10);
  assert.equal(hot.self[0].key, 'Row · src/a.tsx:3');
  assert.equal(hot.self[0].selfMs, 20);
});

test('heap snapshots summarize by constructor and diff', () => {
  const snap = (extra) => ({
    snapshot: { meta: { node_fields: ['type', 'name', 'id', 'self_size', 'edge_count'], node_types: [['hidden', 'object', 'string', 'closure']] } },
    strings: ['', 'Listener', 'Timer', 'onTick'],
    nodes: [1, 1, 1, 100, 0, 1, 2, 2, 50, 0, 3, 3, 3, 30, 0, ...extra],
  });
  const before = summarizeHeapSnapshot(snap([]));
  const after = summarizeHeapSnapshot(snap([1, 1, 4, 100, 0, 1, 1, 5, 100, 0]));
  assert.equal(before.groups.find(g => g.name === 'onTick()').count, 1);
  const diff = diffHeap(before, after);
  assert.equal(diff.grew[0].name, 'Listener');
  assert.equal(diff.grew[0].count, 2);
  assert.equal(diff.sizeDelta, 200);
});

test('map calibration reports how much of the bundle agrees with the map', () => {
  const sources = ['a.js', 'b.js', 'c.js'];
  // Each module: one mapped line then a footer line. The map is shifted by 1 line (a prepended banner).
  const bundle = ['banner', 'code a', '},0,[],"a.js");', 'code b', '},1,[],"b.js");', 'code c', '},2,[],"c.js");'].join('\n');
  const lines = [[[0, 0, 0, 0]], [[0, 0, 1, 0]], [[0, 1, 0, 0]], [[0, 1, 1, 0]], [[0, 2, 0, 0]], [[0, 2, 1, 0]]];
  const good = calibrateOffset(bundle, lines, sources);
  assert.equal(good.offset, 1);
  assert.equal(good.agreement, 1);
  // A module whose code differs (an extra line inside it) can't be placed with confidence.
  const edited = ['banner', 'code a', '},0,[],"a.js");', 'code b', 'extra', '},1,[],"b.js");', 'code c', '},2,[],"c.js");'].join('\n');
  const partial = calibrateOffset(edited, lines, sources);
  assert.ok(partial.agreement < 1);
  // Its own footer still places it, and the modules after it.
  assert.equal(offsetAt(partial, 4), 2);
  assert.equal(offsetAt(partial, 7), 2);
  // The same modules in another order (a fresh Metro vs a long-running one):
  // each module gets its own offset. (Module c shares its range with the banner.)
  const reordered = ['banner', 'code c', '},2,[],"c.js");', 'code a', '},0,[],"a.js");', 'code b', '},1,[],"b.js");'].join('\n');
  const moved = calibrateOffset(reordered, lines, sources);
  assert.deepEqual(moved.footerLines, [2, 4, 6]);
  assert.equal(offsetAt(moved, 1), -3);
  assert.equal(offsetAt(moved, 3), 3);
  assert.equal(offsetAt(moved, 5), 3);
  const reorderedNoBanner = ['code c', '},2,[],"c.js");', 'code a', '},0,[],"a.js");', 'code b', '},1,[],"b.js");'].join('\n');
  const moved2 = calibrateOffset(reorderedNoBanner, lines, sources);
  assert.equal(moved2.agreement, 1);
  assert.equal(offsetAt(moved2, 0), -4);
  assert.equal(offsetAt(moved2, 2), 2);
  // A map from different code: no module can be placed.
  assert.equal(calibrateOffset(edited, lines, ['x.js', 'y.js', 'z.js']).agreement, null);
});

test('runs summarize a window and compare with the previous run', async () => {
  const now = Date.now();
  const history = (blocked) => ({
    stalls: [{ type: 'stall', at: now - 500, ms: blocked, culprits: [{ key: 'k', name: 'Feed', kind: 'app', file: 'src/Feed.tsx', line: 3, count: 1 }], devOnly: null }],
    jank: [], console: [{ at: now - 100, level: 'error' }], requests: [], vitals: [], screens: [{ at: now - 400, name: 'lobby', ms: 2000 + blocked }],
  });
  const a = summarizeRun(history(400), now - 1000, now + 1);
  assert.equal(a.blockedMs, 400);
  assert.equal(a.errors, 1);
  assert.equal(a.offenders[0].where, 'Feed · src/Feed.tsx:3');
  const b = summarizeRun(history(100), now - 1000, now + 1);
  const cmp = compareRuns(a, b);
  assert.equal(cmp.verdict, 'better');
  assert.match(describeComparison(cmp), /JS blocked: 400ms → 100ms \(↓ better\)/);
  assert.match(describeComparison(cmp), /lobby screen load: 2400ms → 2100ms/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hitch-runs-'));
  let h = history(400);
  const engine = { history: () => h, status: () => ({ appId: 'com.x' }), renders: () => null };
  const runs = createRuns({ engine, root: () => dir, dir });
  runs.start('scroll home');
  assert.throws(() => runs.start('again'), /still recording/);
  const first = await runs.stop();
  assert.equal(first.previous, null);
  h = history(100);
  h.stalls[0].at = Date.now();
  runs.start('Scroll home');
  const second = await runs.stop();
  assert.equal(second.previous.name, 'scroll home');
  assert.equal(runs.list('scroll home').length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('android: devices, /proc stat lines and lane names', () => {
  assert.deepEqual(parseDevices('List of devices attached\nemulator-5554  device product:sdk model:Pixel_7 device:x\nZX1 unauthorized\n'), [{ serial: 'emulator-5554', model: 'Pixel 7' }]);
  const stat = '1234 (mqt_v_js) S 1 2 3 4 5 6 7 8 9 10 120 30 0 0 20 0 1 0 100 0 0';
  assert.deepEqual(parseStat(stat), { tid: 1234, name: 'mqt_v_js', ticks: 150 });
  assert.equal(parseStat('99 (Binder (pool)) S 1 2 3 4 5 6 7 8 9 10 5 5 0').ticks, 10);
  assert.equal(laneName('mqt_v_js', 5, 1), 'JS thread');
  assert.equal(laneName('com.app', 1, 1), 'Main/UI thread');
  assert.equal(laneName('pool-3-thread-2', 7, 1), 'unnamed threads (pool)');
});

test('scenarios validate their steps and are saved by name', async () => {
  const { createScenarios, validateSteps } = await import('./runs.mjs');
  assert.throws(() => validateSteps([]), /at least one step/);
  assert.throws(() => validateSteps([{ tap: 1 }]), /unknown step/);
  assert.throws(() => validateSteps([{ wait: 999 }]), /1-120 seconds/);
  assert.throws(() => validateSteps([{ open_url: 'lobby' }]), /scheme/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hitch-scenarios-'));
  const scenarios = createScenarios({ dir });
  scenarios.save('Cold home load', [{ reload: true }, { wait: 8 }]);
  assert.deepEqual(scenarios.load('cold home load').steps, [{ reload: true }, { wait: 8 }]);
  assert.equal(scenarios.list().length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('several plays of a scenario are summarized by their medians', async () => {
  const { medianSummary } = await import('./runs.mjs');
  const base = { seconds: 20, stalls: 5, worstStallMs: 300, devOnlyMs: 0, jankSeconds: 4, droppedFrames: 200, errors: 0, warnings: 2, slowRequests: 0, failedRequests: 0, offenders: [], renders: null };
  const merged = medianSummary([
    { ...base, blockedMs: 700, screens: [{ name: 'lobby', ms: 6000 }] },
    { ...base, blockedMs: 1900, screens: [{ name: 'lobby', ms: 2600 }] },
    { ...base, blockedMs: 800, screens: [{ name: 'lobby', ms: 5000 }] },
  ]);
  assert.equal(merged.iterations, 3);
  assert.equal(merged.blockedMs, 800);
  assert.deepEqual(merged.spread.blockedMs, [700, 1900]);
  assert.deepEqual(merged.screens, [{ name: 'lobby', ms: 5000 }]);
});

test('a saved run keeps its full breakdown and can be opened with its comparison', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hitch-run-detail-'));
  const now = Date.now();
  const h = {
    stalls: [{ type: 'stall', id: 1, at: now + 200, ms: 300, devOnly: null, culprits: [{ key: 'k', name: 'Feed', kind: 'app', file: 'src/Feed.tsx', line: 3, count: 1, snapshot: 1 }], snapshots: [[{ name: 'a' }], [{ name: 'b' }]] }],
    jank: [], console: [], requests: [{ type: 'request', id: 2, at: now + 300, ms: 80, url: 'https://x/y', method: 'GET', status: 200, issue: false }], vitals: [], screens: [], logs: [], alerts: [], hot: [], lanes: [],
  };
  const engine = { history: () => h, status: () => ({ appId: 'com.x' }), renders: () => null };
  const runs = createRuns({ engine, root: () => dir, dir });
  runs.start('open feed');
  const first = await runs.stop();
  assert.equal(first.run.detail, undefined);
  const list = runs.list('open feed');
  assert.equal(list.length, 1);
  assert.equal(list[0].detail, undefined);
  const opened = runs.get(list[0].id);
  assert.equal(opened.run.detail.stalls.length, 1);
  assert.deepEqual(opened.run.detail.stalls[0].snapshots, [[], [{ name: 'b' }]]);
  assert.equal(opened.run.detail.requests.length, 1);
  assert.equal(opened.previous, null);
  await new Promise(r => setTimeout(r, 5));
  runs.start('open feed');
  await runs.stop();
  const second = runs.list('open feed').at(-1);
  const both = runs.get(second.id);
  assert.equal(both.previous.id, list[0].id);
  assert.ok(both.comparison);
  assert.equal(runs.get('../etc/passwd'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runs can be deleted, and only by a well-formed id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hitch-run-delete-'));
  const engine = { history: () => ({ stalls: [], jank: [], console: [], requests: [], vitals: [], screens: [], logs: [], alerts: [], hot: [], lanes: [] }), status: () => ({}), renders: () => null };
  const runs = createRuns({ engine, root: () => dir, dir });
  runs.start('home v1');
  await runs.stop();
  const [run] = runs.list();
  assert.equal(runs.remove('../../etc/passwd'), false);
  assert.equal(runs.remove(run.id), true);
  assert.equal(runs.list().length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'home-v1')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
