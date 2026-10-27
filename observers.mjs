// Everything beyond JS freezes and thread CPU: console output,
// network requests, memory + thread-count vitals with leak detection, and
// startup timing. All fed by debugger events or host-side reads.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { fingerprint } from './console-format.mjs';
import { BODY_MAX, REQUEST_BODY_MAX, clip, createBodyStore, redactBody, redactHeaders } from './network-detail.mjs';

const run = promisify(execFile);

const VITALS_MS = 2000;
const VITALS_HISTORY = 1800;
const REQUEST_HISTORY = 1000;
const DEDUPE_MS = 10000;
const LEAK_WINDOW_MS = 180000;
const LEAK_BUCKET_MS = 20000;
const LEAK_COOLDOWN_MS = 180000;
// A JS reload starts a new runtime and frees the old one lazily, so memory
// spikes and drains for a minute or two. Only trust samples after that.
const RELOAD_SETTLE_MS = 90000;
const SETTLE_QUIET_MS = 1000;
const SETTLE_TIMEOUT_MS = 30000;
const CONSOLE_LEVELS = new Set(['warning', 'warn', 'error', 'assert', 'exception']);
// Plain logs aren't issues, but they're the context around one.
const LOG_LEVELS = new Set(['log', 'info', 'debug', 'trace', 'dir', 'table']);
const LOG_HISTORY = 2000;
const LOG_TEXT_MAX = 1000;
const LOG_FLUSH_MS = 500;
// Logging helpers sit on top of every console stack; the caller is the story.
const LOG_WRAPPER = /logging|reactotron|console|LogBox|polyfills|errorGuard|ExceptionsManager/i;

const MB = 1024 * 1024;
// A JS reload frees the old runtime's JS objects, but native memory (images,
// views, animation engines) only comes back if the app released it. Checked
// once things have settled after a reload.
const RELOAD_MEMORY_CHECK_MS = 45000;
const RELOAD_MEMORY_MIN_GROWTH = 150 * MB;

function slopePerMin(points) {
  const n = points.length;
  if (n < 3) return 0;
  const mx = points.reduce((s, p) => s + p[0], 0) / n;
  const my = points.reduce((s, p) => s + p[1], 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of points) {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  }
  return den ? (num / den) * 60000 : 0;
}

// Lowest value per bucket: the post-GC floor, so the sawtooth doesn't fake a trend.
function bucketFloors(samples, key, windowMs, bucketMs, now) {
  const buckets = new Map();
  for (const s of samples) {
    if (now - s.at > windowMs || s[key] == null) continue;
    const b = Math.floor((s.at - (now - windowMs)) / bucketMs);
    const prev = buckets.get(b);
    if (!prev || s[key] < prev[1]) buckets.set(b, [s.at, s[key]]);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
}

function steadilyRising(points) {
  let ups = 0;
  for (let i = 1; i < points.length; i++) if (points[i][1] >= points[i - 1][1]) ups++;
  return points.length >= 6 && ups >= points.length - 2;
}

// Memory series whose post-GC floor rose steadily over the window. Pass only
// samples from one runtime: a reload in the window reads as growth.
export function memoryLeaks(vitals, now) {
  const span = vitals.length ? now - vitals[0].at : 0;
  if (span < LEAK_WINDOW_MS * 0.8) return [];
  const found = [];
  for (const [key, kind, minRise, minSlope] of [
    ['heapUsed', 'heap', 15 * MB, 3 * MB],
    ['rss', 'rss', 60 * MB, 10 * MB],
  ]) {
    const floors = bucketFloors(vitals, key, LEAK_WINDOW_MS, LEAK_BUCKET_MS, now);
    if (!steadilyRising(floors)) continue;
    const rise = floors.at(-1)[1] - floors[0][1];
    const slope = slopePerMin(floors);
    if (rise < minRise || slope < minSlope) continue;
    found.push({ kind, from: floors[0][1], to: floors.at(-1)[1], slope });
  }
  return found;
}

export function createObservers({ publish, settings, nextId, symbolicate, getPid, readRss, getAndroidApp, getInspector, getThreadNames, sessionStartedAt }) {
  const vitals = [];
  const requests = [];
  const consoleEvents = [];
  const startups = [];
  const lastLeakAt = { heap: 0, rss: 0, threads: 0 };
  let reloadedAt = 0;
  let reloadMemory = null;
  let vitalsTimer = null;
  let threadCount = null;

  // ---------------------------------------------------------------- console

  // Same level and same message apart from ids/numbers, close enough in time: one entry with a count.
  const repeatOf = (list, level, key, at, lookback) => {
    for (let i = list.length - 1; i >= Math.max(0, list.length - lookback); i--) {
      const e = list[i];
      if (e.level === level && e.key === key && at - e.lastAt < DEDUPE_MS) return e;
    }
    return null;
  };

  const repeat = (e, text, at) => {
    e.count += 1;
    e.lastAt = at;
    if (text !== e.text) e.lastText = text;
  };

  const onConsole = async raw => {
    if (raw.ignore) return;
    // Replayed history from before we attached is noise, except right after a reload.
    if (raw.at < (startup?.startedAt ?? sessionStartedAt) - 2000) return;
    if (LOG_LEVELS.has(raw.level)) return onLog(raw);
    if (!CONSOLE_LEVELS.has(raw.level)) return;
    const level = raw.level === 'warning' || raw.level === 'warn' ? 'warn' : 'error';
    const text = raw.text.slice(0, 4000);
    const key = fingerprint(text);
    const dup = repeatOf(consoleEvents, level, key, raw.at, consoleEvents.length);
    if (dup) {
      repeat(dup, text, raw.at);
      publish({ ...dup });
      return;
    }
    const frames = await symbolicate(raw.frames.slice(0, 25));
    const source =
      frames.find(f => f.kind === 'app' && !LOG_WRAPPER.test(f.file ?? '')) ??
      frames.find(f => f.kind === 'lib' && !LOG_WRAPPER.test(f.file ?? '')) ??
      null;
    const event = { type: 'console', id: nextId(), at: raw.at, lastAt: raw.at, level, exception: raw.level === 'exception', text, key, source, frames, count: 1 };
    consoleEvents.push(event);
    if (consoleEvents.length > 500) consoleEvents.shift();
    publish(event);
  };

  // Apps can log hundreds of lines a second: batch them to the window.
  const logs = [];
  const unsentLogs = new Map();
  let logTimer = null;
  const flushLogs = () => {
    logTimer = null;
    if (!unsentLogs.size) return;
    publish({ type: 'logs', entries: [...unsentLogs.values()].map(e => ({ ...e })) });
    unsentLogs.clear();
  };

  const onLog = raw => {
    const level = raw.level === 'debug' || raw.level === 'info' ? raw.level : 'log';
    const text = raw.text.slice(0, LOG_TEXT_MAX);
    const key = fingerprint(text);
    let entry = repeatOf(logs, level, key, raw.at, 20);
    if (entry) repeat(entry, text, raw.at);
    else {
      entry = { type: 'log', id: nextId(), at: raw.at, lastAt: raw.at, level, text, key, count: 1 };
      logs.push(entry);
      if (logs.length > LOG_HISTORY) logs.shift();
    }
    unsentLogs.set(entry.id, entry);
    logTimer ??= setTimeout(flushLogs, LOG_FLUSH_MS);
  };

  // ---------------------------------------------------------------- network

  const inflight = new Map();
  // Response bodies of recent requests, read once each finishes.
  const bodies = createBodyStore();
  const readBody = async (requestId, eventId) => {
    const raw = await getInspector()?.responseBody(requestId);
    if (!raw) return null;
    const text = raw.base64Encoded ? null : redactBody(raw.body);
    const body = { ...(text != null ? clip(text, BODY_MAX) : { text: null, truncated: false, size: raw.body.length }), base64: raw.base64Encoded };
    bodies.set(eventId, body);
    return body;
  };
  const onNetwork = (method, params) => {
    if (method === 'requestWillBeSent') {
      inflight.set(params.requestId, {
        url: params.request?.url ?? '',
        method: params.request?.method ?? 'GET',
        startTs: params.timestamp,
        at: params.wallTime ? Math.round(params.wallTime * 1000) : params.timestamp ? Math.round(params.timestamp * 1000) : Date.now(),
        initiator: (params.initiator?.stack?.callFrames ?? []).slice(0, 20),
        requestHeaders: redactHeaders(params.request?.headers),
        requestBody: params.request?.postData ? clip(redactBody(params.request.postData), REQUEST_BODY_MAX) : null,
      });
    } else if (method === 'responseReceived') {
      const r = inflight.get(params.requestId);
      if (r) Object.assign(r, { status: params.response?.status ?? null, mime: params.response?.mimeType ?? null, responseHeaders: redactHeaders(params.response?.headers) });
    } else if (method === 'loadingFinished' || method === 'loadingFailed') {
      const r = inflight.get(params.requestId);
      if (!r) return;
      inflight.delete(params.requestId);
      finishRequest(r, method, params).catch(() => {});
    }
  };

  const finishRequest = async (r, method, params) => {
    {
      const ms = params.timestamp && r.startTs ? Math.round((params.timestamp - r.startTs) * 1000) : Date.now() - r.at;
      const failed = method === 'loadingFailed' || (r.status ?? 0) >= 400;
      const event = {
        type: 'request',
        id: nextId(),
        at: r.at,
        ms,
        url: r.url,
        method: r.method,
        status: r.status ?? null,
        bytes: params.encodedDataLength ?? null,
        failed,
        error: params.errorText ?? null,
        canceled: Boolean(params.canceled),
        issue: !params.canceled && (failed || ms >= settings.slowRequestMs),
        source: null,
        mime: r.mime ?? null,
        requestHeaders: r.requestHeaders ?? null,
        requestBody: r.requestBody ?? null,
        responseHeaders: r.responseHeaders ?? null,
        bodySize: null,
      };
      if (method === 'loadingFinished') {
        const body = await readBody(params.requestId, event.id).catch(() => null);
        event.bodySize = body?.size ?? null;
      }
      // Only flagged requests are worth symbolicating the initiator for.
      if (event.issue && r.initiator.length) {
        const frames = await symbolicate(r.initiator.map(f => ({ functionName: f.functionName, url: f.url, lineNumber: f.lineNumber, columnNumber: f.columnNumber })));
        event.source = frames.find(f => f.kind === 'app') ?? null;
        event.frames = frames;
      }
      requests.push(event);
      if (requests.length > REQUEST_HISTORY) requests.shift();
      publish(event);
    }
  };

  // ---------------------------------------------------------------- startup

  // One startup in progress at a time: from launch/reload to the app settling.
  let startup = null;
  let quietSince = null;

  const beginStartup = (kind, startedAt) => {
    startup = { kind, startedAt, jsReadyAt: null };
    quietSince = null;
    setTimeout(() => finishStartup(null), SETTLE_TIMEOUT_MS);
  };

  const finishStartup = settledAt => {
    if (!startup) return;
    const s = startup;
    startup = null;
    const event = {
      type: 'startup',
      id: nextId(),
      at: s.startedAt,
      kind: s.kind,
      toJsMs: s.jsReadyAt ? s.jsReadyAt - s.startedAt : null,
      toSettleMs: settledAt ? settledAt - s.startedAt : null,
      settled: Boolean(settledAt),
      issue: true,
    };
    startups.push(event);
    publish(event);
  };

  // "Running "app" with {...}" is AppRegistry starting the first screen.
  const onStartupConsole = raw => {
    if (startup && !startup.jsReadyAt && /^Running "/.test(raw.text) && raw.at >= startup.startedAt - 500) startup.jsReadyAt = raw.at;
  };

  // Settled = JS (and UI, when visible) quiet for a full second after JS started.
  const onLanes = event => {
    if (!startup?.jsReadyAt || event.at < startup.jsReadyAt) return;
    const busy = name => {
      const lane = event.lanes.find(([n]) => n === name);
      return lane ? lane[1] / event.windowMs : 0;
    };
    const quiet = busy('JS thread') < 0.1 && busy('Main/UI thread') < 0.3;
    if (!quiet) {
      quietSince = null;
      return;
    }
    quietSince ??= event.at - event.windowMs;
    if (event.at - quietSince >= SETTLE_QUIET_MS) finishStartup(quietSince);
  };

  const processStartedAt = async pid => {
    try {
      const { stdout } = await run('ps', ['-o', 'lstart=', '-p', String(pid)]);
      const at = Date.parse(stdout.trim());
      return Number.isFinite(at) ? at : null;
    } catch {
      return null;
    }
  };

  // ---------------------------------------------------------------- vitals

  const rssOf = async pid => {
    try {
      const { stdout } = await run('ps', ['-o', 'rss=', '-p', String(pid)]);
      const kb = Number(stdout.trim());
      return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
    } catch {
      return null;
    }
  };

  const checkLeaks = now => {
    const settled = vitals.filter(v => v.at >= reloadedAt + RELOAD_SETTLE_MS);
    for (const leak of memoryLeaks(settled, now)) {
      if (now - lastLeakAt[leak.kind] < LEAK_COOLDOWN_MS) continue;
      lastLeakAt[leak.kind] = now;
      publish({
        type: 'leak',
        id: nextId(),
        at: now,
        kind: leak.kind,
        from: leak.from,
        to: leak.to,
        mbPerMin: Math.round((leak.slope / MB) * 10) / 10,
        windowMs: LEAK_WINDOW_MS,
        issue: true,
      });
    }
    const span = settled.length ? now - settled[0].at : 0;
    if (span >= LEAK_WINDOW_MS * 0.8 && now - lastLeakAt.threads >= LEAK_COOLDOWN_MS) {
      const floors = bucketFloors(settled, 'threads', LEAK_WINDOW_MS, LEAK_BUCKET_MS, now);
      const rise = floors.length ? floors.at(-1)[1] - floors[0][1] : 0;
      if (steadilyRising(floors) && rise >= 8) {
        lastLeakAt.threads = now;
        const before = settled.find(v => now - v.at <= LEAK_WINDOW_MS)?.names ?? [];
        const after = getThreadNames();
        const counts = list => list.reduce((m, n) => m.set(n, (m.get(n) ?? 0) + 1), new Map());
        const was = counts(before);
        const grew = [...counts(after)].map(([name, n]) => ({ name, added: n - (was.get(name) ?? 0) })).filter(g => g.added > 0).sort((a, b) => b.added - a.added);
        publish({ type: 'threadleak', id: nextId(), at: now, from: floors[0][1], to: floors.at(-1)[1], grew: grew.slice(0, 8), issue: true });
      }
    }
  };

  const checkReloadMemory = (now, rss) => {
    if (!reloadMemory || rss == null || now - reloadMemory.at < RELOAD_MEMORY_CHECK_MS) return;
    const { before } = reloadMemory;
    reloadMemory = null;
    if (before != null && rss - before >= RELOAD_MEMORY_MIN_GROWTH && rss >= before * 1.25) {
      publish({ type: 'leak', id: nextId(), at: now, kind: 'reload', from: before, to: rss, mbPerMin: null, windowMs: RELOAD_MEMORY_CHECK_MS, issue: true });
    }
  };

  const pollVitals = async () => {
    const pid = getPid();
    const inspector = getInspector();
    const android = getAndroidApp?.();
    const [heap, rss] = await Promise.all([inspector?.heapUsage() ?? null, android ? readRss(android) : pid ? rssOf(pid) : null]);
    if (!heap && !rss) return;
    const at = Date.now();
    const sample = {
      type: 'vitals',
      at,
      heapUsed: heap?.usedSize ?? null,
      heapTotal: heap?.totalSize ?? null,
      rss,
      threads: pid ? threadCount : null,
    };
    // A fresh runtime's heap starts small; GC never shrinks the allocation
    // this much. Catches reloads the debugger link didn't report.
    const prevTotal = vitals.findLast(v => v.heapTotal != null)?.heapTotal;
    if (sample.heapTotal != null && prevTotal && sample.heapTotal < prevTotal / 2) reloadedAt = at;
    vitals.push({ ...sample, names: pid ? getThreadNames() : [] });
    if (vitals.length > VITALS_HISTORY) vitals.shift();
    publish(sample);
    checkLeaks(at);
    checkReloadMemory(at, rss);
  };

  return {
    onConsole: raw => {
      onStartupConsole(raw);
      return onConsole(raw).catch(() => {});
    },
    onNetwork,
    onLanes,
    setThreadCount: n => {
      threadCount = n;
    },
    onReloadStarted: () => {
      reloadedAt = Date.now();
      // Compare with the most memory the app used before the reload, so an app
      // that was idle (memory paged out) doesn't look like it grew.
      const recent = vitals.filter(v => v.rss != null && reloadedAt - v.at <= LEAK_WINDOW_MS);
      reloadMemory = { at: reloadedAt, before: recent.length ? Math.max(...recent.map(v => v.rss)) : null };
      beginStartup('reload', reloadedAt);
    },
    // A process launched moments before we attached is a cold start we can still time.
    onAttached: async pid => {
      if (startup || !pid) return;
      const started = await processStartedAt(pid);
      if (started && Date.now() - started < 120000) beginStartup('cold launch', started);
    },
    start: () => {
      vitalsTimer ??= setInterval(() => pollVitals().catch(() => {}), VITALS_MS);
    },
    stop: () => {
      flushLogs();
      clearTimeout(logTimer);
      clearInterval(vitalsTimer);
      vitalsTimer = null;
    },
    latestVitals: () => vitals.at(-1) ?? null,
    responseBody: id => bodies.get(id),
    inStartup: () => Boolean(startup),
    history: () => ({ vitals: vitals.map(({ names, ...v }) => v), requests, console: consoleEvents, logs, startups }),
    clear: () => {
      clearTimeout(logTimer);
      logTimer = null;
      unsentLogs.clear();
      logs.length = 0;
      vitals.length = 0;
      requests.length = 0;
      consoleEvents.length = 0;
      startups.length = 0;
      bodies.clear();
    },
  };
}
