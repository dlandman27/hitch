// Turns a captured slowdown into a self-contained bug report an AI coding
// agent can act on, and launches Claude Code with it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

import { describeReason } from './react-probe.mjs';

export function readSource(projectRoot, file, line, context) {
  const abs = path.resolve(projectRoot, file);
  if (!abs.startsWith(projectRoot + path.sep)) return null;
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  const all = text.split('\n');
  const start = Math.max(1, line - context);
  const end = Math.min(all.length, line + context);
  const lines = [];
  for (let n = start; n <= end; n++) lines.push({ n, text: all[n - 1] });
  return { file, line, lines };
}

const fence = (lang, body) => `\`\`\`${lang}\n${body}\n\`\`\``;
const frameText = f => (f.file ? `${f.name} — ${f.file}:${f.line}` : `${f.name} [${f.kind}${f.where ? ` ${f.where}` : ''}]`);

const REACT_STEPS = [
  '## What to do',
  '1. This freeze is a synchronous React render, not one slow line. Find what triggered it (the trigger above, or the state/store update that ran just before) and why it re-rendered this much at once.',
  '2. Check the components listed: are they re-rendering with unchanged data (missing `React.memo`, new object/array/function props every render, context values recreated, a selector returning a new reference)? Are lists rendering more items than are visible? The "avoidable" counts and reasons above name the props to stabilize.',
  '3. Fix the cause: memoize the component or its props, stabilize references, narrow selectors/subscriptions, or virtualize/limit the list. Keep behavior identical.',
  '4. Follow the repo conventions (AGENTS.md / CLAUDE.md) and keep the change minimal. Explain why it re-rendered and why your change stops it. Hitch is still running; repeating the interaction should no longer freeze.',
];

const DEV_ONLY_STEPS = devOnly => [
  '## What to do',
  `1. This time was spent in **${devOnly}**, which only runs in dev builds. Production users don't pay it.`,
  '2. Decide whether the dev tooling is worth the jank: make it cheaper, sample it, or make it opt-in (off by default while profiling).',
  '3. Separately, check the app code on the path: if it dispatches or renders far more often than it should, fix that, since it also costs production.',
  '4. Follow the repo conventions (AGENTS.md / CLAUDE.md).',
];

// What the React probe saw render during a freeze: the "why" next to the "where".
export function rendersBlock(renders, heading = '## What React rendered during this freeze') {
  if (!renders?.commits) return [];
  const lines = [
    heading,
    `${renders.commits} commit(s), ${renders.renderMs}ms of render time, ${renders.rendered} component renders (${renders.mounts} mounts)${renders.avoidable ? `, **${renders.avoidable} avoidable** (new props with equal values, or a parent passing equal props to an unmemoized child)` : ''}.`,
    '',
    ...renders.components.slice(0, 10).map(c => {
      const why = c.reasons.map(r => `${describeReason(r.reason)} ×${r.count}`).join('; ');
      return `- **${c.name}** ×${c.renders}${c.mounts ? ` (${c.mounts} mounted)` : ''}, ${c.ms}ms${c.avoidable ? `, ${c.avoidable} avoidable` : ''}${why ? ` — ${why}` : ''}`;
    }),
  ];
  if (renders.primitives?.length) {
    lines.push(`- Building blocks under them: ${renders.primitives.map(p => `${p.name} ×${p.renders}${p.avoidable ? ` (${p.avoidable} avoidable)` : ''}`).join(', ')}`);
  }
  return ['', ...lines];
}

function stallPrompt(stall, projectRoot) {
  const first = stall.culprits[0];
  const top = first?.owner && /^(anonymous|\(anonymous\))?$/.test(first.name) ? { ...first, name: `callback inside ${first.owner}` } : first;
  const reactLead = (stall.react || stall.renders?.renderMs >= stall.ms * 0.3) && !stall.devOnly;
  const names = (stall.renders?.components.length ? stall.renders.components : stall.react?.components ?? []).slice(0, 3).map(c => c.name).join(', ');
  const title = stall.devOnly
    ? `# Investigate: ${stall.ms}ms JS freeze in dev-only ${stall.devOnly}`
    : reactLead
      ? `# Fix: ${stall.ms}ms synchronous React ${stall.react?.phase ?? 'render'}${names ? ` (${names})` : ''} froze the JS thread`
      : `# Fix: JS thread blocked ${stall.ms}ms${top?.file ? ` in \`${top.name}\` (${top.file}:${top.line})` : ''}`;
  const sections = [
    title,
    '',
    `Hitch caught the React Native JS thread busy for **${stall.ms}ms** without yielding (threshold ${stall.thresholdMs}ms)${stall.screen ? ` on the **${stall.screen}** screen` : ''}. While it is blocked, touches, navigation, and JS-driven animations freeze.`,
    ...(stall.actions?.length ? ['', `Redux action being dispatched during the freeze: ${stall.actions.map(a => `\`${a.type}\``).join(', ')}.`] : []),
    '',
    '## Where the time went',
    `${stall.snapshotCount} stack snapshot(s) were taken *during* the stall${stall.sampled ? ' (from Hermes\' sampling profiler, which was recording)' : ''}:`,
    ...stall.culprits.map(c => `- ${c.count}/${stall.snapshotCount} snapshots: ${frameText(c === first ? top : c)}${c.hot?.kind === 'lib' ? ` — time spent inside \`${c.hot.pkg}\` (${c.hot.name})${c.via?.length ? ` via ${c.via.join(' › ')}` : ''}` : ''}`),
  ];
  if (first?.appChain?.length > 1) {
    sections.push('', 'App code on that path (innermost first):', ...first.appChain.map(f => `- ${f.name} — ${f.file}:${f.line}`));
  }
  if (stall.devOnly) {
    sections.push('', `**This is dev-only work (${stall.devOnly}).** It does not run in production builds.`);
  }
  if (top?.file && top.kind === 'app') {
    const src = readSource(projectRoot, top.file, top.line, 12);
    if (src) {
      sections.push('', reactLead ? `## Where one capture landed (${top.file}, line ${top.line} marked; context, not the cause)` : `## Code (${top.file}, line ${top.line} marked)`, fence('ts', src.lines.map(l => `${l.n === top.line ? '→' : ' '} ${String(l.n).padStart(4)}  ${l.text}`).join('\n')));
    }
  }
  const stack = stall.snapshots[top?.snapshot ?? 0] ?? [];
  if (stack.length) {
    sections.push('', '## Call stack (innermost first)', fence('', stack.map(frameText).join('\n')));
  }
  if (stall.react && !stall.devOnly) {
    sections.splice(sections.indexOf('## Where the time went'), 0, `**Diagnosis: React ${stall.react.phase}.** ${stall.react.captures} of ${stall.snapshotCount} captures were inside one synchronous React ${stall.react.phase}${stall.react.trigger ? `, started by ${stall.react.trigger}` : ''}. The cost is that whole render; a single line is only where a capture landed.`, '');
    if (stall.react.components.length) {
      sections.push('', '## Components on the stack during the freeze', ...stall.react.components.map(c => `- ${c.name} — ${c.file}:${c.line} (${c.count}/${stall.snapshotCount} captures)`));
    }
  }
  if (stall.snapshotCount <= 2) {
    sections.push('', `> Evidence is thin: only ${stall.snapshotCount} stack capture(s). Treat the location as a lead and confirm it.`);
  }
  if (stall.occurrences?.length > 1) {
    sections.push('', `## History`, `The same line has blocked the JS thread ${stall.occurrences.length} times this session (worst ${Math.max(...stall.occurrences)}ms, total ${stall.occurrences.reduce((a, b) => a + b, 0)}ms).`);
  }
  sections.push(...rendersBlock(stall.renders));
  const steps = stall.devOnly ? DEV_ONLY_STEPS(stall.devOnly) : reactLead ? REACT_STEPS : null;
  if (steps) {
    sections.push('', ...steps, '', 'Note: measured on a dev build in the iOS simulator — absolute times are inflated, the culprit is real.');
    return sections.join('\n');
  }
  sections.push(
    '',
    '## What to do',
    '1. Read the code above and its callers; figure out why this does so much synchronous work on the JS thread (large loops, repeated work per render, unmemoized derivations, JSON/array churn, synchronous storage, etc.).',
    '2. Fix the root cause — avoid the work, memoize it, move it off the render path, batch it, or defer it — without changing behavior.',
    '3. Follow the repo conventions (AGENTS.md / CLAUDE.md) and keep the change minimal.',
    '4. Explain what was slow and why your change fixes it. Hitch is still running; redoing the same interaction should no longer produce this stall.',
    '',
    'Note: measured on a dev build in the iOS simulator — absolute times are inflated, the culprit is real.',
  );
  return sections.join('\n');
}

function hotPrompt(hot) {
  const sections = [
    `# Investigate: ${hot.trigger}`,
    '',
    'Hitch sampled every native thread of the app for 1s while this was happening. Busy threads:',
    '',
  ];
  for (const t of hot.threads) {
    sections.push(`### ${t.label} — ${t.busyPct}% busy`, `Time by subsystem: ${t.categories.slice(0, 4).map(c => `${c.name} ${c.pct}%`).join(', ')}`, 'Hottest frames:', fence('', t.frames.map(f => `${String(f.ms).padStart(5)}ms  ${f.name}${f.lib ? `  (${f.lib})` : ''}${f.source ? `  ${f.source}` : ''}${f.via ? `\n         called from: ${f.via}` : ''}`).join('\n')), '');
  }
  sections.push(
    '## What to do',
    '1. Work out which JS/React code drives this native work (e.g. Yoga layout = too many or too-deep views re-laying out; mounting = large commits; CoreAnimation = heavy views/shadows/blur; an SDK thread = that SDK’s configuration).',
    '2. Find the responsible components/config in this repo and propose or make the smallest fix that removes the cost.',
    '3. Follow the repo conventions (AGENTS.md / CLAUDE.md).',
    '',
    'Note: measured on a dev build in the iOS simulator.',
  );
  return sections.join('\n');
}

const codeBlock = (projectRoot, frame, context) => {
  if (!frame?.file || frame.kind !== 'app') return [];
  const src = readSource(projectRoot, frame.file, frame.line, context);
  return src ? ['', `## Code (${frame.file}, line ${frame.line} marked)`, fence('ts', src.lines.map(l => `${l.n === frame.line ? '→' : ' '} ${String(l.n).padStart(4)}  ${l.text}`).join('\n'))] : [];
};
const stackBlock = frames => (frames?.length ? ['', '## Call stack (innermost first)', fence('', frames.map(frameText).join('\n'))] : []);
const MB = 1024 * 1024;

function consolePrompt(c, projectRoot) {
  const kind = c.exception ? 'uncaught exception' : `console.${c.level}`;
  return [
    `# Fix: ${kind}${c.source?.file ? ` from ${c.source.file}:${c.source.line}` : ''}${c.count > 1 ? ` (×${c.count})` : ''}`,
    '',
    `Hitch caught this ${kind} while testing the app${c.count > 1 ? `; it fired ${c.count} times, each within 10s of the last (ids and numbers in the text may differ)` : ''}:`,
    fence('', c.text.slice(0, 3000)),
    ...(c.lastText ? ['', 'The latest repeat read:', fence('', c.lastText.slice(0, 1500))] : []),
    ...codeBlock(projectRoot, c.source, 12),
    ...stackBlock(c.frames),
    '',
    '## What to do',
    '1. Work out what the message means and why this code path produces it (for React warnings: the component and prop/key/state involved).',
    '2. Fix the cause rather than silencing the log. If it fires repeatedly, find why it runs that often too.',
    '3. Follow the repo conventions (AGENTS.md / CLAUDE.md) and keep the change minimal. Hitch is still running and will show if it happens again.',
  ].join('\n');
}

function requestPrompt(r, projectRoot) {
  return [
    `# Investigate: ${r.failed ? 'failed' : 'slow'} request ${r.method} ${r.url}`,
    '',
    `Hitch saw this request ${r.failed ? `fail (${r.error ?? `HTTP ${r.status}`})` : `take ${r.ms}ms`} while testing the app. Status: ${r.status ?? '—'}, size: ${r.bytes != null ? `${Math.round(r.bytes / 1024)} KB` : 'unknown'}.`,
    ...codeBlock(projectRoot, r.source, 12),
    ...stackBlock(r.frames),
    '',
    '## What to do',
    '1. Find the code that issues this request and what the UI does while waiting on it.',
    r.failed
      ? '2. Work out why it fails (bad params, auth, wrong endpoint, a timeout) and whether the app handles the failure gracefully.'
      : '2. Check whether it can be avoided, cached, deduplicated, made smaller (pagination, fewer fields) or started earlier, and whether the UI blocks on it unnecessarily.',
    '3. Follow the repo conventions (AGENTS.md / CLAUDE.md). If the fix belongs in the backend, say so instead of working around it in the app.',
  ].join('\n');
}

function startupPrompt(s) {
  return [
    `# Speed up ${s.kind === 'reload' ? 'app reload' : 'cold launch'}: ${((s.toSettleMs ?? s.toJsMs ?? 0) / 1000).toFixed(1)}s`,
    '',
    `Hitch timed a ${s.kind}: ${s.toJsMs != null ? `${(s.toJsMs / 1000).toFixed(2)}s until the first screen started rendering` : 'JS start not observed'}${s.settled ? `, ${((s.toSettleMs - (s.toJsMs ?? 0)) / 1000).toFixed(2)}s more until the app settled` : ', and it never settled within 30s'}.`,
    '',
    '## What to do',
    '1. Look at what runs at startup: module-level code in imported files, providers and their effects, SDK initialization, and the first screen\'s data loading.',
    '2. Find work that can be deferred until after the first screen, lazy-loaded, or done in parallel instead of in sequence.',
    '3. Follow the repo conventions (AGENTS.md / CLAUDE.md) and keep changes minimal; explain the expected saving.',
  ].join('\n');
}

function leakPrompt(a) {
  if (a.type === 'threadleak') {
    return [
      `# Investigate: threads piling up (${a.from} → ${a.to} in 3 min)`,
      '',
      'Hitch saw the app keep creating native threads without them going away. Threads that grew:',
      ...a.grew.map(g => `- ${g.name}: +${g.added}`),
      '',
      '## What to do',
      '1. Identify which native module or SDK owns these threads and what app action triggers new ones.',
      '2. Fix how it is used (reuse a client/instance, avoid re-initializing per call/render) so threads are not created repeatedly.',
    ].join('\n');
  }
  if (a.kind === 'reload') {
    return [
      `# Investigate: app memory not freed by a JS reload (${Math.round(a.from / MB)} MB → ${Math.round(a.to / MB)} MB)`,
      '',
      'A JS reload throws away the old JavaScript runtime, so its JS objects are freed. App memory still grew this much after the reload settled, which means native resources the old JS created were never released: images, native views, animation or graphics engines (Rive, Skia, Lottie), video players, or native module singletons that keep adding state.',
      '',
      '## What to do',
      '1. Find native resources the app creates and should release on unmount or on reload: image caches, Rive/Skia/Lottie instances or render workers, players, listeners registered with native modules.',
      '2. Check they are disposed in cleanup (effect returns, `componentWillUnmount`, module invalidate) and that singletons aren\'t re-created on each JS start.',
      '3. Production users rarely reload JS, so this mostly costs dev sessions, but the same missing cleanup leaks when screens unmount.',
    ].join('\n');
  }
  return [
    `# Investigate: possible memory leak (${a.kind === 'heap' ? 'JS heap' : 'app memory'} +${a.mbPerMin} MB/min)`,
    '',
    `Hitch saw ${a.kind === 'heap' ? 'the JS heap' : 'total app memory'} grow from ${Math.round(a.from / MB)} MB to ${Math.round(a.to / MB)} MB over 3 minutes, with the post-GC floor rising steadily.`,
    '',
    '## What to do',
    '1. Find what the user was doing (which screens were opened and closed) and check those screens for listeners, subscriptions, intervals or timers not cleaned up on unmount, and caches or stores that only grow.',
    '2. Fix the cleanup and explain which object was being retained.',
  ].join('\n');
}

function jankPrompt(j) {
  return [
    `# Fix: choppy frames${j.screen ? ` on ${j.screen}` : ''} — ${j.fps} fps for ${j.seconds}s`,
    '',
    `Hitch counted animation frames on the JS thread while React was busy. For ${j.seconds}s the app ran at about **${j.fps} fps** and dropped **${j.dropped} frames**${j.worstGapMs ? ` (longest hitch ${j.worstGapMs}ms)` : ''} that individual freezes don't explain: many small hitches, each under the freeze threshold.`,
    ...rendersBlock(j.renders, '## What React rendered in that time'),
    '',
    '## What to do',
    '1. Find what runs repeatedly during this period: list items mounting while scrolling, timers or subscriptions firing every frame, JS-driven animations, or state updates on scroll events.',
    '2. Make each update cheaper (memoized rows, stable props, fewer views per row) or rarer (throttle scroll handlers, batch updates, move animations to the UI thread with Reanimated).',
    '3. Follow the repo conventions (AGENTS.md / CLAUDE.md). Redo the same interaction with Hitch running to check frames recovered.',
  ].join('\n');
}

function screenPrompt(sc) {
  return [
    `# Speed up the ${sc.name} screen: ${(sc.ms / 1000).toFixed(1)}s to settle`,
    '',
    `Hitch timed **${sc.name}** from the navigation to the first full second without a React commit: ${(sc.ms / 1000).toFixed(2)}s${sc.settled ? '' : ' (it never settled within 15s)'}, across ${sc.commits} commits with ${sc.renderMs}ms of render time and ${sc.mounts} component mounts${sc.stalls ? `, including ${sc.stalls} JS freeze(s)` : ''}.${sc.memoryAtStart && sc.memoryAtEnd ? ` App memory went from ${Math.round(sc.memoryAtStart / MB)} MB to ${Math.round(sc.memoryAtEnd / MB)} MB.` : ''}`,
    ...rendersBlock(sc.renders, '## What React rendered while it loaded'),
    '',
    '## What to do',
    '1. Separate waiting from working: requests on the critical path (start them earlier, in parallel, or cache them) versus render cost (mounting more than is visible, heavy rows, re-render cascades as data arrives).',
    '2. Render less up front (virtualize, defer below-the-fold sections, skeletons that don\'t re-render) and avoid several commits as each piece of data lands.',
    '3. Follow the repo conventions (AGENTS.md / CLAUDE.md) and explain the expected saving.',
  ].join('\n');
}

const PROMPTS = {
  jank: e => jankPrompt(e),
  screen: e => screenPrompt(e),
  stall: (e, root) => stallPrompt(e, root),
  hot: e => hotPrompt(e),
  console: (e, root) => consolePrompt(e, root),
  request: (e, root) => requestPrompt(e, root),
  startup: e => startupPrompt(e),
  leak: e => leakPrompt(e),
  threadleak: e => leakPrompt(e),
};

const logLine = l => `${new Date(l.at).toTimeString().slice(0, 8)} console.${l.level}: ${l.text.split('\n')[0].slice(0, 200)}${l.count > 1 ? ` (×${l.count})` : ''}`;

export function buildPrompt(event, projectRoot) {
  const prompt = PROMPTS[event.type](event, projectRoot);
  if (!event.recentLogs?.length) return prompt;
  // What the app logged just before: placed ahead of the instructions.
  const logs = ['## App logs just before this', fence('', event.recentLogs.map(logLine).join('\n')), ''].join('\n');
  const at = prompt.indexOf('## What to do');
  return at >= 0 ? `${prompt.slice(0, at)}${logs}\n${prompt.slice(at)}` : `${prompt}\n\n${logs}`;
}

// Opens Terminal in the project and starts Claude Code with the prompt.
export function sendToClaude(prompt, projectRoot, name) {
  const dir = path.join(os.homedir(), '.hitch', 'handoffs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  fs.writeFileSync(file, prompt);
  const quote = s => `'${s.replace(/'/g, `'\\''`)}'`;
  const command = `cd ${quote(projectRoot)} && claude "$(cat ${quote(file)})"`;
  const script = `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(command)}\nend tell`;
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], error => (error ? reject(error) : resolve(file)));
  });
}

// Editor: $HITCH_EDITOR (or the old $PERF_WATCH_EDITOR) / $REACT_EDITOR, else Cursor or VS Code on PATH.
export function openInEditor(projectRoot, file, line) {
  const abs = path.resolve(projectRoot, file);
  if (!abs.startsWith(projectRoot + path.sep)) return Promise.reject(new Error('outside project'));
  const preferred = process.env.HITCH_EDITOR ?? process.env.PERF_WATCH_EDITOR ?? process.env.REACT_EDITOR;
  const candidates = preferred ? [preferred] : ['cursor', 'code'];
  const tryNext = i =>
    new Promise((resolve, reject) => {
      if (i >= candidates.length) {
        execFile('open', [abs], error => (error ? reject(error) : resolve('open')));
        return;
      }
      execFile(candidates[i], ['-g', `${abs}:${line}`], error => (error ? tryNext(i + 1).then(resolve, reject) : resolve(candidates[i])));
    });
  return tryNext(0);
}
