import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { PROBE_SOURCE, createScreenTracker, describeReason, jankPeriods, summarizeRenders } from './react-probe.mjs';

const commit = (at, rows, ms = 10) => ({ at, ms, rendered: rows.reduce((s, r) => s + r[1], 0), mounts: rows.reduce((s, r) => s + r[3], 0), rows });

test('summarizes renders per component, leading with app components', () => {
  const commits = [
    commit(1000, [['PlayerCard', 10, 40, 0, { 'props~ market:equal,onPress:fn': 8, 'state #1': 2 }], ['View', 300, 30, 100, { 'props~ style:equal': 150 }]]),
    commit(1200, [['PlayerCard', 5, 20, 5, {}], ['Feed', 1, 5, 0, { 'store #3': 1 }]]),
    commit(9000, [['Later', 1, 1, 0, {}]]),
  ];
  const r = summarizeRenders(commits, 900, 1300);
  assert.equal(r.commits, 2);
  assert.equal(r.components[0].name, 'PlayerCard');
  assert.equal(r.components[0].renders, 15);
  assert.equal(r.components[0].mounts, 5);
  assert.equal(r.components[0].avoidable, 8);
  assert.deepEqual(r.components.map(c => c.name), ['PlayerCard', 'Feed']);
  assert.equal(r.primitives[0].name, 'View');
  assert.equal(r.avoidable, 158);
});

test('describes reasons in plain language', () => {
  assert.equal(describeReason('props~ market:equal,onPress:fn'), 'new props with equal values (market: equal object, onPress: new function)');
  assert.equal(describeReason('parent (equal props)'), 'its parent re-rendered and passed equal props (not memoized)');
  assert.equal(describeReason('store #3 + context ?'), 'a store subscription changed (hook 3) + a context value changed');
  assert.equal(describeReason('props items:diff'), 'props changed (items: changed)');
});

test('jank periods skip frames that freezes already explain and merge seconds', () => {
  const seconds = [[100, 40, 20, 60], [101, 45, 15, 50], [102, 60, 0, 17], [103, 10, 50, 900]];
  const stalls = [{ at: 103000, ms: 900 }];
  const periods = jankPeriods(seconds, stalls);
  assert.equal(periods.length, 1);
  assert.equal(periods[0].at, 100000);
  assert.equal(periods[0].seconds, 2);
  assert.equal(periods[0].dropped, 35);
});

test('screen loads run until a quiet second', () => {
  const loads = [];
  const tracker = createScreenTracker({ onLoad: load => loads.push(load) });
  tracker.onScreen('lobby', 1000, 500);
  tracker.onCommits([commit(1200, [['A', 1, 5, 1, {}]], 30), commit(2500, [['A', 1, 5, 0, {}]], 20)]);
  tracker.tick(3000);
  assert.equal(loads.length, 0);
  tracker.tick(3600);
  assert.equal(loads.length, 1);
  assert.deepEqual([loads[0].name, loads[0].ms, loads[0].commits, loads[0].renderMs, loads[0].mounts], ['lobby', 1500, 2, 50, 1]);
});

// A tiny fake renderer: the probe walks fibers the way React leaves them after a commit.
test('the in-app probe records renders, reasons, mounts and the focused screen', () => {
  let onCommit = () => {};
  const hook = { onCommitFiberRoot: (...args) => onCommit(...args) };
  const timers = [];
  const context = { setInterval: (fn, ms) => timers.push(fn), clearInterval: () => {}, requestAnimationFrame: () => {}, Date };
  context.globalThis = context;
  context.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  vm.createContext(context);
  assert.equal(vm.runInContext(PROBE_SOURCE, context), 'ok');

  const Row = function Row() {};
  const Screen = function Lobby() {};
  const style = { flex: 1 };
  const prevRow = { tag: 0, type: Row, memoizedProps: { style, item: { id: 1 } }, memoizedState: null };
  const row = { tag: 0, type: Row, flags: 1, alternate: prevRow, memoizedProps: { style: { flex: 1 }, item: { id: 1 } }, memoizedState: null, actualDuration: 4 };
  const mounted = { tag: 0, type: Row, flags: 1, alternate: null, memoizedProps: {}, actualDuration: 2 };
  row.sibling = mounted;
  const nav = { isFocused: () => true };
  const screen = { tag: 0, type: Screen, flags: 1, alternate: { tag: 0, type: Screen, memoizedProps: { route: { name: 'lobby' }, navigation: nav }, child: null }, memoizedProps: { route: { name: 'lobby' }, navigation: nav }, child: row, actualDuration: 10 };
  row.return = screen;
  mounted.return = screen;
  const root = { current: { tag: 3, child: screen, alternate: { child: null }, actualDuration: 10 } };
  screen.return = root.current;

  context.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, root);
  const out = JSON.parse(vm.runInContext('__HITCH__.poll()', context));
  assert.equal(out.screen, 'lobby');
  assert.equal(out.commits.length, 1);
  const rows = Object.fromEntries(out.commits[0].rows.map(([name, n, ms, mounts, why]) => [name, { n, ms, mounts, why }]));
  assert.equal(rows.Row.n, 2);
  assert.equal(rows.Row.mounts, 1);
  assert.deepEqual(rows.Row.why, { 'props~ style:equal,item:equal': 1 });
  assert.equal(rows.Lobby.ms, 4);
});

test('a long frame gap is spread over the seconds it spans', () => {
  let rafCallback = null;
  let now = 10000;
  const hook = { onCommitFiberRoot: () => {} };
  const FakeDate = { now: () => now };
  const context = { setInterval: () => 0, clearInterval: () => {}, requestAnimationFrame: fn => (rafCallback = fn), Date: FakeDate, __REACT_DEVTOOLS_GLOBAL_HOOK__: hook };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(PROBE_SOURCE, context);
  const root = { current: { tag: 3, child: null, alternate: null, actualDuration: 1 } };
  context.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, root);
  const tick = ms => {
    now += ms;
    context.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, root);
    rafCallback();
  };
  tick(16);
  tick(16);
  tick(2000); // a 2s freeze from 10.032s to 12.032s
  tick(16);
  now = 14000;
  const out = JSON.parse(vm.runInContext('__HITCH__.poll()', context));
  const bySec = Object.fromEntries(out.frames.map(([sec, n, dropped, worst]) => [sec, { n, dropped, worst }]));
  assert.ok(bySec[10].dropped >= 57 && bySec[10].dropped <= 59, `second 10: ${bySec[10].dropped}`);
  assert.ok(bySec[11].dropped >= 59 && bySec[11].dropped <= 60, `second 11: ${bySec[11].dropped}`);
  assert.equal(bySec[12].worst, 16);
});
