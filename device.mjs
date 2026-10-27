// Physical iPhone, Release build: no Metro, no debugger. Threads are sampled
// from the Mac with Apple's profiler (xctrace Time Profiler) in short bursts;
// the app only pays during the 1s it is being sampled. Requires a build you
// signed for development (TestFlight/App Store builds refuse to be attached).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { GENERIC_LEAF, IDLE_LEAVES, categoryOf, threadLabel } from './native-sample.mjs';

const run = promisify(execFile);
const XML_ENTITIES = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };
const unescape = s => s.replace(/&(lt|gt|amp|quot|apos);/g, m => XML_ENTITIES[m]);

async function devicectlJson(args) {
  const out = path.join(os.tmpdir(), `hitch-devicectl-${process.pid}-${Date.now()}.json`);
  try {
    await run('xcrun', ['devicectl', ...args, '--json-output', out, '--quiet'], { timeout: 30000 });
    return JSON.parse(fs.readFileSync(out, 'utf8')).result;
  } finally {
    fs.rmSync(out, { force: true });
  }
}

// USB/Wi-Fi paired iPhones that are connected right now.
export async function listPhysicalDevices() {
  try {
    const result = await devicectlJson(['list', 'devices']);
    return (result.devices ?? [])
      .filter(d => d.hardwareProperties?.reality === 'physical' && d.hardwareProperties?.platform === 'iOS' && d.connectionProperties?.tunnelState === 'connected')
      .map(d => ({ udid: d.hardwareProperties.udid, name: d.deviceProperties?.name ?? 'iPhone', identifier: d.identifier }));
  } catch {
    return [];
  }
}

// Only developer-signed apps can be profiled; those are the ones worth listing.
export async function listProfilableApps(device) {
  try {
    const result = await devicectl(['device', 'info', 'apps', '--device', device.identifier]);
    return (result.apps ?? []).filter(a => a.builtByDeveloper).map(a => ({ bundleId: a.bundleIdentifier, name: a.name, url: a.url }));
  } catch {
    return [];
  }
}
const devicectl = devicectlJson;

async function findProcess(device, app) {
  const result = await devicectl(['device', 'info', 'processes', '--device', device.identifier]);
  const bundlePath = decodeURIComponent((app.url ?? '').replace(/^file:\/\//, '')).replace(/\/$/, '');
  const proc = (result.runningProcesses ?? []).find(p => {
    const exe = decodeURIComponent((p.executable ?? '').replace(/^file:\/\//, ''));
    return bundlePath ? exe.startsWith(bundlePath) : false;
  });
  return proc?.processIdentifier ?? null;
}

// Apple's own libraries say *what* is happening (drawing, layout); the first
// frames from anything else say *who* asked for it (a React Native view class,
// an SDK, the app binary).
const SYSTEM_LIB = /^(CoreGraphics|QuartzCore|UIKitCore|UIKit|CoreFoundation|Foundation|libobjc\.A\.dylib|libobjcMsgSend\.dylib|libdispatch\.dylib|libsystem_[\w.]+|libswiftCore\.dylib|libswift\w*\.dylib|dyld|ImageIO|libz\.1\.dylib|Metal|AGXMetal\w*|IOSurface|CoreText|CoreImage|libc\+\+\.1\.dylib|libc\+\+abi\.dylib|GraphicsServices|FrontBoardServices|BoardServices|RunningBoardServices|CoreAnimation|libxpc\.dylib|libdyld\.dylib|AttributeGraph|SwiftUI|SwiftUICore)$/;
const callerChain = stack => {
  const chain = [];
  for (const frame of stack) {
    const [name, lib] = frame.split('  ');
    const library = lib?.replace(/^\(|\)$/g, '');
    if (!library || SYSTEM_LIB.test(library) || /^0x[0-9a-f]+$/.test(name)) continue;
    if (!chain.includes(name)) chain.push(name);
    if (chain.length === 3) break;
  }
  return chain.join(' ← ');
};

// Parses `xctrace export` of the time-profile table into one entry per sample
// of a running thread: when, which thread, how long, and where. Rows only
// cover running threads, so a thread's sample weight is its busy time.
export function parseSamples(xml, { appNames = [], processName = null } = {}) {
  const threads = new Map();
  const states = new Map();
  const weights = new Map();
  const times = new Map();
  const frames = new Map();
  const binaries = new Map();
  const backtraces = new Map();
  const samples = [];

  const rowRe = /<row>([\s\S]*?)<\/row>/g;
  for (let m; (m = rowRe.exec(xml)); ) {
    const row = m[1];
    const timeDef = row.match(/<sample-time id="(\d+)"[^>]*>(\d+)<\/sample-time>/);
    if (timeDef) times.set(timeDef[1], Number(timeDef[2]));
    const timeRef = timeDef ?? row.match(/<sample-time ref="(\d+)"\/>/);
    const tNs = timeRef ? times.get(timeRef[1]) ?? 0 : 0;

    const td = row.match(/<thread id="(\d+)" fmt="([^"]*)"/);
    if (td) threads.set(td[1], unescape(td[2]));
    const tr = td ?? row.match(/<thread ref="(\d+)"\/>/);
    const thread = tr ? threads.get(tr[1]) : null;

    // Blocked/waiting samples aren't work, even when the frame is unsymbolicated.
    const sd = row.match(/<thread-state id="(\d+)" fmt="([^"]*)"/);
    if (sd) states.set(sd[1], sd[2]);
    const sr = sd ?? row.match(/<thread-state ref="(\d+)"\/>/);
    const state = sr ? states.get(sr[1]) : 'Running';

    let weight = 1e6;
    const wd = row.match(/<weight id="(\d+)"[^>]*>(\d+)<\/weight>/);
    if (wd) weights.set(wd[1], Number(wd[2]));
    const wr = wd ?? row.match(/<weight ref="(\d+)"\/>/);
    if (wr) weight = weights.get(wr[1]) ?? weight;

    let stack = [];
    const bd = row.match(/<tagged-backtrace id="(\d+)">([\s\S]*?)<\/tagged-backtrace>/);
    if (bd) {
      const frameRe = /<frame id="(\d+)" name="([^"]*)"[^>]*?(\/?)>(?:<binary (?:id="(\d+)" name="([^"]*)"[^>]*?\/>|ref="(\d+)"\/>))?|<frame ref="(\d+)"\/>/g;
      for (let f; (f = frameRe.exec(bd[2])); ) {
        if (f[7]) {
          stack.push(frames.get(f[7]) ?? '?');
          continue;
        }
        if (f[4]) binaries.set(f[4], unescape(f[5]));
        const lib = f[4] ? binaries.get(f[4]) : f[6] ? binaries.get(f[6]) : null;
        const text = `${unescape(f[2])}${lib ? `  (${lib})` : ''}`;
        frames.set(f[1], text);
        stack.push(text);
      }
      backtraces.set(bd[1], stack);
    } else {
      const br = row.match(/<tagged-backtrace ref="(\d+)"\/>/);
      if (br) stack = backtraces.get(br[1]) ?? [];
    }
    if (!thread || (state && state !== 'Running')) continue;
    // A sample parked in the kernel (waiting) isn't work.
    if (stack[0] && IDLE_LEAVES.test(stack[0].split('  ')[0])) continue;
    // "Main Thread (0x1f) (Process, pid: 12)" or, for unnamed threads,
    // "0x1f (Process, pid: 12)" / "Process (0x1f) (Process, pid: 12)".
    const parts = thread.match(/^(.*?)\s*\(([^()]*), pid: \d+\)$/);
    const proc = parts ? parts[2].trim() : null;
    if (processName && proc !== processName) continue;
    const name = (parts ? parts[1] : thread).replace(/\s*\(?0x[0-9a-f]+\)?$/i, '').trim();
    const unnamed = !name || name === proc || appNames.includes(name);
    const label = /^Main Thread$/i.test(name) ? 'Main/UI thread' : unnamed ? 'unnamed threads (pool)' : threadLabel(name);
    // Leaf first in the export; callers follow.
    const category = categoryOf([label, ...[...stack].reverse()]);
    const attributed = stack.find(fr => !GENERIC_LEAF.test(fr)) ?? stack[0] ?? '?';
    samples.push({ tMs: tNs / 1e6, label, ms: weight / 1e6, category, attributed, via: callerChain(stack) });
  }
  return samples;
}

// Per-thread totals (busy, subsystem split, hottest frames) for a set of samples.
export function summarizeSamples(samples, windowMs) {
  const byThread = new Map();
  for (const s of samples) {
    const t = byThread.get(s.label) ?? { label: s.label, totalMs: windowMs, busyMs: 0, overheadMs: 0, self: new Map(), categories: new Map() };
    t.busyMs += s.ms;
    t.categories.set(s.category, (t.categories.get(s.category) ?? 0) + s.ms);
    const key = `${s.attributed}\u0000${s.category}\u0000${s.via ?? ''}`;
    t.self.set(key, (t.self.get(key) ?? 0) + s.ms);
    byThread.set(s.label, t);
  }
  return [...byThread.values()];
}

export function parseTimeProfile(xml, seconds, appNames = []) {
  return summarizeSamples(parseSamples(xml, { appNames }), seconds * 1000);
}

// xctrace on a phone resolves processes by executable name, not devicectl's pid.
const executableOf = app => decodeURIComponent((app.url ?? '').replace(/^file:\/\//, '')).replace(/\/$/, '').split('/').pop().replace(/\.app$/, '');

export async function recordDevice({ device, pid, seconds, appNames = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hitch-trace-'));
  const trace = path.join(dir, 'burst.trace');
  try {
    await run('xcrun', ['xctrace', 'record', '--template', 'Time Profiler', '--device', device.udid, '--attach', String(pid), '--time-limit', `${seconds}s`, '--output', trace, '--no-prompt'], { timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
    const { stdout } = await run('xcrun', ['xctrace', 'export', '--input', trace, '--xpath', '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]'], { timeout: 120000, maxBuffer: 512 * 1024 * 1024 });
    return parseTimeProfile(stdout, seconds, appNames);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Attaching to just the app keeps each trace small, so the restart gap between
// chunks stays short. It only works while the app is running in the foreground.
async function recordChunk({ device, seconds, signal, executable }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hitch-stream-'));
  const trace = path.join(dir, 'chunk.trace');
  try {
    await run('xcrun', ['xctrace', 'record', '--template', 'Time Profiler', '--device', device.udid, '--attach', executable, '--time-limit', `${seconds}s`, '--output', trace, '--no-prompt'], { timeout: (seconds + 120) * 1000, maxBuffer: 64 * 1024 * 1024, signal, killSignal: 'SIGINT' });
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    // xctrace reports this on stdout, not stderr.
    if (/Cannot find process/.test(`${error.stdout ?? ''}${error.stderr ?? ''}${error.message}`)) {
      const notRunning = new Error('app not in the foreground');
      notRunning.notRunning = true;
      throw notRunning;
    }
    throw error;
  }
  return { dir, trace };
}

async function readChunk({ dir, trace }, filter) {
  try {
    const [toc, table] = await Promise.all([
      run('xcrun', ['xctrace', 'export', '--input', trace, '--toc'], { timeout: 120000, maxBuffer: 64 * 1024 * 1024 }),
      run('xcrun', ['xctrace', 'export', '--input', trace, '--xpath', '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]'], { timeout: 180000, maxBuffer: 1024 * 1024 * 1024 }),
    ]);
    const startMs = Date.parse(toc.stdout.match(/<start-date>([^<]+)</)?.[1] ?? '');
    const durationMs = Number(toc.stdout.match(/<duration>([^<]+)</)?.[1] ?? 0) * 1000;
    return { startMs, durationMs, samples: parseSamples(table.stdout, filter) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const BUCKET_MS = 50;
const POOL = 'unnamed threads (pool)';

// An engine-shaped watcher for one Release app on one phone: records the
// phone continuously in back-to-back chunks (iOS allows one profiling session
// at a time) and replays each chunk onto the lanes at its real timestamps.
export function startDeviceEngine({ device, app, settings, chunkSec = 20 }) {
  const events = new EventEmitter();
  const status = {
    state: 'connecting',
    appId: app.bundleId,
    device: device.name,
    physical: true,
    release: true,
    native: true,
    symbols: 'n/a',
    settings: { ...settings, chunkSec },
    startedAt: new Date().toISOString(),
  };
  const history = { stalls: [], hot: [], lanes: [], alerts: [], vitals: [], requests: [], console: [], startups: [], coverage: [] };
  const executable = executableOf(app);
  // Attached traces hold only the app (labelled with its display name), so
  // they need no process filter.
  const filter = { processName: null, appNames: [app.name?.trim(), executable].filter(Boolean) };
  let nextId = 1;
  let stopped = false;
  let lastChunk = null;
  // Stopping ends the in-flight recording: iOS allows one profiling session.
  const abort = new AbortController();

  const setStatus = patch => {
    Object.assign(status, patch);
    events.emit('event', { type: 'status', ...status });
  };
  const publish = event => {
    if (event.type === 'hot') history.hot.push(event);
    if (event.type === 'coverage') history.coverage.push(event);
    if (event.type === 'lanes') {
      history.lanes.push(event);
      if (history.lanes.length > 3600) history.lanes.shift();
    }
    events.emit('event', event);
  };

  const hotEvent = (samples, from, to, trigger) => {
    const threads = summarizeSamples(samples.filter(x => x.at >= from && x.at < to), to - from)
      .filter(t => t.busyMs >= 5)
      .sort((x, y) => y.busyMs - x.busyMs)
      .slice(0, 6)
      .map(t => ({
        label: t.label,
        busyPct: Math.min(100, Math.round((t.busyMs / (to - from)) * 100)),
        busyMs: Math.round(t.busyMs),
        categories: [...t.categories].sort((x, y) => y[1] - x[1]).map(([name, v]) => ({ name, pct: Math.round((v / t.busyMs) * 100) })),
        frames: [...t.self]
          .sort((x, y) => y[1] - x[1])
          .slice(0, 6)
          .map(([key, v]) => {
            const [frame, category, via] = key.split('\u0000');
            const [name, lib] = frame.split('  ');
            return { name, lib: lib?.replace(/^\(|\)$/g, '') ?? null, source: null, category, via: via || null, ms: Math.round(v) };
          }),
      }));
    return { type: 'hot', id: nextId++, at: from, until: to, trigger, threads, device: true };
  };

  const ingest = ({ startMs, durationMs, samples }) => {
    for (const x of samples) x.at = startMs + x.tMs;
    const endMs = startMs + durationMs;
    publish({ type: 'coverage', from: startMs, to: endMs });

    // Lanes: 50ms buckets per thread, exactly like the simulator's live feed.
    const buckets = new Map();
    for (const x of samples) {
      const b = Math.floor((x.at - startMs) / BUCKET_MS);
      const lanes = buckets.get(b) ?? new Map();
      lanes.set(x.label, (lanes.get(x.label) ?? 0) + x.ms);
      buckets.set(b, lanes);
    }
    const nBuckets = Math.ceil(durationMs / BUCKET_MS);
    for (let b = 0; b < nBuckets; b++) {
      const lanes = buckets.get(b) ?? new Map();
      publish({ type: 'lanes', at: startMs + (b + 1) * BUCKET_MS, windowMs: BUCKET_MS, lanes: [...lanes].map(([n, ms]) => [n, Math.round(ms)]) });
    }

    // JS thread busy streaks: the Release-build equivalent of a freeze. Short
    // breaks (<150ms) don't end a streak, and anything under 100ms is just a
    // blip at this 50ms resolution.
    const minFreezeMs = Math.max(settings.stallMs, 100);
    const streaks = [];
    for (let b = 0; b < nBuckets; b++) {
      if ((buckets.get(b)?.get('JS thread') ?? 0) / BUCKET_MS < 0.6) continue;
      const t = startMs + b * BUCKET_MS;
      const last = streaks.at(-1);
      if (last && t - last.to < 150) last.to = t + BUCKET_MS;
      else streaks.push({ from: t, to: t + BUCKET_MS });
    }
    for (const st of streaks) {
      const ms = st.to - st.from;
      if (ms < minFreezeMs) continue;
      publish({ ...hotEvent(samples, st.from, st.to, `JS thread busy ${ms}ms without a break`), jsBusy: true, ms });
    }

    // Hot seconds: UI thread or any named thread pegged for a full second.
    const perSecond = new Map();
    for (const x of samples) {
      const sec = Math.floor((x.at - startMs) / 1000);
      const m = perSecond.get(sec) ?? new Map();
      m.set(x.label, (m.get(x.label) ?? 0) + x.ms);
      perSecond.set(sec, m);
    }
    let hot = null;
    const flushHot = endSec => {
      if (hot) publish(hotEvent(samples, startMs + hot.from * 1000, startMs + endSec * 1000, `${hot.label} at ${hot.peak}% for ${endSec - hot.from}s`));
      hot = null;
    };
    for (let sec = 0; sec < Math.ceil(durationMs / 1000); sec++) {
      const m = perSecond.get(sec) ?? new Map();
      const ui = ((m.get('Main/UI thread') ?? 0) / 1000) * 100;
      const other = [...m].filter(([n]) => n !== 'Main/UI thread' && n !== 'JS thread' && n !== POOL).sort((x, y) => y[1] - x[1])[0];
      const hit = ui >= settings.uiHot ? { label: 'UI thread', pct: ui } : other && (other[1] / 1000) * 100 >= settings.threadHot ? { label: other[0], pct: (other[1] / 1000) * 100 } : null;
      if (hit && hot?.label === hit.label) hot.peak = Math.max(hot.peak, Math.round(hit.pct));
      else {
        flushHot(sec);
        if (hit) hot = { label: hit.label, from: sec, peak: Math.round(hit.pct) };
      }
    }
    flushHot(Math.ceil(durationMs / 1000));

    lastChunk = { samples, startMs, endMs };
    setStatus({ state: samples.length ? 'live' : 'no-app', lastDataAt: endMs });
  };

  (async () => {
    let pendingRead = Promise.resolve();
    while (!stopped) {
      setStatus({ recording: true, chunkStartedAt: Date.now() });
      // A failed attach dies within ~2s, so only call it streaming once the
      // recording has survived longer than that; otherwise the banner flickers.
      const attached = setTimeout(() => setStatus({ waitingForForeground: false }), 5000);
      let chunk;
      try {
        chunk = await recordChunk({ device, seconds: status.settings.chunkSec, signal: abort.signal, executable });
      } catch (error) {
        clearTimeout(attached);
        if (stopped) break;
        if (error.notRunning) {
          setStatus({ state: 'no-app', recording: false, waitingForForeground: true });
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        const detail = `${error.stdout ?? ''}\n${error.stderr ?? ''}`.split('\n').map(l => l.trim()).find(l => /error|Error|Cannot|failed/.test(l));
        events.emit('log', `phone recording failed: ${detail ?? error.message.split('\n')[0]}`);
        setStatus({ state: 'disconnected', recording: false });
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      // Export the finished chunk while the next one records.
      pendingRead = pendingRead.then(() => readChunk(chunk, filter).then(ingest).catch(error => events.emit('log', `phone chunk unreadable: ${error.message.split('\n')[0]}`)));
    }
  })();

  events.status = () => ({ type: 'status', ...status });
  events.history = () => history;
  // "Sample threads" on a phone: summarize the most recent recorded chunk.
  events.sampleNow = () => {
    if (lastChunk) publish(hotEvent(lastChunk.samples, lastChunk.startMs, lastChunk.endMs, `last ${Math.round((lastChunk.endMs - lastChunk.startMs) / 1000)}s on the phone`));
  };
  events.reloadApp = () => Promise.resolve({ error: 'release build' });
  events.setSettings = patch => {
    if (Number.isFinite(patch.chunkSec) && patch.chunkSec >= 5) status.settings.chunkSec = patch.chunkSec;
    for (const key of ['stallMs', 'uiHot', 'threadHot']) if (Number.isFinite(patch[key]) && patch[key] > 0) settings[key] = patch[key];
    setStatus({ settings: { ...status.settings, ...settings } });
  };
  events.clear = () => {
    history.hot.length = 0;
    history.lanes.length = 0;
    history.coverage.length = 0;
    events.emit('event', { type: 'cleared' });
  };
  events.writeReport = () => null;
  events.stop = async () => {
    stopped = true;
    abort.abort();
  };
  return events;
}
