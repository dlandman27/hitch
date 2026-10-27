// Android native threads over adb: per-thread CPU from /proc/<pid>/task/*/stat
// (one `adb shell` per poll, nothing inside the app), with React Native's
// thread names mapped to the lanes the iOS simulator shows.

import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';

const run = promisify(execFile);
// Linux reports CPU time in clock ticks of 1/100s (USER_HZ) on Android.
const TICK_MS = 10;
// One adb round trip per poll; faster than this mostly measures adb.
export const ANDROID_POLL_MS = 250;

const adb = (serial, args, timeout = 3000) => run('adb', [...(serial ? ['-s', serial] : []), ...args], { timeout }).then(r => r.stdout);

// `adb devices -l` -> [{ serial, model }] for devices that are ready.
export function parseDevices(text) {
  return text
    .split('\n')
    .slice(1)
    .map(line => line.trim().split(/\s+/))
    .filter(parts => parts[1] === 'device')
    .map(([serial, , ...rest]) => ({ serial, model: rest.find(p => p.startsWith('model:'))?.slice(6).replace(/_/g, ' ') ?? serial }));
}

export async function androidDevices() {
  try {
    return parseDevices(await adb(null, ['devices', '-l']));
  } catch {
    return [];
  }
}

// The app's process on whichever connected device runs it.
export async function findAndroidApp(appId) {
  for (const device of await androidDevices()) {
    const pid = Number((await adb(device.serial, ['shell', 'pidof', appId]).catch(() => '')).trim().split(/\s+/)[0]);
    if (pid) return { ...device, pid };
  }
  return null;
}

// One /proc/<pid>/task/<tid>/stat line -> { tid, name, ticks }. The name sits
// in parentheses and may contain spaces, so fields are read after the last ')'.
export function parseStat(line) {
  const open = line.indexOf('(');
  const close = line.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const tid = Number(line.slice(0, open).trim());
  const rest = line.slice(close + 2).split(' ');
  // rest[0] is field 3 (state); utime and stime are fields 14 and 15.
  const ticks = Number(rest[11]) + Number(rest[12]);
  return Number.isFinite(tid) && Number.isFinite(ticks) ? { tid, name: line.slice(open + 1, close), ticks } : null;
}

// React Native's thread names on Android, in the lanes' vocabulary.
export function laneName(name, tid, pid) {
  if (tid === pid) return 'Main/UI thread';
  if (/^mqt_(v_)?js$/.test(name)) return 'JS thread';
  if (/^mqt_native_modu/.test(name)) return 'Native modules thread';
  if (/^hades|^HermesGC|HeapTaskDaemon/i.test(name)) return 'Hermes GC (hades)';
  if (/^RenderThread$/.test(name)) return 'RenderThread';
  if (/^(OkHttp|okhttp)/.test(name)) return 'OkHttp';
  if (/^(pool-\d+-thread-\d+|AsyncTask #\d+|DefaultDispatch|binder:)/.test(name)) return 'unnamed threads (pool)';
  return name;
}

export function startAndroidThreadMonitor({ serial, pid, pollMs = ANDROID_POLL_MS }) {
  const events = new EventEmitter();
  let previous = null;
  let previousAt = 0;
  let stopped = false;
  let names = [];

  const poll = async () => {
    if (stopped) return;
    let text;
    try {
      text = await adb(serial, ['shell', `cat /proc/${pid}/task/*/stat 2>/dev/null`]);
    } catch {
      events.emit('gone');
      return;
    }
    const rows = text.split('\n').map(parseStat).filter(Boolean);
    if (!rows.length) {
      events.emit('gone');
      return;
    }
    const now = Date.now();
    names = rows.map(r => laneName(r.name, r.tid, pid));
    if (previous) {
      const windowMs = now - previousAt;
      const threads = rows.map(r => ({ name: laneName(r.name, r.tid, pid), busyMs: Math.max(0, (r.ticks - (previous.get(r.tid) ?? r.ticks)) * TICK_MS) }));
      events.emit('tick', { windowMs, at: now, threads });
    }
    previous = new Map(rows.map(r => [r.tid, r.ticks]));
    previousAt = now;
    setTimeout(poll, pollMs);
  };
  poll();
  events.stop = () => {
    stopped = true;
  };
  events.names = () => names;
  return events;
}

// Resident memory of the app's process, for the memory lane.
export async function androidRss(serial, pid) {
  try {
    const status = await adb(serial, ['shell', `cat /proc/${pid}/status`]);
    const kb = Number(status.match(/VmRSS:\s+(\d+)/)?.[1]);
    return kb ? kb * 1024 : null;
  } catch {
    return null;
  }
}
