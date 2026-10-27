// Debugger link to the app's JS runtime. Having the debugger enabled costs the
// app nothing while it runs; we only act by pausing for an instant to read the
// stack of whatever JS is running right now.

import { EventEmitter } from 'node:events';

import { formatConsoleArgs, previewFromProperties } from './console-format.mjs';

// A pause that lands later than this was queued behind idle time, so the
// stack belongs to unrelated later work and is dropped.
const FRESH_PAUSE_MS = 40;
// Objects in warnings and errors are worth one property read each; plain logs
// are too frequent for that and show whatever preview the debugger sent.
const EXPAND_LEVELS = new Set(['warning', 'warn', 'error', 'assert']);
const EXPAND_MAX = 4;
const EXPAND_TIMEOUT_MS = 300;

export async function findTarget(metroUrl, appId, device) {
  const res = await fetch(`${metroUrl}/json/list`);
  const pages = await res.json();
  return pages.filter(p => p.webSocketDebuggerUrl && (!appId || p.appId === appId) && (!device || p.deviceName === device)).at(-1) ?? null;
}

export function connectInspector({ metroUrl, target }) {
  const events = new EventEmitter();
  const ws = new WebSocket(target.webSocketDebuggerUrl, { headers: { Origin: metroUrl } });
  const scripts = new Map();
  const pending = new Map();
  let nextId = 0;
  let pauseRequest = null;
  let externallyPaused = false;
  // Every Debugger.pause we send, until its Debugger.paused arrives. Hermes can
  // deliver a requested pause late (on the next JS it runs), so a pause is only
  // someone else's (a DevTools breakpoint) when none of ours is outstanding.
  let ourPauses = 0;
  let lastPauseSentAt = 0;
  let pausedByUsSince = 0;
  let ready = false;
  let contexts = 0;
  let heapChunks = null;

  const send = (method, params) =>
    new Promise(resolve => {
      const id = ++nextId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const resume = () => {
    pausedByUsSince = Date.now();
    send('Debugger.resume');
  };

  // The Redux action being dispatched, read from the paused `dispatch` frame.
  // Costs one round trip while the app is already frozen; capped hard.
  const ACTION_READ_MS = 30;
  const readAction = async callFrames => {
    const frame = callFrames.find(f => f.functionName === 'dispatch');
    if (!frame?.callFrameId) return null;
    const res = await Promise.race([
      send('Debugger.evaluateOnCallFrame', {
        callFrameId: frame.callFrameId,
        expression: '(function(a){return a && typeof a.type === "string" ? a.type : null})(arguments[0])',
        returnByValue: true,
        silent: true,
      }),
      new Promise(r => setTimeout(() => r(null), ACTION_READ_MS)),
    ]);
    const type = res?.result?.result?.value;
    return typeof type === 'string' ? { frame, type } : null;
  };

  const onPaused = async params => {
    const ours = ourPauses > 0 || Date.now() - lastPauseSentAt < 5000;
    if (!ours) {
      // A DevTools breakpoint paused the app; stay out of the way.
      externallyPaused = true;
      return;
    }
    ourPauses = Math.max(0, ourPauses - 1);
    const fresh = pauseRequest && Date.now() - pauseRequest.requestedAt <= FRESH_PAUSE_MS;
    const action = fresh ? await readAction(params.callFrames).catch(() => null) : null;
    resume();
    if (!pauseRequest) return;
    const { resolve } = pauseRequest;
    pauseRequest = null;
    if (!fresh) {
      resolve(null);
      return;
    }
    resolve(
      params.callFrames.map(f => ({
        functionName: f.functionName,
        url: scripts.get(f.location.scriptId) ?? '',
        lineNumber: f.location.lineNumber,
        columnNumber: f.location.columnNumber,
        ...(action?.frame === f ? { action: action.type } : {}),
      })),
    );
  };

  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === 'Debugger.scriptParsed') {
      scripts.set(msg.params.scriptId, msg.params.url);
      // A new bundle after we were ready: the JS reloaded (bridgeless reloads keep this socket open).
      if (ready && /\.bundle/.test(msg.params.url)) events.emit('bundle', msg.params.url);
    } else if (msg.method === 'Runtime.executionContextCreated') {
      contexts += 1;
      if (ready && contexts > 1) events.emit('reloaded');
    }
    else if (msg.method === 'Debugger.paused') onPaused(msg.params).catch(() => resume());
    else if (msg.method === 'Runtime.consoleAPICalled') consoleEvent(msg.params).then(event => events.emit('console', event));
    else if (msg.method === 'Runtime.exceptionThrown') events.emit('console', exceptionEvent(msg.params));
    else if (msg.method === 'HeapProfiler.addHeapSnapshotChunk') heapChunks?.push(msg.params.chunk);
    else if (msg.method?.startsWith('Network.')) events.emit('network', msg.method.slice(8), msg.params);
    else if (msg.method === 'Debugger.resumed') {
      externallyPaused = false;
      pausedByUsSince = 0;
    }
  });

  const frameOf = f => ({
    functionName: f.functionName,
    url: f.url || scripts.get(f.scriptId) || '',
    lineNumber: f.lineNumber,
    columnNumber: f.columnNumber,
  });
  // The debugger's own banner, not app output.
  const isOwnNotice = params => params.context?.includes('InstanceAgent');
  const withTimeout = promise => Promise.race([promise, new Promise(r => setTimeout(() => r(null), EXPAND_TIMEOUT_MS))]);
  const expandArgs = async params => {
    const expanded = new Map();
    if (!EXPAND_LEVELS.has(params.type)) return expanded;
    const wanted = params.args.map((a, i) => [a, i]).filter(([a]) => a.type === 'object' && a.objectId && a.subtype !== 'null' && !a.preview?.properties?.length).slice(0, EXPAND_MAX);
    await Promise.all(
      wanted.map(async ([a, i]) => {
        const res = await withTimeout(send('Runtime.getProperties', { objectId: a.objectId, ownProperties: true }));
        if (res?.result?.result) expanded.set(i, previewFromProperties(a, res.result.result));
      }),
    );
    return expanded;
  };
  const consoleEvent = async params => {
    const args = params.args ?? [];
    const expanded = await expandArgs({ ...params, args }).catch(() => new Map());
    return {
      level: params.type,
      at: params.timestamp ? Math.round(params.timestamp) : Date.now(),
      text: formatConsoleArgs(args, expanded),
      frames: (params.stackTrace?.callFrames ?? []).map(frameOf),
      ignore: isOwnNotice(params),
    };
  };
  const exceptionEvent = params => {
    const d = params.exceptionDetails ?? {};
    return {
      level: 'exception',
      at: params.timestamp ? Math.round(params.timestamp) : Date.now(),
      text: d.exception?.description ?? d.text ?? 'Uncaught exception',
      frames: (d.stackTrace?.callFrames ?? []).map(frameOf),
      ignore: false,
    };
  };

  ws.addEventListener('open', async () => {
    const res = await send('Debugger.enable', {});
    if (res.error) {
      events.emit('error', new Error(`Debugger.enable failed: ${res.error.message}`));
      return;
    }
    // Console + network reporting are built into the app's debugger; enabling
    // them only asks it to send us what it already produces.
    await Promise.all([send('Runtime.enable', {}), send('Network.enable', {})]);
    ready = true;
    events.emit('ready', [...new Set(scripts.values())].filter(Boolean));
  });
  ws.addEventListener('error', () => events.emit('error', new Error('inspector connection failed')));
  ws.addEventListener('close', () => {
    clearInterval(safety);
    pauseRequest?.resolve(null);
    pauseRequest = null;
    events.emit('close');
  });

  events.reloadApp = () => send('Page.reload', {});

  // Answered by Hermes off the JS thread, so polling it doesn't stall the app.
  events.heapUsage = () =>
    ws.readyState === WebSocket.OPEN
      ? Promise.race([send('Runtime.getHeapUsage', {}).then(r => r.result ?? null), new Promise(r => setTimeout(() => r(null), 1000))])
      : Promise.resolve(null);

  // A finished request's response body, as the app's network agent kept it.
  events.responseBody = requestId =>
    ws.readyState === WebSocket.OPEN
      ? Promise.race([send('Network.getResponseBody', { requestId }).then(r => r.result ?? null), new Promise(r => setTimeout(() => r(null), 3000))])
      : Promise.resolve(null);

  // Runs an expression in the app and returns its JSON-able value (or null).
  events.evaluate = (expression, timeoutMs = 2000) =>
    ws.readyState === WebSocket.OPEN
      ? Promise.race([
          send('Runtime.evaluate', { expression, returnByValue: true, silent: true }).then(r => (r.result?.exceptionDetails ? null : (r.result?.result?.value ?? null))),
          new Promise(r => setTimeout(() => r(null), timeoutMs)),
        ])
      : Promise.resolve(null);

  // Hermes' sampling profiler: a stack every ~10ms, so short freezes get a
  // stack too. Runs only for bounded windows (startup, a recorded run).
  let profilingSince = 0;
  events.startProfile = async () => {
    if (profilingSince || ws.readyState !== WebSocket.OPEN) return false;
    const res = await send('Profiler.start', {});
    if (res.error) return false;
    profilingSince = Date.now();
    return true;
  };
  events.stopProfile = async () => {
    if (!profilingSince) return null;
    const startedAt = profilingSince;
    profilingSince = 0;
    if (ws.readyState !== WebSocket.OPEN) return null;
    const res = await Promise.race([send('Profiler.stop', {}), new Promise(r => setTimeout(() => r(null), 15000))]);
    const profile = res?.result?.profile;
    return profile ? { profile, startedAt, stoppedAt: Date.now(), scripts: new Map(scripts) } : null;
  };
  events.isProfiling = () => Boolean(profilingSince);

  // A full JS heap snapshot. Freezes the app while Hermes writes it (seconds
  // for a large heap), so it only ever runs when someone asks for one.
  events.heapSnapshot = async () => {
    if (heapChunks || ws.readyState !== WebSocket.OPEN) return null;
    heapChunks = [];
    try {
      const res = await Promise.race([send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }), new Promise(r => setTimeout(() => r({ error: { message: 'timed out' } }), 120000))]);
      if (res.error) throw new Error(res.error.message);
      return heapChunks.join('');
    } finally {
      heapChunks = null;
    }
  };

  // Resolves with the stack running *now*, or null if nothing fresh was running.
  events.captureStack = () => {
    if (pauseRequest || externallyPaused || ws.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    return new Promise(resolve => {
      pauseRequest = { requestedAt: Date.now(), resolve };
      ourPauses += 1;
      lastPauseSentAt = Date.now();
      send('Debugger.pause', {});
    });
  };

  // Fallback heartbeat when the host can't read thread CPU (Android / device):
  // an evaluate only runs once the JS thread is free, so a late reply = blocked.
  // Each ping costs the app ~2ms, hence the slow default interval.
  events.startPing = ({ intervalMs, onBlocked, onUnblocked, onTick }) => {
    let sentAt = 0;
    let outstanding = false;
    let blocked = false;
    let lastTick = Date.now();
    const timer = setInterval(async () => {
      // Responsiveness lane: a window counts as busy while a ping is unanswered.
      const now = Date.now();
      onTick?.({ at: now, windowMs: now - lastTick, busy: outstanding && now - sentAt > intervalMs / 2 });
      lastTick = now;
      if (outstanding) {
        if (!blocked && Date.now() - sentAt >= intervalMs) {
          blocked = true;
          onBlocked(sentAt);
        }
        return;
      }
      outstanding = true;
      sentAt = Date.now();
      await send('Runtime.evaluate', { expression: '0', silent: true });
      outstanding = false;
      if (blocked) onUnblocked(Date.now());
      blocked = false;
    }, intervalMs / 2);
    return () => clearInterval(timer);
  };

  // Never leave the app frozen: if a resume we sent hasn't landed, send again.
  const safety = setInterval(() => {
    if (pausedByUsSince && Date.now() - pausedByUsSince > 500 && ws.readyState === WebSocket.OPEN) {
      pausedByUsSince = Date.now();
      send('Debugger.resume');
    }
  }, 250);

  // Resolves once the app is resumed and the debugger detached (or 500ms).
  events.close = () => {
    clearInterval(safety);
    if (ws.readyState !== WebSocket.OPEN) return Promise.resolve();
    ws.send(JSON.stringify({ id: ++nextId, method: 'Debugger.resume', params: {} }));
    if (profilingSince) ws.send(JSON.stringify({ id: ++nextId, method: 'Profiler.stop', params: {} }));
    for (const method of ['Network.disable', 'Runtime.disable']) ws.send(JSON.stringify({ id: ++nextId, method, params: {} }));
    const disabled = send('Debugger.disable', {});
    return Promise.race([disabled, new Promise(r => setTimeout(r, 500))]).finally(() => ws.close());
  };
  return events;
}
