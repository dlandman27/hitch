import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { hasFindings, writeReport } from './engine.mjs';
import { createObservers } from './observers.mjs';

function setup() {
  const published = [];
  let id = 0;
  const observers = createObservers({
    publish: e => published.push(e),
    settings: { slowRequestMs: 1000 },
    nextId: () => ++id,
    symbolicate: async frames => frames.map(f => ({ name: f.functionName, file: 'src/App.tsx', line: 10, kind: 'app' })),
    getPid: () => null,
    getInspector: () => null,
    getThreadNames: () => [],
    sessionStartedAt: Date.now() - 1000,
  });
  return { observers, published };
}

const raw = (level, text, at = Date.now()) => ({ level, text, at, frames: [{ functionName: 'save', url: 'bundle', lineNumber: 1, columnNumber: 1 }], ignore: false });

test('groups warnings that differ only by ids and numbers, keeping the latest text', async () => {
  const { observers, published } = setup();
  await observers.onConsole(raw('warning', 'retry 1 for order 123'));
  await observers.onConsole(raw('warning', 'retry 2 for order 456'));
  const { console: events } = observers.history();
  assert.equal(events.length, 1);
  assert.equal(events[0].count, 2);
  assert.equal(events[0].text, 'retry 1 for order 123');
  assert.equal(events[0].lastText, 'retry 2 for order 456');
  assert.equal(published.at(-1).count, 2);
});

test('keeps plain logs as context and sends them in batches', async () => {
  const { observers, published } = setup();
  await observers.onConsole(raw('log', 'mounted Home'));
  await observers.onConsole(raw('log', 'mounted Home'));
  await observers.onConsole(raw('info', 'fetched 20 bets'));
  assert.equal(observers.history().console.length, 0);
  assert.deepEqual(
    observers.history().logs.map(l => [l.level, l.text, l.count]),
    [
      ['log', 'mounted Home', 2],
      ['info', 'fetched 20 bets', 1],
    ],
  );
  assert.equal(published.length, 0);
  observers.stop();
  const batch = published.find(e => e.type === 'logs');
  assert.equal(batch.entries.length, 2);
});

test('a session with only console errors still gets a report', async () => {
  const { observers } = setup();
  await observers.onConsole(raw('error', 'boom'));
  const history = { stalls: [], hot: [], lanes: [], alerts: [], ...observers.history() };
  assert.ok(hasFindings(history));
  assert.ok(!hasFindings({ stalls: [], hot: [], alerts: [], console: [], requests: [{ issue: false }], startups: [] }));
  observers.stop();
});

test('report lists console errors, requests and startups', async () => {
  const { observers } = setup();
  await observers.onConsole(raw('error', 'boom | pipe'));
  observers.stop();
  const history = { stalls: [], hot: [], lanes: [], alerts: [], ...observers.history() };
  history.requests.push({ type: 'request', at: Date.now(), ms: 2300, method: 'GET', url: 'https://api.example.com/bets/open', status: 200, failed: false, issue: true, source: null });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hitch-'));
  const status = { appId: 'com.example', startedAt: new Date().toISOString(), settings: { stallMs: 50 } };
  const md = fs.readFileSync(writeReport(history, status, dir), 'utf8');
  assert.match(md, /1 console errors · 0 warnings · 1 slow\/failed requests/);
  assert.match(md, /\| error \| 1 \| .* \| boom \\\| pipe \| `src\/App\.tsx:10` \|/);
  assert.match(md, /GET https:\/\/api\.example\.com\/bets\/open/);
  assert.doesNotMatch(md, /Lines blocking the JS thread/);
});
