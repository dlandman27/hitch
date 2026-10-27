// Everything that happened between two moments: the slice someone selects on
// the timeline. Freezes, choppy frames, screens, requests, console, logs,
// memory and per-thread CPU, plus what React rendered; and a brief for an AI.

import { rankOffenders } from './engine.mjs';
import { rendersBlock } from './handoff.mjs';

const MB = 1024 * 1024;
const clock = at => new Date(at).toTimeString().slice(0, 8);
const overlaps = (from, to) => e => e.at <= to && (e.until ?? e.lastAt ?? e.at + (e.ms ?? 0)) >= from;

// Average busy share per thread over the range, from the lane ticks.
export function threadsBetween(lanes, from, to) {
  const totals = new Map();
  let span = 0;
  for (const tick of lanes ?? []) {
    if (tick.at < from || tick.at - tick.windowMs > to) continue;
    span += tick.windowMs;
    for (const [name, busy] of tick.lanes) totals.set(name, (totals.get(name) ?? 0) + busy);
  }
  if (!span) return [];
  return [...totals]
    .map(([name, busy]) => ({ name, pct: Math.min(100, Math.round((busy / span) * 100)) }))
    .filter(t => t.pct > 0)
    .sort((a, b) => b.pct - a.pct);
}

export function summarizeRange(history, from, to, renders) {
  const stalls = (history.stalls ?? []).filter(overlaps(from, to));
  const requests = (history.requests ?? []).filter(overlaps(from, to));
  const vitals = (history.vitals ?? []).filter(v => v.at >= from - 2000 && v.at <= to + 2000 && (v.heapUsed > 0 || v.rss > 0));
  const first = vitals[0];
  const last = vitals.at(-1);
  return {
    from,
    to,
    seconds: Math.round((to - from) / 100) / 10,
    stalls,
    blockedMs: stalls.reduce((sum, s) => sum + s.ms, 0),
    devOnlyMs: stalls.filter(s => s.devOnly).reduce((sum, s) => sum + s.ms, 0),
    offenders: rankOffenders(stalls.filter(s => !s.devOnly)).slice(0, 5).map(o => ({ where: o.file ? `${o.name} · ${o.file}:${o.line}` : o.name, blockedMs: Math.round(o.blockedMs) })),
    jank: (history.jank ?? []).filter(overlaps(from, to)),
    screens: (history.screens ?? []).filter(overlaps(from, to)),
    hot: (history.hot ?? []).filter(overlaps(from, to)),
    requests,
    console: (history.console ?? []).filter(overlaps(from, to)),
    logs: (history.logs ?? []).filter(overlaps(from, to)).slice(-60),
    alerts: (history.alerts ?? []).filter(a => a.at >= from && a.at <= to),
    memory: first && last ? { heapFrom: first.heapUsed, heapTo: last.heapUsed, rssFrom: first.rss, rssTo: last.rss, threadsFrom: first.threads, threadsTo: last.threads } : null,
    threads: threadsBetween(history.lanes, from, to).slice(0, 12),
    renders: renders?.commits ? renders : null,
  };
}

// A brief for an AI agent: what happened in this slice and what to look at.
export function rangePrompt(range) {
  const lines = [
    `# Investigate ${range.seconds}s of the app (${clock(range.from)}–${clock(range.to)})`,
    '',
    `Hitch recorded this slice of a React Native dev session${range.screens[0] ? ` around the **${range.screens.map(s => s.name).join(' → ')}** screen(s)` : ''}.`,
    '',
    '## What happened',
    range.stalls.length ? `- JS thread blocked **${range.blockedMs}ms** over ${range.stalls.length} freeze(s)${range.devOnlyMs ? ` (${range.devOnlyMs}ms of it dev-only tooling)` : ''}` : '- No JS freezes',
    ...range.jank.map(j => `- Choppy frames: ${j.fps} fps for ${j.seconds}s, ${j.dropped} frames dropped outside freezes`),
    ...range.screens.map(s => `- Screen ${s.name} took ${(s.ms / 1000).toFixed(1)}s to settle (${s.commits} commits, ${s.mounts} mounts)`),
    ...range.requests.filter(r => r.issue).map(r => `- ${r.failed ? 'Failed' : 'Slow'} request ${r.method} ${r.url.slice(0, 120)} (${r.failed ? (r.error ?? `HTTP ${r.status}`) : `${r.ms}ms`})`),
    ...range.console.map(c => `- console.${c.level}${c.count > 1 ? ` ×${c.count}` : ''}: ${c.text.split('\n')[0].slice(0, 160)}`),
    ...range.alerts.map(a => `- Leak alert: ${a.type === 'threadleak' ? `threads ${a.from} → ${a.to}` : `${a.kind} memory climbing`}`),
    ...(range.memory?.heapFrom != null ? [`- JS heap ${Math.round(range.memory.heapFrom / MB)} → ${Math.round(range.memory.heapTo / MB)} MB${range.memory.rssFrom != null ? `, app memory ${Math.round(range.memory.rssFrom / MB)} → ${Math.round(range.memory.rssTo / MB)} MB` : ''}`] : []),
  ];
  if (range.offenders.length) lines.push('', '## Lines that blocked the JS thread', ...range.offenders.map(o => `- ${o.blockedMs}ms — ${o.where}`));
  if (range.threads.length) lines.push('', '## Busiest threads', ...range.threads.slice(0, 6).map(t => `- ${t.name}: ${t.pct}%`));
  lines.push(...rendersBlock(range.renders, '## What React rendered in this slice'));
  if (range.logs.length) lines.push('', '## App logs in this slice', '```', ...range.logs.slice(-25).map(l => `${clock(l.at)} console.${l.level}: ${l.text.split('\n')[0].slice(0, 160)}${l.count > 1 ? ` (×${l.count})` : ''}`), '```');
  lines.push(
    '',
    '## What to do',
    '1. Work out what the user was doing in this slice and which code ran: the freezes, the components React rendered (and why), and the requests.',
    '2. Find the biggest cost and fix its cause (avoidable re-renders, too much mounted at once, work on the JS thread that can be deferred), keeping behavior identical.',
    '3. Follow the repo conventions (AGENTS.md / CLAUDE.md). Hitch is still running; redo the same interaction to check the slice got lighter.',
    '',
    'Note: measured on a dev build; absolute times are inflated, the ranking is real.',
  );
  return lines.join('\n');
}
