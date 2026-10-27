// The watcher itself: attaches to the app, detects slowdowns, and emits plain
// JSON events (status, tick, stall, hot) for the UI and terminal to render.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { connectInspector, findTarget } from './js-inspector.mjs';
import { bootedSimulatorNames } from './discovery.mjs';
import { findSimulatorPid, sampleNative } from './native-sample.mjs';
import { createObservers } from './observers.mjs';
import { androidRss, findAndroidApp, startAndroidThreadMonitor } from './android.mjs';
import { diffHeap, summarizeHeapSnapshot } from './heap.mjs';
import { hotFunctions, profileSamples, stacksBetween } from './profile.mjs';
import { PROBE_SOURCE, createScreenTracker, describeReason, jankPeriods, summarizeRenders } from './react-probe.mjs';
import { createSymbolicator } from './symbolicate.mjs';
import { startThreadMonitor } from './thread-monitor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLL_MS = 50;
const SNAPSHOT_GAP_MS = 30;
const ROLLING_MS = 1000;
const BURST_MS = 1000;
const BURST_COOLDOWN_MS = 10000;
const MAX_SNAPSHOTS = 12;
const MAX_FRAMES = 40;
// 3 minutes of 50ms ticks, enough to backfill the UI's widest window.
const LANE_HISTORY = 3600;
// The React probe is read this often; a freeze reads it at once when it ends.
const PROBE_POLL_MS = 2000;
const PROBE_INSTALL_TRIES = 40;
const COMMIT_HISTORY_MS = 120000;
// Startup is the heaviest moment and freezes there often end before a pause
// lands, so the first seconds after JS starts are profiled.
const STARTUP_PROFILE_MS = 15000;
// Freezes this close together are one burst (a screen load, a scroll).
const BURST_GAP_MS = 1000;
// A screen that takes this long to settle is worth a look, even in dev.
const SLOW_SCREEN_MS = 1500;
// Kinds that get the screen they happened on.
const SCREEN_TAGGED = new Set(['stall', 'hot', 'console', 'request', 'leak', 'threadleak', 'startup', 'jank']);

function startSymbolServer(projectRoot) {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = fork(path.join(HERE, 'symbol-server.mjs'), [projectRoot, String(port)], { stdio: 'ignore' });
  const ready = new Promise((resolve, reject) => {
    child.on('message', msg => msg?.ready && resolve(`http://127.0.0.1:${port}`));
    child.on('exit', code => reject(new Error(`symbol server exited (${code})`)));
  });
  ready.catch(() => {});
  return { child, ready };
}

function packageOf(file) {
  const rest = file.slice(file.lastIndexOf('node_modules/') + 'node_modules/'.length).split('/');
  return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
}

function describeFrame(frame, loc) {
  const name = frame.functionName || loc?.name || '(anonymous)';
  const action = frame.action ? { action: frame.action } : {};
  // Hitch's own probe (installed through the debugger): say so, never blame the app.
  if (frame.url === 'hitch-probe.js') return { name, kind: 'lib', file: 'hitch-probe.js', line: frame.lineNumber + 1, pkg: 'Hitch probe', ...action };
  if (!frame.url) return { name, kind: 'native', ...action };
  if (!loc || !loc.inRepo) return { name, kind: 'unmapped', where: `bundle ${frame.lineNumber + 1}:${frame.columnNumber}`, ...action };
  const lib = loc.file.includes('node_modules/');
  return { name, kind: lib ? 'lib' : 'app', file: loc.file, line: loc.line, snippet: loc.snippet, pkg: lib ? packageOf(loc.file) : null, verified: loc.verified, ...action };
}

// Work that only exists in dev builds: flag it so nobody chases it.
const DEV_ONLY = [
  [f => /node_modules\/reactotron-/.test(f.file ?? ''), 'Reactotron'],
  [f => /^(detectMutations|trackForMutations|trackProperties|findNonSerializableValue|isPlain|getSerialize|isNestedFrozen|isImmutableDefault|freezeDraftable)/.test(f.name) && /@reduxjs\/toolkit/.test(f.file ?? ''), 'Redux Toolkit dev checks'],
  [f => /node_modules\/react-devtools-core\//.test(f.file ?? ''), 'React DevTools backend'],
  [f => f.file === 'hitch-probe.js', "Hitch's React probe"],
  [f => /why-did-you-render/.test(f.file ?? ''), 'why-did-you-render'],
  [f => /^(logComponentRender|startProfilerTimer|stopProfilerTimerIfRunningAndRecordIncompleteDuration|logRenderPhase|logCommitPhase|shouldProfile|pushComponentEffectDuration|recordEffectDuration)$/.test(f.name), 'React dev profiling'],
  [f => /webapis\/performance\/(Performance|EventTiming)|structuredClone/.test(f.file ?? ''), 'React dev profiling'],
];

function devOnlyLabel(frames) {
  for (const frame of frames) {
    for (const [test, label] of DEV_ONLY) if (test(frame)) return label;
  }
  return null;
}

const frameKey = f => (f.file ? `${f.name}@${f.file}:${f.line}` : `${f.name}@${f.kind}`);

// "sym  (Lib)  file.mm:42" -> { name, lib, source }
function splitNativeFrame(text) {
  const [name, lib, source] = text.split('  ');
  return { name, lib: lib?.replace(/^\(|\)$/g, '').replace(/^in /, '') ?? null, source: source ?? null };
}

export function startEngine(initial) {
  const events = new EventEmitter();
  const settings = { stallMs: initial.stallMs, uiHot: initial.uiHot, threadHot: initial.threadHot, slowRequestMs: initial.slowRequestMs ?? 1000 };
  const status = {
    state: 'connecting',
    appId: initial.app,
    device: null,
    metro: initial.metro,
    project: initial.project,
    native: false,
    symbols: 'loading',
    settings,
    startedAt: new Date().toISOString(),
  };
  const history = { stalls: [], hot: [], lanes: [], alerts: [], jank: [], screens: [] };
  status.health = { symbols: 'loading', mapAgreement: null, probe: 'off', profiling: false, debuggerMs: null };
  const setHealth = patch => setStatus({ health: { ...status.health, ...patch } });
  let currentScreen = null;
  let nextId = 1;

  const setStatus = patch => {
    Object.assign(status, patch);
    events.emit('event', { type: 'status', ...status });
  };
  const publish = event => {
    if (SCREEN_TAGGED.has(event.type) && event.screen === undefined) event.screen = currentScreen;
    if (event.type === 'stall') {
      const previous = history.stalls.at(-1);
      event.burst = previous && event.at - (previous.at + previous.ms) <= BURST_GAP_MS ? previous.burst : event.id;
      history.stalls.push(event);
    }
    if (event.type === 'jank') {
      const i = history.jank.findIndex(j => j.id === event.id);
      if (i >= 0) history.jank[i] = event;
      else history.jank.push(event);
    }
    if (event.type === 'screen') history.screens.push(event);
    if (event.type === 'hot') history.hot.push(event);
    if (event.type === 'leak' || event.type === 'threadleak') history.alerts.push(event);
    if (event.type === 'lanes') {
      history.lanes.push(event);
      if (history.lanes.length > LANE_HISTORY) history.lanes.shift();
      observers?.onLanes(event);
    }
    events.emit('event', event);
  };
  let observers = null;

  const symbolicator = createSymbolicator({
    metroUrl: initial.metro,
    appMetroUrl: initial.metro,
    projectRoot: initial.project,
    onHealth: ({ agreement, mismatch }) => {
      setHealth({ symbols: mismatch ? 'mismatch' : 'ok', mapAgreement: agreement == null ? null : Math.round(agreement * 1000) / 10 });
      setStatus({ symbols: mismatch ? 'mismatch' : 'ready' });
    },
  });
  const symbolServer = startSymbolServer(initial.project);
  symbolServer.ready.then(
    url => {
      symbolicator.setUrl(url);
      setStatus({ symbols: 'ready' });
    },
    () => {
      setStatus({ symbols: 'error' });
      setHealth({ symbols: 'error' });
    },
  );

  observers = createObservers({
    publish,
    settings,
    nextId: () => nextId++,
    sessionStartedAt: Date.now(),
    symbolicate: async frames => {
      await symbolServer.ready.catch(() => {});
      await symbolicator.resolveAll(frames);
      return frames.map(f => describeFrame(f, symbolicator.lookup(f)));
    },
    getPid: () => pid ?? androidApp?.pid ?? null,
    readRss: androidApp => (androidApp ? androidRss(androidApp.serial, androidApp.pid) : null),
    getAndroidApp: () => androidApp,
    getInspector: () => inspector,
    getThreadNames: () => monitor?.names() ?? [],
  });
  observers.start();

  // --- JS stalls ---------------------------------------------------------

  let inspector = null;
  let episode = null;

  const finishStall = async stall => {
    const endedAt = stall.startedAt + stall.ms;
    // Too few pause captures (it ended first): use the profiler's samples when it was running.
    let raw = stall.snapshots;
    if (raw.length < 2 && profiler.covers(stall.startedAt)) {
      const samples = await profiler.samplesFor(stall.startedAt);
      const sampled = samples ? stacksBetween(samples, stall.startedAt, endedAt, MAX_SNAPSHOTS) : [];
      if (sampled.length > raw.length) raw = sampled;
    }
    await symbolServer.ready.catch(() => {});
    await symbolicator.resolveAll(raw.flat());
    const snapshots = raw.map(frames => frames.slice(0, MAX_FRAMES).map(f => describeFrame(f, symbolicator.lookup(f))));
    const { culprits: ranked, devOnly, react, stale, actions } = analyzeSnapshots(snapshots);
    if (stale && !status.bundleStale) setStatus({ bundleStale: true });
    // What React rendered meanwhile, straight from the probe.
    await probe.pollNow();
    const renders = summarizeRenders(probe.commits, stall.startedAt - 50, endedAt + 300);
    publish({
      type: 'stall',
      id: nextId++,
      at: stall.startedAt,
      ms: Math.round(stall.ms),
      stale,
      snapshotCount: snapshots.length,
      sampled: raw !== stall.snapshots,
      culprits: ranked,
      devOnly,
      react,
      actions,
      renders: renders.commits ? renders : null,
      snapshots,
    });
  };

  const beginEpisode = startedAt => {
    if (episode) return;
    episode = { startedAt, busyMs: 0, snapshots: [] };
    const current = episode;
    (async () => {
      while (episode === current && inspector) {
        const frames = await inspector.captureStack();
        // A pause takes effect at the next JS that runs. When the thread was busy
        // in native code, that's often Hitch's own frame callback, which says
        // nothing about the freeze: treat it as no stack. (The probe's own cost
        // is measured separately and shown in health.)
        const inProbe = frames?.[0]?.url === 'hitch-probe.js';
        if (frames && !inProbe && episode === current && current.snapshots.length < MAX_SNAPSHOTS) current.snapshots.push(frames);
        await new Promise(r => setTimeout(r, SNAPSHOT_GAP_MS));
      }
    })();
  };
  const endEpisode = busyMs => {
    const finished = episode;
    episode = null;
    if (finished && busyMs >= settings.stallMs) {
      finishStall({ ...finished, ms: busyMs }).catch(error => events.emit('log', `stall report failed: ${error.message}`));
    }
  };

  let stopPing = null;
  let stopped = false;
  let pid = null;
  // An Android device or emulator running the app: threads come over adb.
  let androidApp = null;

  // --- React probe: renders, frames, screens -------------------------------

  const screenTracker = createScreenTracker({
    onLoad: load =>
      publish({
        type: 'screen',
        id: nextId++,
        at: load.at,
        name: load.name,
        ms: load.ms,
        settled: load.settled,
        commits: load.commits,
        renderMs: Math.round(load.renderMs),
        mounts: load.mounts,
        stalls: history.stalls.filter(st => st.at >= load.at && st.at <= load.at + load.ms).length,
        memoryAtStart: load.memoryAtStart,
        memoryAtEnd: observers.latestVitals()?.rss ?? null,
        renders: summarizeRenders(probe.commits, load.at, load.at + load.ms),
        issue: load.ms >= SLOW_SCREEN_MS,
      }),
  });
  const probe = {
    commits: [],
    cost: { ms: 0, max: 0, commits: 0, renderMs: 0 },
    frames: [],
    installing: null,
    polling: null,
    timer: null,
    install() {
      if (!inspector) return;
      const link = inspector;
      probe.installing = (async () => {
        for (let attempt = 0; attempt < PROBE_INSTALL_TRIES && link === inspector; attempt++) {
          const result = await link.evaluate(PROBE_SOURCE).catch(() => null);
          if (result === 'ok') {
            setHealth({ probe: 'on' });
            return true;
          }
          // The hook appears a moment after the new JS starts.
          setHealth({ probe: result === 'no-hook' ? 'no-hook' : 'off' });
          await new Promise(r => setTimeout(r, 500));
        }
        return false;
      })();
      clearInterval(probe.timer);
      probe.timer = setInterval(() => probe.pollNow().catch(() => {}), PROBE_POLL_MS);
    },
    pollNow() {
      if (!inspector || status.health.probe !== 'on') return Promise.resolve();
      probe.polling ??= (async () => {
        const sentAt = Date.now();
        const raw = await inspector?.evaluate('globalThis.__HITCH__ ? __HITCH__.poll() : null');
        setHealth({ debuggerMs: Date.now() - sentAt });
        if (typeof raw !== 'string') return;
        const out = JSON.parse(raw);
        const now = Date.now();
        probe.commits.push(...out.commits);
        // What the probe itself costs the app, kept visible in health.
        for (const c of out.commits) {
          probe.cost.ms += c.probeMs;
          probe.cost.max = Math.max(probe.cost.max, c.probeMs);
          probe.cost.commits += 1;
        }
        if (out.commits.length) setHealth({ probeCost: { totalMs: probe.cost.ms, maxMs: probe.cost.max, commits: probe.cost.commits, renderMs: (probe.cost.renderMs += out.commits.reduce((sum, c) => sum + c.ms, 0)) } });
        while (probe.commits.length && now - probe.commits[0].at > COMMIT_HISTORY_MS) probe.commits.shift();
        for (const change of out.screens) screenTracker.onScreen(change.name, change.at, observers.latestVitals()?.rss);
        screenTracker.onCommits(out.commits);
        screenTracker.tick(now);
        if (out.screen !== currentScreen) {
          currentScreen = out.screen;
          setStatus({ screen: out.screen });
        }
        if (out.frames.length) onFrames(out.frames);
      })().finally(() => {
        probe.polling = null;
      });
      return probe.polling;
    },
    stop() {
      clearInterval(probe.timer);
      probe.timer = null;
    },
  };

  // Dropped frames that freezes don't explain: many small hitches.
  const onFrames = seconds => {
    publish({ type: 'frames', seconds });
    for (const period of jankPeriods(seconds, history.stalls)) {
      const last = history.jank.at(-1);
      // A period that continues the last one (split across polls) extends it.
      if (last && period.at <= last.until) {
        const merged = { ...last, until: period.until, seconds: (period.until - last.at) / 1000, dropped: last.dropped + period.dropped, worstGapMs: Math.max(last.worstGapMs, period.worstGapMs) };
        merged.fps = Math.round(((last.fps * last.seconds) + (period.fps * period.seconds)) / (last.seconds + period.seconds));
        merged.renders = summarizeRenders(probe.commits, merged.at, merged.until);
        publish(merged);
      } else {
        publish({ type: 'jank', id: nextId++, ...period, renders: summarizeRenders(probe.commits, period.at, period.until), issue: true });
      }
    }
  };

  // --- sampling profiler ---------------------------------------------------

  const profiler = {
    session: null,
    // Starts a profile for `ms` (or until stop) and resolves with its samples.
    run(ms, reason) {
      if (!inspector || profiler.session) return profiler.session?.done ?? Promise.resolve(null);
      const link = inspector;
      const startedAt = Date.now();
      let finish;
      const done = new Promise(r => (finish = r));
      profiler.session = { startedAt, reason, done, stop: () => finish(null) };
      setHealth({ profiling: reason });
      (async () => {
        const started = await link.startProfile();
        if (!started) return null;
        await Promise.race([new Promise(r => setTimeout(r, ms)), done]);
        const result = await link.stopProfile();
        return result ? { ...result, samples: profileSamples(result) } : null;
      })()
        .catch(() => null)
        .then(result => {
          profiler.session = null;
          setHealth({ profiling: false });
          profiler.last = result;
          finish(result);
        });
      return done;
    },
    startupWindow() {
      profiler.run(STARTUP_PROFILE_MS, 'startup');
    },
    covers: at => Boolean((profiler.session && at >= profiler.session.startedAt) || (profiler.last && at >= profiler.last.startedAt && at <= profiler.last.stoppedAt)),
    async samplesFor(at) {
      const result = profiler.session && at >= profiler.session.startedAt ? await profiler.session.done : profiler.last;
      return result?.samples ?? null;
    },
    last: null,
  };

  // An on-demand profile, described: where JS time went in the next `seconds`.
  const profileFor = async seconds => {
    if (profiler.session) profiler.session.stop();
    await profiler.session?.done;
    const result = await profiler.run(seconds * 1000, 'manual');
    if (!result) return null;
    await symbolServer.ready.catch(() => {});
    const frames = result.samples.map(s => s.frames.slice(0, MAX_FRAMES));
    await symbolicator.resolveAll(frames.flat());
    const described = frames.map(list => list.map(f => describeFrame(f, symbolicator.lookup(f))));
    // Idle samples were dropped, so time per sample comes from the profile itself.
    const sampleMs = result.profile.samples.length > 1 ? (result.stoppedAt - result.startedAt) / result.profile.samples.length : 10;
    return { seconds, samples: result.samples.length, busyMs: Math.round(result.samples.length * sampleMs), ...hotFunctions(described, sampleMs) };
  };

  const attach = async () => {
    if (stopped) return;
    // Follow whichever app is on Metro unless one was pinned with --app.
    const target = await findTarget(initial.metro, initial.app, initial.device).catch(() => null);
    if (!target) {
      setStatus({ state: 'no-app' });
      setTimeout(attach, 2000);
      return;
    }
    if (target.appId !== status.appId) {
      monitor?.stop();
      monitor = null;
      pid = null;
      androidApp = null;
    }
    const onSimulator = (await bootedSimulatorNames()).has(target.deviceName);
    setStatus({ appId: target.appId, device: target.deviceName, physical: !onSimulator });
    // Only a simulator app is a local process we can read threads from; the
    // same bundle id on a phone must not pick up the simulator's process.
    if (initial.native && !pid && onSimulator) {
      pid = await findSimulatorPid(target.appId);
      if (pid) {
        startNative(startThreadMonitor({ pid, pollMs: POLL_MS }));
        observers.onAttached(pid);
      }
    } else if (initial.native && !onSimulator && !androidApp) {
      androidApp = await findAndroidApp(target.appId);
      if (androidApp) {
        setStatus({ platform: 'android', device: androidApp.model, physical: false });
        startNative(startAndroidThreadMonitor({ serial: androidApp.serial, pid: androidApp.pid }));
      }
    }
    inspector = connectInspector({ metroUrl: initial.metro, target });
    inspector.on('console', raw => observers.onConsole(raw));
    inspector.on('network', (method, params) => observers.onNetwork(method, params));
    inspector.on('reloaded', () => {
      // Bridgeless reloads keep the debugger link: a new JS context is the signal.
      symbolicator.reset();
      setStatus({ bundleStale: false });
      observers.onReloadStarted();
      probe.install();
      profiler.startupWindow();
    });
    inspector.on('bundle', url => {
      symbolicator.reset();
      symbolServer.ready.then(() => symbolicator.resolveAll([{ url, lineNumber: 0, columnNumber: 0 }])).catch(() => {});
    });
    inspector.on('ready', urls => {
      symbolicator.reset();
      setStatus({ state: 'live', native: Boolean(pid || androidApp), bundleStale: false });
      probe.install();
      if (observers.inStartup()) profiler.startupWindow();
      // Load the bundle's source map now so the first stall reports instantly.
      symbolServer.ready.then(() => symbolicator.resolveAll(urls.map(url => ({ url, lineNumber: 0, columnNumber: 0 })))).catch(() => {});
      if (!pid && !androidApp) {
        stopPing = inspector.startPing({
          intervalMs: 200,
          onBlocked: beginEpisode,
          onUnblocked: endedAt => endEpisode(endedAt - (episode?.startedAt ?? endedAt)),
          onTick: ({ at, windowMs, busy }) => publish({ type: 'lanes', at, windowMs, lanes: [['JS thread', busy ? windowMs : 0]] }),
        });
      }
    });
    inspector.on('error', error => events.emit('log', error.message));
    inspector.on('close', () => {
      probe.stop();
      setHealth({ probe: 'off' });
      stopPing?.();
      stopPing = null;
      inspector = null;
      if (stopped) return;
      // The debugger link drops when the JS reloads: time the next start.
      observers.onReloadStarted();
      setStatus({ state: 'disconnected' });
      setTimeout(attach, 1500);
    });
  };

  // --- native threads ----------------------------------------------------

  let monitor = null;
  const startNative = threadMonitor => {
    monitor = threadMonitor;
    const recent = [];
    let burstCoolUntil = 0;

    monitor.on('tick', ({ windowMs, at, threads }) => {
      observers.setThreadCount(threads.length);
      const js = threads.find(t => t.name === 'JS thread');
      // Without the debugger attached (mid-reload) a freeze can't be explained,
      // and startup timing already covers that window.
      if (js && !inspector) episode = null;
      if (js && inspector) {
        // Busy for most of the window = something is hogging the JS thread.
        if (js.busyMs >= windowMs * 0.6) {
          beginEpisode(at - windowMs);
          episode.busyMs += js.busyMs;
        } else if (episode) {
          episode.busyMs += js.busyMs;
          endEpisode(episode.busyMs);
        }
      }

      // Every thread, every tick: the UI draws these as live lanes.
      const lanes = new Map();
      for (const t of threads) lanes.set(t.name, (lanes.get(t.name) ?? 0) + t.busyMs);
      publish({ type: 'lanes', at, windowMs: Math.round(windowMs), lanes: [...lanes].map(([name, busy]) => [name, Math.round(busy)]) });

      recent.push({ at, windowMs, threads });
      while (recent.length && at - recent[0].at > ROLLING_MS) recent.shift();
      const span = recent.reduce((sum, r) => sum + r.windowMs, 0);
      if (span < ROLLING_MS * 0.5) return;
      // Several OS threads can share a name (two GC threads, a pool): rate
      // each name per thread so "hot" means one thread is actually pegged.
      const totals = new Map();
      for (const r of recent) for (const t of r.threads) totals.set(t.name, (totals.get(t.name) ?? 0) + t.busyMs);
      const perName = new Map();
      for (const t of threads) perName.set(t.name, (perName.get(t.name) ?? 0) + 1);
      for (const [name, busy] of totals) totals.set(name, busy / (perName.get(name) ?? 1));
      const pctOf = name => Math.min(100, ((totals.get(name) ?? 0) / span) * 100);
      // The merged worker pool can exceed 100% legitimately; it never triggers.
      const others = [...totals]
        .filter(([name]) => name !== 'Main/UI thread' && name !== 'JS thread' && name !== 'unnamed threads (pool)')
        .map(([name, busy]) => ({ name, pct: (busy / span) * 100 }))
        .sort((a, b) => b.pct - a.pct);
      const uiPct = pctOf('Main/UI thread');

      if (span < ROLLING_MS * 0.9 || at < burstCoolUntil) return;
      const hottest = others[0];
      const trigger =
        uiPct >= settings.uiHot
          ? `UI thread at ${Math.round(uiPct)}% for 1s`
          : hottest && hottest.pct >= settings.threadHot
            ? `${hottest.name} at ${Math.round(hottest.pct)}% for 1s`
            : null;
      if (!trigger) return;
      burstCoolUntil = Number.POSITIVE_INFINITY;
      runBurst(trigger).finally(() => {
        burstCoolUntil = Date.now() + BURST_COOLDOWN_MS;
      });
    });
    monitor.on('gone', () => {
      monitor?.stop();
      monitor = null;
      pid = null;
      androidApp = null;
      setStatus({ state: 'disconnected', native: false });
    });
  };

  let bursting = null;
  const runBurst = trigger => {
    if (bursting || !pid) return bursting ?? Promise.resolve();
    const firedAt = Date.now();
    bursting = sampleNative({ pid, seconds: BURST_MS / 1000, intervalMs: 5 })
        .then(sampled => {
          const threadsOut = sampled
            .filter(t => t.busyMs >= 10)
            .sort((a, b) => b.busyMs - a.busyMs)
            .slice(0, 6)
            .map(t => ({
              label: t.label,
              busyPct: Math.min(100, Math.round((t.busyMs / BURST_MS) * 100)),
              busyMs: Math.round(t.busyMs),
              categories: [...t.categories].sort((a, b) => b[1] - a[1]).map(([name, v]) => ({ name, pct: Math.round((v / t.busyMs) * 100) })),
              frames: [...t.self]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 6)
                .map(([key, v]) => {
                  const [frame, category] = key.split('\u0000');
                  return { ...splitNativeFrame(frame), category, ms: Math.round(v) };
                }),
            }));
          publish({ type: 'hot', id: nextId++, at: firedAt, until: firedAt + BURST_MS, trigger, threads: threadsOut });
        })
        .catch(error => events.emit('log', `native sample failed: ${error.message.split('\n')[0]}`))
        .finally(() => {
          bursting = null;
        });
    return bursting;
  };

  attach();

  events.status = () => ({ type: 'status', ...status });
  events.reloadApp = () => inspector?.reloadApp();
  events.sampleNow = () => runBurst('manual sample');
  events.history = () => ({ ...history, ...observers.history() });
  events.profile = seconds => profileFor(seconds);
  // Background profiling for a recorded run: freezes in it get full stacks.
  events.profileWindow = (ms, reason) => {
    profiler.run(ms, reason);
  };
  events.stopProfileWindow = () => profiler.session?.stop();
  // Named heap snapshots, summarized; the last few are kept for diffs.
  const heaps = new Map();
  events.heapSnapshot = async label => {
    if (!inspector) throw new Error('not attached to the app');
    const text = await inspector.heapSnapshot();
    if (!text) throw new Error('a heap snapshot is already running');
    const summary = { label, screen: currentScreen, ...summarizeHeapSnapshot(JSON.parse(text)) };
    heaps.delete(label);
    heaps.set(label, summary);
    while (heaps.size > 6) heaps.delete(heaps.keys().next().value);
    return summary;
  };
  events.heapDiff = (before, after) => {
    const a = heaps.get(before);
    const b = heaps.get(after);
    if (!a || !b) throw new Error(`no snapshot named ${!a ? before : after}; have: ${[...heaps.keys()].join(', ') || 'none'}`);
    return { before: a, after: b, ...diffHeap(a, b) };
  };
  events.heapLabels = () => [...heaps.values()].map(h => ({ label: h.label, at: h.at, screen: h.screen, size: h.size, count: h.count }));
  events.renders = (from, to) => summarizeRenders(probe.commits, from, to);
  events.setSettings = patch => {
    for (const key of Object.keys(settings)) {
      if (Number.isFinite(patch[key]) && patch[key] > 0) settings[key] = patch[key];
    }
    setStatus({ settings });
  };
  events.clear = () => {
    history.stalls.length = 0;
    history.hot.length = 0;
    history.alerts.length = 0;
    history.lanes.length = 0;
    history.jank.length = 0;
    history.screens.length = 0;
    observers.clear();
    events.emit('event', { type: 'cleared' });
  };
  events.writeReport = outDir => writeReport(events.history(), status, outDir);
  events.stop = async () => {
    stopped = true;
    observers.stop();
    episode = null;
    stopPing?.();
    probe.stop();
    await inspector?.evaluate('globalThis.__HITCH__ && __HITCH__.stop()', 500).catch(() => {});
    monitor?.stop();
    symbolServer.child.kill();
    inspector?.removeAllListeners('close');
    await inspector?.close();
  };
  return events;
}

// --- stack analysis ------------------------------------------------------

const RENDER_FRAMES = /^(renderRootSync|renderRootConcurrent|workLoopSync|workLoopConcurrent|performUnitOfWork|beginWork|completeUnitOfWork|renderWithHooks)$/;
const COMMIT_FRAMES = /^(commitRoot|commitRootImpl|commitRootWhenReady|flushMutationEffects|commitMutationEffectsOnFiber|flushLayoutEffects|flushPassiveEffects|commitLayoutEffects|commitPassiveMountOnFiber)$/;
const isComponent = f => f.kind === 'app' && /^[A-Z][A-Za-z0-9]*$/.test(f.name);

// What started a synchronous React render, from the outermost frames.
const TRIGGERS = [
  [/^dispatchEvent$|^dispatchDiscreteEvent$|^batchedUpdates/, 'a touch or native event handler'],
  [/^processRootScheduleInMicrotask$|^flushSyncWorkAcrossRoots/, 'a state update flushed right after it was set (setState / store change)'],
  [/^performWorkOnRootViaSchedulerTask$|^workLoop$|^flushWork$/, 'a scheduled React update'],
  [/^callTimers$|^_callTimer$/, 'a timer (setTimeout / setInterval)'],
];

function renderShape(frames) {
  if (frames.some(f => COMMIT_FRAMES.test(f.name))) return 'commit';
  if (frames.some(f => RENDER_FRAMES.test(f.name))) return 'render';
  return null;
}

// Turns a stall's stack captures into: the culprit per capture (grouped),
// the library the time was really in, dev-only tooling, and — when React
// rendering dominated — which components were rendering and why.
export function analyzeSnapshots(snapshots) {
  const culprits = new Map();
  snapshots.forEach((frames, index) => {
    const at = [frames.findIndex(f => f.kind === 'app'), frames.findIndex(f => f.kind === 'lib'), 0].find(i => i >= 0 && frames[i]);
    const culprit = frames[at];
    if (!culprit) return;
    // Where the time actually was: the innermost real frame, plus the
    // libraries between it and the app code that led there.
    const hotFrame = frames.find(f => f.kind !== 'native') ?? frames[0];
    const hot = hotFrame && hotFrame !== culprit ? { name: hotFrame.name, kind: hotFrame.kind, pkg: hotFrame.pkg ?? null, file: hotFrame.file ?? null, line: hotFrame.line ?? null } : null;
    const between = frames.slice(0, at);
    const via = [...new Set(between.map(f => f.pkg).filter(p => p && p !== hot?.pkg))].slice(0, 3);
    const appChain = [...new Map(frames.slice(at).filter(f => f.kind === 'app').map(f => [`${f.file}:${f.line}`, { name: f.name, file: f.file, line: f.line }])).values()].slice(0, 4);
    const devOnly = devOnlyLabel(between.length ? between : [culprit]);
    const key = `${frameKey(culprit)}|${hot?.pkg ?? hot?.name ?? ''}`;
    // The nearest named function around an anonymous callback.
    const owner = frames.slice(at + 1).find(f => f.kind === culprit.kind && f.name && !/^(anonymous|\(anonymous\))$/.test(f.name))?.name ?? null;
    const entry = culprits.get(key) ?? { key, ...culprit, owner, hot, via, appChain, devOnly, count: 0, snapshot: index };
    entry.count += 1;
    culprits.set(key, entry);
  });
  const ranked = [...culprits.values()].sort((a, b) => b.count - a.count);

  const shapes = snapshots.map(renderShape);
  const inReact = shapes.filter(Boolean).length;
  let react = null;
  if (snapshots.length && inReact / snapshots.length >= 0.5) {
    const components = new Map();
    for (const frames of snapshots) {
      const seen = new Set();
      for (const f of frames) {
        if (!isComponent(f) || seen.has(f.name)) continue;
        seen.add(f.name);
        const c = components.get(f.name) ?? { name: f.name, file: f.file, line: f.line, count: 0 };
        c.count += 1;
        components.set(f.name, c);
      }
    }
    const outer = snapshots.flatMap(frames => frames.slice(-8));
    const trigger = TRIGGERS.find(([test]) => outer.some(f => test.test(f.name)))?.[1] ?? null;
    const commits = shapes.filter(s => s === 'commit').length;
    react = {
      phase: commits && commits < inReact ? 'render + commit' : commits ? 'commit' : 'render',
      captures: inReact,
      components: [...components.values()].sort((a, b) => b.count - a.count).slice(0, 8),
      trigger,
    };
  }

  // Redux actions being dispatched when a capture landed, most frequent first.
  const actionCounts = new Map();
  for (const frames of snapshots) for (const f of frames) if (f.action) actionCounts.set(f.action, (actionCounts.get(f.action) ?? 0) + 1);
  const actions = [...actionCounts].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count }));
  if (react && actions.length && react.trigger?.startsWith('a state update')) react.trigger = `a Redux action (${actions[0].type})`;

  return {
    culprits: ranked,
    devOnly: ranked[0]?.devOnly ?? null,
    react,
    actions,
    stale: snapshots.some(frames => frames.some(f => f.verified === false)),
  };
}

// --- report --------------------------------------------------------------

const ms = value => `${Math.round(value)}ms`;
const clock = at => new Date(at).toTimeString().slice(0, 8);
const where = c => (c.file ? `${c.name} · ${c.file}:${c.line}` : `${c.name} [${c.kind}]`);

export function rankOffenders(stalls) {
  const lines = new Map();
  for (const stall of stalls) {
    const total = stall.culprits.reduce((sum, c) => sum + c.count, 0) || 1;
    for (const c of stall.culprits) {
      const entry = lines.get(c.key) ?? { ...c, blockedMs: 0, stalls: 0, worstMs: 0 };
      entry.blockedMs += (stall.ms * c.count) / total;
      entry.stalls += 1;
      entry.worstMs = Math.max(entry.worstMs, stall.ms);
      lines.set(c.key, entry);
    }
  }
  return [...lines.values()].sort((a, b) => b.blockedMs - a.blockedMs);
}

// Anything worth a report: a session with only console errors or failed requests counts too.
export function hasFindings(history) {
  return [history.stalls, history.hot, history.alerts, history.console, (history.requests ?? []).filter(r => r.issue), history.startups, history.jank, (history.screens ?? []).filter(sc => sc.issue)].some(list => list?.length);
}

// Components re-rendered with equal props during freezes, summed over the session.
export function avoidableRows(stalls) {
  const rows = new Map();
  for (const stall of stalls) {
    for (const c of stall.renders?.components ?? []) {
      if (!c.avoidable) continue;
      const row = rows.get(c.name) ?? { name: c.name, avoidable: 0, renders: 0, stalls: 0, reasons: new Map() };
      row.avoidable += c.avoidable;
      row.renders += c.renders;
      row.stalls += 1;
      for (const r of c.reasons) row.reasons.set(r.reason, (row.reasons.get(r.reason) ?? 0) + r.count);
      rows.set(c.name, row);
    }
  }
  return [...rows.values()]
    .sort((a, b) => b.avoidable - a.avoidable)
    .slice(0, 15)
    .map(r => ({ ...r, reason: describeReason([...r.reasons].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '') }));
}

const section = (title, lines) => (lines.length ? [`## ${title}`, '', ...lines, ''] : []);
const firstLine = text => text.split('\n')[0].slice(0, 160).replace(/\|/g, '\\|');

export function writeReport(history, status, outDir) {
  const dir = outDir ?? path.join(os.homedir(), '.hitch', status.startedAt.replace(/[:.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const minutes = ((Date.now() - Date.parse(status.startedAt)) / 60000).toFixed(1);
  const blocked = history.stalls.reduce((sum, s) => sum + s.ms, 0);
  const consoleEvents = history.console ?? [];
  const requests = (history.requests ?? []).filter(r => r.issue);
  const errors = consoleEvents.filter(c => c.level === 'error').length;
  const md = [
    `# Hitch — ${status.appId}`,
    '',
    `${status.startedAt} · ${minutes} min · ${history.stalls.length} JS stalls (≥${status.settings.stallMs}ms, ${ms(blocked)} blocked) · ${history.hot.length} native hot spots · ${errors} console errors · ${consoleEvents.length - errors} warnings · ${requests.length} slow/failed requests`,
    '',
    ...section(
      'Lines blocking the JS thread',
      history.stalls.length
        ? [
            '| blocked | stalls | worst | function · file:line |',
            '|---|---|---|---|',
            ...rankOffenders(history.stalls).slice(0, 25).map(o => `| ${ms(o.blockedMs)} | ${o.stalls} | ${ms(o.worstMs)} | \`${where(o)}\` |`),
          ]
        : [],
    ),
    ...section('Worst stalls', [...history.stalls].sort((a, b) => b.ms - a.ms).slice(0, 10).map(s => `- **${ms(s.ms)}** at ${clock(s.at)} — ${s.culprits[0] ? where(s.culprits[0]) : 'no stack captured'}`)),
    ...section(
      'Native hot spots',
      history.hot.flatMap(h => [
        `- **${clock(h.at)}** ${h.trigger}`,
        ...h.threads.slice(0, 3).map(t => `  - ${t.label} ${t.busyPct}% — ${t.categories.slice(0, 2).map(c => `${c.name} ${c.pct}%`).join(', ')}; top: \`${t.frames[0]?.name ?? '?'}\``),
      ]),
    ),
    ...section(
      'Console errors & warnings',
      consoleEvents.length
        ? [
            '| level | times | first seen | message | logged from |',
            '|---|---|---|---|---|',
            ...[...consoleEvents]
              .sort((a, b) => (a.level === b.level ? b.count - a.count : a.level === 'error' ? -1 : 1))
              .slice(0, 30)
              .map(c => `| ${c.exception ? 'exception' : c.level} | ${c.count} | ${clock(c.at)} | ${firstLine(c.text)} | ${c.source?.file ? `\`${c.source.file}:${c.source.line}\`` : '—'} |`),
          ]
        : [],
    ),
    ...section(
      'Slow & failed requests',
      requests.slice(-30).map(r => `- **${r.failed ? (r.error ?? `HTTP ${r.status}`) : ms(r.ms)}** at ${clock(r.at)} — \`${r.method} ${r.url.slice(0, 160)}\`${r.source?.file ? ` from \`${r.source.file}:${r.source.line}\`` : ''}`),
    ),
    ...section(
      'Startups',
      (history.startups ?? []).map(s => `- **${s.kind}** at ${clock(s.at)} — JS started ${s.toJsMs != null ? ms(s.toJsMs) : '—'}, ${s.settled ? `settled ${ms(s.toSettleMs)}` : 'never settled within 30s'}`),
    ),
    ...section(
      'Screen loads',
      (history.screens ?? []).length
        ? ['| screen | settled in | commits | render time | mounts | freezes |', '|---|---|---|---|---|---|', ...history.screens.map(sc => `| ${sc.name} | ${sc.settled ? ms(sc.ms) : `>${ms(sc.ms)}`} | ${sc.commits} | ${ms(sc.renderMs)} | ${sc.mounts} | ${sc.stalls} |`)]
        : [],
    ),
    ...section(
      'Choppy frames',
      (history.jank ?? []).map(j => `- **${clock(j.at)}** ${j.fps} fps for ${j.seconds}s, ${j.dropped} frames dropped outside freezes${j.screen ? ` on ${j.screen}` : ''}${j.renders?.components?.[0] ? ` — most rendered: ${j.renders.components.slice(0, 3).map(c => `${c.name} ×${c.renders}`).join(', ')}` : ''}`),
    ),
    ...section(
      'Avoidable re-renders',
      avoidableRows(history.stalls).map(r => `- **${r.name}**: ${r.avoidable} avoidable of ${r.renders} renders across ${r.stalls} freeze(s) — ${r.reason}`),
    ),
    ...section(
      'Leaks',
      (history.alerts ?? []).map(a => (a.type === 'threadleak' ? `- **${clock(a.at)}** threads ${a.from} → ${a.to}` : a.kind === 'reload' ? `- **${clock(a.at)}** app memory not freed by a JS reload: ${Math.round(a.from / 1048576)} → ${Math.round(a.to / 1048576)} MB` : `- **${clock(a.at)}** ${a.kind === 'heap' ? 'JS heap' : 'app memory'} climbing ${a.mbPerMin} MB/min`)),
    ),
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'report.md'), md);
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(history, null, 2));
  return path.join(dir, 'report.md');
}

// A saved session (session.json from a report) served read-only to the UI.
export function openSession(file, initial) {
  const events = new EventEmitter();
  const history = JSON.parse(fs.readFileSync(file, 'utf8'));
  history.lanes ??= [];
  history.logs ??= [];
  history.jank ??= [];
  history.screens ??= [];
  // Re-run the analysis so older sessions get the current attribution.
  for (const stall of history.stalls) {
    const { culprits, devOnly, react } = analyzeSnapshots(stall.snapshots ?? []);
    Object.assign(stall, { culprits, devOnly, react });
  }
  const status = {
    state: 'replay',
    appId: `saved session · ${path.basename(path.dirname(file))}`,
    device: null,
    project: initial.project,
    native: true,
    symbols: 'ready',
    settings: { stallMs: initial.stallMs, uiHot: initial.uiHot, threadHot: initial.threadHot },
    startedAt: new Date().toISOString(),
  };
  events.status = () => ({ type: 'status', ...status });
  events.history = () => history;
  events.setSettings = () => {};
  events.clear = () => {};
  events.sampleNow = () => {};
  events.reloadApp = () => Promise.resolve({ error: 'saved session' });
  events.writeReport = () => file;
  events.stop = async () => {};
  events.servers = () => ({ type: 'servers', servers: [], phones: [], current: null });
  events.project = () => initial.project;
  return events;
}
