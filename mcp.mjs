// A local MCP server (Streamable HTTP, JSON responses only) on Hitch's own port,
// so an agent working in the app's repo can read what Hitch caught and check
// a fix: list findings, read one in full, search app logs, clear, reload.
//
//   claude mcp add --transport http hitch http://127.0.0.1:7370/mcp

import { avoidableRows, rankOffenders } from './engine.mjs';
import { buildPrompt, rendersBlock } from './handoff.mjs';
import { createScenarios, describeComparison, describeRun } from './runs.mjs';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'hitch', version: '1.0.0' };
const INSTRUCTIONS = `Hitch watches a running React Native app (through Metro's debugger and, on a simulator, the native threads) and records slowdowns as they happen: JS-thread stalls with the blocking line, native hot spots, console errors and warnings, slow or failed requests, startups and memory or thread leaks. It also keeps the app's recent console.log lines.
It also sees what React rendered and why (from the React DevTools hook), dropped frames, screen load times, and can profile the JS thread or snapshot the heap on request.
Start with hitch_status, then hitch_findings; hitch_finding gives one finding in full (stack, source, what React rendered and why, the app's logs just before it, and what to look at). To check a fix: hitch_run_start, use the app, hitch_run_stop (compares with the previous run of the same name); or hitch_clear, hitch_reload_app, use the app, then hitch_findings again.`;

const KINDS = ['stall', 'hot', 'console', 'request', 'startup', 'leak', 'jank', 'screen'];
const LIMIT_MAX = 200;

const clock = at => new Date(at).toTimeString().slice(0, 8);
const ms = v => `${Math.round(v)}ms`;
const mb = bytes => `${Math.round(bytes / 1024 / 1024)} MB`;
const firstLine = (text, max = 200) => (text ?? '').split('\n')[0].slice(0, max);
const where = c => (c.file ? `${c.name} · ${c.file}:${c.line}` : `${c.name} [${c.kind}]`);
const from = source => (source?.file ? ` · from ${source.file}:${source.line}` : '');

const on = e => (e.screen ? ` · on ${e.screen}` : '');
const rendered = r => (r?.components?.length ? ` · rendered ${r.components.slice(0, 3).map(c => `${c.name} ×${c.renders}`).join(', ')}${r.avoidable ? ` (${r.avoidable} avoidable)` : ''}` : '');

// One line per finding: enough to pick which one to read in full.
const SUMMARY = {
  stall: s => `JS stall ${ms(s.ms)} — ${s.culprits[0] ? where(s.culprits[0]) : 'ended before a stack could be captured'}${s.devOnly ? ` (dev-only: ${s.devOnly})` : ''}${s.react?.trigger ? ` · ${s.react.trigger}` : ''}${rendered(s.renders)}${on(s)}`,
  jank: j => `choppy frames — ${j.fps} fps for ${j.seconds}s, ${j.dropped} frames dropped outside freezes${rendered(j.renders)}${on(j)}`,
  screen: sc => `screen load ${sc.name} — ${(sc.ms / 1000).toFixed(1)}s to settle${sc.settled ? '' : ' (never settled)'}, ${sc.commits} commits, ${sc.mounts} mounts${sc.stalls ? `, ${sc.stalls} freezes` : ''}`,
  hot: h => `native hot spot — ${h.trigger}${h.threads?.[0] ? ` · ${h.threads[0].label} ${h.threads[0].busyPct}% busy, top ${h.threads[0].frames?.[0]?.name ?? '?'}` : ''}`,
  console: c => `console.${c.exception ? 'exception' : c.level}${c.count > 1 ? ` ×${c.count}` : ''}: ${firstLine(c.text)}${from(c.source)}`,
  request: r => `${r.failed ? `failed (${r.error ?? `HTTP ${r.status}`})` : `slow ${ms(r.ms)}`} — ${r.method} ${r.url.slice(0, 200)}${from(r.source)}`,
  startup: s => `${s.kind} — JS started ${s.toJsMs != null ? ms(s.toJsMs) : '—'}, ${s.settled ? `settled ${ms(s.toSettleMs)}` : 'never settled'}`,
  leak: a =>
    a.type === 'threadleak'
      ? `threads piling up ${a.from} → ${a.to}`
      : a.kind === 'reload'
        ? `app memory not freed by a JS reload (${mb(a.from)} → ${mb(a.to)})`
        : `${a.kind === 'heap' ? 'JS heap' : 'app memory'} climbing ${a.mbPerMin} MB/min (${mb(a.from)} → ${mb(a.to)})`,
};

// Findings by kind, newest last. Requests only count when slow or failed.
function findingsOf(history) {
  return {
    stall: history.stalls ?? [],
    hot: history.hot ?? [],
    console: history.console ?? [],
    request: (history.requests ?? []).filter(r => r.issue),
    startup: history.startups ?? [],
    leak: history.alerts ?? [],
    jank: history.jank ?? [],
    screen: (history.screens ?? []).filter(sc => sc.issue),
  };
}

// Consecutive freezes of one burst (a screen load, a scroll) read as one line.
function groupBursts(list) {
  const out = [];
  for (const e of list) {
    const last = out.at(-1);
    if (e.type === 'stall' && last?.type === 'stall' && last.burst === e.burst && e.burst != null) {
      last.members ??= [{ ...last }];
      last.members.push(e);
    } else out.push({ ...e });
  }
  return out.map(e => (e.members?.length > 1 ? burstLine(e.members) : e));
}

function burstLine(members) {
  const blocked = members.reduce((sum, m) => sum + m.ms, 0);
  const worst = members.reduce((a, b) => (b.ms > a.ms ? b : a));
  const span = members.at(-1).at + members.at(-1).ms - members[0].at;
  const devOnly = members.filter(m => m.devOnly).reduce((sum, m) => sum + m.ms, 0);
  return {
    ...members[0],
    line: `#${members[0].id}  ${clock(members[0].at)}  burst of ${members.length} JS stalls — ${ms(blocked)} blocked over ${(span / 1000).toFixed(1)}s${devOnly ? ` (${ms(devOnly)} dev-only)` : ''}; worst #${worst.id} ${ms(worst.ms)}: ${worst.culprits[0] ? where(worst.culprits[0]) : 'no stack'}${rendered(worst.renders)}${on(members[0])}\n      ids: ${members.map(m => m.id).join(', ')}`,
  };
}

const kindOf = event => (event.type === 'threadleak' ? 'leak' : event.type);
const findingLine = e => e.line ?? `#${e.id}  ${clock(e.at)}  ${SUMMARY[kindOf(e)](e)}`;
const searchable = e => [SUMMARY[kindOf(e)](e), e.text, e.url, e.screen, e.name, ...(e.culprits ?? []).map(where), ...(e.renders?.components ?? []).map(c => c.name)].filter(Boolean).join('\n').toLowerCase();

const number = (description, extra = {}) => ({ type: 'number', description, ...extra });
const string = (description, extra = {}) => ({ type: 'string', description, ...extra });
const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

const TOOLS = [
  {
    name: 'hitch_status',
    description: 'What Hitch is watching (app, device, Metro, project), whether it is live, current memory and threads, and how many findings of each kind it has.',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ_ONLY,
  },
  {
    name: 'hitch_findings',
    description: 'List what Hitch caught, one line each with an id: JS stalls, native hot spots, console errors/warnings, slow or failed requests, startups and leaks. Read one in full with hitch_finding.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: string('Only this kind of finding.', { enum: KINDS }),
        level: string('Console findings only: error or warn.', { enum: ['error', 'warn'] }),
        search: string('Case-insensitive text to match in the message, URL, function or file.'),
        since_seconds: number('Only findings from the last N seconds.', { minimum: 1 }),
        after_id: number('Only findings with an id above this; pass the highest id you have seen to get what is new.'),
        limit: number('Most recent N (default 50).', { minimum: 1, maximum: LIMIT_MAX }),
        dev_only: string('Freezes in dev-only tooling (Reactotron, React dev profiling, Redux dev checks): hide (default), show, or only.', { enum: ['hide', 'show', 'only'] }),
        group_bursts: { type: 'boolean', description: 'Collapse freezes that happened back to back (a screen load, a scroll) into one line (default true).' },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: 'hitch_finding',
    description: 'One finding in full, written as a brief to fix it: the stack or request, the source around the line, how often it happened, and the app logs just before it.',
    inputSchema: { type: 'object', properties: { id: number('Id from hitch_findings.') }, required: ['id'] },
    annotations: READ_ONLY,
  },
  {
    name: 'hitch_top_offenders',
    description: 'The lines that blocked the JS thread the longest across all stalls, with total blocked time, stall count and worst stall.',
    inputSchema: { type: 'object', properties: { limit: number('How many (default 15).', { minimum: 1, maximum: 100 }) } },
    annotations: READ_ONLY,
  },
  {
    name: 'hitch_logs',
    description: "The app's recent console.log / info / debug lines (repeats grouped), newest last.",
    inputSchema: {
      type: 'object',
      properties: {
        search: string('Case-insensitive text to match.'),
        level: string('Only this level, e.g. log, info, debug.'),
        since_seconds: number('Only lines from the last N seconds.', { minimum: 1 }),
        limit: number('Most recent N (default 100).', { minimum: 1, maximum: LIMIT_MAX }),
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: 'hitch_renders',
    description: 'What React rendered in a time window, from the probe Hitch installs through the React DevTools hook: commits, render time, mounts, and per component how often it rendered and why (state, store, context, changed props, or new props with equal values = avoidable). Also the session-wide list of avoidable re-renders seen during freezes.',
    inputSchema: { type: 'object', properties: { since_seconds: number('Window: the last N seconds (default 30).', { minimum: 1, maximum: 120 }) } },
    annotations: READ_ONLY,
  },
  {
    name: 'hitch_profile',
    description: "Record the JS thread with Hermes' sampling profiler for N seconds and return where the time went: hottest functions by self time and your own functions by total time. Use it while reproducing something slow. Costs the app a little CPU only while recording.",
    inputSchema: { type: 'object', properties: { seconds: number('How long to record (default 5, max 30).', { minimum: 1, maximum: 30 }) } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'hitch_heap_snapshot',
    description: 'Take a JS heap snapshot and keep its summary under a label (e.g. "before", "after"). Freezes the app for a few seconds while Hermes writes it. Take one, open and leave a screen a few times, take another, then hitch_heap_diff.',
    inputSchema: { type: 'object', properties: { label: string('Name for this snapshot.') }, required: ['label'] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'hitch_heap_diff',
    description: 'Which kinds of objects grew between two heap snapshots taken with hitch_heap_snapshot: count and bytes per constructor, biggest growth first.',
    inputSchema: { type: 'object', properties: { before: string('Label of the earlier snapshot.'), after: string('Label of the later snapshot.') }, required: ['before', 'after'] },
    annotations: READ_ONLY,
  },
  {
    name: 'hitch_run_start',
    description: 'Start recording a named run (e.g. "open app and scroll home"). Do the interaction in the app, then call hitch_run_stop. The run is profiled for its first minute so short freezes get stacks.',
    inputSchema: { type: 'object', properties: { name: string('Name of the scenario; runs with the same name are compared.') }, required: ['name'] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'hitch_run_stop',
    description: 'Stop the recording run, save it to ~/.hitch/runs, and compare it with the previous run of the same name (freezes, blocked time, choppy frames, screen loads, render time, avoidable re-renders, console errors, requests).',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'hitch_run_scenario',
    description: 'Replay a named scenario as a recorded run and compare it with the last run of that name. Steps: {"reload": true} reloads the JS, {"open_url": "myapp://screen"} opens a deep link in the booted simulator, {"wait": 8} waits (settling, or time for the user to scroll). Steps given are saved under the name; omit them to replay the saved ones. Plays 3 times by default and compares medians. Use the same scenario before and after a change.',
    inputSchema: {
      type: 'object',
      properties: {
        name: string('Scenario name, e.g. "cold home load".'),
        steps: { type: 'array', description: 'Steps to play (saved for next time). Omit to replay the saved scenario.', items: { type: 'object' } },
        times: number('Play it this many times and keep the medians (default 3; single runs of the same code vary a lot).', { minimum: 1, maximum: 5 }),
      },
      required: ['name'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'hitch_runs',
    description: 'Saved runs, newest last, with their branch and commit and headline numbers.',
    inputSchema: { type: 'object', properties: { name: string('Only runs with this name.') } },
    annotations: READ_ONLY,
  },
  {
    name: 'hitch_clear',
    description: 'Forget everything Hitch has recorded so far, so the next hitch_findings shows only what happens after a change.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'hitch_reload_app',
    description: "Reload the app's JS bundle (like pressing r in Metro) so a code change takes effect.",
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'hitch_save_report',
    description: 'Write the session report (markdown plus the raw session.json) to ~/.hitch and return its path.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
];

const text = value => ({ content: [{ type: 'text', text: value }] });
const failure = value => ({ content: [{ type: 'text', text: value }], isError: true });
const sinceCut = seconds => (seconds ? Date.now() - seconds * 1000 : -Infinity);
const capped = (value, fallback, max) => Math.min(Math.max(1, Math.floor(Number(value) || fallback)), max);

export function createMcp({ engine, findEvent, withContext, root, runs, scenarios = createScenarios() }) {
  const call = {
    hitch_status() {
      const status = engine.status();
      const history = engine.history();
      const vitals = history.vitals?.at(-1);
      const counts = Object.entries(findingsOf(history)).map(([kind, list]) => `${kind} ${list.length}`).join(' · ');
      return text(
        [
          `state: ${status.state ?? 'unknown'}`,
          status.appId && `app: ${status.appId}${status.device ? ` on ${status.device}` : ''}${status.physical ? ' (physical device)' : ''}`,
          status.project && `project: ${status.project}`,
          status.metro && `metro: ${status.metro}`,
          status.startedAt && `watching since: ${status.startedAt}`,
          status.screen && `screen: ${status.screen}`,
          status.health && `health: source maps ${status.health.symbols}${status.health.mapAgreement != null ? ` (${status.health.mapAgreement}% of modules agree with the running bundle)` : ''} · React probe ${status.health.probe}${status.health.probeCost ? ` (cost so far ${status.health.probeCost.totalMs}ms over ${status.health.probeCost.commits} commits, max ${status.health.probeCost.maxMs}ms; React itself rendered ${Math.round(status.health.probeCost.renderMs)}ms)` : ''} · debugger round trip ${status.health.debuggerMs ?? '—'}ms · native threads ${status.native ? 'on' : status.physical ? 'off (physical device)' : 'off'}${status.health.profiling ? ` · profiling (${status.health.profiling})` : ''}`,
          status.health?.symbols === 'mismatch' && 'warning: the source map does not match the bundle the app runs, so app file:line locations are unreliable until it catches up (reload the app, or restart Hitch).',
          runs?.active() && `recording run: "${runs.active().name}" since ${clock(runs.active().startedAt)}`,
          vitals && `now: JS heap ${mb(vitals.heapUsed)} · app memory ${vitals.rss ? mb(vitals.rss) : '—'} · ${vitals.threads ?? '—'} threads`,
          `stall threshold: ${status.settings?.stallMs ?? '—'}ms`,
          `findings: ${counts}`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    },

    hitch_findings({ kind, level, search, since_seconds, after_id, limit, dev_only = 'hide', group_bursts = true } = {}) {
      if (kind && !KINDS.includes(kind)) return failure(`kind must be one of ${KINDS.join(', ')}`);
      const byKind = findingsOf(engine.history());
      const cut = sinceCut(since_seconds);
      const needle = search?.toLowerCase();
      const list = (kind ? byKind[kind] : Object.values(byKind).flat())
        .filter(e => (e.lastAt ?? e.at) >= cut)
        .filter(e => after_id == null || e.id > after_id)
        .filter(e => !level || (kindOf(e) === 'console' && e.level === level))
        .filter(e => !needle || searchable(e).includes(needle))
        .sort((a, b) => a.at - b.at || a.id - b.id);
      const isDev = e => e.type === 'stall' && Boolean(e.devOnly);
      const hiddenDev = dev_only === 'hide' ? list.filter(isDev) : [];
      const filtered = dev_only === 'only' ? list.filter(isDev) : dev_only === 'hide' ? list.filter(e => !isDev(e)) : list;
      const lines = group_bursts ? groupBursts(filtered) : filtered;
      const shown = lines.slice(-capped(limit, 50, LIMIT_MAX));
      const notes = [
        lines.length > shown.length && `(${lines.length - shown.length} older not shown)`,
        hiddenDev.length && `(${hiddenDev.length} freezes in dev-only tooling hidden, ${ms(hiddenDev.reduce((sum, e) => sum + e.ms, 0))} blocked; dev_only: "show" to include them)`,
      ].filter(Boolean);
      if (!shown.length) return text([...notes, 'Nothing matching yet.'].join('\n'));
      return text([...notes, ...shown.map(findingLine)].join('\n'));
    },

    hitch_finding({ id } = {}) {
      const event = findEvent(Number(id));
      if (!event) return failure(`No finding #${id}. It may have been cleared; list them again with hitch_findings.`);
      return text(buildPrompt(withContext(event), root()));
    },

    hitch_top_offenders({ limit } = {}) {
      const stalls = engine.history().stalls ?? [];
      if (!stalls.length) return text('No JS stalls recorded yet.');
      const max = capped(limit, 15, 100);
      const rows = rankOffenders(stalls);
      const row = o => `${ms(o.blockedMs).padStart(7)} blocked · ${String(o.stalls).padStart(3)} stalls · worst ${ms(o.worstMs).padStart(6)} — ${where(o)}${o.kind === 'app' ? '' : ` [${o.pkg ?? o.kind}]`}`;
      const total = stalls.reduce((sum, s) => sum + s.ms, 0);
      const dev = rows.filter(o => o.devOnly);
      const avoidable = avoidableRows(stalls);
      return text(
        [
          `${stalls.length} stalls, ${ms(total)} blocked in all. Blocked time is shared between the lines sampled in each stall.`,
          ...rows.filter(o => !o.devOnly).slice(0, max).map(row),
          ...(dev.length ? ['', 'Dev-only tooling (not in production builds):', ...dev.slice(0, 5).map(o => `${row(o)} (${o.devOnly})`)] : []),
          ...(avoidable.length ? ['', 'Components re-rendered with equal props during freezes (avoidable):', ...avoidable.slice(0, 8).map(r => `${String(r.avoidable).padStart(5)} of ${r.renders} renders · ${r.name} — ${r.reason}`)] : []),
        ].join('\n'),
      );
    },

    hitch_logs({ search, level, since_seconds, limit } = {}) {
      const cut = sinceCut(since_seconds);
      const needle = search?.toLowerCase();
      const logs = (engine.history().logs ?? [])
        .filter(l => (l.lastAt ?? l.at) >= cut)
        .filter(l => !level || l.level === level)
        .filter(l => !needle || l.text.toLowerCase().includes(needle))
        .slice(-capped(limit, 100, LIMIT_MAX));
      if (!logs.length) return text('No app logs matching yet.');
      return text(logs.map(l => `${clock(l.at)} console.${l.level}${l.count > 1 ? ` ×${l.count}` : ''}: ${l.text}`).join('\n'));
    },

    hitch_renders({ since_seconds } = {}) {
      const to = Date.now();
      const renders = engine.renders?.(to - capped(since_seconds, 30, 120) * 1000, to);
      if (!renders) return failure('The React probe is not available for this session (it needs a dev build attached through Metro).');
      if (!renders.commits) return text(`No React commits in the last ${capped(since_seconds, 30, 120)}s. Interact with the app and ask again.${engine.status().health?.probe !== 'on' ? ` (React probe: ${engine.status().health?.probe})` : ''}`);
      const avoidable = avoidableRows(engine.history().stalls ?? []);
      return text(
        [
          ...rendersBlock(renders, `## React in the last ${capped(since_seconds, 30, 120)}s`).slice(1),
          ...(avoidable.length ? ['', '## Avoidable re-renders during freezes this session', ...avoidable.slice(0, 8).map(r => `- ${r.name}: ${r.avoidable} of ${r.renders} renders — ${r.reason}`)] : []),
        ].join('\n'),
      );
    },

    async hitch_profile({ seconds } = {}) {
      const result = await engine.profile(capped(seconds, 5, 30));
      if (!result) return failure("Couldn't record a profile (is the app attached through Metro?).");
      const row = r => `${String(r.selfMs).padStart(6)}ms self · ${String(r.totalMs).padStart(6)}ms total — ${r.key}`;
      return text(
        [
          `${result.seconds}s recorded, ${result.samples} samples of JS running (about ${ms(result.busyMs)} busy).`,
          ...(result.samples ? [] : ['The JS thread was idle the whole time. Profile while doing the slow interaction.']),
          '',
          'Hottest functions (self time):',
          ...result.self.slice(0, 15).map(row),
          ...(result.app.length ? ['', 'Your code by total time (including what it called):', ...result.app.slice(0, 10).map(r => `${String(r.totalMs).padStart(6)}ms — ${r.key}`)] : []),
        ].join('\n'),
      );
    },

    async hitch_heap_snapshot({ label } = {}) {
      if (!label) return failure('Give the snapshot a label, e.g. "before".');
      const summary = await engine.heapSnapshot(String(label));
      return text(
        [
          `Snapshot "${label}"${summary.screen ? ` on ${summary.screen}` : ''}: ${summary.count} objects, ${mb(summary.size)}.`,
          'Largest kinds:',
          ...summary.groups.slice(0, 12).map(g => `- ${g.name}: ${g.count} objects, ${mb(g.size)}`),
        ].join('\n'),
      );
    },

    hitch_heap_diff({ before, after } = {}) {
      const diff = engine.heapDiff(String(before), String(after));
      const kb = bytes => `${bytes >= 0 ? '+' : ''}${Math.round(bytes / 1024)} KB`;
      return text(
        [
          `"${before}" → "${after}": ${diff.countDelta >= 0 ? '+' : ''}${diff.countDelta} objects, ${kb(diff.sizeDelta)}.`,
          diff.grew.length ? 'Grew the most:' : 'Nothing grew.',
          ...diff.grew.map(g => `- ${g.name}: +${g.count} objects (${g.total} now), ${kb(g.size)}`),
          ...(diff.grew.length ? ['', 'Objects that keep growing after leaving a screen are being retained: look for listeners, subscriptions, timers or caches created there and never cleaned up.'] : []),
        ].join('\n'),
      );
    },

    hitch_run_start({ name } = {}) {
      if (!runs) return failure('Runs are not available here.');
      const run = runs.start(String(name ?? 'run'));
      return text(`Recording run "${run.name}". Do the interaction in the app, then call hitch_run_stop.`);
    },

    async hitch_run_stop() {
      if (!runs) return failure('Runs are not available here.');
      const { run, file, previous, comparison } = await runs.stop();
      return text(
        [
          describeRun(run),
          '',
          previous ? `Compared with the previous "${run.name}" run (${previous.git?.branch ?? '?'}@${previous.git?.commit ?? '?'}, ${previous.startedAt}):\n${describeComparison(comparison)}` : 'No earlier run with this name to compare with; the next one will be.',
          '',
          `Saved ${file}`,
        ].join('\n'),
      );
    },

    async hitch_run_scenario({ name, steps, times } = {}) {
      if (!runs) return failure('Runs are not available here.');
      if (!name) return failure('Name the scenario.');
      if (steps) scenarios.save(String(name), steps);
      const saved = scenarios.load(String(name));
      if (!saved) return failure(`No saved scenario "${name}". Pass steps the first time, e.g. [{"reload": true}, {"wait": 10}]. Saved: ${scenarios.list().map(s => s.name).join(', ') || 'none'}`);
      const { run, file, previous, comparison } = await runs.play(saved.name, saved.steps, capped(times, 3, 5));
      return text(
        [
          `Played ${saved.steps.map(step => Object.entries(step).map(([k, v]) => (k === 'reload' ? 'reload' : `${k.replace('_', ' ')} ${v}`))[0]).join(' → ')}`,
          '',
          describeRun(run),
          '',
          previous ? `Compared with the previous run (${previous.git?.branch ?? '?'}@${previous.git?.commit ?? '?'}):\n${describeComparison(comparison)}` : 'First run of this scenario; the next one will be compared with it.',
          '',
          `Saved ${file}`,
        ].join('\n'),
      );
    },

    hitch_runs({ name } = {}) {
      if (!runs) return failure('Runs are not available here.');
      const list = runs.list(name);
      if (!list.length) return text('No saved runs yet. Record one with hitch_run_start / hitch_run_stop.');
      return text(list.slice(-20).map(r => `${r.startedAt}  "${r.name}"  ${r.git?.branch ?? '?'}@${r.git?.commit ?? '?'}  blocked ${r.summary.blockedMs}ms / ${r.summary.stalls} freezes, choppy ${r.summary.jankSeconds}s, ${r.summary.errors} errors`).join('\n'));
    },

    hitch_clear() {
      engine.clear();
      return text('Cleared. Findings and logs from here on only.');
    },

    async hitch_reload_app() {
      const result = await engine.reloadApp();
      return result?.error ? failure(`Couldn't reload: ${result.error}`) : text('Reloading the app.');
    },

    hitch_save_report() {
      return text(`Saved ${engine.writeReport()}`);
    },
  };

  async function handle(message) {
    const { id, method, params } = message ?? {};
    const reply = result => ({ jsonrpc: '2.0', id, result });
    const error = (code, msg) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message: msg } });
    if (message?.jsonrpc !== '2.0' || typeof method !== 'string') return error(-32600, 'Invalid request');
    // Notifications (no id) get no reply.
    if (id === undefined) return null;
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const tool = call[params?.name];
        if (!tool) return error(-32602, `Unknown tool: ${params?.name}`);
        try {
          return reply(await tool(params.arguments ?? {}));
        } catch (err) {
          return reply(failure(`Hitch error: ${err.message}`));
        }
      }
      default:
        return error(-32601, `Method not found: ${method}`);
    }
  }

  // Requests from a web page (a foreign Origin) are refused, so a site open in
  // a browser can't drive Hitch through this port.
  const localOrigin = origin => !origin || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);

  return async function serveMcp(req, res, readBody) {
    const send = (status, body) => {
      res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (!localOrigin(req.headers.origin)) return send(403, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Forbidden origin' } });
    // No server-initiated stream and no sessions to end.
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      return res.end();
    }
    const body = await readBody(req, null);
    if (body === null) return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    if (Array.isArray(body)) {
      const replies = (await Promise.all(body.map(handle))).filter(Boolean);
      return replies.length ? send(200, replies) : send(202);
    }
    const reply = await handle(body);
    return reply ? send(200, reply) : send(202);
  };
}
