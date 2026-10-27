import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rangePrompt, summarizeRange, threadsBetween } from './range.mjs';

const t0 = 1_000_000;
const history = {
  stalls: [
    { type: 'stall', id: 1, at: t0 + 1000, ms: 300, devOnly: null, culprits: [{ key: 'a', name: 'Feed', kind: 'app', file: 'src/Feed.tsx', line: 4, count: 1 }] },
    { type: 'stall', id: 2, at: t0 + 2000, ms: 100, devOnly: 'Reactotron', culprits: [] },
    { type: 'stall', id: 3, at: t0 + 9000, ms: 500, devOnly: null, culprits: [] },
  ],
  requests: [{ type: 'request', id: 4, at: t0 + 1500, ms: 1200, method: 'GET', url: 'https://api.example.com/x', status: 200, issue: true, failed: false }],
  console: [{ type: 'console', id: 5, at: t0 + 1800, lastAt: t0 + 1800, level: 'error', text: 'boom\nstack', count: 1 }],
  logs: [{ type: 'log', id: 6, at: t0 + 1900, lastAt: t0 + 1900, level: 'info', text: 'loaded feed', count: 2 }],
  screens: [{ type: 'screen', id: 7, at: t0 + 500, name: 'lobby', ms: 2500, commits: 4, mounts: 90 }],
  jank: [],
  alerts: [],
  hot: [],
  vitals: [
    { at: t0, heapUsed: 100e6, rss: 500e6, threads: 40 },
    { at: t0 + 3000, heapUsed: 120e6, rss: 560e6, threads: 42 },
  ],
  lanes: [
    { at: t0 + 1050, windowMs: 50, lanes: [['JS thread', 50], ['Main/UI thread', 10]] },
    { at: t0 + 1100, windowMs: 50, lanes: [['JS thread', 25], ['Main/UI thread', 0]] },
  ],
};

test('a range collects what overlaps it, and leaves the rest out', () => {
  const r = summarizeRange(history, t0, t0 + 3000, null);
  assert.deepEqual(r.stalls.map(s => s.id), [1, 2]);
  assert.equal(r.blockedMs, 400);
  assert.equal(r.devOnlyMs, 100);
  assert.equal(r.offenders[0].where, 'Feed · src/Feed.tsx:4');
  assert.equal(r.requests.length, 1);
  assert.equal(r.screens[0].name, 'lobby');
  assert.equal(r.memory.heapFrom, 100e6);
  assert.equal(r.memory.heapTo, 120e6);
  assert.deepEqual(r.threads, [{ name: 'JS thread', pct: 75 }, { name: 'Main/UI thread', pct: 10 }]);
});

test('threads average their busy time over the ticks in the range', () => {
  // The first tick ended before the range began, so only the second counts.
  assert.deepEqual(threadsBetween(history.lanes, t0 + 1060, t0 + 1100), [{ name: 'JS thread', pct: 50 }]);
  assert.deepEqual(threadsBetween([], t0, t0 + 1), []);
});

test('the range brief names what happened and what to do', () => {
  const prompt = rangePrompt(summarizeRange(history, t0, t0 + 3000, null));
  assert.match(prompt, /^# Investigate 3s of the app/);
  assert.match(prompt, /around the \*\*lobby\*\* screen/);
  assert.match(prompt, /blocked \*\*400ms\*\* over 2 freeze\(s\) \(100ms of it dev-only tooling\)/);
  assert.match(prompt, /Slow request GET https:\/\/api.example.com\/x \(1200ms\)/);
  assert.match(prompt, /console.error: boom/);
  assert.match(prompt, /JS heap 95 → 114 MB/);
  assert.match(prompt, /console.info: loaded feed \(×2\)/);
  assert.match(prompt, /## What to do/);
});
