// Reads every app thread's CPU time from the host with `ps -M` (~3ms of host
// CPU per poll, nothing inside the app). Thread rows are named with a 0.3s
// `sample`, refreshed at most every 10s when the thread count changes.

import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';

import { threadNames } from './native-sample.mjs';

const run = promisify(execFile);
const RENAME_MIN_INTERVAL_MS = 10000;

function cpuSeconds(text) {
  // [[dd-]hh:]mm:ss.ss
  const [days, rest] = text.includes('-') ? text.split('-') : ['0', text];
  return rest.split(':').reduce((acc, part) => acc * 60 + Number(part), 0) + Number(days) * 86400;
}

async function readThreadCpu(pid) {
  const { stdout } = await run('ps', ['-M', '-p', String(pid)]);
  // STIME / UTIME are the only `m:ss.ss` fields on a row.
  return stdout
    .trim()
    .split('\n')
    .slice(1)
    .map(row => {
      const [stime, utime] = row.trim().split(/\s+/).filter(f => /^[\d-]*[\d:]+\.\d+$/.test(f) && f.includes(':'));
      return stime && utime ? cpuSeconds(stime) + cpuSeconds(utime) : 0;
    });
}

export function startThreadMonitor({ pid, pollMs }) {
  const events = new EventEmitter();
  let names = [];
  let namedAt = 0;
  let countAtNaming = 0;
  let naming = null;
  let previous = null;
  let previousAt = 0;
  let stopped = false;

  let lastAttemptAt = 0;
  const rename = () => {
    lastAttemptAt = Date.now();
    naming ??= threadNames(pid)
      .then(list => {
        names = list;
        namedAt = Date.now();
      })
      .catch(() => {})
      .finally(() => {
        naming = null;
      });
    return naming;
  };

  const poll = async () => {
    if (stopped) return;
    let cpu;
    try {
      cpu = await readThreadCpu(pid);
    } catch {
      events.emit('gone');
      return;
    }
    const now = Date.now();
    if (names.length === 0 && now - lastAttemptAt > 2000) rename();
    if (cpu.length !== countAtNaming && now - namedAt > RENAME_MIN_INTERVAL_MS) {
      countAtNaming = cpu.length;
      rename();
    }
    // Short-lived worker threads come and go at the end of the list (newest
    // last), so the long-lived rows we care about (main, JS) keep their index.
    if (previous && names.length > 0) {
      const windowMs = now - previousAt;
      const rows = Math.min(cpu.length, previous.length);
      const threads = cpu.slice(0, rows).map((value, i) => ({
        name: names[i] ?? 'unnamed threads (pool)',
        busyMs: Math.max(0, (value - previous[i]) * 1000),
      }));
      events.emit('tick', { windowMs, at: now, threads });
    }
    previous = cpu;
    previousAt = now;
    setTimeout(poll, pollMs);
  };

  readThreadCpu(pid)
    .then(cpu => {
      countAtNaming = cpu.length;
    })
    .catch(() => {})
    .then(rename)
    .then(poll);
  events.stop = () => {
    stopped = true;
  };
  events.names = () => names;
  return events;
}
