// Hitch UI: live thread lanes + captured slowdowns + AI hand-off.

const $ = sel => document.querySelector(sel);
const el = (tag, cls, html) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html !== undefined) node.innerHTML = html;
  return node;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clock = at => new Date(at).toTimeString().slice(0, 8);
const ago = at => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return clock(at);
};

// Every color and font comes from the Shoelace theme tokens. The theme loads
// from a CDN, and WebKit (Hitch.app) can run this before it arrives on a cold
// cache, so read the tokens again once every stylesheet has loaded.
const T = name => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
const COLORS = {};
const INK = {};
const CATEGORY_COLORS = {};
let FONT_SANS = '';
let FONT_MONO = '';

function readTheme() {
  Object.assign(COLORS, {
    js: T('lane-js'),
    ui: T('lane-ui'),
    gc: T('lane-gc'),
    sdk: T('lane-sdk'),
    net: T('lane-net'),
    other: T('lane-other'),
    stall: T('freeze'),
    severe: T('freeze-severe'),
    hot: T('sampled'),
  });
  Object.assign(INK, {
    text: T('sl-color-neutral-900'),
    label: T('sl-color-neutral-700'),
    muted: T('sl-color-neutral-500'),
    grid: T('sl-color-neutral-100'),
    track: T('sl-color-neutral-50'),
    rule: T('sl-color-neutral-100'),
  });
  FONT_SANS = T('sl-font-sans');
  FONT_MONO = T('sl-font-mono');
  Object.assign(CATEGORY_COLORS, {
    'Yoga layout': T('sl-color-sky-400'),
    'Text layout': T('sl-color-cyan-300'),
    'Hermes GC': COLORS.gc,
    'Reanimated / worklets': T('sl-color-fuchsia-400'),
    Images: T('sl-color-yellow-400'),
    'Firestore / gRPC': COLORS.net,
    'Analytics SDKs': COLORS.sdk,
    Network: T('sl-color-emerald-400'),
    'React mounting / shadow tree': T('sl-color-green-400'),
    'Hermes JS execution': COLORS.js,
    'CoreAnimation / render': T('sl-color-rose-400'),
    UIKit: T('sl-color-indigo-300'),
    Other: COLORS.other,
  });
  $('#legend').innerHTML = [
    ['JS', COLORS.js],
    ['UI', COLORS.ui],
    ['GC', COLORS.gc],
    ['SDKs', COLORS.sdk],
    ['Network / Firestore', COLORS.net],
    ['Freeze', COLORS.stall],
    ['Sampled', COLORS.hot],
  ]
    .map(([label, color]) => `<span><i style="background:${color}"></i>${label}</span>`)
    .join('');
}
readTheme();
if (document.readyState !== 'complete') addEventListener('load', readTheme, { once: true });

const SEVERE_MS = 100;

// Plain-language explanations behind every (i).
const ROW_INFO = {
  'Main/UI thread':
    'The iOS main thread. It handles touches, layout (Yoga), updating native views and native-driven animations. When it is busy the screen cannot draw, so scrolling and animations stutter. Measured as CPU time every 50ms from your Mac; nothing runs inside the app.',
  'JS thread':
    'Runs your JavaScript: React renders, state updates, Redux, effects and network callbacks. When it is pegged, taps and JS animations freeze. Busy stretches over the freeze threshold are boxed, and Hitch grabs the stack to show the line responsible.',
  'Hermes GC (hades)':
    "Hermes' garbage-collector threads. Spikes mean the app is creating lots of short-lived objects (allocation churn), often from re-renders building new arrays and objects every time.",
  network:
    "Each XHR request (axios, React Native's XMLHttpRequest) drawn from send to finish. Teal is fine, amber is slower than your threshold, red failed. Expo replaces the global fetch with a native one the app does not report, so fetch and RTK Query calls do not appear here.",
  console:
    'Triangles are console.warn, console.error and uncaught exceptions from the app, at the moment they happened, with the line that logged them. Repeats of the same message (even with different ids or numbers in it) are grouped with a count. Faint ticks are plain console.log / info / debug lines; hover one to read it.',
  memory:
    'Green is the JS heap (memory used by JavaScript objects, from the debugger every 2s). Blue is total app memory (from your Mac, simulator only). Each line is scaled to its own range so slow climbs stand out. Red marks are leak warnings.',
};

function threadInfo(name) {
  if (ROW_INFO[name]) return ROW_INFO[name];
  if (name === 'unnamed threads (pool)') return 'Unnamed worker threads from iOS\'s shared thread pool (GCD), merged into one row. Several run at once, so this row can go above 100%. Bursts usually mean background work like decoding, disk I/O or SDK processing.';
  if (/datadog|dd-react|sentry|crashlytics|amplitude|segment|intercom|appsflyer|braze/i.test(name)) return `A background thread owned by an SDK (${shortThreadName(name)}). It costs CPU and battery but does not block the screen directly; steady activity here is SDK overhead.`;
  if (/NSURLSession|CFNetwork|network|socket/i.test(name)) return 'iOS networking. It does the actual network I/O for requests, including native SDK traffic the Network row cannot see.';
  if (/firestore|grpc|firebase/i.test(name)) return 'Firebase / Firestore background work: listeners, syncing and gRPC traffic.';
  return 'A background native thread, shown because it used CPU in this window. The % is CPU time over the last second. Background threads do not freeze the UI directly, but they compete for the same CPU.';
}

const VITAL_INFO = {
  'JS heap': 'Memory used by JavaScript objects in Hermes, read from the debugger every 2 seconds. If it keeps rising after you leave screens, something is being kept alive (a leak).',
  'App memory': 'Total memory of the app process (resident size), read from your Mac every 2 seconds. Includes native memory such as images and SDKs. Simulator only.',
  Threads: 'Number of OS threads in the app. It should stay roughly flat; steady growth means something keeps spawning threads without ending them.',
  'Last reload': 'Time from the JS reload until the first screen started rendering, then until the JS and UI threads went quiet.',
  'Cold launch': 'Time from the app process starting until the first screen started rendering, then until the JS and UI threads went quiet.',
};

const EVENT_INFO = {
  stall: 'The JS thread was busy without a break for at least your freeze threshold. While that happens, taps, scrolling and JS animations do not respond. Hitch pauses the app for an instant during the freeze to read what code is running, so you see the actual function and line.',
  hot: 'A native thread stayed busy (the UI thread at your threshold, or any thread at 90%) for a full second, so Hitch sampled every native thread for 1 second to see which functions were burning the CPU.',
  console: 'A console.warn, console.error or uncaught exception from the app, with the line of your code that logged it. React warnings land here too. Repeats of the same message are grouped even when ids or numbers in it change; the plain console.log lines just before it are listed below.',
  request: 'An XHR request that failed or took longer than your slow-request threshold. Anything waiting on it was stuck that long.',
  startup: 'Timing of a cold launch or JS reload: until the first screen started rendering, then until the app settled (JS and UI threads quiet for 1 second).',
  leak: 'Memory kept climbing for 3 minutes, measured at its lowest point after each garbage collection so normal ups and downs do not count. That pattern usually means something is never released.',
  threadleak: 'The number of OS threads kept climbing for 3 minutes. Something is creating threads and never ending them.',
  jank: 'Frames dropped on the JS thread while React was busy, beyond what individual freezes explain: many small hitches that each stay under the freeze threshold but together make scrolling or animations choppy. Counted by a tiny probe Hitch adds through the debugger.',
  screen: 'How long a screen took to settle after navigating to it: from the screen change until a full second passes without React re-rendering. Includes data loading and every render as results arrive.',
};

const info = text => `<sl-tooltip content="${esc(text)}" hoist><sl-icon name="info-circle" class="info-i"></sl-icon></sl-tooltip>`;
const PINNED = ['Main/UI thread', 'JS thread', 'Hermes GC (hades)'];
const LIVE_MS = 1000;
const HISTORY_MS = 185000;

const state = {
  coverage: [],
  vitals: [],
  requests: [],
  consoleEvents: [],
  logs: [],
  search: '',
  startups: [],
  alerts: [],
  jank: [],
  screens: [],
  run: null,
  range: null,
  drag: null,
  detailCopy: null,
  view: 'timeline',
  servers: [],
  current: null,
  status: null,
  stalls: [],
  hot: [],
  lanes: new Map(),
  windowSec: 30,
  paused: false,
  pausedAt: 0,
  selectedId: null,
  filter: 'all',
  showIdle: false,
  hover: null,
};

function laneColor(name) {
  if (name === 'JS thread') return COLORS.js;
  if (name === 'Main/UI thread') return COLORS.ui;
  if (/hades|Hermes GC/i.test(name)) return COLORS.gc;
  if (/datadog|amplitude|segment|sentry|crashlytics|intercom|appsflyer|dd-react|braze/i.test(name)) return COLORS.sdk;
  if (/firestore|firebase|grpc|network|socket|cfnetwork|nsurl|http/i.test(name)) return COLORS.net;
  return COLORS.other;
}

function shortThreadName(name) {
  return name.replace(/^DispatchQueue_\d+:\s*/, '').replace(/\s+\(serial\)$/, '').replace(/^com\.(apple|google|facebook|datadoghq)\./, '');
}

// ---------------------------------------------------------------- data in

function addLanes(event) {
  for (const [name, busy] of event.lanes) {
    let lane = state.lanes.get(name);
    if (!lane) {
      lane = { name, color: laneColor(name), points: [] };
      state.lanes.set(name, lane);
    }
    lane.points.push([event.at, event.windowMs, Math.min(1, busy / event.windowMs)]);
  }
}

function trimLanes() {
  const cutoff = Date.now() - HISTORY_MS;
  for (const lane of state.lanes.values()) {
    let i = 0;
    while (i < lane.points.length && lane.points[i][0] < cutoff) i++;
    if (i) lane.points.splice(0, i);
  }
}

function connect() {
  const source = new EventSource('/events');
  source.onmessage = message => {
    const event = JSON.parse(message.data);
    if (event.type === 'snapshot') {
      state.stalls = event.stalls;
      state.hot = event.hot;
      state.vitals = event.vitals ?? [];
      state.requests = event.requests ?? [];
      state.consoleEvents = event.console ?? [];
      state.logs = event.logs ?? [];
      state.startups = event.startups ?? [];
      state.alerts = event.alerts ?? [];
      state.jank = event.jank ?? [];
      state.screens = event.screens ?? [];
      state.coverage = event.coverage ?? [];
      renderVitals();
      state.lanes.clear();
      event.lanes.forEach(addLanes);
      setStatus(event.status);
      if (event.servers) setServers(event);
      showList();
      renderEvents();
      const linked = Number(location.hash.match(/event=(\d+)/)?.[1]);
      if (linked && !state.selectedId) select(linked);
    } else if (event.type === 'status') {
      setStatus(event);
    } else if (event.type === 'servers') {
      setServers(event);
    } else if (event.type === 'lanes') {
      addLanes(event);
    } else if (event.type === 'stall') {
      state.stalls.push(event);
      renderEvents();
    } else if (event.type === 'hot') {
      state.hot.push(event);
      renderEvents();
    } else if (event.type === 'coverage') {
      state.coverage.push(event);
    } else if (event.type === 'vitals') {
      state.vitals.push(event);
      if (state.vitals.length > 1800) state.vitals.shift();
      renderVitals();
    } else if (event.type === 'request') {
      state.requests.push(event);
      if (state.requests.length > 1000) state.requests.shift();
      if (event.issue) renderEvents();
    } else if (event.type === 'console') {
      // Repeats of the same message come back with the same id and a higher count.
      const i = state.consoleEvents.findIndex(e => e.id === event.id);
      if (i >= 0) state.consoleEvents[i] = event;
      else state.consoleEvents.push(event);
      renderEvents();
      if (state.selectedId === event.id) renderDetail(event);
    } else if (event.type === 'logs') {
      // Repeats update an entry already shown, which is always near the end.
      for (const entry of event.entries) {
        const i = state.logs.findLastIndex((l, k) => k >= state.logs.length - 50 && l.id === entry.id);
        if (i >= 0) state.logs[i] = entry;
        else state.logs.push(entry);
      }
      if (state.logs.length > 2000) state.logs.splice(0, state.logs.length - 2000);
    } else if (event.type === 'startup') {
      state.startups.push(event);
      renderEvents();
      renderVitals();
    } else if (event.type === 'leak' || event.type === 'threadleak') {
      state.alerts.push(event);
      renderEvents();
    } else if (event.type === 'jank') {
      // A choppy period can grow while it continues: same id, longer span.
      const i = state.jank.findIndex(j => j.id === event.id);
      if (i >= 0) state.jank[i] = event;
      else state.jank.push(event);
      renderEvents();
      if (state.selectedId === event.id) renderDetail(event);
    } else if (event.type === 'screen') {
      state.screens.push(event);
      renderEvents();
    } else if (event.type === 'run') {
      setRun(event.active);
      if (event.finished) showRunResult(event.finished);
      if (state.view === 'runs') viewRenderers.runs();
    } else if (event.type === 'cleared') {
      state.coverage = [];
      state.lanes.clear();
      state.vitals = [];
      renderVitals();
      layoutAt = 0;
      state.stalls = [];
      state.hot = [];
      state.requests = [];
      state.consoleEvents = [];
      state.logs = [];
      state.startups = [];
      state.alerts = [];
      state.jank = [];
      state.screens = [];
      state.selectedId = null;
      lastReact = null;
      networkKey = '';
      heapState.diff = null;
      renderEvents();
      showList();
      // The open view shows the cleared state right away.
      if (state.view !== 'timeline') refreshView(state.view);
    }
  };
  source.onerror = () => setStatus({ ...(state.status ?? {}), state: 'server-down' });
}

const STATE_LABEL = { 'no-server': 'No Metro running', replay: 'Saved session', live: 'Live', connecting: 'Connecting…', 'no-app': 'Waiting for app', disconnected: 'Reconnecting…', 'server-down': 'Hitch stopped' };

function setStatus(status) {
  // Another app took over Metro: its threads are a different process.
  if (state.status?.appId && status.appId && status.appId !== state.status.appId) state.lanes.clear();
  state.status = status;
  $('#conn').dataset.state = status.state;
  $('#conn-state').textContent = STATE_LABEL[status.state] ?? status.state;
  $('#conn-dot').dataset.state = status.state;
  // Like Xcode's scheme › destination: app, then where it runs.
  $('#conn-app').innerHTML = status.appId
    ? `<span class="ta-app">${esc(status.appId)}</span>${status.device ? `<sl-icon name="chevron-right" class="ta-sep"></sl-icon><sl-icon name="${status.physical ? 'phone' : 'phone-landscape'}" class="ta-device-icon"></sl-icon><span class="ta-device">${esc(status.device)}</span>` : ''}`
    : 'No app yet';
  const since = status.startedAt ? new Date(status.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
  $('#tb-detail').textContent = status.screen ? ` · on ${status.screen}` : since && status.state !== 'replay' ? ` · since ${since}` : '';
  const refused = (status.health?.debuggerDrops ?? 0) >= 8 && status.state !== 'live';
  $('#debugger-alert').hidden = !refused;
  $('#debugger-alert').open = refused;
  const mismatch = status.health?.symbols === 'mismatch';
  $('#map-alert').hidden = !mismatch;
  $('#map-alert').open = mismatch;
  renderTargetLabel();
  if (status.settings && !document.activeElement?.closest?.('sl-input')) {
    $('#set-stall').value = status.settings.stallMs;
    $('#set-ui').value = status.settings.uiHot;
    $('#set-thread').value = status.settings.threadHot;
    $('#set-slow').value = status.settings.slowRequestMs ?? 1000;
  }
  // A saved session can't be paused, sampled, recorded or reset.
  $('#topbar').classList.toggle('replay', status.state === 'replay');
  $('#stale-alert').hidden = !status.bundleStale;
  $('#stale-alert').open = Boolean(status.bundleStale);
  const empty = $('#lanes-empty');
  empty.hidden = !(status.state === 'live' && !status.native);
  empty.open = !empty.hidden;
  empty.lastChild.textContent = status.physical
    ? ' Physical device: per-thread lanes need the simulator. The JS lane shows responsiveness, and freezes are captured on the right.'
    : ' Thread lanes need the app running in the iOS simulator. JS freezes are still captured on the right.';
  const phoneNote = $('#phone-note');
  phoneNote.hidden = !status.release;
  phoneNote.open = Boolean(status.release);
  if (status.release) {
    const behind = status.lastDataAt ? Math.round((Date.now() - status.lastDataAt) / 1000) : null;
    phoneNote.querySelector('span').textContent = status.waitingForForeground
      ? 'Waiting for ALPHA to be open on your iPhone. Unlock the phone and open the app; streaming starts automatically (the profiler can only attach to an app that is running in the foreground).'
      : `Streaming from your iPhone (Release build). Apple's profiler records the phone in back-to-back ${status.settings?.chunkSec ?? 20}s chunks and each one is replayed onto the lanes at its real time, so data arrives about ${(status.settings?.chunkSec ?? 20) + 5}s behind${behind != null ? ` (latest data ${behind}s ago)` : ', first chunk on its way'}. Hatched stretches are the few seconds between chunks that couldn't be recorded. JS stacks, console, network and memory aren't available in Release builds.`;
  }
}

// ---------------------------------------------------------------- vitals

function trend(key) {
  const now = state.vitals.at(-1)?.at ?? 0;
  const old = state.vitals.find(v => now - v.at <= 120000 && v[key] != null);
  const last = state.vitals.at(-1)?.[key];
  if (!old || last == null || now - old.at < 30000) return '';
  const diff = last - old[key];
  if (key === 'threads') return diff ? ` (${diff > 0 ? '+' : ''}${diff} in 2m)` : '';
  return Math.abs(diff) >= 5 * MB ? ` (${diff > 0 ? '+' : '−'}${fmtMb(Math.abs(diff))} in 2m)` : '';
}

function renderVitals() {
  const v = state.vitals.at(-1);
  const startup = state.startups.at(-1);
  const chips = [];
  if (v?.heapUsed != null) chips.push(['JS heap', `${fmtMb(v.heapUsed)}${trend('heapUsed')}`]);
  if (v?.rss != null) chips.push(['App memory', `${fmtMb(v.rss)}${trend('rss')}`]);
  if (v?.threads != null) chips.push(['Threads', `${v.threads}${trend('threads')}`]);
  if (startup) {
    const total = startup.toSettleMs ?? startup.toJsMs;
    chips.push([startup.kind === 'reload' ? 'Last reload' : 'Cold launch', total != null ? `${(total / 1000).toFixed(1)}s` : '—']);
  }
  $('#vitals').innerHTML = chips
    .map(([k, val]) => {
      const [value, change] = val.split(' (');
      const delta = change ? `<span class="vd${change.startsWith('+') ? ' up' : ''}">${esc(change.slice(0, -1))}</span>` : '';
      return `<sl-tooltip content="${esc(VITAL_INFO[k] ?? '')}" hoist><span class="vital"><span class="vk">${k}</span><span class="vv">${esc(value)}${delta}</span></span></sl-tooltip>`;
    })
    .join('');
}

// ---------------------------------------------------------------- servers

const basename = p => p?.split('/').filter(Boolean).pop() ?? '';

function renderTargetLabel() {
  const replay = state.status?.state === 'replay';
  const server = state.servers.find(s => s.url === state.current?.metro);
  const phone = state.current?.phone ? (state.phones ?? []).find(p => p.udid === state.current.phone) : null;
  $('#target-project').textContent = replay ? 'Saved session' : phone ? `📱 ${phone.name}` : server ? server.name : state.current ? basename(state.current.project) : 'Looking for Metro…';
}

function setServers({ servers, phones, current }) {
  state.servers = servers;
  state.phones = phones ?? [];
  state.current = current;
  renderTargetLabel();
  const menu = $('#target-list');
  if (state.status?.state === 'replay') {
    menu.innerHTML = '<sl-menu-item disabled>Reviewing a saved session</sl-menu-item>';
    return;
  }
  const phoneHtml = (state.phones ?? []).map(p => {
    const items = p.apps.length
      ? p.apps
          .map(a => `<sl-menu-item type="checkbox" ${current?.phone === p.udid && current?.bundleId === a.bundleId ? 'checked' : ''} data-phone="${esc(p.udid)}" data-bundle="${esc(a.bundleId)}">
            ${esc(a.name)} <span class="menu-port">${esc(a.bundleId)}</span><span slot="suffix" class="menu-port">Release · profiler</span></sl-menu-item>`)
          .join('')
      : '<sl-menu-item disabled><span style="color:var(--sl-color-neutral-500)">No self-signed builds installed (TestFlight/App Store builds can\'t be profiled)</span></sl-menu-item>';
    return `<sl-divider></sl-divider><sl-menu-label>📱 ${esc(p.name)} <span class="menu-port">USB</span></sl-menu-label>${items}`;
  });
  if (!servers.length && !phoneHtml.length) {
    menu.innerHTML = '<sl-menu-item disabled>No Metro dev servers or phones found. Start one with yarn start, or plug in your iPhone.</sl-menu-item>';
    return;
  }
  const html = servers.map((server, i) => {
    const watchingServer = current?.metro === server.url;
    const items = server.apps.length
      ? server.apps
          .map(app => {
            const on = watchingServer && (current.app ? current.app === app.appId && (!current.device || current.device === app.device) : state.status?.appId === app.appId && state.status?.device === app.device);
            return `<sl-menu-item type="checkbox" ${on ? 'checked' : ''} data-metro="${esc(server.url)}" data-app="${esc(app.appId)}" data-device="${esc(app.device ?? '')}">
              ${esc(app.appId)}<span slot="suffix" class="menu-port">${esc(app.device ?? '')}</span></sl-menu-item>`;
          })
          .join('')
      : `<sl-menu-item type="checkbox" ${watchingServer ? 'checked' : ''} data-metro="${esc(server.url)}">
          <span style="color:var(--sl-color-neutral-500)">No app connected yet</span></sl-menu-item>`;
    return `${i ? '<sl-divider></sl-divider>' : ''}
      <sl-menu-label>${esc(server.name)} <span class="menu-port">:${server.port}</span></sl-menu-label>
      <span class="menu-path" title="${esc(server.project)}">${esc(server.project)}</span>
      ${items}`;
  });
  menu.innerHTML = html.join('') + phoneHtml.join('');
}

$('#target-list').addEventListener('sl-select', async e => {
  const { metro, app, device, phone, bundle } = e.detail.item.dataset;
  if (!metro && !phone) return;
  $('#target-menu').hide();
  const res = await post('/api/attach', phone ? { phone, bundleId: bundle } : { metro, app: app || null, device: device || null });
  if (res.error) toast(`Couldn't switch: ${res.error}`, 'danger');
  else toast(phone ? `Sampling ${bundle} on your phone every 30s` : `Watching ${app || basename(state.servers.find(s => s.url === metro)?.project)}`, 'success');
});

// ---------------------------------------------------------------- lanes

const canvas = $('#lanes');
const ctx = canvas.getContext('2d');
const LABEL_W = 210;
// Time labels on top, then a strip naming the screen the app was on.
const AXIS_H = 46;
const TIME_Y = 11;
const SCREEN_Y = 31;
const BIG_ROW = 50;
const ROW = 26;
const IDLE_ROW = 26;
const NET_ROW = 40;
const CONSOLE_ROW = 26;
const MEM_ROW = 58;
const NET_TRACKS = 3;
const MB = 1024 * 1024;
const fmtMb = bytes => (bytes == null ? '—' : bytes >= 1024 * MB ? `${(bytes / 1024 / MB).toFixed(2)} GB` : `${Math.round(bytes / MB)} MB`);
const shortUrl = url => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
};
let layout = { rows: [], height: 0, idleCount: 0 };
let layoutAt = 0;

function viewRange() {
  const replayEnd = state.status?.state === 'replay' ? Math.max(0, ...[...state.stalls, ...state.hot].map(e => e.at + 2000)) : 0;
  // Phone data lands a chunk late; end the timeline at the newest recorded moment.
  const phoneEnd = state.status?.release && state.status.lastDataAt ? state.status.lastDataAt : 0;
  const end = replayEnd || (state.paused ? state.pausedAt : phoneEnd || Date.now());
  return [end - state.windowSec * 1000, end];
}

function busyBetween(lane, from, to) {
  let busy = 0;
  let span = 0;
  for (let i = lane.points.length - 1; i >= 0; i--) {
    const [at, windowMs, pct] = lane.points[i];
    if (at < from) break;
    if (at - windowMs > to) continue;
    busy += pct * windowMs;
    span += windowMs;
  }
  return span ? busy / span : 0;
}

function computeLayout() {
  const [from, to] = viewRange();
  const lanes = [...state.lanes.values()];
  const pinned = PINNED.map(name => state.lanes.get(name)).filter(Boolean);
  // Two GC threads share a name upstream; keep the pinned order stable.
  const rest = lanes
    .filter(l => !PINNED.includes(l.name))
    .map(l => ({ lane: l, busy: busyBetween(l, from, to) }))
    .sort((a, b) => b.busy - a.busy);
  const active = rest.filter(r => r.busy >= 0.004).map(r => r.lane);
  const idle = rest.filter(r => r.busy < 0.004).map(r => r.lane);
  const rows = [];
  let y = AXIS_H;
  for (const lane of pinned) {
    const h = lane.name === 'Hermes GC (hades)' ? ROW : BIG_ROW;
    rows.push({ lane, y, h });
    y += h;
  }
  // Release builds on a phone report none of these; don't show empty rows.
  const specials = state.status?.release ? [] : [['network', NET_ROW], ['console', CONSOLE_ROW], ['memory', MEM_ROW]];
  for (const [special, h] of specials) {
    rows.push({ special, y, h });
    y += h;
  }
  for (const lane of active) {
    rows.push({ lane, y, h: ROW });
    y += ROW;
  }
  if (idle.length) {
    rows.push({ idleToggle: true, y, h: IDLE_ROW, count: idle.length });
    y += IDLE_ROW;
    if (state.showIdle) {
      for (const lane of idle) {
        rows.push({ lane, y, h: ROW, idle: true });
        y += ROW;
      }
    }
  }
  layout = { rows, height: y + 12, idleCount: idle.length };
  $('#thread-count').textContent = `${active.length + pinned.length} active / ${state.lanes.size}`;
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.parentElement.clientWidth;
  const height = Math.max(layout.height, canvas.parentElement.clientHeight);
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.height = `${height}px`;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width, height };
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function draw() {
  if (performance.now() - layoutAt > 500) {
    computeLayout();
    layoutAt = performance.now();
  }
  const { width, height } = resizeCanvas();
  const [from, to] = viewRange();
  const trackX = LABEL_W;
  const trackW = width - LABEL_W - 14;
  const xOf = t => trackX + ((t - from) / (to - from)) * trackW;

  ctx.clearRect(0, 0, width, height);

  // axis
  ctx.font = `500 10.5px ${FONT_MONO}`;
  ctx.textBaseline = 'middle';
  const step = state.windowSec <= 15 ? 2 : state.windowSec <= 30 ? 5 : state.windowSec <= 60 ? 10 : 30;
  for (let s = 0; s <= state.windowSec; s += step) {
    const x = xOf(to - s * 1000);
    ctx.fillStyle = INK.grid;
    ctx.fillRect(Math.round(x), AXIS_H, 1, height - AXIS_H);
    ctx.fillStyle = INK.muted;
    ctx.textAlign = s === 0 ? 'right' : 'center';
    ctx.fillText(s === 0 ? (state.paused ? 'paused' : state.status?.release ? 'latest' : 'now') : `-${s}s`, x, TIME_Y);
  }

  // Phone streaming records in chunks; mark what wasn't recorded so a gap
  // never reads as an idle app.
  if (state.status?.release) {
    const covered = state.coverage.filter(c => c.to >= from && c.from <= to).sort((x, y) => x.from - y.from);
    let cursor = from;
    const gaps = [];
    for (const c of covered) {
      if (c.from > cursor) gaps.push([cursor, c.from]);
      cursor = Math.max(cursor, c.to);
    }
    if (cursor < to) gaps.push([cursor, to]);
    ctx.save();
    for (const [g0, g1] of gaps) {
      const x0 = Math.max(trackX, xOf(g0));
      const x1 = Math.min(trackX + trackW, xOf(g1));
      if (x1 - x0 < 1) continue;
      ctx.fillStyle = INK.track;
      ctx.globalAlpha = 0.7;
      ctx.fillRect(x0, AXIS_H, x1 - x0, layout.height - AXIS_H);
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = INK.muted;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = x0 - (layout.height - AXIS_H); x < x1; x += 8) {
        ctx.moveTo(Math.max(x, x0), AXIS_H + Math.max(0, x0 - x));
        ctx.lineTo(Math.min(x + (layout.height - AXIS_H), x1), AXIS_H + Math.min(layout.height - AXIS_H, x1 - x));
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // hot-burst bands (behind lanes)
  for (const hot of state.hot) {
    const end = hot.until ?? hot.at + 1000;
    if (end < from || hot.at > to) continue;
    const x0 = Math.max(trackX, xOf(hot.at));
    const x1 = Math.min(trackX + trackW, xOf(end));
    const selected = hot.id === state.selectedId;
    ctx.fillStyle = COLORS.hot;
    ctx.globalAlpha = selected ? 0.16 : 0.07;
    ctx.fillRect(x0, AXIS_H, x1 - x0, layout.height - AXIS_H);
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'transparent';
    ctx.fillRect(x0, AXIS_H, x1 - x0, layout.height - AXIS_H);
    ctx.fillStyle = COLORS.hot;
    for (let x = x0; x < x1; x += 4) ctx.fillRect(x, AXIS_H - 6, 2, 4);
  }

  // rows
  for (const row of layout.rows) {
    if (row.special) {
      drawSpecialRow(row, { from, to, trackX, trackW, xOf });
      continue;
    }
    if (row.idleToggle) {
      ctx.fillStyle = INK.muted;
      ctx.font = `500 11.5px ${FONT_SANS}`;
      ctx.textAlign = 'left';
      ctx.fillText(`${state.showIdle ? '▾' : '▸'}  ${row.count} idle thread${row.count === 1 ? '' : 's'}`, 16, row.y + row.h / 2);
      ctx.fillStyle = INK.rule;
      ctx.fillRect(trackX, row.y + row.h / 2, trackW, 1);
      continue;
    }
    const { lane, y, h } = row;
    const live = busyBetween(lane, to - LIVE_MS, to);
    const big = h === BIG_ROW;

    // label
    ctx.fillStyle = lane.color;
    roundRect(14, y + h / 2 - 4, 8, 8, 2);
    ctx.fill();
    ctx.fillStyle = row.idle ? INK.muted : big ? INK.text : INK.label;
    ctx.font = `${big ? 600 : 500} ${big ? 12.5 : 11.5}px ${FONT_SANS}`;
    ctx.textAlign = 'left';
    const label = shortThreadName(lane.name);
    const maxLabel = LABEL_W - 76;
    let text = label;
    while (ctx.measureText(text).width > maxLabel && text.length > 4) text = text.slice(0, -2);
    const shown = text === label ? text : `${text}…`;
    ctx.fillText(shown, 30, y + h / 2);
    if (big || state.hover?.y >= y && state.hover?.y < y + h) infoGlyph(30 + ctx.measureText(shown).width + 6, y + h / 2);
    ctx.font = `500 11px ${FONT_MONO}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = live > 0.6 ? COLORS.severe : live > 0.25 ? COLORS.stall : INK.muted;
    ctx.fillText(`${Math.round(live * 100)}%`, LABEL_W - 12, y + h / 2);

    // track
    ctx.fillStyle = INK.track;
    ctx.fillRect(trackX, y + 2, trackW, h - 4);
    const base = y + h - 3;
    const amp = h - 7;
    ctx.fillStyle = lane.color;
    for (const [at, windowMs, pct] of lane.points) {
      if (at < from || at - windowMs > to || pct <= 0) continue;
      const x0 = xOf(at - windowMs);
      const x1 = xOf(at);
      const barH = Math.max(1, pct * amp);
      ctx.globalAlpha = 0.35 + pct * 0.65;
      ctx.fillRect(x0, base - barH, Math.max(1, x1 - x0 - 0.5), barH);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = INK.rule;
    ctx.fillRect(trackX, y + h - 1, trackW, 1);
  }

  // stall markers on the JS lane, with a guide through every lane
  const jsRow = layout.rows.find(r => r.lane?.name === 'JS thread');
  let labelEnd = -Infinity;
  for (const stall of [...state.stalls].sort((a, b) => a.at - b.at)) {
    const end = stall.at + stall.ms;
    if (end < from || stall.at > to) continue;
    const x0 = xOf(stall.at);
    const x1 = Math.max(x0 + 3, xOf(end));
    const color = stall.ms >= SEVERE_MS ? COLORS.severe : COLORS.stall;
    const selected = stall.id === state.selectedId;
    ctx.fillStyle = color;
    ctx.globalAlpha = selected ? 0.12 : 0.04;
    ctx.fillRect(x0, AXIS_H, x1 - x0, layout.height - AXIS_H);
    ctx.globalAlpha = 1;
    ctx.fillRect(x0, AXIS_H - 6, x1 - x0, 4);
    if (jsRow) {
      ctx.strokeStyle = color;
      ctx.lineWidth = selected ? 2 : 1.25;
      ctx.fillStyle = color;
      roundRect(x0, jsRow.y + 3, x1 - x0, jsRow.h - 6, 3);
      ctx.globalAlpha = 0.18;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.stroke();
      // Skip a label that would collide with the previous one; hover still shows it.
      ctx.font = `600 10.5px ${FONT_MONO}`;
      const text = `${stall.ms}ms`;
      if (x1 + 4 > labelEnd + 6) {
        ctx.textAlign = 'left';
        ctx.fillStyle = color;
        ctx.fillText(text, x1 + 4, jsRow.y + 11);
        labelEnd = x1 + 4 + ctx.measureText(text).width;
      }
    }
  }

  drawScreens({ from, to, trackX, trackW, xOf });

  // A selected range (being dragged, or open on the right).
  const sel = state.drag ?? state.range;
  if (sel) {
    const x0 = Math.max(trackX, xOf(sel.from));
    const x1 = Math.min(trackX + trackW, xOf(sel.to));
    if (x1 > x0) {
      ctx.fillStyle = COLORS.ui;
      ctx.globalAlpha = 0.12;
      ctx.fillRect(x0, AXIS_H, x1 - x0, layout.height - AXIS_H);
      ctx.globalAlpha = 0.9;
      ctx.fillRect(x0, AXIS_H, 1.5, layout.height - AXIS_H);
      ctx.fillRect(x1 - 1.5, AXIS_H, 1.5, layout.height - AXIS_H);
      ctx.globalAlpha = 1;
      const label = `${((sel.to - sel.from) / 1000).toFixed(1)}s`;
      ctx.font = `600 10.5px ${FONT_SANS}`;
      ctx.textAlign = 'center';
      pill(label, (x0 + x1) / 2, SCREEN_Y, COLORS.ui, '#fff');
    }
  }

  // hover crosshair, with the time it points at
  if (state.hover && state.hover.x > trackX && !state.drag) {
    const x = Math.round(state.hover.x);
    ctx.fillStyle = INK.muted;
    ctx.fillRect(x, AXIS_H, 1, layout.height - AXIS_H);
    const t = from + ((x - trackX) / trackW) * (to - from);
    ctx.font = `600 10.5px ${FONT_SANS}`;
    ctx.textAlign = 'center';
    pill(clock(t), Math.min(Math.max(x, trackX + 30), trackX + trackW - 30), TIME_Y, '#48484a', '#fff');
  }

  requestAnimationFrame(draw);
}

// A small rounded label centered on x (font and alignment set by the caller).
function pill(text, x, cy, fill, color) {
  const w = ctx.measureText(text).width + 12;
  ctx.fillStyle = fill;
  roundRect(x - w / 2, cy - 8, w, 16, 8);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(text, x, cy + 0.5);
}

// Which screen the app was on: a label where each screen began, and a faint
// line down through the lanes so freezes can be read against it.
function drawScreens({ from, to, trackX, trackW, xOf }) {
  const changes = [...state.screens].sort((a, b) => a.at - b.at);
  const before = changes.filter(sc => sc.at < from).at(-1);
  const inView = changes.filter(sc => sc.at >= from && sc.at <= to);
  ctx.font = `500 10.5px ${FONT_SANS}`;
  ctx.textAlign = 'left';
  let labelEnd = -Infinity;
  const label = (name, x) => {
    const text = name;
    const w = ctx.measureText(text).width + 14;
    if (x < labelEnd + 6 || x + w > trackX + trackW) return;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    roundRect(x, SCREEN_Y - 8, w, 16, 5);
    ctx.fill();
    ctx.fillStyle = INK.label;
    ctx.fillText(text, x + 7, SCREEN_Y + 0.5);
    labelEnd = x + w;
  };
  const current = before?.name ?? (inView.length ? null : state.status?.screen);
  if (current) label(current, trackX + 2);
  for (const sc of inView) {
    const x = xOf(sc.at);
    ctx.fillStyle = INK.muted;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(Math.round(x), SCREEN_Y + 8, 1, layout.height - SCREEN_Y - 8);
    ctx.globalAlpha = 1;
    label(sc.name, x + 3);
  }
}

function infoGlyph(x, cy) {
  ctx.strokeStyle = INK.muted;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x + 5, cy, 5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = INK.muted;
  ctx.font = `600 8px ${FONT_SANS}`;
  ctx.textAlign = 'center';
  ctx.fillText('i', x + 5, cy + 0.5);
}

function rowLabel(row, title, value, color) {
  ctx.fillStyle = color;
  roundRect(14, row.y + row.h / 2 - 4, 8, 8, 2);
  ctx.fill();
  ctx.fillStyle = INK.text;
  ctx.font = `600 12px ${FONT_SANS}`;
  ctx.textAlign = 'left';
  ctx.fillText(title, 30, row.y + row.h / 2);
  infoGlyph(30 + ctx.measureText(title).width + 6, row.y + row.h / 2);
  if (value) {
    ctx.font = `500 10.5px ${FONT_MONO}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = INK.muted;
    ctx.fillText(value, LABEL_W - 12, row.y + row.h / 2);
  }
}

function requestColor(r) {
  if (r.failed) return COLORS.severe;
  if (r.ms >= (state.status?.settings?.slowRequestMs ?? 1000)) return COLORS.stall;
  return COLORS.net;
}

function drawSpecialRow(row, { from, to, trackX, trackW, xOf }) {
  const { y, h } = row;
  ctx.fillStyle = INK.track;
  ctx.fillRect(trackX, y + 2, trackW, h - 4);
  if (row.special === 'network') {
    const visible = state.requests.filter(r => r.at + r.ms >= from && r.at <= to);
    rowLabel(row, 'Network', `${visible.length} req`, COLORS.net);
    const trackH = (h - 8) / NET_TRACKS;
    const ends = new Array(NET_TRACKS).fill(-Infinity);
    for (const r of [...visible].sort((a, b) => a.at - b.at)) {
      // First free sub-track, so overlapping requests stack instead of hiding.
      let track = ends.findIndex(end => end < r.at);
      if (track < 0) track = ends.indexOf(Math.min(...ends));
      ends[track] = r.at + r.ms;
      const x0 = Math.max(trackX, xOf(r.at));
      const x1 = Math.min(trackX + trackW, Math.max(x0 + 2, xOf(r.at + r.ms)));
      ctx.fillStyle = requestColor(r);
      ctx.globalAlpha = r.id === state.selectedId ? 1 : 0.75;
      roundRect(x0, y + 4 + track * trackH, x1 - x0, trackH - 2, 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  } else if (row.special === 'console') {
    const visible = state.consoleEvents.filter(c => c.at >= from && c.at <= to);
    rowLabel(row, 'Console', `${visible.length}`, COLORS.stall);
    // Plain logs: faint ticks along the bottom, under the warnings and errors.
    ctx.fillStyle = INK.muted;
    ctx.globalAlpha = 0.55;
    for (const l of state.logs) {
      if (l.lastAt < from || l.at > to) continue;
      ctx.fillRect(Math.round(xOf(l.at)), y + h - 9, 1.5, 5);
    }
    ctx.globalAlpha = 1;
    for (const c of visible) {
      const x = xOf(c.at);
      ctx.fillStyle = c.level === 'error' ? COLORS.severe : COLORS.stall;
      ctx.globalAlpha = c.id === state.selectedId ? 1 : 0.85;
      ctx.beginPath();
      ctx.moveTo(x, y + 5);
      ctx.lineTo(x + 5, y + h - 6);
      ctx.lineTo(x - 5, y + h - 6);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  } else if (row.special === 'memory') {
    const points = state.vitals.filter(v => v.at >= from - 4000 && v.at <= to);
    // Lines start a sample before the window; keep them inside the track.
    ctx.save();
    ctx.beginPath();
    ctx.rect(trackX, y, trackW, h);
    ctx.clip();
    const series = [
      ['heapUsed', COLORS.js],
      ['rss', COLORS.ui],
    ];
    for (const [key, color] of series) {
      const values = points.map(p => p[key]).filter(v => v != null);
      if (values.length < 2) continue;
      // Each line scales to its own range so a slow climb is visible.
      const min = Math.min(...values);
      const max = Math.max(...values);
      const span = Math.max(max - min, 4 * MB);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (const p of points) {
        if (p[key] == null) continue;
        const px = xOf(p.at);
        const py = y + h - 5 - ((p[key] - min) / span) * (h - 12);
        if (started) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
        started = true;
      }
      ctx.stroke();
    }
    for (const leak of state.alerts) {
      if (leak.at < from || leak.at > to) continue;
      ctx.fillStyle = COLORS.severe;
      ctx.fillRect(xOf(leak.at) - 1, y + 3, 2, h - 6);
    }
    ctx.restore();
    // Label drawn after the clip so the column stays clean.
    const last = state.vitals.at(-1);
    rowLabel(row, 'Memory', last ? fmtMb(last.heapUsed) : '', COLORS.js);
  }
  ctx.fillStyle = INK.rule;
  ctx.fillRect(trackX, y + h - 1, trackW, 1);
}

function hitTest(x, y) {
  const width = canvas.clientWidth;
  const [from, to] = viewRange();
  const trackW = width - LABEL_W - 14;
  const t = from + ((x - LABEL_W) / trackW) * (to - from);
  const row = layout.rows.find(r => y >= r.y && y < r.y + r.h) ?? null;
  const pad = ((to - from) / trackW) * 4;
  let item = null;
  if (x > LABEL_W && row?.special === 'network') {
    item = state.requests.filter(r => t >= r.at - pad && t <= r.at + r.ms + pad).sort((a, b) => b.ms - a.ms)[0] ?? null;
  } else if (x > LABEL_W && row?.special === 'console') {
    item = state.consoleEvents.filter(c => Math.abs(c.at - t) <= pad * 2).sort((a, b) => Math.abs(a.at - t) - Math.abs(b.at - t))[0] ?? null;
  } else if (x > LABEL_W && row?.special === 'memory') {
    item = state.alerts.find(a => Math.abs(a.at - t) <= pad * 2) ?? null;
  }
  const stall = !item && x > LABEL_W ? state.stalls.find(s => t >= s.at - pad && t <= s.at + s.ms + pad) : null;
  const hot = !item && !stall && x > LABEL_W ? state.hot.find(h => t >= h.at && t <= (h.until ?? h.at + 1000)) : null;
  return { t, row, stall, hot, item };
}

// Drag across the lanes to select a range; it pauses the lanes and opens a
// page for that slice. A plain click still opens what's under the pointer.
let dragStart = null;
let suppressClick = false;
const timeAtX = x => {
  const [from, to] = viewRange();
  return from + ((x - LABEL_W) / (canvas.clientWidth - LABEL_W - 14)) * (to - from);
};
canvas.addEventListener('mousedown', e => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  if (e.button !== 0 || x <= LABEL_W) return;
  dragStart = { x, t: timeAtX(x) };
});
window.addEventListener('mousemove', e => {
  if (!dragStart) return;
  const x = e.clientX - canvas.getBoundingClientRect().left;
  if (!state.drag && Math.abs(x - dragStart.x) < 5) return;
  if (!state.drag && !state.paused) togglePause();
  const t = timeAtX(Math.max(LABEL_W, Math.min(x, canvas.clientWidth - 14)));
  state.drag = { from: Math.min(dragStart.t, t), to: Math.max(dragStart.t, t) };
});
window.addEventListener('mouseup', () => {
  if (state.drag && state.drag.to - state.drag.from > 100) {
    const range = state.drag;
    suppressClick = true;
    showRange(range.from, range.to);
  }
  state.drag = null;
  dragStart = null;
});

canvas.addEventListener('mousemove', e => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  state.hover = { x, y };
  const { t, row, stall, hot, item } = hitTest(x, y);
  const tip = $('#hover-tip');
  canvas.style.cursor = item || stall || hot || row?.idleToggle ? 'pointer' : 'crosshair';
  if (x < LABEL_W && (row?.lane || row?.special)) {
    const name = row.lane ? shortThreadName(row.lane.name) : row.special[0].toUpperCase() + row.special.slice(1);
    tip.innerHTML = `<div class="tip-name">${esc(name)}</div><div class="tip-info">${esc(row.lane ? threadInfo(row.lane.name) : ROW_INFO[row.special])}</div>`;
    tip.hidden = false;
    tip.style.left = `${x + 14}px`;
    tip.style.top = `${y + 14}px`;
    canvas.style.cursor = 'help';
    return;
  }
  if (x < LABEL_W || (!row?.lane && !row?.special && !stall && !hot)) {
    tip.hidden = true;
    return;
  }
  const parts = [];
  if (row?.special === 'memory') {
    const v = state.vitals.reduce((best, p) => (!best || Math.abs(p.at - t) < Math.abs(best.at - t) ? p : best), null);
    if (v) parts.push(`<div class="tip-name">Memory</div><div class="tip-val">JS heap ${fmtMb(v.heapUsed)} · app ${fmtMb(v.rss)}${v.threads ? ` · ${v.threads} threads` : ''}</div>`);
  }
  if (item?.type === 'request') parts.push(`<div class="tip-name">${esc(item.method)} ${esc(shortUrl(item.url))}</div><div class="tip-val">${item.ms}ms · ${item.failed ? (item.status ?? 'failed') : item.status}</div>`);
  if (item?.type === 'console') parts.push(`<div class="tip-name">console.${item.level}${item.count > 1 ? ` ×${item.count}` : ''}</div><div class="tip-val">${esc(item.text.slice(0, 120))}</div>`);
  if (row?.special === 'console' && !item) {
    const [from, to] = viewRange();
    const pad = ((to - from) / (canvas.clientWidth - LABEL_W - 14)) * 4;
    const near = state.logs.filter(l => Math.abs(l.at - t) <= pad).slice(-4);
    for (const l of near) parts.push(`<div class="tip-name">console.${l.level}${l.count > 1 ? ` ×${l.count}` : ''} · ${clock(l.at)}</div><div class="tip-val">${esc(l.text.split('\n')[0].slice(0, 120))}</div>`);
  }
  if (item?.type === 'leak' || item?.type === 'threadleak') parts.push(`<div class="tip-hint" style="color:var(--freeze-severe)">● ${esc(leakTitle(item))}</div>`);
  if (row?.special === 'network' && !item) parts.push('<div class="tip-name">Network</div><div class="tip-val">XHR-based requests (axios etc). Expo fetch isn\'t reported by the app.</div>');
  if (row?.lane) {
    const pct = busyBetween(row.lane, t - 120, t + 120);
    parts.push(`<div class="tip-name">${esc(shortThreadName(row.lane.name))}</div><div class="tip-val">${Math.round(pct * 100)}% busy · ${((Date.now() - t) / 1000).toFixed(1)}s ago</div>`);
  }
  if (stall) parts.push(`<div class="tip-hint" style="color:var(--freeze)">● ${stall.ms}ms JS freeze${stall.culprits[0] ? ` — ${esc(displayName(stall.culprits[0]))}` : ''} · click to inspect</div>`);
  if (hot) parts.push(`<div class="tip-hint" style="color:var(--sampled)">● ${esc(hot.trigger)} · click to inspect</div>`);
  tip.innerHTML = parts.join('');
  tip.hidden = false;
  const wrap = canvas.parentElement;
  tip.style.left = `${Math.min(x + 14, wrap.clientWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${y + 14}px`;
});

canvas.addEventListener('mouseleave', () => {
  state.hover = null;
  $('#hover-tip').hidden = true;
});

canvas.addEventListener('click', e => {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const { row, stall, hot, item } = hitTest(e.clientX - rect.left, e.clientY - rect.top);
  if (row?.idleToggle) {
    state.showIdle = !state.showIdle;
    layoutAt = 0;
    return;
  }
  const event = item ?? stall ?? hot;
  if (event) select(event.id);
});

// ---------------------------------------------------------------- events list

const FILTERS = {
  all: () => true,
  stall: e => e.type === 'stall',
  hot: e => e.type === 'hot',
  console: e => e.type === 'console',
  'console-error': e => e.type === 'console' && e.level === 'error',
  'console-warn': e => e.type === 'console' && e.level === 'warn',
  request: e => e.type === 'request',
  startup: e => e.type === 'startup',
  leak: e => e.type === 'leak' || e.type === 'threadleak',
  jank: e => e.type === 'jank',
  screen: e => e.type === 'screen',
  'no-dev': e => !(e.type === 'stall' && e.devOnly),
};

// Everything a search can match on: messages, URLs, function names and files.
const searchText = e =>
  [e.text, e.lastText, e.method, e.url, e.trigger, e.kind, e.screen, e.name, e.source?.file, e.source?.name, ...(e.culprits ?? []).flatMap(c => [c.name, c.file]), ...(e.react?.components ?? []).map(c => c.name), ...(e.renders?.components ?? []).map(c => c.name), ...(e.actions ?? []).map(a => a.type), ...(e.threads ?? []).map(t => t.label)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

function capturedEvents() {
  return [...state.stalls, ...state.hot, ...state.consoleEvents, ...state.requests.filter(r => r.issue), ...state.startups, ...state.alerts, ...state.jank, ...state.screens].sort((a, b) => b.at - a.at);
}

function allEvents() {
  const terms = state.search.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = FILTERS[state.filter] ?? FILTERS.all;
  return capturedEvents().filter(e => matches(e) && (!terms.length || terms.every(term => searchText(e).includes(term))));
}

const findEvent = id => [state.stalls, state.hot, state.consoleEvents, state.requests, state.startups, state.alerts, state.jank, state.screens].flat().find(e => e.id === id);

const leakTitle = a =>
  a.type === 'threadleak'
    ? `Threads piling up: ${a.from} → ${a.to}`
    : a.kind === 'reload'
      ? 'App memory not freed by a JS reload'
      : `${a.kind === 'heap' ? 'JS heap' : 'App memory'} climbing ${a.mbPerMin} MB/min`;

// Anonymous callbacks read better as "callback in <enclosing function>".
const displayName = c => (c.owner && /^(anonymous|\(anonymous\))?$/.test(c.name) ? `${c.owner} › callback` : c.name);

function eventText(event) {
  const c = event.culprits[0];
  if (event.devOnly) return { title: `${event.devOnly} (dev-only)`, where: c?.file ? `from ${c.file}:${c.line}` : 'dev tooling' };
  if (event.react || event.renders?.renderMs >= event.ms * 0.3) {
    const names = (event.renders?.components.length ? event.renders.components : event.react?.components ?? []).slice(0, 3).map(x => x.name);
    const avoidable = event.renders?.avoidable ? ` · ${event.renders.avoidable} avoidable re-renders` : '';
    return { title: `React ${event.react?.phase ?? 'render'}${names.length ? ` · ${names.join(', ')}` : ''}`, where: `${event.react?.trigger ?? 'synchronous React work'}${avoidable}` };
  }
  return culpritText(c);
}

function culpritText(c) {
  if (!c) return { title: 'JS freeze (no stack)', where: 'ended before a stack could be captured' };
  // Time spent inside a library: name the library, then the app line that called it.
  if (c.hot?.kind === 'lib' && c.kind === 'app') return { title: `${c.hot.pkg} › ${c.hot.name}`, where: `from ${c.file}:${c.line}` };
  if (c.file) return { title: displayName(c), where: `${c.file}:${c.line}` };
  if (c.file) return { title: c.name, where: `${c.file}:${c.line}` };
  return { title: c.name, where: c.kind === 'native' ? 'native / Hermes builtin' : c.where ?? c.kind };
}

// Freezes that came back to back (a screen load, a scroll) share a burst id.
const burstSize = stall => (stall.burst == null ? 1 : state.stalls.filter(s => s.burst === stall.burst).length);

function renderEvents() {
  const list = $('#events');
  const events = allEvents();
  $('#event-count').textContent = events.length;
  const total = capturedEvents().length;
  $('#issue-count').hidden = total === 0;
  $('#issue-count span').textContent = total;
  const filtered = state.filter !== 'all' || state.search.trim();
  $('#events-empty').hidden = events.length > 0 || filtered;
  $('#events-nomatch').hidden = events.length > 0 || !filtered;
  list.replaceChildren(
    ...events.map(event => {
      const item = el('button', 'event');
      item.type = 'button';
      if (event.id === state.selectedId) item.classList.add('selected');
      if (event.type === 'stall') {
        const severe = event.ms >= SEVERE_MS;
        if (severe) item.classList.add('severe');
        if (!event.culprits.length) item.classList.add('uncaught');
        const { title, where } = eventText(event);
        item.innerHTML = `<sl-icon class="icon" name="${severe ? 'exclamation-octagon-fill' : 'exclamation-triangle-fill'}"></sl-icon>
          <span class="title">${esc(title)}</span>
          <span class="meta"><sl-badge variant="${severe ? 'danger' : 'warning'}" pill>${event.ms}ms</sl-badge><span>${ago(event.at)}</span></span>
          <span class="where">${event.devOnly ? `<sl-badge variant="neutral" class="dev-badge">dev-only</sl-badge> ` : ''}${esc(where)}${burstSize(event) > 1 ? ` · burst of ${burstSize(event)}` : ''}${event.screen ? ` · ${esc(event.screen)}` : ''}</span>`;
      } else if (event.type === 'console') {
        const error = event.level === 'error';
        item.classList.add(error ? 'severe' : 'warn');
        const where = event.source?.file ? `${event.source.file}:${event.source.line}` : 'no app frame on the stack';
        item.innerHTML = `<sl-icon class="icon" name="${error ? 'x-circle-fill' : 'exclamation-circle-fill'}"></sl-icon>
          <span class="title">${esc(event.text.split('\n')[0].slice(0, 140))}</span>
          <span class="meta"><sl-badge variant="${error ? 'danger' : 'warning'}" pill>${event.exception ? 'exception' : error ? 'error' : 'warn'}${event.count > 1 ? ` ×${event.count}` : ''}</sl-badge><span>${ago(event.lastAt ?? event.at)}</span></span>
          <span class="where">${esc(where)}</span>`;
      } else if (event.type === 'request') {
        item.classList.add(event.failed ? 'severe' : 'warn', 'net');
        item.innerHTML = `<sl-icon class="icon" name="${event.failed ? 'wifi-off' : 'hourglass-split'}"></sl-icon>
          <span class="title">${esc(event.method)} ${esc(shortUrl(event.url))}</span>
          <span class="meta"><sl-badge variant="${event.failed ? 'danger' : 'warning'}" pill>${event.failed ? (event.status ?? 'failed') : `${(event.ms / 1000).toFixed(1)}s`}</sl-badge><span>${ago(event.at)}</span></span>
          <span class="where">${esc(event.failed ? `${event.error ?? `HTTP ${event.status}`} · ${event.ms}ms` : `slow request · HTTP ${event.status ?? '?'}`)}${event.source?.file ? ` · ${esc(event.source.file)}:${event.source.line}` : ''}</span>`;
      } else if (event.type === 'startup') {
        item.classList.add('startup');
        const total = event.toSettleMs ?? event.toJsMs;
        item.innerHTML = `<sl-icon class="icon" name="rocket-takeoff"></sl-icon>
          <span class="title">${event.kind === 'reload' ? 'App reload' : 'Cold launch'}</span>
          <span class="meta"><sl-badge variant="primary" pill>${total != null ? `${(total / 1000).toFixed(1)}s` : '—'}</sl-badge><span>${ago(event.at)}</span></span>
          <span class="where">${event.toJsMs != null ? `JS started ${(event.toJsMs / 1000).toFixed(1)}s` : 'JS start not seen'} · ${event.settled ? `settled ${(event.toSettleMs / 1000).toFixed(1)}s` : 'never settled within 30s'}</span>`;
      } else if (event.type === 'leak' || event.type === 'threadleak') {
        item.classList.add('severe');
        item.innerHTML = `<sl-icon class="icon" name="${event.type === 'threadleak' ? 'diagram-3' : 'graph-up-arrow'}"></sl-icon>
          <span class="title">${esc(leakTitle(event))}</span>
          <span class="meta"><sl-badge variant="danger" pill>${event.type === 'threadleak' ? `+${event.to - event.from}` : `+${fmtMb(event.to - event.from)}`}</sl-badge><span>${ago(event.at)}</span></span>
          <span class="where">${esc(event.type === 'threadleak' ? (event.grew.map(g => `${shortThreadName(g.name)} +${g.added}`).join(', ') || 'unnamed threads') : `${fmtMb(event.from)} → ${fmtMb(event.to)} over 3 min`)}</span>`;
      } else if (event.type === 'jank') {
        item.classList.add('warn');
        const names = event.renders?.components?.slice(0, 2).map(c => c.name) ?? [];
        item.innerHTML = `<sl-icon class="icon" name="film"></sl-icon>
          <span class="title">Choppy frames${event.screen ? ` on ${esc(event.screen)}` : ''}</span>
          <span class="meta"><sl-badge variant="warning" pill>${event.fps} fps</sl-badge><span>${ago(event.at)}</span></span>
          <span class="where">${event.seconds}s · ${event.dropped} frames dropped outside freezes${names.length ? ` · rendering ${esc(names.join(', '))}` : ''}</span>`;
      } else if (event.type === 'screen') {
        item.classList.add(event.issue ? 'warn' : 'startup');
        item.innerHTML = `<sl-icon class="icon" name="window-stack"></sl-icon>
          <span class="title">${esc(event.name)} screen</span>
          <span class="meta"><sl-badge variant="${event.issue ? 'warning' : 'primary'}" pill>${(event.ms / 1000).toFixed(1)}s</sl-badge><span>${ago(event.at)}</span></span>
          <span class="where">${event.commits} renders · ${event.mounts} mounts${event.stalls ? ` · ${event.stalls} freeze${event.stalls === 1 ? '' : 's'}` : ''}${event.settled ? '' : ' · never settled'}</span>`;
      } else if (event.jsBusy) {
        // A phone (Release) freeze: no JS stack, so name what the JS thread was doing natively.
        const severe = event.ms >= SEVERE_MS;
        item.classList.add(severe ? 'severe' : 'warn');
        const js = event.threads.find(t => t.label === 'JS thread');
        const others = event.threads.filter(t => t.label !== 'JS thread').slice(0, 2).map(t => `${shortThreadName(t.label)} ${t.busyPct}%`);
        item.innerHTML = `<sl-icon class="icon" name="${severe ? 'exclamation-octagon-fill' : 'exclamation-triangle-fill'}"></sl-icon>
          <span class="title">JS freeze on phone${js ? ` · ${esc(js.categories[0]?.name ?? '')}` : ''}</span>
          <span class="meta"><sl-badge variant="${severe ? 'danger' : 'warning'}" pill>${event.ms}ms</sl-badge><span>${ago(event.at)}</span></span>
          <span class="where">${esc(others.length ? `meanwhile ${others.join(', ')}` : 'Release build: no JS stack available')}</span>`;
      } else {
        item.classList.add('hot');
        const top = event.threads[0];
        item.innerHTML = `<sl-icon class="icon" name="fire"></sl-icon>
          <span class="title">${esc(top ? `${shortThreadName(top.label)} running hot` : event.trigger)}</span>
          <span class="meta"><sl-badge variant="neutral" pill>${top ? `${top.busyPct}%` : '—'}</sl-badge><span>${ago(event.at)}</span></span>
          <span class="where">${esc(top ? `${top.categories[0]?.name ?? ''} · ${event.trigger}` : 'cooled before the sample')}</span>`;
      }
      item.addEventListener('click', () => select(event.id));
      return item;
    }),
  );
}

setInterval(() => {
  if (!$('#list-panel').hidden) renderEvents();
}, 15000);

// ---------------------------------------------------------------- detail

function select(id) {
  const event = findEvent(id);
  if (!event) return;
  state.range = null;
  state.selectedId = id;
  renderEvents();
  $('#list-panel').hidden = true;
  $('#detail-panel').hidden = false;
  renderDetail(event);
}

function showList() {
  state.selectedId = null;
  state.range = null;
  $('#detail-panel').hidden = true;
  $('#list-panel').hidden = false;
  renderEvents();
}

const KEYWORDS = /^(const|let|var|function|return|if|else|for|while|of|in|new|await|async|export|import|from|default|class|extends|true|false|null|undefined|this|typeof|switch|case|break|continue|try|catch|throw|interface|type)$/;
function highlight(line) {
  return line.replace(/(\/\/.*$)|('(?:\\.|[^'])*'|"(?:\\.|[^"])*"|`(?:\\.|[^`])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)|([^A-Za-z_$\d'"`/]+|\/)/g, (m, com, str, num, fnc, word, other) => {
    if (com) return `<span class="com">${esc(com)}</span>`;
    if (str) return `<span class="str">${esc(str)}</span>`;
    if (num) return `<span class="num">${esc(num)}</span>`;
    if (fnc) return KEYWORDS.test(fnc) ? `<span class="kw">${esc(fnc)}</span>` : `<span class="fnc">${esc(fnc)}</span>`;
    if (word) return KEYWORDS.test(word) ? `<span class="kw">${esc(word)}</span>` : esc(word);
    return esc(other ?? m);
  });
}

async function loadCode(container, file, line) {
  const res = await fetch(`/api/source?file=${encodeURIComponent(file)}&line=${line}&context=7`);
  if (!res.ok) {
    container.innerHTML = '<sl-alert open variant="neutral"><sl-icon slot="icon" name="info-circle-fill"></sl-icon>Source not readable from the project folder.</sl-alert>';
    return;
  }
  const src = await res.json();
  container.innerHTML = `<pre class="code">${src.lines.map(l => `<div class="ln${l.n === line ? ' hit' : ''}"><span>${l.n}</span><span>${highlight(l.text)}</span></div>`).join('')}</pre>`;
  container.querySelector('.hit')?.scrollIntoView({ block: 'nearest' });
}

function shareRows(rows) {
  return `<div class="share">${rows
    .map(r => `<div class="share-row"><span class="lbl" title="${esc(r.label)}">${esc(r.label)}</span><span class="pct">${r.text}</span><sl-progress-bar value="${Math.max(2, Math.round(r.pct))}" style="--indicator-color:${r.color}"></sl-progress-bar></div>`)
    .join('')}</div>`;
}

function renderStack(frames, culpritIndex) {
  const items = [];
  let fold = [];
  const flush = () => {
    if (!fold.length) return;
    const pkgs = [...new Set(fold.map(f => f.pkg ?? (f.kind === 'native' ? 'native' : 'bundle')))].slice(0, 3).join(', ');
    const hidden = fold;
    items.push({ fold: hidden, label: `${hidden.length} library frame${hidden.length === 1 ? '' : 's'} · ${pkgs}` });
    fold = [];
  };
  frames.forEach((f, i) => {
    if (f.kind === 'app' || i === 0 || i === culpritIndex) {
      flush();
      items.push({ frame: f });
    } else {
      fold.push(f);
    }
  });
  flush();

  const list = el('ol', 'stack');
  const frameItem = f => {
    const li = el('li', f.kind === 'app' ? 'app' : '');
    li.innerHTML = `<span class="dot"></span><span><span class="f-name">${esc(f.name)}</span><span class="f-loc">${esc(f.file ? `${f.file}:${f.line}` : f.kind === 'native' ? 'native' : f.where ?? f.kind)}</span></span>`;
    if (f.kind === 'app') li.querySelector('.f-loc').addEventListener('click', () => openEditor(f.file, f.line));
    return li;
  };
  for (const item of items) {
    if (item.frame) {
      list.append(frameItem(item.frame));
      continue;
    }
    const li = el('li', 'fold', `<sl-icon name="chevron-right"></sl-icon><span>${esc(item.label)}</span>`);
    li.addEventListener('click', () => li.replaceWith(...item.fold.map(frameItem)));
    list.append(li);
  }
  return list;
}

function threadsDuring(from, to, exclude) {
  return [...state.lanes.values()]
    .filter(l => l.name !== exclude)
    .map(l => ({ lane: l, pct: busyBetween(l, from, to) }))
    .filter(r => r.pct >= 0.05)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 5);
}

function renderDetail(event) {
  const root = $('#detail');
  root.replaceChildren();
  const renderers = {
    stall: renderStallDetail,
    hot: renderHotDetail,
    console: renderConsoleDetail,
    request: renderRequestDetail,
    startup: renderStartupDetail,
    leak: renderLeakDetail,
    threadleak: renderLeakDetail,
    jank: renderJankDetail,
    screen: renderScreenDetail,
  };
  $('#editor-btn').disabled = true;
  setActions(null);
  headerType = event.type;
  renderers[event.type](root, event);
  root.querySelector('.back').addEventListener('click', showList);
  root.scrollTop = 0;
}

let headerType = null;
function header(kindBadge, number, unit, time) {
  return `<div class="d-top">
      <sl-button class="back" size="small" variant="text"><sl-icon slot="prefix" name="chevron-left"></sl-icon>Events</sl-button>
      <div class="spacer"></div>${kindBadge}${EVENT_INFO[headerType] ? info(EVENT_INFO[headerType]) : ''}
    </div>
    <div class="d-big"><span class="num">${number}</span><span class="unit">${unit}</span></div>
    <div class="d-time">${time}</div>`;
}

function section(title, hint) {
  const node = el('div', 'd-section');
  node.innerHTML = `<h3>${title}${hint ? ` <small>${hint}</small>` : ''}</h3>`;
  return node;
}

function renderStallDetail(root, stall) {
  const severe = stall.ms >= SEVERE_MS;
  const top = stall.culprits[0];
  const same = top ? state.stalls.filter(s => s.culprits[0]?.key === top.key) : [];
  const where = top?.file ? `<code>${esc(displayName(top))}</code> in <code>${esc(top.file)}:${top.line}</code>` : top ? `<code>${esc(top.name)}</code> (${esc(top.kind === 'native' ? 'native code' : 'outside your source')})` : null;
  const inLib = top?.hot?.kind === 'lib' && top.kind === 'app';
  const libSentence = inLib
    ? ` The time itself was inside <strong>${esc(top.hot.pkg)}</strong> (<code>${esc(top.hot.name)}</code>)${top.via?.length ? `, reached through ${top.via.map(v => `<code>${esc(v)}</code>`).join(' › ')}` : ''}. Your code on that path:`
    : '';
  const react = !stall.devOnly ? stall.react : null;
  const reactSentence = react
    ? `This was <strong>React work</strong>: ${react.captures} of ${stall.snapshotCount} captures were inside one synchronous React ${react.phase}${react.trigger ? `, started by ${esc(react.trigger)}` : ''}. The cost is that whole render, not a single line. The highlighted line below is just where a capture landed.`
    : null;
  const summary = reactSentence
    ? `The JS thread was busy for <strong>${stall.ms}ms</strong> without a break, so taps, scrolling and JS animations were frozen. ${reactSentence}`
    : top
    ? `The JS thread was busy for <strong>${stall.ms}ms</strong> without a break, so taps, scrolling and JS animations were frozen. ${top.count} of ${stall.snapshotCount} stack capture${stall.snapshotCount === 1 ? ' was' : 's were'} ${inLib ? 'on the same path.' : `inside ${where}.`}${libSentence}`
    : `The JS thread was busy for <strong>${stall.ms}ms</strong> without a break. It ended before a stack could be captured; the next one like it is usually caught.`;
  const repeat = same.length > 1 ? ` · <sl-badge variant="warning" pill>${same.length}× this session</sl-badge>` : '';

  root.insertAdjacentHTML(
    'beforeend',
    `${header(`<sl-badge variant="${severe ? 'danger' : 'warning'}">JS freeze</sl-badge>`, stall.ms, 'ms blocked', `${clock(stall.at)} · ${ago(stall.at)}${repeat}`)}
    <p class="d-summary">${summary}</p>`,
  );

  if (stall.stale) {
    root.insertAdjacentHTML('beforeend', '<sl-alert open variant="warning" style="margin-top:12px"><sl-icon slot="icon" name="exclamation-triangle-fill"></sl-icon><strong>Captured while the app ran older code.</strong> The file and line below may be wrong; reload the app and reproduce it.</sl-alert>');
  }

  const context = [
    stall.screen && `on the <strong>${esc(stall.screen)}</strong> screen`,
    stall.actions?.length && `while dispatching <code>${esc(stall.actions[0].type)}</code>`,
    burstSize(stall) > 1 && `one of ${burstSize(stall)} freezes in a row`,
    stall.sampled && 'stacks from the sampling profiler',
  ].filter(Boolean);
  if (context.length) root.insertAdjacentHTML('beforeend', `<p class="d-summary d-context">${context.join(' · ')}</p>`);

  const renders = rendersSection(stall.renders, 'What React rendered', 'during the freeze, and why');
  if (renders) root.append(renders);

  if (stall.snapshotCount > 0 && stall.snapshotCount <= 2) {
    root.insertAdjacentHTML('beforeend', `<sl-alert open variant="neutral" class="dev-alert"><sl-icon slot="icon" name="info-circle-fill"></sl-icon>Only ${stall.snapshotCount} stack capture${stall.snapshotCount === 1 ? '' : 's'}, so treat the location as a lead, not proof. Repeat the interaction to collect more.</sl-alert>`);
  }

  if (react?.components.length) {
    const node = section('Components rendering', 'seen on the stack during the freeze');
    const chips = el('div', 'chips');
    for (const c of react.components) {
      const tag = el('sl-tag', '', `${esc(c.name)} <span class="menu-port">${c.count}/${stall.snapshotCount}</span>`);
      tag.size = 'small';
      tag.title = `${c.file}:${c.line}`;
      tag.style.cursor = 'pointer';
      tag.addEventListener('click', () => openEditor(c.file, c.line));
      chips.append(tag);
    }
    node.append(chips);
    root.append(node);
  }

  if (inLib && !react && top.appChain?.length) {
    const chain = el('ol', 'stack app-chain');
    for (const f of top.appChain) {
      const li = el('li', 'app', `<span class="dot"></span><span><span class="f-name">${esc(f.name)}</span><span class="f-loc">${esc(f.file)}:${f.line}</span></span>`);
      li.querySelector('.f-loc').addEventListener('click', () => openEditor(f.file, f.line));
      chain.append(li);
    }
    root.append(chain);
  }

  if (stall.devOnly) {
    root.insertAdjacentHTML('beforeend', `<sl-alert open variant="neutral" class="dev-alert"><sl-icon slot="icon" name="tools"></sl-icon><strong>Dev-only: ${esc(stall.devOnly)}.</strong> This work doesn't run in production builds, so users never feel it — but it does make your dev session janky and can hide real problems. Consider turning it off while profiling.</sl-alert>`);
  }

  if (top) {
    const node = section('What was running');
    const card = el('sl-card');
    card.innerHTML = `<div slot="header" class="card-head">
        <span class="fn">${esc(displayName(top))}</span><div class="spacer"></div>
        ${top.file ? `<sl-button size="small" variant="text" class="loc">${esc(top.file)}:${top.line}<sl-icon slot="suffix" name="box-arrow-up-right"></sl-icon></sl-button>` : ''}
      </div><div class="code-slot"></div>`;
    node.append(card);
    root.append(node);
    if (top.file) {
      card.querySelector('.loc').addEventListener('click', () => openEditor(top.file, top.line));
      loadCode(card.querySelector('.code-slot'), top.file, top.line);
    } else {
      card.querySelector('.code-slot').innerHTML = '<sl-alert open variant="neutral" style="margin:var(--sl-spacing-small)"><sl-icon slot="icon" name="info-circle-fill"></sl-icon>No source line: this frame is native or inside the Hermes runtime. The stack below shows which of your code called it.</sl-alert>';
    }
  }

  if (stall.culprits.length > 1) {
    const node = section('Where the time went', 'share of stack captures');
    node.insertAdjacentHTML(
      'beforeend',
      shareRows(stall.culprits.map(c => ({ label: c.file ? `${displayName(c)} · ${c.file}:${c.line}` : c.name, pct: (c.count / stall.snapshotCount) * 100, text: `${c.count}/${stall.snapshotCount}`, color: c.kind === 'app' ? COLORS.js : COLORS.other }))),
    );
    root.append(node);
  }

  const frames = stall.snapshots[top?.snapshot ?? 0];
  if (frames?.length) {
    const node = section('Call stack', 'innermost first · your code highlighted');
    const culpritIndex = frames.findIndex(f => top && f.name === top.name && f.file === top.file && f.line === top.line);
    node.append(renderStack(frames, culpritIndex));
    root.append(node);
  }

  const around = relatedSection('Around this freeze', relatedAround(stall.at - 1500, stall.at + stall.ms + 1500, stall.id));
  const stallLogs = logsSection(stall.at - 5000, stall.at + stall.ms + 500);
  if (around) root.append(around);
  if (stallLogs) root.append(stallLogs);

  const others = threadsDuring(stall.at, stall.at + stall.ms, 'JS thread');
  if (others.length) {
    const node = section('Other threads during the freeze');
    node.insertAdjacentHTML('beforeend', shareRows(others.map(o => ({ label: shortThreadName(o.lane.name), pct: o.pct * 100, text: `${Math.round(o.pct * 100)}%`, color: o.lane.color }))));
    root.append(node);
  }

  $('#editor-btn').disabled = !top?.file;
  $('#editor-btn').onclick = () => top?.file && openEditor(top.file, top.line);
}

// What else happened in the app around a moment: console output and requests.
function relatedAround(from, to, excludeId) {
  const near = [
    ...state.consoleEvents.filter(c => c.at >= from && c.at <= to),
    ...state.requests.filter(r => r.at <= to && r.at + r.ms >= from),
    ...state.stalls.filter(s => s.at <= to && s.at + s.ms >= from),
  ].filter(e => e.id !== excludeId);
  return near.sort((a, b) => a.at - b.at).slice(0, 12);
}

// The plain log lines around a moment, oldest first: what the app said it was doing.
// Log lines from the live session, or the ones a saved run carries.
function logsSection(from, to, saved = null) {
  const lines = (saved ?? state.logs).filter(l => (l.lastAt ?? l.at) >= from && l.at <= to).slice(-20);
  if (!lines.length) return null;
  const node = section('App logs', `${clock(from)}–${clock(to)}`);
  const list = el('div', 'log-lines');
  for (const l of lines) {
    const row = el('div', `log-line ${l.level}`);
    row.innerHTML = `<span class="log-time">${clock(l.at)}</span><span class="log-text">${esc(l.text)}</span>${l.count > 1 ? `<sl-badge variant="neutral" pill>×${l.count}</sl-badge>` : ''}`;
    list.append(row);
  }
  node.append(list);
  return node;
}

const stackText = frames => frames.map(f => `${f.name ?? '?'}  ${f.file ? `${f.file}:${f.line}` : (f.where ?? f.kind ?? '')}`).join('\n');

// A copy button on a section's heading.
function copyButton(node, value, label) {
  const button = el('sl-copy-button');
  button.value = value;
  button.copyLabel = label;
  button.successLabel = 'Copied';
  (node.querySelector('h3') ?? node.closest('.d-section')?.querySelector('h3'))?.append(button);
}

function relatedSection(title, items) {
  if (!items.length) return null;
  const node = section(title);
  const list = el('div', 'related');
  for (const e of items) {
    const label =
      e.type === 'console'
        ? `console.${e.level}: ${e.text.split('\n')[0].slice(0, 90)}`
        : e.type === 'request'
          ? `${e.method} ${shortUrl(e.url)} · ${e.ms}ms${e.failed ? ' · failed' : ''}`
          : `JS freeze ${e.ms}ms`;
    const b = el('sl-button', '', esc(label));
    b.size = 'small';
    b.variant = 'text';
    b.style.justifySelf = 'start';
    // Events from a saved run may no longer be in this session: open them as saved.
    b.addEventListener('click', () => {
      // Ids restart each session: only the same event (same id and time) opens live.
      const live = findEvent(e.id);
      if (live && live.at === e.at) select(e.id);
      else showSaved(e);
    });
    list.append(b);
  }
  node.append(list);
  return node;
}

function frameList(root, frames, title) {
  if (!frames?.length) return;
  const node = section(title, 'innermost first · your code highlighted');
  copyButton(node, stackText(frames), 'Copy stack');
  node.append(renderStack(frames, frames.findIndex(f => f.kind === 'app')));
  root.append(node);
}

function codeCard(root, title, frame) {
  if (!frame?.file) return;
  const node = section(title);
  const card = el('sl-card');
  card.innerHTML = `<div slot="header" class="card-head"><span class="fn">${esc(frame.name)}</span><div class="spacer"></div>
    <sl-button size="small" variant="text" class="loc">${esc(frame.file)}:${frame.line}<sl-icon slot="suffix" name="box-arrow-up-right"></sl-icon></sl-button></div><div class="code-slot"></div>`;
  card.querySelector('.loc').addEventListener('click', () => openEditor(frame.file, frame.line));
  loadCode(card.querySelector('.code-slot'), frame.file, frame.line);
  node.append(card);
  root.append(node);
  $('#editor-btn').disabled = false;
  $('#editor-btn').onclick = () => openEditor(frame.file, frame.line);
}

function renderConsoleDetail(root, c) {
  const error = c.level === 'error';
  const kind = c.exception ? 'Uncaught exception' : error ? 'console.error' : 'console.warn';
  const lastAt = c.lastAt ?? c.at;
  root.insertAdjacentHTML(
    'beforeend',
    `${header(`<sl-badge variant="${error ? 'danger' : 'warning'}">${kind}</sl-badge>`, c.count > 1 ? `×${c.count}` : '1×', c.count > 1 ? 'times' : 'logged', `${clock(c.at)} · ${ago(lastAt)}`)}
    ${c.count > 1 ? `<dl class="kv"><dt>First seen</dt><dd>${clock(c.at)}</dd><dt>Last seen</dt><dd>${clock(lastAt)} · ${ago(lastAt)}</dd></dl>` : ''}`,
  );
  const message = section('Message');
  copyButton(message, c.text, 'Copy message');
  message.insertAdjacentHTML('beforeend', `<pre class="console-text">${esc(c.text)}</pre>`);
  root.append(message);
  if (c.lastText) {
    const latest = section('Latest repeat', 'same message, different values');
    copyButton(latest, c.lastText, 'Copy message');
    latest.insertAdjacentHTML('beforeend', `<pre class="console-text">${esc(c.lastText)}</pre>`);
    root.append(latest);
  }
  if (c.source) codeCard(root, 'Logged from', c.source);
  else root.insertAdjacentHTML('beforeend', '<sl-alert open variant="neutral" class="dev-alert"><sl-icon slot="icon" name="info-circle-fill"></sl-icon>No app code on the stack. This came from a library or native module.</sl-alert>');
  const related = relatedSection('Around this message', relatedAround(c.at - 1500, c.at + 1500, c.id));
  if (related) root.append(related);
  const logs = logsSection(c.at - 5000, c.at + 500);
  if (logs) root.append(logs);
  frameList(root, c.frames, 'Call stack');
}

// Pretty JSON when it parses; anything else as it came.
const prettyText = text => {
  const t = (text ?? '').trim();
  if (!/^[[{]/.test(t)) return text ?? '';
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return text;
  }
};

const headersList = headers =>
  headers && Object.keys(headers).length
    ? `<dl class="kv headers">${Object.entries(headers)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => `<dt>${esc(name)}</dt><dd${value === '•••• hidden' ? ' class="hidden-value"' : ''}>${esc(value)}</dd>`)
        .join('')}</dl>`
    : '<p class="d-hint">No headers reported.</p>';

function bodyBlock(node, text, note) {
  const pretty = prettyText(text);
  node.insertAdjacentHTML('beforeend', `${note ? `<p class="d-hint">${note}</p>` : ''}<pre class="body-pre">${esc(pretty)}</pre>`);
  copyButton(node, pretty, 'Copy body');
}

function renderRequestDetail(root, r) {
  const slowMs = state.status?.settings?.slowRequestMs ?? 1000;
  const verdict = r.failed ? (r.error ? `failed: ${esc(r.error)}` : `failed with HTTP ${r.status}`) : r.ms >= slowMs ? `took ${(r.ms / 1000).toFixed(1)}s, over your ${slowMs}ms threshold` : `took ${r.ms}ms`;
  const kind = r.failed ? ['danger', 'Failed request'] : r.issue ? ['warning', 'Slow request'] : ['primary', 'Request'];
  const size = r.bodySize ?? r.bytes;
  root.insertAdjacentHTML(
    'beforeend',
    `${header(`<sl-badge variant="${kind[0]}">${kind[1]}</sl-badge>`, r.ms, 'ms', `${clock(r.at)} · ${ago(r.at)}`)}
    <p class="d-summary">This <code>${esc(r.method)}</code> request ${verdict}.${r.issue ? ' Anything waiting on it (a spinner, a list, a button) was stuck that long.' : ''}</p>
    <dl class="kv">
      <dt>URL</dt><dd>${esc(r.url)}</dd>
      <dt>Status</dt><dd>${esc(r.status ?? '—')}</dd>
      <dt>Type</dt><dd>${esc(r.mime ?? '—')}</dd>
      <dt>Size</dt><dd>${size != null ? (size >= 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`) : '—'}</dd>
    </dl>`,
  );

  // Response first: it's usually what someone opens a request to see.
  const response = section('Response', r.status ? `HTTP ${esc(r.status)}` : '');
  response.insertAdjacentHTML('beforeend', '<div class="body-slot"><p class="d-hint">Loading the response body…</p></div>');
  root.append(response);
  const slot = response.querySelector('.body-slot');
  const tooOld = r.requestHeaders === undefined;
  fetch(`/api/response?id=${r.id}`)
    .then(res => (res.headers.get('content-type')?.includes('json') ? res.json() : { error: 'old' }))
    .catch(() => ({ error: 'old' }))
    .then(body => {
      slot.replaceChildren();
      if (body.error === 'old' || tooOld) {
        slot.innerHTML = '<sl-alert open variant="warning"><sl-icon slot="icon" name="exclamation-triangle-fill"></sl-icon><strong>Restart Hitch to see bodies and headers.</strong> The running Hitch doesn\'t capture them yet; quit and reopen Hitch.app, then repeat the request.</sl-alert>';
        return;
      }
      if (body.error) slot.innerHTML = `<p class="d-hint">${esc(r.failed ? 'No body: the request failed.' : body.error)}</p>`;
      else if (body.base64) slot.innerHTML = `<p class="d-hint">Binary body, ${body.size} bytes.</p>`;
      else if (!body.text) slot.innerHTML = '<p class="d-hint">Empty body.</p>';
      else bodyBlock(slot, body.text, body.truncated ? `Showing the first ${Math.round(body.text.length / 1024)} KB of ${Math.round(body.size / 1024)} KB.` : '');
    });
  const responseHeaders = el('details', 'headers-fold');
  responseHeaders.innerHTML = `<summary>Response headers</summary>${headersList(r.responseHeaders)}`;
  response.append(responseHeaders);

  const request = section('Request', 'credentials hidden');
  if (!tooOld) request.insertAdjacentHTML('beforeend', headersList(r.requestHeaders));
  if (r.requestBody?.text) {
    const bodyNode = el('div', 'request-body');
    request.append(bodyNode);
    bodyBlock(bodyNode, r.requestBody.text, r.requestBody.truncated ? `Showing the first ${Math.round(r.requestBody.text.length / 1024)} KB of ${Math.round(r.requestBody.size / 1024)} KB.` : 'Body');
  }
  root.append(request);

  if (r.source) codeCard(root, 'Requested from', r.source);
  const related = relatedSection('While it was in flight', relatedAround(r.at, r.at + r.ms, r.id));
  const requestLogs = logsSection(r.at - 2000, r.at + r.ms + 500);
  if (related) root.append(related);
  if (requestLogs) root.append(requestLogs);
  frameList(root, r.frames, 'Call stack when it was sent');
}

function renderStartupDetail(root, s) {
  const total = s.toSettleMs ?? s.toJsMs;
  const js = s.toJsMs ?? 0;
  const settle = s.toSettleMs != null ? s.toSettleMs - js : 0;
  root.insertAdjacentHTML(
    'beforeend',
    `${header(`<sl-badge variant="primary">${s.kind === 'reload' ? 'Reload' : 'Cold launch'}</sl-badge>`, total != null ? (total / 1000).toFixed(1) : '—', 'seconds', `${clock(s.at)} · ${ago(s.at)}`)}
    <p class="d-summary">${s.kind === 'reload' ? 'From the JS reload' : 'From the app process launching'} until the first screen started rendering took <strong>${s.toJsMs != null ? `${(s.toJsMs / 1000).toFixed(2)}s` : 'an unknown time'}</strong>${
      s.settled ? `, then <strong>${(settle / 1000).toFixed(2)}s</strong> more until the JS and UI threads went quiet (the app settled).` : '. The app never settled within 30 seconds, so something kept the JS or UI thread busy.'
    }</p>
    <div class="startup-bar">
      <i style="width:${total ? (js / total) * 100 : 0}%;background:var(--lane-ui)" title="until JS started"></i>
      <i style="width:${total ? (settle / total) * 100 : 0}%;background:var(--lane-js)" title="until settled"></i>
    </div>
    <div class="cats" style="margin-top:6px"><span><i style="background:var(--lane-ui)"></i>bundle + native start</span><span><i style="background:var(--lane-js)"></i>first screens rendering and settling</span></div>`,
  );
  const freezes = state.stalls.filter(f => f.at >= s.at && f.at <= s.at + (total ?? 30000));
  const related = relatedSection('Freezes during startup', freezes);
  if (related) root.append(related);
}

// What the React probe saw: per component, renders (mounts), time, and why.
function rendersSection(renders, title, hint) {
  if (!renders?.commits) return null;
  const node = section(title, hint);
  node.insertAdjacentHTML(
    'beforeend',
    `<p class="d-summary">${renders.commits} commit${renders.commits === 1 ? '' : 's'}, <strong>${renders.renderMs}ms</strong> rendering, ${renders.rendered} component renders (${renders.mounts} mounts)${renders.avoidable ? `, <strong>${renders.avoidable} avoidable</strong>` : ''}.</p>`,
  );
  const list = el('div', 'renders');
  for (const c of renders.components.slice(0, 10)) {
    const row = el('div', 'render-row');
    row.innerHTML = `<div class="render-head"><span class="fn">${esc(c.name)}</span><span class="render-nums">×${c.renders}${c.mounts ? ` · ${c.mounts} mounted` : ''} · ${c.ms}ms${c.avoidable ? ` · <span class="avoidable">${c.avoidable} avoidable</span>` : ''}</span></div>
      ${c.reasons.length ? `<ul class="render-why">${c.reasons.map(r => `<li>${esc(r.text ?? r.reason)} <span class="menu-port">×${r.count}</span></li>`).join('')}</ul>` : ''}`;
    list.append(row);
  }
  node.append(list);
  if (renders.primitives?.length) {
    node.insertAdjacentHTML('beforeend', `<p class="d-hint">Building blocks under them: ${renders.primitives.map(p => `${esc(p.name)} ×${p.renders}${p.avoidable ? ` (${p.avoidable} avoidable)` : ''}`).join(', ')}</p>`);
  }
  return node;
}

function renderJankDetail(root, j) {
  root.insertAdjacentHTML(
    'beforeend',
    `${header('<sl-badge variant="warning">Choppy frames</sl-badge>', j.fps, 'fps', `${clock(j.at)}–${clock(j.until)} · ${ago(j.at)}`)}
    <p class="d-summary">For <strong>${j.seconds}s</strong>${j.screen ? ` on <strong>${esc(j.screen)}</strong>` : ''} the JS thread managed about <strong>${j.fps} frame${j.fps === 1 ? '' : 's'} per second</strong> and dropped <strong>${j.dropped}</strong> frames that individual freezes don't account for${j.worstGapMs ? ` (longest hitch ${j.worstGapMs}ms)` : ''}. That's many small hitches, each under the freeze threshold, which together make scrolling and animations feel choppy.</p>`,
  );
  const renders = rendersSection(j.renders, 'What React rendered meanwhile');
  if (renders) root.append(renders);
  const freezes = relatedSection('Freezes in this period', state.stalls.filter(f => f.at >= j.at && f.at <= j.until));
  if (freezes) root.append(freezes);
  const logs = logsSection(j.at, j.until);
  if (logs) root.append(logs);
}

function renderScreenDetail(root, sc) {
  root.insertAdjacentHTML(
    'beforeend',
    `${header(`<sl-badge variant="${sc.issue ? 'warning' : 'primary'}">Screen load</sl-badge>`, (sc.ms / 1000).toFixed(1), `s · ${esc(sc.name)}`, `${clock(sc.at)} · ${ago(sc.at)}`)}
    <p class="d-summary">From navigating to <strong>${esc(sc.name)}</strong> until React stopped re-rendering for a full second took <strong>${(sc.ms / 1000).toFixed(2)}s</strong>${sc.settled ? '' : ' (it never settled within 15s)'}: ${sc.commits} renders, ${sc.renderMs}ms of render time and ${sc.mounts} components mounted${sc.stalls ? `, with ${sc.stalls} JS freeze${sc.stalls === 1 ? '' : 's'}` : ''}.${sc.memoryAtStart && sc.memoryAtEnd ? ` App memory went from ${fmtMb(sc.memoryAtStart)} to ${fmtMb(sc.memoryAtEnd)}.` : ''}</p>`,
  );
  const renders = rendersSection(sc.renders, 'What React rendered while it loaded');
  if (renders) root.append(renders);
  const freezes = relatedSection('Freezes while it loaded', state.stalls.filter(f => f.at >= sc.at && f.at <= sc.at + sc.ms));
  if (freezes) root.append(freezes);
  const requests = relatedSection('Slow or failed requests while it loaded', state.requests.filter(r => r.issue && r.at >= sc.at && r.at <= sc.at + sc.ms));
  if (requests) root.append(requests);
}

function renderLeakDetail(root, a) {
  if (a.kind === 'reload') {
    root.insertAdjacentHTML(
      'beforeend',
      `${header('<sl-badge variant="danger">Memory kept after reload</sl-badge>', `+${fmtMb(a.to - a.from)}`, '', `${clock(a.at)} · ${ago(a.at)}`)}
      <p class="d-summary">A JS reload throws away the old JavaScript runtime, yet app memory went from <strong>${fmtMb(a.from)}</strong> to <strong>${fmtMb(a.to)}</strong> once the reload settled. Native resources the old JS created were never released: images, native views, animation or graphics engines (Rive, Skia, Lottie), players, or native module singletons.</p>
      <p class="d-summary">Users rarely reload JS, but the same missing cleanup leaks whenever those screens unmount.</p>`,
    );
    return;
  }
  if (a.type === 'threadleak') {
    root.insertAdjacentHTML(
      'beforeend',
      `${header('<sl-badge variant="danger">Threads piling up</sl-badge>', `+${a.to - a.from}`, 'threads in 3 min', `${clock(a.at)} · ${ago(a.at)}`)}
      <p class="d-summary">The app went from <strong>${a.from}</strong> to <strong>${a.to}</strong> threads and kept climbing. Something keeps creating threads without ending them, usually a native module or SDK that starts a worker per call.</p>`,
    );
    if (a.grew.length) {
      const node = section('Threads that grew');
      node.insertAdjacentHTML('beforeend', shareRows(a.grew.map(g => ({ label: shortThreadName(g.name), pct: Math.min(100, g.added * 10), text: `+${g.added}`, color: COLORS.severe }))));
      root.append(node);
    }
    return;
  }
  root.insertAdjacentHTML(
    'beforeend',
    `${header('<sl-badge variant="danger">Possible memory leak</sl-badge>', `${a.mbPerMin}`, 'MB per minute', `${clock(a.at)} · ${ago(a.at)}`)}
    <p class="d-summary">${a.kind === 'heap' ? 'The JS heap' : 'The app\'s total memory'} grew from <strong>${fmtMb(a.from)}</strong> to <strong>${fmtMb(a.to)}</strong> over the last 3 minutes, and the low point after each garbage collection kept rising. Memory that survives GC like this is usually a leak: listeners, timers or subscriptions not cleaned up, or caches that only grow.</p>
    <p class="d-summary">To pin it down, visit a screen and leave it a few times and watch the Memory lane. If it steps up each time and never comes back down, that screen is leaking.</p>`,
  );
}

function renderHotDetail(root, hot) {
  const top = hot.threads[0];
  root.insertAdjacentHTML(
    'beforeend',
    `${header('<sl-badge variant="neutral">Threads hot</sl-badge>', top ? `${top.busyPct}%` : '—', top ? esc(shortThreadName(top.label)) : '', `${clock(hot.at)} · ${ago(hot.at)} · ${esc(hot.trigger)}`)}
    <p class="d-summary">${
      top
        ? `Every native thread was sampled for 1 second. The busiest was <strong>${esc(shortThreadName(top.label))}</strong> at ${top.busyPct}%, mostly in <strong>${esc(top.categories[0]?.name ?? 'unknown')}</strong>.`
        : 'The spike had already cooled when the sample ran; nothing stayed busy for the full second.'
    }</p>`,
  );
  const node = section('Busy threads', '1s native sample');
  for (const t of hot.threads) {
    const card = el('sl-card', 'thread-card');
    card.innerHTML = `<div class="tc-body">
      <div class="tc-head"><span class="tc-name">${esc(shortThreadName(t.label))}</span><span class="tc-pct">${t.busyPct}%</span></div>
      <div class="stackbar">${t.categories.map(c => `<i style="width:${c.pct}%;background:${CATEGORY_COLORS[c.name] ?? COLORS.other}"></i>`).join('')}</div>
      <div class="cats">${t.categories.slice(0, 4).map(c => `<span><i style="background:${CATEGORY_COLORS[c.name] ?? COLORS.other}"></i>${esc(c.name)} ${c.pct}%</span>`).join('')}</div>
      <ul class="frames">${t.frames.map(f => `<li><span class="fm">${f.ms}ms</span><span class="fn" title="${esc(f.name)}">${esc(f.name)} <span class="lib">${esc(f.lib ?? '')}</span>${f.via ? `<span class="via" title="${esc(f.via)}">called from ${esc(f.via)}</span>` : ''}</span></li>`).join('')}</ul>
    </div>`;
    node.append(card);
  }
  root.append(node);
  $('#editor-btn').disabled = true;
}

// ---------------------------------------------------------------- actions

function toast(text, variant = 'primary') {
  const icon = { primary: 'info-circle-fill', success: 'check-circle-fill', warning: 'exclamation-triangle-fill', danger: 'x-circle-fill', neutral: 'info-circle-fill' }[variant] ?? 'info-circle-fill';
  const alert = Object.assign(document.createElement('sl-alert'), { variant, closable: true, duration: 3500 });
  alert.innerHTML = `<sl-icon slot="icon" name="${icon}"></sl-icon>${esc(text)}`;
  document.body.append(alert);
  alert.toast();
}

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then(r => r.json());

async function openEditor(file, line) {
  const res = await post('/api/open', { file, line });
  toast(res.error ? `Couldn't open editor: ${res.error}` : `Opened ${file}:${line} in ${res.editor}`, res.error ? 'danger' : 'success');
}

// Pages that aren't a fix-it brief (a log line, a thread) copy their own text,
// and there's nothing to hand to Claude Code.
function setActions(copyText) {
  state.detailCopy = copyText;
  $('#handoff-btn').disabled = Boolean(copyText);
  $('#copy-btn').innerHTML = `<sl-icon slot="prefix" name="clipboard"></sl-icon>${copyText ? 'Copy' : 'Copy prompt'}`;
}

$('#copy-btn').addEventListener('click', async () => {
  if (state.detailCopy) {
    await navigator.clipboard.writeText(state.detailCopy);
    toast('Copied.', 'success');
    return;
  }
  const query = state.range ? `from=${Math.round(state.range.from)}&to=${Math.round(state.range.to)}` : `id=${state.selectedId}`;
  const res = await fetch(`/api/prompt?${query}`).then(r => r.json());
  await navigator.clipboard.writeText(res.prompt);
  toast('Fix prompt copied. Paste it into any AI agent.', 'success');
});

$('#handoff-btn').addEventListener('click', async () => {
  const button = $('#handoff-btn');
  button.loading = true;
  const res = await post('/api/handoff', state.range ? { from: Math.round(state.range.from), to: Math.round(state.range.to) } : { id: state.selectedId });
  button.loading = false;
  toast(res.error ? `Hand-off failed: ${res.error}` : 'Claude Code is opening in Terminal with the full context.', res.error ? 'danger' : 'success');
});

$('#reload-btn').addEventListener('click', async () => {
  await post('/api/reload');
  toast('Reloading the app…');
});

$('#pause-btn').addEventListener('click', togglePause);
function togglePause() {
  state.paused = !state.paused;
  state.pausedAt = Date.now();
  const button = $('#pause-btn');
  button.classList.toggle('active', state.paused);
  $('.topbar').classList.toggle('paused', state.paused);
  button.querySelector('sl-icon').name = state.paused ? 'play-fill' : 'pause-fill';
  button.setAttribute('aria-label', state.paused ? 'Resume the lanes' : 'Pause the lanes');
  button.closest('sl-tooltip').content = state.paused ? 'Resume the lanes (P)' : 'Pause the lanes (P)';
  $('#menu-pause').firstChild.textContent = state.paused ? 'Resume lanes' : 'Pause lanes';
}

$('#sample-btn').addEventListener('click', async () => {
  await post('/api/sample');
  toast('Sampling every thread for 1s…');
});

// The time window lives in the toolbar, or in ••• when the window is narrow.
function setWindow(seconds) {
  state.windowSec = seconds;
  layoutAt = 0;
  $('#window-select').value = String(seconds);
  for (const item of document.querySelectorAll('[data-window]')) item.checked = Number(item.dataset.window) === seconds;
}
$('#window-select').addEventListener('sl-change', e => setWindow(Number(e.target.value)));
for (const item of document.querySelectorAll('[data-window]')) item.addEventListener('click', () => setWindow(Number(item.dataset.window)));

$('#filter').addEventListener('sl-change', e => {
  state.filter = e.target.value;
  renderEvents();
});

$('#search').addEventListener('sl-input', e => {
  state.search = e.target.value;
  renderEvents();
});

$('#settings-btn').addEventListener('click', () => $('#settings').show());
$('#menu-pause').addEventListener('click', togglePause);
$('#tb-clear').addEventListener('click', () => $('#reset-btn').click());
const reloadApp = async () => {
  const res = await post('/api/reload');
  toast(res.error ? `Couldn't reload: ${res.error}` : 'Reloading the app…', res.error ? 'danger' : 'primary');
};
$('#tb-reload').addEventListener('click', reloadApp);
$('#menu-reload').addEventListener('click', reloadApp);
$('#menu-sample').addEventListener('click', () => $('#sample-btn').click());
$('#menu-run').addEventListener('click', () => $('#run-btn').click());
$('#menu-report').addEventListener('click', async () => {
  const res = await post('/api/report');
  toast(res.file ? `Report saved to ${res.file}` : "Couldn't save the report", res.file ? 'success' : 'danger');
});
$('#issue-count').addEventListener('click', () => {
  state.filter = 'all';
  $('#filter').value = 'all';
  showList();
});
for (const [id, key] of [['#set-stall', 'stallMs'], ['#set-ui', 'uiHot'], ['#set-thread', 'threadHot'], ['#set-slow', 'slowRequestMs']]) {
  $(id).addEventListener('sl-change', e => post('/api/settings', { [key]: Number(e.target.value) }).then(() => toast('Threshold updated', 'success')));
}
$('#report-btn').addEventListener('click', async () => {
  const res = await post('/api/report');
  toast(`Report saved: ${res.file}`, 'success');
});
// ---------------------------------------------------------------- asking for a name

// A small sheet with one text field; resolves with the text, or null if cancelled.
// With confirm: true there's no field, and it resolves true or null.
function askText({ title, hint, value, ok, confirm = false, danger = false }) {
  const dialog = $('#ask-dialog');
  const input = $('#ask-input');
  input.hidden = confirm;
  $('#ask-ok').variant = danger ? 'danger' : 'primary';
  dialog.label = title;
  $('#ask-hint').textContent = hint ?? '';
  $('#ask-ok').textContent = ok ?? 'OK';
  input.value = value ?? '';
  return new Promise(resolve => {
    let answer = null;
    const done = text => {
      answer = text;
      dialog.hide();
    };
    const onOk = () => {
      if (confirm) return done(true);
      const text = input.value.trim();
      if (text) done(text);
    };
    const onKey = e => {
      if (e.key === 'Enter') onOk();
    };
    const onCancel = () => done(null);
    $('#ask-ok').addEventListener('click', onOk);
    $('#ask-cancel').addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
    dialog.addEventListener(
      'sl-after-hide',
      () => {
        $('#ask-ok').removeEventListener('click', onOk);
        $('#ask-cancel').removeEventListener('click', onCancel);
        input.removeEventListener('keydown', onKey);
        resolve(answer);
      },
      { once: true },
    );
    dialog.addEventListener('sl-after-show', () => input.select?.(), { once: true });
    dialog.show();
  });
}

// ---------------------------------------------------------------- runs

function setRun(active) {
  state.run = active;
  const btn = $('#run-btn');
  btn.querySelector('.tb-btn-label').textContent = active ? `Stop “${active.name}”` : 'Record';
  btn.querySelector('sl-icon').name = active ? 'stop-fill' : 'record-circle';
  btn.classList.toggle('recording', Boolean(active));
  btn.setAttribute('aria-label', active ? `Stop recording ${active.name}` : 'Record run');
  $('#menu-run').firstChild.textContent = active ? `Stop “${active.name}”` : 'Record run…';
}

function showRunResult({ run, previous, comparison }) {
  const s = run.summary;
  const arrow = { better: '<span class="better">↓ better</span>', worse: '<span class="worse">↑ worse</span>', same: '≈ same' };
  $('#run-dialog').label = `Run "${run.name}"`;
  $('#run-result').innerHTML = `
    <p class="d-summary">${s.seconds}s${run.git?.branch ? ` on <code>${esc(run.git.branch)}@${esc(run.git.commit)}</code>${run.git.dirty ? ' (uncommitted changes)' : ''}` : ''}: JS blocked <strong>${s.blockedMs}ms</strong> over ${s.stalls} freezes (worst ${s.worstStallMs}ms${s.devOnlyMs ? `, ${s.devOnlyMs}ms dev-only` : ''}), ${s.jankSeconds}s of choppy frames, ${s.errors} console errors.</p>
    ${s.screens.length ? `<p class="d-summary">Screens: ${s.screens.map(sc => `${esc(sc.name)} ${(sc.ms / 1000).toFixed(1)}s`).join(', ')}</p>` : ''}
    ${s.renders ? `<p class="d-summary">React: ${s.renders.renderMs}ms rendering, ${s.renders.mounts} mounts, ${s.renders.avoidable} avoidable re-renders.</p>` : ''}
    ${
      comparison
        ? `<h3>Compared with the previous run <small>${esc(previous.git?.branch ?? '')}@${esc(previous.git?.commit ?? '')}</small></h3>
           <p><strong>Overall: ${esc(comparison.verdict)}</strong></p>
           <ul class="run-compare">${comparison.lines.map(l => `<li>${esc(l.label)}: ${l.before}${l.unit} → ${l.after}${l.unit} ${arrow[l.change]}</li>`).join('')}</ul>`
        : '<p class="d-hint">The next run with this name will be compared with this one.</p>'
    }`;
  const open = $('#run-dialog-open');
  open.hidden = !run.id;
  open.onclick = () => {
    $('#run-dialog').hide();
    showRun(run.id);
  };
  $('#run-dialog').show();
}

$('#run-dialog-close').addEventListener('click', () => $('#run-dialog').hide());
$('#run-btn').addEventListener('click', async () => {
  if (state.run) {
    $('#run-btn').disabled = true;
    const res = await post('/api/run/stop', {});
    $('#run-btn').disabled = false;
    if (res.error) toast(res.error, 'danger');
    return;
  }
  const name = await askText({ title: 'Record a run', hint: 'Do the interaction in the app, then press Stop. Runs with the same name are compared with each other.', value: state.status?.screen ? `open ${state.status.screen}` : 'run', ok: 'Start recording' });
  if (!name) return;
  const res = await post('/api/run/start', { name });
  if (res.error) toast(res.error, 'danger');
  else setRun({ name: res.name, startedAt: res.startedAt });
});
fetch('/api/runs')
  .then(r => r.json())
  .then(r => setRun(r.active))
  .catch(() => {});

$('#reset-btn').addEventListener('click', async () => {
  await post('/api/clear');
  toast('Cleared. Still watching.', 'success');
});

$('#clear-btn').addEventListener('click', () => {
  post('/api/clear');
  $('#settings').hide();
});

document.addEventListener('keydown', e => {
  if (e.target.closest?.('sl-input, sl-drawer')) return;
  if (e.key === 'Escape') {
    showList();
  } else if (e.key === 'p') {
    togglePause();
  } else if (e.key === 'j' || e.key === 'k') {
    const list = allEvents();
    if (!list.length) return;
    const index = list.findIndex(ev => ev.id === state.selectedId);
    const next = e.key === 'j' ? Math.min(list.length - 1, index + 1) : Math.max(0, index - 1);
    select(list[index === -1 ? 0 : next].id);
  }
});

window.addEventListener('hashchange', () => {
  const linked = Number(location.hash.match(/event=(\d+)/)?.[1]);
  if (linked) select(linked);
});

// ---------------------------------------------------------------- range

// A slice of the timeline, opened on the right like an event.
async function showRange(from, to) {
  state.selectedId = null;
  state.range = { from, to };
  renderEvents();
  $('#list-panel').hidden = true;
  $('#detail-panel').hidden = false;
  const root = $('#detail');
  root.replaceChildren();
  headerType = null;
  setActions(null);
  root.insertAdjacentHTML('beforeend', header('<sl-badge variant="primary">Selected range</sl-badge>', ((to - from) / 1000).toFixed(1), 'seconds', `${clock(from)}–${clock(to)}`));
  root.querySelector('.back').addEventListener('click', showList);
  $('#editor-btn').disabled = true;
  const range = await fetch(`/api/range?from=${Math.round(from)}&to=${Math.round(to)}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (state.range?.from !== from) return;
  if (!range) {
    root.insertAdjacentHTML('beforeend', '<sl-alert open variant="warning" style="margin-top:12px"><sl-icon slot="icon" name="exclamation-triangle-fill"></sl-icon><strong>Restart Hitch to see this range.</strong> The running Hitch is older than this page; quit and reopen Hitch.app.</sl-alert>');
    return;
  }
  renderRangeDetail(root, range);
}

function renderRangeDetail(root, r) {
  const errors = r.console.filter(c => c.level === 'error').length;
  const issues = r.requests.filter(q => q.issue);
  const facts = [
    r.stalls.length
      ? `the JS thread was blocked <strong>${r.blockedMs}ms</strong> over ${r.stalls.length} freeze${r.stalls.length === 1 ? '' : 's'}${r.devOnlyMs ? ` (${r.devOnlyMs}ms dev-only)` : ''}`
      : 'the JS thread never froze',
    r.jank.length && `frames were choppy for ${r.jank.reduce((sum, j) => sum + j.seconds, 0)}s`,
    r.renders && `React rendered for <strong>${r.renders.renderMs}ms</strong> across ${r.renders.commits} commits${r.renders.avoidable ? `, ${r.renders.avoidable} of them avoidable re-renders` : ''}`,
    r.requests.length && `${r.requests.length} request${r.requests.length === 1 ? '' : 's'}${issues.length ? `, ${issues.length} slow or failed` : ''}`,
    (errors || r.console.length) && `${errors} console error${errors === 1 ? '' : 's'} and ${r.console.length - errors} warning${r.console.length - errors === 1 ? '' : 's'}`,
  ].filter(Boolean);
  root.insertAdjacentHTML('beforeend', `<p class="d-summary">In these ${r.seconds} seconds${r.screens.length ? ` (${r.screens.map(sc => esc(sc.name)).join(' → ')})` : ''}, ${facts.join('; ')}.</p>`);

  if (r.memory?.heapFrom != null) {
    const node = section('Memory');
    node.insertAdjacentHTML(
      'beforeend',
      `<div class="stat-row">
        <div class="stat"><div class="k">JS heap</div><div class="v">${fmtMb(r.memory.heapTo)}</div><div class="s">${deltaMb(r.memory.heapFrom, r.memory.heapTo)}</div></div>
        ${r.memory.rssTo != null ? `<div class="stat"><div class="k">App memory</div><div class="v">${fmtMb(r.memory.rssTo)}</div><div class="s">${deltaMb(r.memory.rssFrom, r.memory.rssTo)}</div></div>` : ''}
        ${r.memory.threadsTo != null ? `<div class="stat"><div class="k">Threads</div><div class="v">${r.memory.threadsTo}</div><div class="s">${r.memory.threadsTo - r.memory.threadsFrom >= 0 ? '+' : ''}${r.memory.threadsTo - r.memory.threadsFrom} in range</div></div>` : ''}
      </div>`,
    );
    root.append(node);
  }
  const freezes = relatedSection('Freezes', r.stalls);
  if (freezes) root.append(freezes);
  const renders = rendersSection(r.renders, 'What React rendered', 'and why');
  if (renders) root.append(renders);
  if (r.threads.length) {
    const node = section('Busiest threads', 'average over the range');
    node.insertAdjacentHTML('beforeend', shareRows(r.threads.slice(0, 8).map(t => ({ label: shortThreadName(t.name), pct: t.pct, text: `${t.pct}%`, color: laneColor(t.name) }))));
    root.append(node);
  }
  const requests = relatedSection('Requests', r.requests);
  if (requests) root.append(requests);
  const consoleEvents = relatedSection('Console errors & warnings', r.console);
  if (consoleEvents) root.append(consoleEvents);
  const logs = logsSection(r.from, r.to, r.logs ?? null);
  if (logs) root.append(logs);
}

const deltaMb = (a, b) => (a == null || b == null ? '' : `${b - a >= 0 ? '+' : '−'}${fmtMb(Math.abs(b - a))} in range`);

// ---------------------------------------------------------------- log and thread pages

// Opens the right side on a page that isn't a finding.
function openPage() {
  state.selectedId = null;
  state.range = null;
  renderEvents();
  $('#list-panel').hidden = true;
  $('#detail-panel').hidden = false;
  $('#editor-btn').disabled = true;
  const root = $('#detail');
  root.replaceChildren();
  root.scrollTop = 0;
  headerType = null;
  return root;
}

function showLog(id) {
  const log = state.logs.find(l => l.id === id);
  if (!log) return;
  const root = openPage();
  const level = log.level === 'info' ? 'primary' : 'neutral';
  root.insertAdjacentHTML('beforeend', header(`<sl-badge variant="${level}">console.${esc(log.level)}</sl-badge>`, clock(log.at), log.count > 1 ? `×${log.count}` : '', `${ago(log.at)}${log.count > 1 ? ` · last at ${clock(log.lastAt)}` : ''}${state.status?.screen ? '' : ''}`));
  root.querySelector('.back').addEventListener('click', showList);
  const message = section('Message');
  message.insertAdjacentHTML('beforeend', `<pre class="body-pre">${esc(prettyText(log.text))}</pre>`);
  root.append(message);
  if (log.lastText && log.lastText !== log.text) {
    const latest = section('Latest repeat', 'the text changed between repeats');
    latest.insertAdjacentHTML('beforeend', `<pre class="body-pre">${esc(prettyText(log.lastText))}</pre>`);
    root.append(latest);
  }
  const jump = el('sl-button', '', '<sl-icon slot="prefix" name="bar-chart-steps"></sl-icon>Show on timeline');
  jump.size = 'small';
  jump.style.marginTop = '12px';
  jump.addEventListener('click', () => jumpTo(log.at));
  root.append(jump);
  const around = relatedSection('Caught around it', relatedAround(log.at - 5000, log.at + 5000, null));
  if (around) root.append(around);
  const logs = logsSection(log.at - 5000, log.at + 5000);
  if (logs) root.append(logs);
  setActions(log.lastText && log.lastText !== log.text ? `${log.text}\n\nLatest repeat:\n${log.lastText}` : log.text);
}

function showThread(name) {
  const lane = state.lanes.get(name);
  if (!lane) return;
  const root = openPage();
  const now = Date.now();
  const pct = v => `${Math.round(v * 100)}%`;
  const avg = busyBetween(lane, now - state.windowSec * 1000, now);
  const peak = Math.max(0, ...lane.points.map(p => p[2]));
  root.insertAdjacentHTML('beforeend', header('<sl-badge variant="neutral">Thread</sl-badge>', pct(busyBetween(lane, now - 1000, now)), 'busy now', esc(shortThreadName(name))));
  root.querySelector('.back').addEventListener('click', showList);
  root.insertAdjacentHTML('beforeend', `<p class="d-summary">${esc(threadInfo(name))}</p>`);

  // CPU over the history the window keeps (about 3 minutes).
  const t0 = lane.points[0]?.[0] ?? now;
  const BUCKETS = 120;
  const span = Math.max(1, now - t0);
  const buckets = Array.from({ length: BUCKETS }, () => [0, 0]);
  for (const [at, , busy] of lane.points) {
    const b = Math.min(BUCKETS - 1, Math.floor(((at - t0) / span) * BUCKETS));
    buckets[b][0] += busy;
    buckets[b][1] += 1;
  }
  const values = buckets.map(([sum, n]) => (n ? sum / n : 0));
  const chart = section('CPU', `${clock(t0)} – now`);
  chart.insertAdjacentHTML(
    'beforeend',
    `<div class="chart-card">${sparkline(values, lane.color, 480, 90).replace('class="spark"', 'class="spark spark-big"')}</div>
    <div class="stat-row">
      <div class="stat"><div class="k">Now</div><div class="v">${pct(busyBetween(lane, now - 1000, now))}</div></div>
      <div class="stat"><div class="k">Average, last ${state.windowSec}s</div><div class="v">${pct(avg)}</div></div>
      <div class="stat"><div class="k">Peak</div><div class="v">${pct(peak)}</div></div>
    </div>`,
  );
  root.append(chart);

  // Native samples where this thread was busy: its hottest functions.
  const short = shortThreadName(name);
  const samples = state.hot
    .map(h => ({ h, t: h.threads.find(t => t.label === name || shortThreadName(t.label) === short) }))
    .filter(x => x.t)
    .slice(-3)
    .reverse();
  if (samples.length) {
    const node = section('Native samples', 'when it was busy');
    for (const { h, t } of samples) {
      const card = el('sl-card', 'thread-card');
      card.innerHTML = `<div class="tc-body">
        <div class="tc-head"><span class="tc-name">${clock(h.at)} · ${esc(h.trigger)}</span><span class="tc-pct">${t.busyPct}%</span></div>
        <div class="stackbar">${t.categories.map(c => `<i style="width:${c.pct}%;background:${CATEGORY_COLORS[c.name] ?? COLORS.other}"></i>`).join('')}</div>
        <div class="cats">${t.categories.slice(0, 4).map(c => `<span><i style="background:${CATEGORY_COLORS[c.name] ?? COLORS.other}"></i>${esc(c.name)} ${c.pct}%</span>`).join('')}</div>
        <ul class="frames">${t.frames.map(f => `<li><span class="fm">${f.ms}ms</span><span class="fn" title="${esc(f.name)}">${esc(f.name)} <span class="lib">${esc(f.lib ?? '')}</span></span></li>`).join('')}</ul>
      </div>`;
      card.addEventListener('click', () => select(h.id));
      node.append(card);
    }
    root.append(node);
  } else {
    root.insertAdjacentHTML('beforeend', '<p class="d-hint" style="margin-top:14px">No native samples of this thread yet. Hitch samples every thread when one runs hot, or when you press Sample in the toolbar.</p>');
  }

  // Freezes during which this thread was mostly busy too.
  const busyFreezes = state.stalls.filter(st => name === 'JS thread' || busyBetween(lane, st.at, st.at + st.ms) > 0.5).slice(-10).reverse();
  const freezes = relatedSection('Freezes while it was busy', busyFreezes);
  if (freezes) root.append(freezes);
  setActions(`${short}: ${pct(busyBetween(lane, now - 1000, now))} now, ${pct(avg)} average over ${state.windowSec}s, ${pct(peak)} peak.\n${threadInfo(name)}`);
}

$('#view-threads').addEventListener('click', e => {
  const row = e.target.closest('.grow[data-thread]');
  if (row) showThread(row.dataset.thread);
});

// ---------------------------------------------------------------- copy a view as a prompt

let lastReact = null;
const pctText = v => `${Math.round(v * 100)}%`;
const mbText = b => (b == null ? '—' : fmtMb(b));

function promptHeader(title) {
  const st = state.status ?? {};
  return [
    `# Hitch: ${title}`,
    '',
    `From Hitch, a live performance watcher, attached to ${st.appId ?? 'the app'}${st.device ? ` on ${st.device}` : ''}${st.screen ? `, on the ${st.screen} screen` : ''}, at ${clock(Date.now())}. Measured on a dev build: absolute times are inflated, rankings are real.`,
    '',
  ];
}

const WHAT_TO_DO = ['', '## What to do', 'Look at this data and the app code, find what is worth fixing, and propose fixes ranked by impact. Follow the repo conventions (AGENTS.md / CLAUDE.md).'];

const renderLines = renders =>
  renders?.commits
    ? [
        `${renders.commits} commits, ${renders.renderMs}ms rendering, ${renders.rendered} component renders (${renders.mounts} mounts), ${renders.avoidable} avoidable.`,
        ...renders.components.slice(0, 15).map(c => `- ${c.name} ×${c.renders}${c.mounts ? ` (${c.mounts} mounted)` : ''}, ${c.ms}ms${c.avoidable ? `, ${c.avoidable} avoidable` : ''}${c.reasons.length ? ` — ${c.reasons.map(r => `${r.text ?? r.reason} ×${r.count}`).join('; ')}` : ''}`),
      ]
    : ['No React commits in this window.'];

const viewPrompts = {
  async timeline() {
    const [from, to] = viewRange();
    const res = await fetch(`/api/prompt?from=${Math.round(from)}&to=${Math.round(to)}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
    return res?.prompt ?? null;
  },
  threads() {
    const now = Date.now();
    const from = now - state.windowSec * 1000;
    const rows = [...state.lanes.values()]
      .map(lane => ({ lane, avg: busyBetween(lane, from, now), now: busyBetween(lane, now - 1000, now), peak: Math.max(0, ...lane.points.filter(p => p[0] >= from).map(p => p[2])) }))
      .filter(r => r.peak > 0.004)
      .sort((a, b) => b.avg - a.avg);
    const hot = state.hot.slice(-2).flatMap(h => h.threads.slice(0, 3).map(t => `- ${clock(h.at)} ${shortThreadName(t.label)} ${t.busyPct}%: ${t.categories.slice(0, 3).map(c => `${c.name} ${c.pct}%`).join(', ')}; top: ${t.frames.slice(0, 3).map(f => `${f.name} (${f.ms}ms)`).join(', ')}`));
    return [
      ...promptHeader(`threads over the last ${state.windowSec}s`),
      '| thread | now | avg | peak |',
      '|---|---|---|---|',
      ...rows.map(r => `| ${shortThreadName(r.lane.name)} | ${pctText(r.now)} | ${pctText(r.avg)} | ${pctText(r.peak)} |`),
      ...(hot.length ? ['', '## Latest native samples (hottest functions)', ...hot] : []),
      ...WHAT_TO_DO,
    ].join('\n');
  },
  console() {
    const lines = [...document.querySelectorAll('#console-list .grow[data-at]')].map(row => {
      const [time, level, text, count] = [...row.children].map(c => c.textContent.trim());
      return `${time} ${level}: ${text.replace(/\n+/g, ' ⏎ ').slice(0, 400)}${count ? ` (${count})` : ''}`;
    });
    return [...promptHeader(`console (${consoleFilter.level === 'all' ? 'all levels' : consoleFilter.level}${consoleFilter.search ? `, matching "${consoleFilter.search}"` : ''})`), '```', ...lines.slice(-200), '```', ...WHAT_TO_DO].join('\n');
  },
  network() {
    const slowMs = state.status?.settings?.slowRequestMs ?? 1000;
    const requests = state.requests.slice(-80);
    const issues = requests.filter(r => r.failed || r.ms >= slowMs);
    const line = r => `- ${clock(r.at)} ${r.method} ${r.url.slice(0, 200)} → ${r.failed ? `failed (${r.error ?? r.status})` : r.status} in ${r.ms}ms${r.bodySize != null ? `, ${r.bodySize >= 1024 ? `${Math.round(r.bodySize / 1024)} KB` : `${r.bodySize} B`}` : ''}${r.source?.file ? ` · from ${r.source.file}:${r.source.line}` : ''}`;
    return [
      ...promptHeader(`network (${requests.length} recent requests)`),
      ...(issues.length ? ['## Slow or failed', ...issues.map(line), ''] : []),
      '## All recent requests',
      ...requests.map(line),
      '',
      'Response bodies for any of these are available through the hitch_request MCP tool (by id) if you need them.',
      ...WHAT_TO_DO,
    ].join('\n');
  },
  memory() {
    const vitals = state.vitals.filter(v => v.heapUsed > 0 || v.rss > 0);
    if (!vitals.length) return null;
    const first = vitals[0];
    const last = vitals.at(-1);
    const range = key => {
      const vals = vitals.map(v => v[key]).filter(v => v != null);
      return vals.length ? `${mbText(Math.min(...vals))} – ${mbText(Math.max(...vals))}` : '—';
    };
    const events = [
      ...state.startups.map(st => `- ${clock(st.at)} ${st.kind}`),
      ...state.screens.map(sc => `- ${clock(sc.at)} screen ${sc.name}`),
      ...state.alerts.map(a => `- ${clock(a.at)} ${leakTitle(a)}`),
    ].sort();
    return [
      ...promptHeader(`memory from ${clock(first.at)} to ${clock(last.at)}`),
      `- JS heap: ${mbText(first.heapUsed)} → ${mbText(last.heapUsed)} (range ${range('heapUsed')})`,
      `- App memory: ${mbText(first.rss)} → ${mbText(last.rss)} (range ${range('rss')})`,
      `- Threads: ${first.threads ?? '—'} → ${last.threads ?? '—'}`,
      ...(events.length ? ['', '## Events', ...events] : []),
      ...(heapState.diff ? ['', `## Heap snapshot comparison (${heapState.diff.countDelta >= 0 ? '+' : ''}${heapState.diff.countDelta} objects)`, ...heapState.diff.grew.slice(0, 20).map(g => `- ${g.name}: +${g.count} objects, +${Math.round(g.size / 1024)} KB`)] : []),
      ...WHAT_TO_DO,
    ].join('\n');
  },
  react() {
    const data = lastReact;
    if (!data) return null;
    const commits = data.commits.filter(c => c.at >= Date.now() - 120000);
    const slow = commits.filter(c => c.ms >= 16);
    return [
      ...promptHeader('React rendering'),
      `## Commits in the last 2 minutes`,
      `${commits.length} commits, ${Math.round(commits.reduce((sum, c) => sum + c.ms, 0))}ms rendering; ${slow.length} took longer than a frame (16ms), the longest ${Math.round(Math.max(0, ...commits.map(c => c.ms)))}ms.`,
      '',
      '## Where render time went (last 2 minutes)',
      ...renderLines(data.summary),
      ...(data.avoidable.length ? ['', '## Avoidable re-renders during freezes this session', ...data.avoidable.slice(0, 15).map(a => `- ${a.name}: ${a.avoidable} of ${a.renders} renders — ${a.reason}`)] : []),
      ...WHAT_TO_DO,
    ].join('\n');
  },
  async runs() {
    const data = await fetch('/api/runs').then(r => (r.ok ? r.json() : null)).catch(() => null);
    if (!data?.runs.length) return null;
    return [
      ...promptHeader('recorded runs'),
      '| run | when | branch | JS blocked | freezes | choppy | errors | screens |',
      '|---|---|---|---|---|---|---|---|',
      ...data.runs.map(r => `| ${r.name} | ${r.startedAt} | ${r.git?.branch ?? ''}@${r.git?.commit ?? ''} | ${r.summary.blockedMs}ms | ${r.summary.stalls} | ${r.summary.jankSeconds}s | ${r.summary.errors} | ${r.summary.screens.map(sc => `${sc.name} ${(sc.ms / 1000).toFixed(1)}s`).join(', ')} |`),
      '',
      'Runs with the same name are the same interaction; compare them to judge whether a change helped.',
      ...WHAT_TO_DO,
    ].join('\n');
  },
};

async function copyView() {
  const text = await viewPrompts[state.view]?.();
  if (!text) {
    toast('Nothing to copy in this view yet.', 'warning');
    return;
  }
  await navigator.clipboard.writeText(text);
  toast(`Copied the ${state.view} page as a prompt.`, 'success');
}
// "Copy page as prompt" sits at the right of each view's title row: the first
// heading, or the toolbar row for Console and the bottom bar for Timeline.
function copyButtonFor() {
  const button = el('button', 'tb-btn view-copy', '<sl-icon name="clipboard-data"></sl-icon><span>Copy page as prompt</span>');
  button.type = 'button';
  button.title = 'Copy this page as a prompt for an AI agent (⇧⌘C)';
  button.addEventListener('click', copyView);
  return button;
}
function placeCopyButton(view) {
  const node = $(`#view-${view}`);
  const host = view === 'timeline' ? node.querySelector('.threads-foot') : view === 'console' ? node.querySelector('.view-tools') : node.querySelector('.view-body > h3');
  if (host && !host.querySelector('.view-copy')) host.append(copyButtonFor());
}
document.addEventListener('keydown', e => {
  if (e.key.toLowerCase() === 'c' && e.metaKey && e.shiftKey) {
    e.preventDefault();
    copyView();
  }
});

// ---------------------------------------------------------------- runs, opened

// An event from a saved run, shown read-only (it may be from another session).
function showSaved(event) {
  const root = openPage();
  headerType = event.type;
  const renderers = { stall: renderStallDetail, console: renderConsoleDetail, request: renderRequestDetail, jank: renderJankDetail, screen: renderScreenDetail, hot: renderHotDetail, startup: renderStartupDetail, leak: renderLeakDetail, threadleak: renderLeakDetail };
  renderers[event.type]?.(root, event);
  root.querySelector('.back')?.addEventListener('click', showList);
  setActions(JSON.stringify(event, null, 2));
}

async function showCompare(a, b) {
  const root = openPage();
  const pair = await fetch(`/api/runs/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!pair) {
    root.insertAdjacentHTML('beforeend', '<sl-alert open variant="warning"><sl-icon slot="icon" name="exclamation-triangle-fill"></sl-icon><strong>Couldn’t compare these runs.</strong> Restart Hitch if it was just updated.</sl-alert>');
    return;
  }
  const { before, after, comparison } = pair;
  const delta = after.summary.blockedMs - before.summary.blockedMs;
  const when = r => new Date(r.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const branch = r => (r.git?.branch ? ` · ${esc(r.git.branch)}@${esc(r.git.commit)}` : '');
  root.insertAdjacentHTML(
    'beforeend',
    `${header('<sl-badge variant="primary">Compare runs</sl-badge>', `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${Math.abs(delta)}`, 'ms JS blocked', `${esc(before.name)} → ${esc(after.name)}`)}
    <p class="d-summary">Overall: <strong>${esc(comparison.verdict)}</strong>. JS was blocked ${before.summary.blockedMs}ms in “${esc(before.name)}” and ${after.summary.blockedMs}ms in “${esc(after.name)}”${before.summary.blockedMs ? ` (${delta <= 0 ? '' : '+'}${Math.round((delta / before.summary.blockedMs) * 100)}%)` : ''}.</p>`,
  );
  root.querySelector('.back').addEventListener('click', showList);

  // Both runs as columns; the change on the right.
  const metric = (label, x, y, unit = '', lowerIsBetter = true) => {
    const change = x === y ? '<span style="color:var(--label-3)">≈</span>' : (y < x) === lowerIsBetter ? `<span class="delta better">${y < x ? '↓' : '↑'} ${Math.abs(y - x)}${unit}</span>` : `<span class="delta worse">${y < x ? '↓' : '↑'} ${Math.abs(y - x)}${unit}</span>`;
    return `<div class="grow cmp-row"><span>${label}</span><span class="num">${x ?? '—'}${unit}</span><span class="num">${y ?? '—'}${unit}</span><span class="num">${change}</span></div>`;
  };
  const b0 = before.summary;
  const a0 = after.summary;
  const screenNames = [...new Set([...b0.screens, ...a0.screens].map(sc => sc.name))];
  const screenMs = (sum, name) => sum.screens.find(sc => sc.name === name)?.ms;
  const table = section('Side by side', 'lower is better');
  table.insertAdjacentHTML(
    'beforeend',
    `<div class="gtable cmp-table">
      <div class="grow ghead cmp-row"><span></span><span class="num">${esc(before.name)}</span><span class="num">${esc(after.name)}</span><span class="num">Change</span></div>
      ${metric('JS blocked', b0.blockedMs, a0.blockedMs, 'ms')}
      ${metric('Freezes', b0.stalls, a0.stalls)}
      ${metric('Worst freeze', b0.worstStallMs, a0.worstStallMs, 'ms')}
      ${metric('Choppy seconds', b0.jankSeconds, a0.jankSeconds, 's')}
      ${metric('Dropped frames', b0.droppedFrames, a0.droppedFrames)}
      ${b0.renders && a0.renders ? metric('React render time', b0.renders.renderMs, a0.renders.renderMs, 'ms') + metric('Component mounts', b0.renders.mounts, a0.renders.mounts) + metric('Avoidable re-renders', b0.renders.avoidable, a0.renders.avoidable) : ''}
      ${screenNames.map(name => metric(`${esc(name)} screen load`, screenMs(b0, name), screenMs(a0, name), 'ms')).join('')}
      ${metric('Console errors', b0.errors, a0.errors)}
      ${metric('Slow requests', b0.slowRequests, a0.slowRequests)}
      ${metric('Failed requests', b0.failedRequests, a0.failedRequests)}
    </div>
    <p class="d-hint">${esc(before.name)}: ${when(before)}${branch(before)} · ${esc(after.name)}: ${when(after)}${branch(after)}</p>`,
  );
  root.append(table);

  // Where React time and blocked time went, in each run.
  const columns = (title, render) => {
    const node = section(title);
    node.insertAdjacentHTML('beforeend', `<div class="cmp-cols"><div><h4>${esc(before.name)}</h4>${render(before)}</div><div><h4>${esc(after.name)}</h4>${render(after)}</div></div>`);
    root.append(node);
  };
  const list = rows => (rows.length ? `<div class="gtable">${rows.join('')}</div>` : '<p class="d-hint">None.</p>');
  if (b0.renders || a0.renders) columns('Most React render time', r => list((r.summary.renders?.top ?? []).map(c => `<div class="grow" style="grid-template-columns:minmax(0,1fr) auto"><span class="name">${esc(c.name)}</span><span class="num">${c.ms}ms ×${c.renders}</span></div>`)));
  columns('Lines that blocked the JS thread', r => list((r.summary.offenders ?? []).map(o => `<div class="grow" style="grid-template-columns:minmax(0,1fr) auto"><span class="mono">${esc(o.where)}</span><span class="num">${o.blockedMs}ms</span></div>`)));

  const open = el('div', 'cmp-open');
  for (const r of [before, after]) {
    const b = el('sl-button', '', `Open “${esc(r.name)}”`);
    b.size = 'small';
    b.addEventListener('click', () => showRun(r.id));
    open.append(b);
  }
  root.append(open);
  const prompt = await fetch(`/api/prompt?compare=${encodeURIComponent(a)},${encodeURIComponent(b)}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  setActions(prompt?.prompt ?? `${before.name} → ${after.name}: ${comparison.verdict}`);
}

async function showRun(id) {
  const root = openPage();
  const found = await fetch(`/api/run?id=${encodeURIComponent(id)}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!found) {
    root.insertAdjacentHTML('beforeend', '<sl-alert open variant="warning"><sl-icon slot="icon" name="exclamation-triangle-fill"></sl-icon><strong>Couldn’t open this run.</strong> Restart Hitch if it was just updated.</sl-alert>');
    return;
  }
  const { run, previous, comparison } = found;
  const s = run.summary;
  const when = new Date(run.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  root.insertAdjacentHTML('beforeend', header(`<sl-badge variant="primary">Run · ${esc(run.name)}</sl-badge>`, s.blockedMs, 'ms JS blocked', `${when}${run.git?.branch ? ` · ${esc(run.git.branch)}@${esc(run.git.commit)}${run.git.dirty ? ' (uncommitted changes)' : ''}` : ''}${s.iterations ? ` · median of ${s.iterations} plays` : ''}`));
  root.querySelector('.back').addEventListener('click', showList);
  const stat = (k, v, sub = '') => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
  root.insertAdjacentHTML(
    'beforeend',
    `<div class="stat-row">
      ${stat('Freezes', s.stalls, `worst ${s.worstStallMs}ms${s.devOnlyMs ? ` · ${s.devOnlyMs}ms dev-only` : ''}`)}
      ${stat('Choppy', `${s.jankSeconds}s`, `${s.droppedFrames} frames dropped`)}
      ${stat('Errors', s.errors, `${s.warnings} warnings`)}
      ${s.renders ? stat('React', `${s.renders.renderMs}ms`, `${s.renders.avoidable} avoidable re-renders`) : stat('Requests', s.slowRequests + s.failedRequests, `${s.slowRequests} slow · ${s.failedRequests} failed`)}
    </div>`,
  );
  if (s.screens.length) root.insertAdjacentHTML('beforeend', `<p class="d-summary d-context">Screens: ${s.screens.map(sc => `${esc(sc.name)} ${(sc.ms / 1000).toFixed(1)}s`).join(' · ')}</p>`);

  if (comparison) {
    const node = section(`Compared with the previous “${esc(run.name)}”`, `${esc(previous.git?.branch ?? '')}@${esc(previous.git?.commit ?? '')} · ${new Date(previous.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`);
    const arrow = { better: '<span class="delta better">↓ better</span>', worse: '<span class="delta worse">↑ worse</span>', same: '<span style="color:var(--label-3)">≈ same</span>' };
    node.insertAdjacentHTML(
      'beforeend',
      `<p class="d-summary" style="margin-top:0">Overall: <strong>${esc(comparison.verdict)}</strong></p>
      <div class="gtable"><div class="grow ghead" style="grid-template-columns:minmax(0,1fr) 90px 90px 80px"><span>Measure</span><span class="num">Before</span><span class="num">This run</span><span></span></div>
      ${comparison.lines.map(l => `<div class="grow" style="grid-template-columns:minmax(0,1fr) 90px 90px 80px"><span>${esc(l.label)}</span><span class="num">${l.before}${l.unit}</span><span class="num">${l.after}${l.unit}</span><span class="num">${arrow[l.change]}</span></div>`).join('')}</div>`,
    );
    const open = el('sl-button', '', '<sl-icon slot="prefix" name="arrow-left-right"></sl-icon>Open the previous run');
    open.size = 'small';
    open.style.marginTop = '10px';
    open.addEventListener('click', () => showRun(previous.id));
    node.append(open);
    root.append(node);
  }

  if (s.offenders?.length) {
    const node = section('Lines that blocked the JS thread');
    node.insertAdjacentHTML('beforeend', `<div class="gtable">${s.offenders.map(o => `<div class="grow" style="grid-template-columns:minmax(0,1fr) 80px"><span class="mono">${esc(o.where)}</span><span class="num">${o.blockedMs}ms</span></div>`).join('')}</div>`);
    root.append(node);
  }

  if (run.detail) {
    renderRangeDetail(root, run.detail);
  } else {
    root.insertAdjacentHTML('beforeend', '<p class="d-hint" style="margin-top:16px">This run was recorded by an older Hitch, so only its numbers were saved. Runs recorded from now on keep every freeze, render, request and log.</p>');
  }
  const compareWith = el('sl-button', '', '<sl-icon slot="prefix" name="arrow-left-right"></sl-icon>Compare with…');
  compareWith.size = 'small';
  compareWith.style.marginTop = '22px';
  compareWith.style.marginRight = '8px';
  compareWith.addEventListener('click', () => {
    compareSel.clear();
    compareSel.add(id);
    setView('runs');
    showList();
    toast('Tick another run, then press Compare.');
  });
  root.append(compareWith);
  const del = el('sl-button', '', '<sl-icon slot="prefix" name="trash3"></sl-icon>Delete run');
  del.size = 'small';
  del.variant = 'text';
  del.className = 'delete-run';
  del.addEventListener('click', async () => {
    if (await deleteRun(id, run.name)) showList();
  });
  root.append(del);
  const prompt = await fetch(`/api/prompt?run=${encodeURIComponent(id)}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  setActions(prompt?.prompt ?? `Run "${run.name}": ${JSON.stringify(s)}`);
}

async function deleteRun(id, name) {
  const ok = await askText({ title: `Delete “${name}”?`, hint: 'The saved run is removed from ~/.hitch/runs. This can’t be undone.', confirm: true, danger: true, ok: 'Delete run' });
  if (!ok) return false;
  const res = await fetch(`/api/run?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).then(r => r.json()).catch(() => ({ error: 'Restart Hitch to delete runs.' }));
  if (res.error) {
    toast(res.error, 'danger');
    return false;
  }
  toast(`Deleted “${name}”.`, 'success');
  // The list on the left drops it straight away, wherever it was deleted from.
  compareSel.delete(id);
  if (state.view === 'runs') await refreshView('runs');
  return true;
}

// Runs picked for comparison (at most two; picking a third drops the oldest pick).
const compareSel = new Set();
function pickRun(id, on) {
  if (on) {
    compareSel.add(id);
    while (compareSel.size > 2) compareSel.delete(compareSel.values().next().value);
  } else compareSel.delete(id);
  viewRenderers.runs();
}

$('#view-runs').addEventListener('click', e => {
  const pick = e.target.closest('.run-pick');
  if (pick) {
    e.stopPropagation();
    pickRun(pick.dataset.run, pick.checked);
    return;
  }
  if (e.target.closest('#compare-go')) {
    const [a, b] = [...compareSel];
    showCompare(a, b);
    return;
  }
  if (e.target.closest('#compare-clear')) {
    compareSel.clear();
    viewRenderers.runs();
    return;
  }
  const del = e.target.closest('.run-delete');
  if (del) {
    e.stopPropagation();
    deleteRun(del.dataset.run, del.dataset.name);
    return;
  }
  const row = e.target.closest('.grow[data-run]');
  if (row?.dataset.run) showRun(row.dataset.run);
});

// ---------------------------------------------------------------- views

const VIEWS = ['timeline', 'threads', 'console', 'network', 'memory', 'react', 'runs'];
const viewRenderers = {};
let viewTimer = null;

function setView(view) {
  state.view = view;
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
  $('#view-select').value = view;
  $('#view-select-compact').value = view;
  clearInterval(viewTimer);
  if (view === 'timeline') {
    layoutAt = 0;
    placeCopyButton('timeline');
    return;
  }
  refreshView(view);
  // Live views refresh while shown; runs only change when a run ends.
  if (view !== 'runs') viewTimer = setInterval(() => refreshView(view), view === 'react' ? 2000 : 1000);
}

// Re-renders a view without losing where it was scrolled to.
async function refreshView(view) {
  const node = $(`#view-${view}`);
  const scrolled = node.querySelector('.view-body')?.scrollTop ?? 0;
  await viewRenderers[view]();
  placeCopyButton(view);
  const body = node.querySelector('.view-body');
  if (body && body.scrollTop !== scrolled) body.scrollTop = scrolled;
}
$('#view-select').addEventListener('sl-change', e => setView(e.target.value));
$('#view-select-compact').addEventListener('sl-change', e => setView(e.target.value));

// Jumps the timeline to a moment (pausing it there), e.g. from a log line.
function jumpTo(at) {
  if (!state.paused) togglePause();
  state.pausedAt = Math.min(Date.now(), at + (state.windowSec * 1000) / 2);
  setView('timeline');
}

const sparkline = (values, color, width = 140, height = 24) => {
  if (values.length < 2) return '';
  const step = width / (values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 1 - v * (height - 3)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><polyline points="0,${height} ${points} ${width},${height}" fill="${color}" fill-opacity="0.18" stroke="none"/><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>`;
};

const emptyView = (title, text) => `<div class="view-empty"><strong>${esc(title)}</strong>${esc(text)}</div>`;

// Threads: every thread with its CPU now, on average, at peak, and a sparkline.
viewRenderers.threads = () => {
  const now = Date.now();
  const from = now - state.windowSec * 1000;
  const BUCKETS = 40;
  const rows = [...state.lanes.values()].map(lane => {
    const recent = lane.points.filter(([at]) => at >= from);
    const buckets = Array.from({ length: BUCKETS }, (_, i) => {
      const b0 = from + (i * (now - from)) / BUCKETS;
      const b1 = from + ((i + 1) * (now - from)) / BUCKETS;
      const inside = recent.filter(([at]) => at > b0 && at <= b1);
      return inside.length ? inside.reduce((sum, p) => sum + p[2], 0) / inside.length : 0;
    });
    return { lane, avg: busyBetween(lane, from, now), now: busyBetween(lane, now - 1000, now), peak: Math.max(0, ...recent.map(p => p[2])), buckets };
  });
  rows.sort((a, b) => (PINNED.includes(b.lane.name) - PINNED.includes(a.lane.name)) || b.avg - a.avg);
  const active = rows.filter(r => r.peak > 0.004 || PINNED.includes(r.lane.name));
  const idle = rows.length - active.length;
  const view = $('#view-threads');
  if (!rows.length) {
    view.innerHTML = emptyView('No threads yet', state.status?.native ? 'Waiting for the first readings.' : 'Thread readings need the app running in the iOS simulator (or Android over adb).');
    return;
  }
  const pct = v => `${Math.round(v * 100)}%`;
  view.innerHTML = `<div class="view-body">
    <h3>Threads <small>last ${state.windowSec}s · ${active.length} active, ${idle} idle</small></h3>
    <div class="gtable threads-table">
      <div class="grow ghead"><span>Thread</span><span class="num">Now</span><span class="num">Avg</span><span class="num">Peak</span><span>Last ${state.windowSec}s</span></div>
      ${active
        .map(
          r => `<div class="grow clickable" data-thread="${esc(r.lane.name)}" title="${esc(threadInfo(r.lane.name))}"><span class="name"><i style="background:${r.lane.color}"></i>${esc(shortThreadName(r.lane.name))}</span>
          <span class="num">${pct(r.now)}</span><span class="num">${pct(r.avg)}</span><span class="num">${pct(r.peak)}</span>${sparkline(r.buckets, r.lane.color)}</div>`,
        )
        .join('')}
    </div>
    ${idle ? `<p class="view-caption" style="margin-top:10px">${idle} more thread${idle === 1 ? ' was' : 's were'} idle the whole time.</p>` : ''}
  </div>`;
};

// Console: every line the app logged, not just warnings and errors.
const consoleFilter = { level: 'all', search: '' };
$('#console-level').addEventListener('sl-change', e => {
  consoleFilter.level = e.target.value;
  viewRenderers.console();
});
$('#console-search').addEventListener('sl-input', e => {
  consoleFilter.search = e.target.value.toLowerCase();
  viewRenderers.console();
});
viewRenderers.console = () => {
  const list = $('#console-list');
  const keepBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const lines = [
    ...state.consoleEvents.map(c => ({ ...c, kind: c.level === 'error' ? 'error' : 'warn' })),
    ...state.logs.map(l => ({ ...l, kind: l.level === 'debug' ? 'debug' : l.level === 'info' ? 'info' : 'log' })),
  ]
    .filter(l => consoleFilter.level === 'all' || (consoleFilter.level === 'log' ? ['log', 'info', 'debug'].includes(l.kind) : l.kind === consoleFilter.level))
    .filter(l => !consoleFilter.search || l.text.toLowerCase().includes(consoleFilter.search))
    .sort((a, b) => a.at - b.at)
    .slice(-400);
  if (!lines.length) {
    list.innerHTML = emptyView('Nothing logged yet', consoleFilter.search || consoleFilter.level !== 'all' ? 'Nothing matches this filter.' : 'Console output from the app shows up here as it happens.');
    return;
  }
  list.innerHTML = `<div class="gtable console-table">${lines
    .map(
      l => `<div class="grow clickable" data-id="${l.id}" data-at="${l.at}" data-finding="${l.type === 'console' ? 1 : ''}" title="${l.type === 'console' ? 'Open this finding' : 'Show this moment on the timeline'}">
        <span class="time">${clock(l.at)}</span><span class="lvl ${l.kind}">${l.kind === 'warn' ? 'warning' : l.kind}</span>
        <span class="text clip">${esc(l.text.slice(0, 1200))}</span>${l.count > 1 ? `<span class="count">×${l.count}</span>` : '<span></span>'}</div>`,
    )
    .join('')}</div>`;
  if (keepBottom) list.scrollTop = list.scrollHeight;
};
$('#console-list').addEventListener('click', e => {
  const row = e.target.closest('.grow[data-at]');
  if (!row) return;
  if (row.dataset.finding) select(Number(row.dataset.id));
  else showLog(Number(row.dataset.id));
});

// Network: a waterfall of recent requests.
let networkKey = '';
viewRenderers.network = () => {
  const view = $('#view-network');
  const requests = state.requests.slice(-120);
  // Nothing new since the last refresh: leave the list (and its scroll) alone.
  const key = `${requests.length}:${requests.at(-1)?.id ?? ''}:${requests.at(-1)?.bodySize ?? ''}`;
  if (key === networkKey && view.querySelector('.view-body')) return;
  networkKey = key;
  if (!requests.length) {
    view.innerHTML = emptyView('No requests yet', 'XHR and axios requests appear here. Expo’s native fetch isn’t reported by the app.');
    return;
  }
  const start = Math.min(...requests.map(r => r.at));
  const end = Math.max(...requests.map(r => r.at + r.ms));
  const span = Math.max(1, end - start);
  const slowMs = state.status?.settings?.slowRequestMs ?? 1000;
  const failed = requests.filter(r => r.failed).length;
  const slow = requests.filter(r => !r.failed && r.ms >= slowMs).length;
  view.innerHTML = `<div class="view-body">
    <h3>Requests <small>${requests.length} recent · ${slow} slow · ${failed} failed</small></h3>
    <div class="gtable net-table">
      <div class="grow ghead"><span>Request</span><span class="num">Status</span><span class="num">Time</span><span>${clock(start)} – ${clock(end)}</span></div>
      ${[...requests]
        .reverse()
        .map(r => {
          const left = ((r.at - start) / span) * 100;
          const width = (r.ms / span) * 100;
          const kind = r.failed ? 'failed' : r.ms >= slowMs ? 'slow' : '';
          return `<div class="grow clickable" data-id="${r.id}" title="${esc(r.method)} ${esc(r.url)}"><span class="mono">${esc(r.method)} ${esc(shortUrl(r.url))}</span>
            <span class="num">${r.failed ? esc(r.status ?? 'failed') : esc(r.status ?? '—')}</span><span class="num">${r.ms >= 1000 ? `${(r.ms / 1000).toFixed(1)}s` : `${r.ms}ms`}</span>
            <span class="wf"><b class="${kind}" style="left:${left.toFixed(2)}%;width:${Math.max(0.4, width).toFixed(2)}%"></b></span></div>`;
        })
        .join('')}
    </div></div>`;
};
$('#view-network').addEventListener('click', e => {
  const id = Number(e.target.closest('.grow[data-id]')?.dataset.id);
  if (id) select(id);
});

// Memory: the whole session's JS heap, app memory and threads, with markers.
const heapState = { snapshots: [], diff: null, busy: false, before: null, after: null };
viewRenderers.memory = () => {
  const view = $('#view-memory');
  const vitals = state.vitals.filter(v => v.heapUsed > 0 || v.rss > 0);
  if (vitals.length < 2) {
    view.innerHTML = emptyView('Collecting memory readings', 'Readings arrive every 2 seconds.');
    return;
  }
  if (view.contains(document.activeElement) && document.activeElement.closest('sl-select, sl-input')) return;
  const W = 640;
  const H = 220;
  const t0 = vitals[0].at;
  const t1 = vitals.at(-1).at;
  const x = t => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const maxMem = Math.max(...vitals.map(v => Math.max(v.heapUsed ?? 0, v.rss ?? 0))) * 1.08;
  const y = b => H - (b / maxMem) * H;
  const threadVals = vitals.map(v => v.threads).filter(v => v != null);
  const maxThreads = Math.max(1, ...threadVals) * 1.15;
  const line = (key, color, scale) => {
    const pts = vitals.filter(v => v[key] != null).map(v => `${x(v.at).toFixed(1)},${scale(v[key]).toFixed(1)}`);
    return pts.length > 1 ? `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>` : '';
  };
  const marks = [
    ...state.startups.map(st => ({ at: st.at, color: COLORS.ui, label: st.kind === 'reload' ? 'reload' : 'launch' })),
    ...state.screens.map(sc => ({ at: sc.at, color: INK.muted, label: sc.name })),
    ...state.alerts.map(a => ({ at: a.at, color: COLORS.severe, label: 'leak' })),
  ].filter(m => m.at >= t0 && m.at <= t1);
  const gridLines = [0.25, 0.5, 0.75, 1].map(f => `<line class="grid" x1="0" x2="${W}" y1="${(H - f * H).toFixed(1)}" y2="${(H - f * H).toFixed(1)}"/><text x="${W + 6}" y="${(H - f * H + 3).toFixed(1)}">${fmtMb(maxMem * f)}</text>`).join('');
  const last = vitals.at(-1);
  const minmax = key => {
    const vals = vitals.map(v => v[key]).filter(v => v != null);
    return vals.length ? [Math.min(...vals), Math.max(...vals)] : null;
  };
  const stat = (k, v, range) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${range}</div></div>`;
  const heapRange = minmax('heapUsed');
  const rssRange = minmax('rss');
  const threadRange = minmax('threads');
  view.innerHTML = `<div class="view-body">
    <h3>Memory <small>${clock(t0)} – ${clock(t1)}</small></h3>
    <div class="chart-card">
      <svg class="chart" viewBox="0 0 ${W + 44} ${H + 18}">
        ${gridLines}
        ${markLines(marks, x, H)}
        ${line('rss', COLORS.ui, y)}
        ${line('heapUsed', COLORS.js, y)}
        ${line('threads', INK.muted, v => H - (v / maxThreads) * H)}
        <text x="0" y="${H + 14}">${clock(t0)}</text><text x="${W}" y="${H + 14}" text-anchor="end">${clock(t1)}</text>
      </svg>
      <div class="legend-row"><span><i style="background:${COLORS.js}"></i>JS heap</span><span><i style="background:${COLORS.ui}"></i>App memory</span><span><i style="background:${INK.muted}"></i>Threads (own scale)</span><span>Dashed lines: launches and reloads, screens, leak alerts</span></div>
    </div>
    <div class="stat-row">
      ${heapRange ? stat('JS heap', fmtMb(last.heapUsed), `${fmtMb(heapRange[0])} – ${fmtMb(heapRange[1])}`) : ''}
      ${rssRange ? stat('App memory', fmtMb(last.rss), `${fmtMb(rssRange[0])} – ${fmtMb(rssRange[1])}`) : ''}
      ${threadRange ? stat('Threads', last.threads ?? '—', `${threadRange[0]} – ${threadRange[1]}`) : ''}
    </div>
    <h3>Heap snapshots <small>what kinds of objects grew between two moments</small></h3>
    <p class="view-caption">Take one, open and leave a screen a few times, take another, then compare. Each snapshot freezes the app for a few seconds.</p>
    <div class="heap-tools">
      <sl-button size="small" variant="primary" id="heap-take" ${heapState.busy ? 'loading' : ''}><sl-icon slot="prefix" name="camera"></sl-icon>Take snapshot</sl-button>
      ${heapState.snapshots.length > 1 ? `<sl-select size="small" id="heap-before" value="${esc(heapState.before ?? heapState.snapshots.at(-2).label)}" hoist>${heapState.snapshots.map(h => `<sl-option value="${esc(h.label)}">${esc(h.label)}</sl-option>`).join('')}</sl-select>
      <sl-icon name="arrow-right"></sl-icon>
      <sl-select size="small" id="heap-after" value="${esc(heapState.after ?? heapState.snapshots.at(-1).label)}" hoist>${heapState.snapshots.map(h => `<sl-option value="${esc(h.label)}">${esc(h.label)}</sl-option>`).join('')}</sl-select>
      <sl-button size="small" id="heap-compare">Compare</sl-button>` : ''}
    </div>
    ${heapState.snapshots.length ? `<p class="view-caption" style="margin-top:8px">${heapState.snapshots.map(h => `${esc(h.label)}: ${fmtMb(h.size)} at ${clock(h.at)}`).join(' · ')}</p>` : ''}
    ${
      heapState.diff
        ? `<div class="gtable heap-table" style="margin-top:8px"><div class="grow ghead"><span>Grew the most (${heapState.diff.countDelta >= 0 ? '+' : ''}${heapState.diff.countDelta} objects, ${heapState.diff.sizeDelta >= 0 ? '+' : '−'}${fmtMb(Math.abs(heapState.diff.sizeDelta))})</span><span class="num">Objects</span><span class="num">Size</span></div>
          ${heapState.diff.grew.slice(0, 15).map(g => `<div class="grow"><span class="mono">${esc(g.name)}</span><span class="num">+${g.count}</span><span class="num">+${Math.round(g.size / 1024)} KB</span></div>`).join('')}</div>`
        : ''
    }
  </div>`;
  $('#heap-take').addEventListener('click', async () => {
    const label = await askText({ title: 'Take a heap snapshot', hint: 'The app freezes for a few seconds while the snapshot is written.', value: heapState.snapshots.length ? 'after' : 'before', ok: 'Take snapshot' });
    if (!label) return;
    heapState.busy = true;
    viewRenderers.memory();
    const res = await post('/api/heap/snapshot', { label });
    heapState.busy = false;
    if (res.error) toast(`Snapshot failed: ${res.error}`, 'danger');
    else heapState.snapshots = (await fetch('/api/heap').then(r => r.json())).snapshots;
    viewRenderers.memory();
  });
  $('#heap-before')?.addEventListener('sl-change', e => (heapState.before = e.target.value));
  $('#heap-after')?.addEventListener('sl-change', e => (heapState.after = e.target.value));
  $('#heap-compare')?.addEventListener('click', async () => {
    const res = await fetch(`/api/heap/diff?before=${encodeURIComponent($('#heap-before').value)}&after=${encodeURIComponent($('#heap-after').value)}`).then(r => r.json());
    if (res.error) toast(res.error, 'danger');
    else heapState.diff = res;
    viewRenderers.memory();
  });
};

// Dashed marker lines; a label is skipped when it would run into the previous one.
function markLines(marks, x, H) {
  let labelEnd = -Infinity;
  return [...marks]
    .sort((a, b) => a.at - b.at)
    .map(m => {
      const px = x(m.at);
      const fits = px >= labelEnd + 4;
      if (fits) labelEnd = px + 3 + m.label.length * 5.6;
      return `<line x1="${px.toFixed(1)}" x2="${px.toFixed(1)}" y1="0" y2="${H}" stroke="${m.color}" stroke-dasharray="3 3" stroke-opacity="0.6"/>${fits ? `<text x="${(px + 3).toFixed(1)}" y="10">${esc(m.label)}</text>` : ''}`;
    })
    .join('');
}

// React: commits over time, where render time went, and avoidable re-renders.
viewRenderers.react = async () => {
  const view = $('#view-react');
  const data = await fetch('/api/react?seconds=120').then(r => (r.ok ? r.json() : null)).catch(() => null);
  lastReact = data;
  if (state.view !== 'react') return;
  if (!data) {
    view.innerHTML = emptyView('Restart Hitch to use this view', 'This view needs data from a newer Hitch than the one running. Quit and reopen Hitch.app (or restart hitch in the terminal).');
    return;
  }
  if (data.probe !== 'on' && !data.commits.length) {
    view.innerHTML = emptyView('React probe not running', data.probe === 'no-hook' ? 'The app has no React DevTools hook (only dev builds have it).' : 'It starts when Hitch attaches to a dev build through Metro.');
    return;
  }
  const W = 640;
  const H = 120;
  const now = Date.now();
  const t0 = now - 120000;
  const commits = data.commits.filter(c => c.at >= t0);
  const maxMs = Math.max(16, ...commits.map(c => c.ms));
  const bars = commits
    .map(c => {
      const bx = ((c.at - t0) / 120000) * W;
      const bh = Math.max(1.5, (c.ms / maxMs) * H);
      const color = c.ms >= 50 ? COLORS.severe : c.ms >= 16 ? COLORS.stall : COLORS.ui;
      return `<rect x="${bx.toFixed(1)}" y="${(H - bh).toFixed(1)}" width="3" height="${bh.toFixed(1)}" rx="1" fill="${color}"><title>${clock(c.at)} · ${c.ms}ms · ${c.rendered} renders · ${c.mounts} mounts</title></rect>`;
    })
    .join('');
  const frameLine = H - (16 / maxMs) * H;
  const body = el('div', 'view-body');
  body.innerHTML = `<h3>React commits <small>last 2 minutes · ${commits.length} commits · ${Math.round(commits.reduce((s2, c) => s2 + c.ms, 0))}ms rendering</small></h3>
    <div class="chart-card">
      <svg class="chart" viewBox="0 0 ${W + 44} ${H + 18}">
        <line class="grid" x1="0" x2="${W}" y1="${H}" y2="${H}"/>
        ${maxMs > 16 ? `<line x1="0" x2="${W}" y1="${frameLine.toFixed(1)}" y2="${frameLine.toFixed(1)}" stroke="${COLORS.stall}" stroke-dasharray="3 3" stroke-opacity="0.6"/><text x="${W + 6}" y="${(frameLine + 3).toFixed(1)}">16ms</text>` : ''}
        <text x="${W + 6}" y="8">${Math.round(maxMs)}ms</text>
        ${bars}
        <text x="0" y="${H + 14}">−2m</text><text x="${W}" y="${H + 14}" text-anchor="end">now</text>
      </svg>
      <div class="legend-row"><span>Each bar is one commit: how long React spent rendering it.</span><span><i style="background:${COLORS.stall}"></i>over a frame (16ms)</span><span><i style="background:${COLORS.severe}"></i>over 50ms</span></div>
    </div>`;
  const summary = rendersSection(data.summary, 'Where render time went', 'last 2 minutes');
  if (summary) body.append(summary);
  if (data.avoidable.length) {
    const node = section('Avoidable re-renders', 'during freezes this session');
    node.insertAdjacentHTML(
      'beforeend',
      `<div class="gtable"><div class="grow ghead" style="grid-template-columns:minmax(0,1fr) 120px"><span>Component and why</span><span class="num">Avoidable</span></div>${data.avoidable
        .slice(0, 12)
        .map(a => `<div class="grow" style="grid-template-columns:minmax(0,1fr) 120px"><span><span class="name">${esc(a.name)}</span><span style="color:var(--label-2);font-size:12px">${esc(a.reason)}</span></span><span class="num">${a.avoidable} of ${a.renders}</span></div>`)
        .join('')}</div>`,
    );
    body.append(node);
  }
  const scrolled = view.querySelector('.view-body')?.scrollTop ?? 0;
  view.replaceChildren(body);
  body.scrollTop = scrolled;
};

// Runs: recorded runs and how each compares with the previous of its name.
viewRenderers.runs = async () => {
  const view = $('#view-runs');
  const data = await fetch('/api/runs').then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!data) {
    view.innerHTML = emptyView('Restart Hitch to use this view', 'Quit and reopen Hitch.app so its server has the runs data.');
    return;
  }
  if (!data.runs.length) {
    view.innerHTML = emptyView('No runs yet', 'Use Record in the toolbar around an interaction (open a screen, scroll). Runs with the same name are compared.');
    return;
  }
  const previous = new Map();
  const rows = data.runs.map(run => {
    const before = previous.get(run.name);
    previous.set(run.name, run);
    return { run, before };
  });
  const delta = (a, b, unit = '') => {
    if (a == null || a === b) return '';
    const better = b < a;
    const change = Math.abs(b - a) >= Math.max(1, Math.abs(a) * 0.1);
    return change ? ` <span class="delta ${better ? 'better' : 'worse'}">${better ? '↓' : '↑'}${Math.abs(b - a)}${unit}</span>` : '';
  };
  view.innerHTML = `<div class="view-body">
    <h3>Runs <small>${data.runs.length} saved${data.active ? ` · recording “${esc(data.active.name)}”` : ''}</small></h3>
    <p class="view-caption">Arrows compare each run with the previous run of the same name; lower is better. Tick any two runs to compare them.</p>
    <div class="compare-bar" ${compareSel.size ? '' : 'hidden'}><span>${compareSel.size === 2 ? 'Two runs picked.' : compareSel.size === 1 ? 'Pick one more run to compare.' : ''}</span><sl-button size="small" variant="primary" id="compare-go" ${compareSel.size === 2 ? '' : 'disabled'}><sl-icon slot="prefix" name="arrow-left-right"></sl-icon>Compare</sl-button><sl-button size="small" variant="text" id="compare-clear">Clear</sl-button></div>
    <div class="gtable runs-table">
      <div class="grow ghead"><span></span><span>Run</span><span class="num">JS blocked</span><span class="num">Freezes</span><span class="num">Choppy</span><span class="num">Errors</span><span></span></div>
      ${rows
        .reverse()
        .map(({ run, before }) => {
          const s2 = run.summary;
          const b = before?.summary;
          return `<div class="grow clickable${compareSel.has(run.id) ? ' picked' : ''}" data-run="${esc(run.id ?? '')}"><input type="checkbox" class="run-pick" aria-label="Pick ${esc(run.name)} to compare" data-run="${esc(run.id ?? '')}" ${compareSel.has(run.id) ? 'checked' : ''} /><span><span class="name">${esc(run.name)}${s2.iterations ? ` <small style="color:var(--label-3)">median of ${s2.iterations}</small>` : ''}</span><span style="color:var(--label-2);font-size:11.5px">${new Date(run.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${run.git?.branch ? ` · ${esc(run.git.branch)}@${esc(run.git.commit)}` : ''}</span></span>
            <span class="num">${s2.blockedMs}ms${delta(b?.blockedMs, s2.blockedMs, 'ms')}</span><span class="num">${s2.stalls}${delta(b?.stalls, s2.stalls)}</span><span class="num">${s2.jankSeconds}s${delta(b?.jankSeconds, s2.jankSeconds, 's')}</span><span class="num">${s2.errors}${delta(b?.errors, s2.errors)}</span><button class="tb-btn run-delete" type="button" title="Delete this run" aria-label="Delete run ${esc(run.name)}" data-run="${esc(run.id ?? '')}" data-name="${esc(run.name)}"><sl-icon name="trash3"></sl-icon></button></div>`;
        })
        .join('')}
    </div></div>`;
};

placeCopyButton('timeline');
placeCopyButton('console');
setInterval(trimLanes, 5000);
connect();
requestAnimationFrame(draw);
