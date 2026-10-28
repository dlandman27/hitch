// What React rendered, why, and how smooth frames were: a small probe Hitch
// installs in the app's JS through the debugger (no app code changes). It
// listens on the React DevTools hook that dev builds already load, so it sees
// every commit: which components rendered or mounted, their render time, and
// for re-renders the reason (state, store, context, or props, and whether
// those props were only new objects with equal values). It also counts
// animation frames while React is busy and notes the focused navigation screen.
//
// The probe only buffers; Hitch reads it every couple of seconds (`poll`).
// Idle apps pay nothing: no commits means no work and no frame callback.

// Runs inside the app (Hermes). Plain ES2015, no imports, never throws into React.
export const PROBE_SOURCE = String.raw`(function () {
  var g = globalThis;
  if (g.__HITCH__ && g.__HITCH__.version === 3) { g.__HITCH__.resume(); return 'ok'; }
  // An older probe from an earlier Hitch: take its place.
  if (g.__HITCH__ && g.__HITCH__.stop) { try { g.__HITCH__.stop(); } catch (e) {} }
  var hook = g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook || typeof hook.onCommitFiberRoot !== 'function') return 'no-hook';

  var COMPONENT = { 0: 1, 1: 1, 11: 1, 14: 1, 15: 1 };
  var MAX_COMMITS = 120, MAX_PER_COMMIT = 1500, MAX_DIFFED = 200, MAX_ROWS = 40;
  // Big components (a screen-level sheet with many custom hooks) run past 100
  // hooks; checking only the first few blamed their own updates on the parent.
  var MAX_HOOKS = 300;
  var FRAME_IDLE_MS = 2000;
  var on = true;
  var commits = [];
  var screens = [];
  var screen = null, screenNav = null, screenDepth = 0;
  var frames = {};
  var lastCommitAt = 0, rafRunning = false, lastFrameAt = 0;

  function nameOf(f) {
    var t = f.type;
    if (!t || typeof t === 'string') return null;
    var n = t.displayName || t.name;
    if (!n && t.render) n = t.render.displayName || t.render.name;
    if (!n && t.type) n = t.type.displayName || t.type.name || (t.type.render && (t.type.render.displayName || t.type.render.name));
    return n || 'Anonymous';
  }

  function deepEq(a, b, depth) {
    if (a === b) return true;
    if (typeof a === 'function' && typeof b === 'function') return a.name === b.name;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || depth <= 0) return false;
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length || a.length > 50) return false;
      for (var i = 0; i < a.length; i++) if (!deepEq(a[i], b[i], depth - 1)) return false;
      return true;
    }
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length || ka.length > 50) return false;
    for (var j = 0; j < ka.length; j++) {
      var k = ka[j];
      if (k === '_owner' || k === '_store') continue;
      if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEq(a[k], b[k], depth - 1)) return false;
    }
    return true;
  }

  // 'fn' new function, same name; 'el' new JSX element, same props;
  // 'equal' new object/array, equal values; 'diff' a real change.
  function kindOf(a, b) {
    if (typeof a === 'function' && typeof b === 'function') return a.name === b.name ? 'fn' : 'diff';
    if (a && b && typeof a === 'object' && typeof b === 'object' && a.$$typeof && b.$$typeof) {
      return a.type === b.type && deepEq(a.props, b.props, 2) ? 'el' : 'diff';
    }
    return deepEq(a, b, 3) ? 'equal' : 'diff';
  }

  function isEffect(h) {
    var s = h.memoizedState;
    return s && typeof s === 'object' && 'create' in s && 'tag' in s;
  }

  function reasonOf(f) {
    var prev = f.alternate;
    var bits = [], hooksCut = false;
    if (f.tag === 1) {
      if (prev.memoizedState !== f.memoizedState) bits.push('state');
    } else {
      var a = prev.memoizedState, b = f.memoizedState, i = 0;
      while (a && b && i < MAX_HOOKS) {
        if (b.queue && a.memoizedState !== b.memoizedState && !isEffect(b)) {
          bits.push(b.queue.getSnapshot ? 'store #' + i : 'state #' + i);
        }
        a = a.next; b = b.next; i++;
      }
      hooksCut = !!(a && b);
    }
    var dep = f.dependencies && f.dependencies.firstContext;
    var pdep = prev.dependencies && prev.dependencies.firstContext;
    while (dep && pdep) {
      if (dep.memoizedValue !== pdep.memoizedValue) {
        var ctx = dep.context;
        bits.push('context ' + ((ctx && (ctx.displayName || (ctx.Provider && ctx.Provider.displayName))) || '?'));
      }
      dep = dep.next; pdep = pdep.next;
    }
    var pp = prev.memoizedProps, np = f.memoizedProps;
    if (pp !== np && pp && np && typeof pp === 'object') {
      var changed = [], avoidable = true, seen = {};
      var keys = Object.keys(pp).concat(Object.keys(np));
      for (var k = 0; k < keys.length && changed.length < 6; k++) {
        var key = keys[k];
        if (seen[key]) continue;
        seen[key] = 1;
        if (pp[key] === np[key]) continue;
        var kd = kindOf(pp[key], np[key]);
        if (kd === 'diff') avoidable = false;
        changed.push(key + ':' + kd);
      }
      if (!changed.length) bits.push('parent (equal props)');
      else bits.push((avoidable ? 'props~ ' : 'props ') + changed.join(','));
    }
    if (bits.length) return bits.join(' + ');
    if (pp !== np) return 'parent';
    // Same props object, so the parent didn't cause it: an update the probe couldn't see.
    return hooksCut ? 'hooks past #' + MAX_HOOKS : 'own update';
  }

  function focusedRoute(f) {
    var p = f.memoizedProps;
    if (!p || !p.route || typeof p.route.name !== 'string' || !p.navigation || !p.navigation.isFocused) return false;
    try { return p.navigation.isFocused(); } catch (e) { return false; }
  }
  function depthOf(f) {
    var d = 0;
    while (f && d < 2000) { f = f.return; d++; }
    return d;
  }
  function stillFocused() {
    try { return screenNav && screenNav.isFocused(); } catch (e) { return false; }
  }

  function onCommit(root) {
    var started = Date.now();
    var rows = {}, rendered = 0, mounts = 0, diffed = 0, focused = null;
    var keepScreen = stillFocused();
    var stack = [root.current];
    while (stack.length && rendered < MAX_PER_COMMIT) {
      var f = stack.pop();
      var alt = f.alternate;
      if (COMPONENT[f.tag] && (!alt || (f.flags & 1))) {
        var name = nameOf(f);
        var row = rows[name] || (rows[name] = { n: 0, ms: 0, m: 0, why: {} });
        var self = f.actualDuration || 0;
        var c = f.child;
        while (c) { self -= c.actualDuration || 0; c = c.sibling; }
        row.n++; row.ms += Math.max(0, self); rendered++;
        if (!alt) { row.m++; mounts++; }
        else if (diffed < MAX_DIFFED) { diffed++; var r = reasonOf(f); row.why[r] = (row.why[r] || 0) + 1; }
      }
      // The focused screen is the deepest focused route: nested navigators
      // (tabs inside a stack) are focused too, so depth decides.
      if (f.tag !== 6 && focusedRoute(f)) {
        var d = depthOf(f);
        if ((!focused || d > focused.depth) && (!keepScreen || d > screenDepth)) focused = { depth: d, fiber: f };
      }
      // A subtree React skipped keeps its old child pointer: nothing below rendered.
      if (f.child && !(alt && alt.child === f.child)) {
        var ch = f.child;
        while (ch) { stack.push(ch); ch = ch.sibling; }
      }
    }
    var list = [];
    for (var n in rows) list.push([n, rows[n].n, Math.round(rows[n].ms * 10) / 10, rows[n].m, rows[n].why]);
    list.sort(function (x, y) { return y[2] - x[2]; });
    var now = Date.now();
    commits.push({ at: now, ms: Math.round((root.current.actualDuration || 0) * 10) / 10, rendered: rendered, mounts: mounts, rows: list.slice(0, MAX_ROWS), probeMs: now - started });
    if (commits.length > MAX_COMMITS) commits.shift();
    if (focused) {
      var p = focused.fiber.memoizedProps;
      screenNav = p.navigation;
      screenDepth = focused.depth;
      if (p.route.name !== screen) { screen = p.route.name; screens.push({ at: now, name: screen }); }
    }
    lastCommitAt = now;
    if (!rafRunning && typeof requestAnimationFrame === 'function') { rafRunning = true; lastFrameAt = 0; requestAnimationFrame(frame); }
  }

  // Frame gaps while React is active. A late frame's missed frames are spread
  // over the seconds the gap spanned, so a freeze's time stays in its own
  // seconds (where Hitch subtracts it); gaps that long aren't "worst hitch".
  function bucket(at) {
    var sec = Math.floor(at / 1000);
    return frames[sec] || (frames[sec] = [0, 0, 0]);
  }
  function frame() {
    var now = Date.now();
    if (lastFrameAt) {
      var gap = now - lastFrameAt;
      bucket(now)[0]++;
      if (gap > 25) {
        var t = lastFrameAt;
        while (t < now) {
          var end = Math.min((Math.floor(t / 1000) + 1) * 1000, now);
          bucket(t)[1] += (end - t) / 16.7;
          t = end;
        }
        bucket(now)[1] -= 1;
      }
      if (gap < 250 && gap > bucket(now)[2]) bucket(now)[2] = gap;
    }
    lastFrameAt = now;
    if (on && now - lastCommitAt < FRAME_IDLE_MS) requestAnimationFrame(frame);
    else { rafRunning = false; lastFrameAt = 0; }
  }

  var original = hook.onCommitFiberRoot;
  function wrapped(id, root) {
    var result = original.apply(this, arguments);
    if (on) { try { onCommit(root); } catch (e) {} }
    return result;
  }
  hook.onCommitFiberRoot = wrapped;
  // DevTools connecting later swaps in its own handler: stay on top of it.
  var guard = setInterval(function () {
    if (on && hook.onCommitFiberRoot !== wrapped) { original = hook.onCommitFiberRoot; hook.onCommitFiberRoot = wrapped; }
  }, 2000);

  // Requests made with a fetch the debugger can't see (Expo's native fetch,
  // or any non-polyfill fetch): recorded here instead. React Native's own
  // fetch is a polyfill over XHR, which its network agent already reports,
  // so it's left alone and nothing is counted twice.
  var NET_MAX = 200, BODY_MAX = 262144, REQ_BODY_MAX = 65536;
  var requests = [];
  var originalFetch = g.fetch;
  function headersOf(h) {
    var out = {};
    try {
      if (!h) return out;
      if (typeof h.forEach === 'function') h.forEach(function (v, k) { out[k] = String(v); });
      else if (Array.isArray(h)) h.forEach(function (pair) { out[pair[0]] = String(pair[1]); });
      else for (var k in h) out[k] = String(h[k]);
    } catch (e) {}
    return out;
  }
  function record(entry) {
    requests.push(entry);
    if (requests.length > NET_MAX) requests.shift();
  }
  var hookedFetch = null;
  if (typeof originalFetch === 'function' && !originalFetch.polyfill && !originalFetch.__hitch) {
    hookedFetch = function (input, init) {
      var p = originalFetch.apply(this, arguments);
      if (!on) return p;
      var entry = null;
      try {
        var req = input && typeof input === 'object' ? input : null;
        entry = {
          at: Date.now(),
          url: typeof input === 'string' ? input : (req && req.url) || String(input),
          method: String((init && init.method) || (req && req.method) || 'GET').toUpperCase(),
          requestHeaders: headersOf((init && init.headers) || (req && req.headers)),
          requestBody: init && typeof init.body === 'string' ? init.body.slice(0, REQ_BODY_MAX) : null,
          requestBodySize: init && typeof init.body === 'string' ? init.body.length : null,
          stack: new Error().stack,
        };
      } catch (e) { return p; }
      p.then(function (res) {
        entry.ms = Date.now() - entry.at;
        entry.status = res.status;
        entry.responseHeaders = headersOf(res.headers);
        entry.mime = entry.responseHeaders['content-type'] || null;
        // The app reads the original; the body here comes from a copy.
        if (/json|text|xml|javascript|html/i.test(entry.mime || '') && typeof res.clone === 'function') {
          try {
            res.clone().text().then(function (t) { entry.body = t.slice(0, BODY_MAX); entry.bodySize = t.length; record(entry); }, function () { record(entry); });
            return;
          } catch (e) {}
        }
        record(entry);
      }, function (err) {
        entry.ms = Date.now() - entry.at;
        entry.failed = true;
        entry.error = String((err && err.message) || err);
        record(entry);
      });
      return p;
    };
    hookedFetch.__hitch = true;
    g.fetch = hookedFetch;
  }

  g.__HITCH__ = {
    version: 3,
    poll: function () {
      var out = { screen: screen, commits: commits, screens: screens, frames: [], requests: requests };
      requests = [];
      var nowSec = Math.floor(Date.now() / 1000);
      for (var s in frames) if (+s < nowSec) { out.frames.push([+s, frames[s][0], Math.max(0, Math.round(frames[s][1])), frames[s][2]]); delete frames[s]; }
      commits = []; screens = [];
      return JSON.stringify(out);
    },
    pause: function () { on = false; },
    resume: function () { on = true; },
    stop: function () { on = false; clearInterval(guard); if (hook.onCommitFiberRoot === wrapped) hook.onCommitFiberRoot = original; if (hookedFetch && g.fetch === hookedFetch) g.fetch = originalFetch; g.__HITCH__ = null; },
  };
  return 'ok';
})()
//# sourceURL=hitch-probe.js`;

// --- host side -----------------------------------------------------------

const AVOIDABLE = /^props~ |^parent \(equal props\)$/;
// React Native and library building blocks: they render because a component
// above them did, so they're counted but the list leads with the components
// that own them.
const PRIMITIVE = /^(View|Text|TextImpl|Image|ImageBackground|ScrollView|FlatList|VirtualizedList|CellRenderer|VirtualizedListCellContextProvider|Pressable|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback|TextInput|SafeAreaView|KeyboardAvoidingView|Modal|ActivityIndicator|Switch|RefreshControl|Animated\(.*\)|AnimatedComponent.*|Shape|Svg|G|Path|Rect|Circle|Line|Defs|Stop|LinearGradient|RadialGradient|ClipPath|Mask|Use|Symbol|Anonymous|Fragment|Context\.Provider|.*\.Provider|.*\.Consumer|withDevTools.*)$/;

// Render rows from the commits in [from, to], merged per component: renders,
// mounts, render time, and the most common reasons. Sorted by time spent.
export function summarizeRenders(commits, from, to) {
  const inWindow = commits.filter(c => c.at >= from && c.at <= to);
  const byName = new Map();
  for (const commit of inWindow) {
    for (const [name, renders, ms, mounts, why] of commit.rows) {
      const row = byName.get(name) ?? { name, renders: 0, mounts: 0, ms: 0, reasons: new Map() };
      row.renders += renders;
      row.mounts += mounts;
      row.ms += ms;
      for (const [reason, n] of Object.entries(why ?? {})) row.reasons.set(reason, (row.reasons.get(reason) ?? 0) + n);
      byName.set(name, row);
    }
  }
  const all = [...byName.values()]
    .map(row => {
      const reasons = [...row.reasons].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([reason, count]) => ({ reason, count, text: describeReason(reason) }));
      const updates = row.renders - row.mounts;
      const avoidable = [...row.reasons].filter(([reason]) => AVOIDABLE.test(reason)).reduce((sum, [, n]) => sum + n, 0);
      return { name: row.name, renders: row.renders, mounts: row.mounts, ms: Math.round(row.ms * 10) / 10, reasons, avoidable: updates ? avoidable : 0 };
    })
    .sort((a, b) => b.ms - a.ms || b.renders - a.renders);
  const components = all.filter(c => !PRIMITIVE.test(c.name));
  const primitives = all.filter(c => PRIMITIVE.test(c.name));
  return {
    commits: inWindow.length,
    renderMs: Math.round(inWindow.reduce((sum, c) => sum + c.ms, 0)),
    rendered: inWindow.reduce((sum, c) => sum + c.rendered, 0),
    mounts: inWindow.reduce((sum, c) => sum + c.mounts, 0),
    components: components.slice(0, 15),
    primitives: primitives.slice(0, 6).map(({ name, renders, avoidable, ms }) => ({ name, renders, avoidable, ms })),
    avoidable: all.reduce((sum, c) => sum + c.avoidable, 0),
  };
}

// Plain-language reason, e.g. "props~ market:equal,onPress:fn" ->
// "new props with equal values (market: equal object, onPress: new function)".
const KIND_TEXT = { equal: 'equal object', fn: 'new function', el: 'new JSX element', diff: 'changed' };
export function describeReason(reason) {
  return reason
    .split(' + ')
    .map(part => {
      if (part === 'parent') return 'its parent re-rendered';
      if (part === 'parent (equal props)') return 'its parent re-rendered and passed equal props (not memoized)';
      if (part === 'own update') return 'its own update (no prop, hook or context change the probe could see)';
      if (/^hooks past #/.test(part)) return `a hook after #${part.slice(12)} changed (not checked)`;
      const props = part.match(/^props(~?) (.+)$/);
      if (props) {
        const keys = props[2].split(',').map(kv => {
          const [key, kind] = kv.split(':');
          return `${key}: ${KIND_TEXT[kind] ?? kind}`;
        });
        return `${props[1] ? 'new props with equal values' : 'props changed'} (${keys.join(', ')})`;
      }
      if (/^store #/.test(part)) return `a store subscription changed (hook ${part.slice(7)})`;
      if (/^state #/.test(part)) return `its state changed (hook ${part.slice(7)})`;
      if (/^context /.test(part)) return part === 'context ?' ? 'a context value changed' : `context ${part.slice(8)} changed`;
      return part;
    })
    .join(' + ');
}

// Seconds with many dropped frames that stalls don't already explain: lots of
// small hitches, each under the stall threshold. Consecutive seconds merge.
const JANK_DROPPED = 12;
export function jankPeriods(seconds, stalls) {
  const covered = sec => stalls.reduce((sum, s) => {
    const overlap = Math.min(s.at + s.ms, (sec + 1) * 1000) - Math.max(s.at, sec * 1000);
    return sum + Math.max(0, overlap);
  }, 0);
  const janky = seconds
    .map(([sec, frames, dropped, worst]) => ({ sec, frames, dropped: Math.max(0, dropped - Math.round(covered(sec) / 16.7)), worst }))
    .filter(s => s.dropped >= JANK_DROPPED)
    .sort((a, b) => a.sec - b.sec);
  const periods = [];
  for (const s of janky) {
    const last = periods.at(-1);
    if (last && s.sec === last.toSec + 1) {
      last.toSec = s.sec;
      last.dropped += s.dropped;
      last.frames += s.frames;
      last.worstGapMs = Math.max(last.worstGapMs, s.worst);
    } else periods.push({ fromSec: s.sec, toSec: s.sec, dropped: s.dropped, frames: s.frames, worstGapMs: s.worst });
  }
  return periods.map(p => {
    const secondsLong = p.toSec - p.fromSec + 1;
    return { at: p.fromSec * 1000, until: (p.toSec + 1) * 1000, seconds: secondsLong, dropped: p.dropped, fps: Math.round(p.frames / secondsLong), worstGapMs: p.worstGapMs };
  });
}

// A screen load runs from the screen change to the first full second without
// a React commit (or a cap), so it covers fetching and settling, not only mount.
const SCREEN_QUIET_MS = 1000;
const SCREEN_MAX_MS = 15000;
export function createScreenTracker({ onLoad }) {
  let open = null;
  const finish = endAt => {
    const load = open;
    open = null;
    onLoad({ ...load, ms: Math.max(0, endAt - load.at), settled: endAt - load.at < SCREEN_MAX_MS });
  };
  return {
    onScreen(name, at, memory) {
      if (open) finish(open.lastCommitAt ?? at);
      open = { name, at, lastCommitAt: null, commits: 0, renderMs: 0, mounts: 0, memoryAtStart: memory ?? null };
    },
    onCommits(commits) {
      if (!open) return;
      for (const c of commits) {
        if (c.at < open.at) continue;
        open.commits += 1;
        open.renderMs += c.ms;
        open.mounts += c.mounts;
        open.lastCommitAt = c.at;
      }
    },
    tick(now) {
      if (!open) return;
      const last = open.lastCommitAt ?? open.at;
      if (now - last >= SCREEN_QUIET_MS) finish(last);
      else if (now - open.at >= SCREEN_MAX_MS) finish(open.at + SCREEN_MAX_MS);
    },
    current: () => open?.name ?? null,
  };
}
