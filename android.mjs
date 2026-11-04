// Android native threads over adb: per-thread CPU from /proc/<pid>/task/*/stat
// (one `adb shell` per poll, nothing inside the app), with React Native's
// thread names mapped to the lanes the iOS simulator shows.

import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { GENERIC_LEAF, categoryOf } from './native-sample.mjs';

const run = promisify(execFile);
// Linux reports CPU time in clock ticks of 1/100s (USER_HZ) on Android.
const TICK_MS = 10;
// Pause between passes of the on-device loop; forking `cat` adds ~90ms more.
export const ANDROID_POLL_MS = 50;
const GONE_AFTER_MS = 1500;
const MAX_RESTARTS = 3;

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
  if (/^mqt_(v_)?native/.test(name)) return 'Native modules thread';
  if (/^hades|^HermesGC/i.test(name)) return 'Hermes GC (hades)';
  // ART's collector for Java/Kotlin objects, not Hermes.
  if (/^HeapTaskDaemon$/.test(name)) return 'Java GC (ART)';
  // OkHttp names its WebSocket thread after the URL; this one is the Metro link.
  if (/:8081\//.test(name)) return 'Metro connection (dev only)';
  if (/^RenderThread$/.test(name)) return 'RenderThread';
  if (/^(OkHttp|okhttp)/.test(name)) return 'OkHttp';
  // Linux cuts thread names at 15 characters, so pool numbers are often lost.
  if (/^(pool-\d+-thread-|AsyncTask #|DefaultDispatch|binder:)/.test(name)) return 'unnamed threads (pool)';
  return name;
}

// Complete frames from a stream of stat dumps separated by FRAME_END lines;
// `rest` is the partial frame still arriving.
const FRAME_END = '@@';
export function splitFrames(buffer) {
  const parts = buffer.split(`${FRAME_END}\n`);
  return { frames: parts.slice(0, -1), rest: parts.at(-1) };
}

// One long-lived `adb shell` loop streams every thread's stat line, so the
// cadence isn't bound by an adb round trip (~85ms) per poll. Forking `cat`
// each pass costs the device ~3% of one core and lands a frame every ~140ms.
export function startAndroidThreadMonitor({ serial, pid, pollMs = ANDROID_POLL_MS }) {
  const events = new EventEmitter();
  let previous = null;
  let previousAt = 0;
  let stopped = false;
  let names = [];
  let lastRowsAt = Date.now();
  let child = null;
  let restarts = 0;

  const onFrame = text => {
    const rows = text.split('\n').map(parseStat).filter(Boolean);
    const now = Date.now();
    if (!rows.length) {
      // The app's /proc entry is gone: it quit or crashed.
      if (now - lastRowsAt > GONE_AFTER_MS) stop('gone');
      return;
    }
    lastRowsAt = now;
    restarts = 0;
    names = rows.map(r => laneName(r.name, r.tid, pid));
    if (previous) {
      const threads = rows.map(r => ({ name: laneName(r.name, r.tid, pid), busyMs: Math.max(0, (r.ticks - (previous.get(r.tid) ?? r.ticks)) * TICK_MS) }));
      events.emit('tick', { windowMs: now - previousAt, at: now, threads });
    }
    previous = new Map(rows.map(r => [r.tid, r.ticks]));
    previousAt = now;
  };

  const stop = reason => {
    if (stopped) return;
    stopped = true;
    child?.kill();
    if (reason) events.emit(reason);
  };

  const launch = () => {
    let buffer = '';
    const loop = `while :; do cat /proc/${pid}/task/*/stat 2>/dev/null; echo ${FRAME_END}; sleep ${pollMs / 1000}; done`;
    child = spawn('adb', [...(serial ? ['-s', serial] : []), 'shell', loop], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      const { frames, rest } = splitFrames(buffer + chunk);
      buffer = rest;
      for (const frame of frames) onFrame(frame);
    });
    // adb drops a connection now and then (more so while simpleperf runs);
    // reconnect a few times before calling the app gone.
    child.on('exit', () => {
      if (stopped) return;
      if (++restarts > MAX_RESTARTS) stop('gone');
      else setTimeout(launch, 500);
    });
  };
  launch();
  events.stop = () => stop(null);
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

// When the process started, from /proc/<pid>/stat field 22 (ticks since boot)
// and /proc/uptime, so a cold launch we attach to late can still be timed.
export function startedAtFrom(statLine, uptimeText, now) {
  const close = statLine.lastIndexOf(')');
  const startTicks = Number(statLine.slice(close + 2).split(' ')[19]);
  const uptimeS = Number(uptimeText.trim().split(/\s+/)[0]);
  if (!Number.isFinite(startTicks) || !Number.isFinite(uptimeS)) return null;
  return Math.round(now - (uptimeS * 1000 - startTicks * TICK_MS));
}

export async function androidStartedAt(serial, pid) {
  try {
    const text = await adb(serial, ['shell', `cat /proc/${pid}/stat; echo; cat /proc/uptime`]);
    const [stat, uptime] = text.split('\n').filter(line => line.trim());
    return startedAtFrom(stat, uptime, Date.now());
  } catch {
    return null;
  }
}

export async function openAndroidUrl(serial, url) {
  await adb(serial, ['shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', `'${url.replace(/'/g, "'\\''")}'`], 10000);
}

// On Android, syscall wrappers, ART trampolines and unsymbolized dex code say
// nothing on their own either; like GENERIC_LEAF, their caller gets the time.
const ANDROID_LEAF = /^(read|write|__ioctl|ioctl|syscall|__epoll_pwait|recvfrom|sendto|__futex\w*|art_quick_\w+|artQuick\w+|art_jni_trampoline|__\w+_aarch64|\*\S+\[\+[0-9a-f]+\])\s/;
const isLeafNoise = frame => GENERIC_LEAF.test(frame) || ANDROID_LEAF.test(frame);

// `simpleperf report-sample --show-callchain` text -> the same per-thread shape
// as parseSample (macOS `sample`), so hot-thread findings read the same.
// Each sample is leaf first, then its callers.
export function parseSimpleperf(text, pid) {
  const threads = new Map();
  let sample = null;
  let frame = null;
  let first = Infinity;
  let last = -Infinity;
  const flush = () => {
    if (!sample?.frames.length) return;
    first = Math.min(first, sample.time);
    last = Math.max(last, sample.time);
    const label = laneName(sample.threadName, sample.tid, pid);
    // Hermes' own sampler (startup and run profiles) is Hitch's footprint, not the app's.
    if (/^hermes-sampling/.test(sample.threadName)) return;
    const thread = threads.get(label) ?? { label, totalMs: 0, busyMs: 0, overheadMs: 0, self: new Map(), categories: new Map() };
    threads.set(label, thread);
    const ms = sample.ms;
    thread.busyMs += ms;
    const path = sample.frames.slice().reverse();
    const category = categoryOf([label, ...path]);
    const attributed = path.findLast(f => !isLeafNoise(f)) ?? path.at(-1);
    thread.categories.set(category, (thread.categories.get(category) ?? 0) + ms);
    const key = `${attributed}\u0000${category}`;
    thread.self.set(key, (thread.self.get(key) ?? 0) + ms);
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === 'sample:') {
      flush();
      sample = { tid: null, threadName: '', time: 0, ms: 1, frames: [] };
      frame = null;
      continue;
    }
    if (!sample) continue;
    const colon = line.indexOf(': ');
    const key = colon < 0 ? line.replace(/:$/, '') : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 2);
    if (key === 'thread_id') sample.tid = Number(value);
    else if (key === 'thread_name') sample.threadName = value;
    else if (key === 'event_count') sample.ms = Number(value) / 1e6 || 1;
    else if (key === 'time' && !frame) sample.time = Number(value);
    else if (key === 'file') frame = { file: value };
    else if (key === 'symbol' && frame) {
      // "sym  (lib.so)", the same frame text the macOS parser produces.
      sample.frames.push(`${value.replace(/ \(\.__uniq\.\d+[^)]*\)|\.llvm\.\d+/g, '')}  (${frame.file.split('/').pop()})`);
      frame = null;
    }
  }
  flush();
  // simpleperf on an emulator often records longer than --duration asks, so
  // the window is the span the samples actually cover.
  const spanMs = last > first ? (last - first) / 1e6 : 0;
  for (const thread of threads.values()) {
    thread.totalMs = Math.max(spanMs, thread.busyMs);
    thread.windowMs = spanMs || undefined;
  }
  return [...threads.values()];
}

// A short native profile of the app with the device's simpleperf. Works for
// debuggable (dev) builds without root; cpu-clock because emulators have no
// hardware counters, frame pointers because DWARF unwinding takes seconds.
export async function sampleAndroid({ serial, appId, pid, seconds }) {
  const file = '/data/local/tmp/hitch-sample.data';
  const timeout = (seconds + 15) * 1000;
  await adb(serial, ['shell', 'simpleperf', 'record', '--app', appId, '-p', String(pid), '-e', 'cpu-clock', '-f', '1000', '--call-graph', 'fp', '--duration', String(seconds), '-o', file], timeout);
  const { stdout } = await run('adb', [...(serial ? ['-s', serial] : []), 'shell', 'simpleperf', 'report-sample', '--show-callchain', '-i', file], { timeout, maxBuffer: 256 * 1024 * 1024 });
  return parseSimpleperf(stdout, pid);
}
