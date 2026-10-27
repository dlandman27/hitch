// Named runs: mark the start and end of an interaction ("open app → scroll
// home"), get its numbers, and compare them with the previous run of the same
// name, e.g. on another branch. Saved in ~/.hitch/runs/<name>/<time>.json.

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { rankOffenders } from './engine.mjs';

const RUNS_DIR = path.join(os.homedir(), '.hitch', 'runs');
const SCENARIOS_DIR = path.join(os.homedir(), '.hitch', 'scenarios');
const run = promisify(execFile);
const MAX_WAIT_S = 120;
// Profiling a run gives its short freezes real stacks; Hermes keeps a profile
// in memory, so a long run is only profiled for its first minute.
const RUN_PROFILE_MS = 60000;
const MB = 1024 * 1024;

const slug = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'run';
const within = (list, from, to) => (list ?? []).filter(e => e.at >= from && e.at <= to);

function gitInfo(root) {
  const git = args => {
    try {
      return execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      return null;
    }
  };
  return { branch: git(['rev-parse', '--abbrev-ref', 'HEAD']), commit: git(['rev-parse', '--short', 'HEAD']), dirty: Boolean(git(['status', '--porcelain'])) };
}

// The numbers for one run, from the session history between from and to.
export function summarizeRun(history, from, to, renders) {
  const stalls = within(history.stalls, from, to);
  const devOnly = stalls.filter(s => s.devOnly);
  const jank = within(history.jank, from, to);
  const consoleEvents = within(history.console, from, to);
  const requests = within(history.requests, from, to).filter(r => r.issue);
  const vitals = within(history.vitals, from, to);
  // Mid-reload samples read an empty heap; skip them.
  const first = vitals.find(v => v.heapUsed > 0 || v.rss > 0);
  const last = vitals.findLast(v => v.heapUsed > 0 || v.rss > 0);
  return {
    seconds: Math.round((to - from) / 100) / 10,
    stalls: stalls.length,
    blockedMs: stalls.reduce((sum, s) => sum + s.ms, 0),
    worstStallMs: Math.max(0, ...stalls.map(s => s.ms)),
    devOnlyMs: devOnly.reduce((sum, s) => sum + s.ms, 0),
    jankSeconds: jank.reduce((sum, j) => sum + j.seconds, 0),
    droppedFrames: jank.reduce((sum, j) => sum + j.dropped, 0),
    screens: within(history.screens, from, to).map(sc => ({ name: sc.name, ms: sc.ms })),
    errors: consoleEvents.filter(c => c.level === 'error').length,
    warnings: consoleEvents.filter(c => c.level === 'warn').length,
    slowRequests: requests.filter(r => !r.failed).length,
    failedRequests: requests.filter(r => r.failed).length,
    heapMb: first?.heapUsed != null && last?.heapUsed != null ? { from: Math.round(first.heapUsed / MB), to: Math.round(last.heapUsed / MB) } : null,
    appMemoryMb: first?.rss != null && last?.rss != null ? { from: Math.round(first.rss / MB), to: Math.round(last.rss / MB) } : null,
    renders: renders?.commits ? { commits: renders.commits, renderMs: renders.renderMs, mounts: renders.mounts, avoidable: renders.avoidable, top: renders.components.slice(0, 5).map(c => ({ name: c.name, renders: c.renders, ms: c.ms })) } : null,
    offenders: rankOffenders(stalls.filter(s => !s.devOnly))
      .slice(0, 5)
      .map(o => ({ where: o.file ? `${o.name} · ${o.file}:${o.line}` : o.name, blockedMs: Math.round(o.blockedMs) })),
  };
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

// Several runs of one scenario as one summary: the median of each number,
// plus the range of blocked time so a reader can see how noisy it was.
export function medianSummary(summaries) {
  if (summaries.length === 1) return summaries[0];
  const typical = [...summaries].sort((a, b) => a.blockedMs - b.blockedMs)[summaries.length >> 1];
  const out = { ...typical, iterations: summaries.length };
  for (const key of ['seconds', 'stalls', 'blockedMs', 'worstStallMs', 'devOnlyMs', 'jankSeconds', 'droppedFrames', 'errors', 'warnings', 'slowRequests', 'failedRequests']) {
    out[key] = median(summaries.map(s => s[key] ?? 0));
  }
  const names = [...new Set(summaries.flatMap(s => s.screens.map(sc => sc.name)))];
  out.screens = names.map(name => ({ name, ms: median(summaries.flatMap(s => s.screens.filter(sc => sc.name === name).map(sc => sc.ms))) }));
  if (summaries.every(s => s.renders)) {
    out.renders = { ...typical.renders };
    for (const key of ['commits', 'renderMs', 'mounts', 'avoidable']) out.renders[key] = median(summaries.map(s => s.renders[key]));
  }
  out.spread = { blockedMs: [Math.min(...summaries.map(s => s.blockedMs)), Math.max(...summaries.map(s => s.blockedMs))] };
  return out;
}

// Lower is better for everything compared here.
const METRICS = [
  ['blockedMs', 'JS blocked', 'ms'],
  ['stalls', 'freezes', ''],
  ['worstStallMs', 'worst freeze', 'ms'],
  ['jankSeconds', 'choppy seconds', 's'],
  ['droppedFrames', 'dropped frames (outside freezes)', ''],
  ['errors', 'console errors', ''],
  ['warnings', 'console warnings', ''],
  ['slowRequests', 'slow requests', ''],
  ['failedRequests', 'failed requests', ''],
];

export function compareRuns(before, after) {
  const lines = [];
  let better = 0;
  let worse = 0;
  // Changes smaller than this are noise between two runs of the same steps.
  const meaningful = (a, b) => Math.abs(b - a) >= Math.max(1, Math.abs(a) * 0.1);
  for (const [key, label, unit] of METRICS) {
    const a = before[key] ?? 0;
    const b = after[key] ?? 0;
    if (a === b) continue;
    const change = meaningful(a, b) ? (b < a ? 'better' : 'worse') : 'same';
    if (change === 'better') better += 1;
    if (change === 'worse') worse += 1;
    lines.push({ label, before: a, after: b, unit, change });
  }
  const screensBefore = new Map(before.screens.map(sc => [sc.name, sc.ms]));
  for (const sc of after.screens) {
    const a = screensBefore.get(sc.name);
    if (a == null) continue;
    const change = meaningful(a, sc.ms) ? (sc.ms < a ? 'better' : 'worse') : 'same';
    if (change === 'better') better += 1;
    if (change === 'worse') worse += 1;
    lines.push({ label: `${sc.name} screen load`, before: a, after: sc.ms, unit: 'ms', change });
  }
  if (before.renders && after.renders) {
    for (const [key, label] of [['renderMs', 'React render time'], ['avoidable', 'avoidable re-renders'], ['mounts', 'component mounts']]) {
      const a = before.renders[key];
      const b = after.renders[key];
      if (a === b) continue;
      const change = meaningful(a, b) ? (b < a ? 'better' : 'worse') : 'same';
      if (change === 'better') better += 1;
      if (change === 'worse') worse += 1;
      lines.push({ label, before: a, after: b, unit: key === 'renderMs' ? 'ms' : '', change });
    }
  }
  const verdict = better && !worse ? 'better' : worse && !better ? 'worse' : better || worse ? 'mixed' : 'about the same';
  return { verdict, lines };
}

export function describeComparison(comparison) {
  const arrow = { better: '↓ better', worse: '↑ worse', same: '≈ same' };
  return [
    `Overall: ${comparison.verdict}.`,
    ...comparison.lines.map(l => `- ${l.label}: ${l.before}${l.unit} → ${l.after}${l.unit} (${arrow[l.change]})`),
  ].join('\n');
}

export function describeRun(run) {
  const s = run.summary;
  return [
    `Run "${run.name}" — ${s.iterations ? `median of ${s.iterations} plays, ` : ''}${s.seconds}s${run.git?.branch ? ` on ${run.git.branch}@${run.git.commit}${run.git.dirty ? ' (uncommitted changes)' : ''}` : ''}`,
    `- JS blocked ${s.blockedMs}ms${s.spread ? ` (range ${s.spread.blockedMs[0]}–${s.spread.blockedMs[1]}ms)` : ''} over ${s.stalls} freeze(s), worst ${s.worstStallMs}ms${s.devOnlyMs ? ` (${s.devOnlyMs}ms of it dev-only tooling)` : ''}`,
    `- Choppy frames: ${s.jankSeconds}s, ${s.droppedFrames} dropped outside freezes`,
    ...(s.screens.length ? [`- Screens: ${s.screens.map(sc => `${sc.name} ${(sc.ms / 1000).toFixed(1)}s`).join(', ')}`] : []),
    `- Console: ${s.errors} errors, ${s.warnings} warnings · Requests: ${s.slowRequests} slow, ${s.failedRequests} failed`,
    ...(s.renders ? [`- React: ${s.renders.commits} commits, ${s.renders.renderMs}ms rendering, ${s.renders.mounts} mounts, ${s.renders.avoidable} avoidable re-renders; most time in ${s.renders.top.map(c => `${c.name} (${c.ms}ms)`).join(', ')}`] : []),
    ...(s.heapMb ? [`- JS heap ${s.heapMb.from} → ${s.heapMb.to} MB${s.appMemoryMb ? `, app memory ${s.appMemoryMb.from} → ${s.appMemoryMb.to} MB` : ''}`] : []),
    ...(s.offenders.length ? ['- Top blocking lines:', ...s.offenders.map(o => `  - ${o.blockedMs}ms ${o.where}`)] : []),
  ].join('\n');
}

// A scenario is a named list of steps that replays the same way each time:
//   { reload: true }            reload the app's JS (and wait for it to start)
//   { open_url: "myapp://x" }   open a deep link in the booted simulator
//   { wait: 5 }                 wait N seconds (time to settle, or for you to scroll)
export function validateSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('a scenario needs at least one step');
  for (const step of steps) {
    const keys = Object.keys(step ?? {});
    if (keys.length !== 1 || !['reload', 'open_url', 'wait'].includes(keys[0])) throw new Error(`unknown step ${JSON.stringify(step)}; use {reload: true}, {open_url: "..."} or {wait: seconds}`);
    if (keys[0] === 'wait' && !(step.wait > 0 && step.wait <= MAX_WAIT_S)) throw new Error(`wait must be 1-${MAX_WAIT_S} seconds`);
    if (keys[0] === 'open_url' && !/^[a-z][\w+.-]*:\/\//i.test(String(step.open_url))) throw new Error(`open_url needs a URL with a scheme, got ${step.open_url}`);
  }
  return steps;
}

const RELOAD_SETTLE_MS = 2000;
async function playStep(step, engine) {
  if (step.reload) {
    await engine.reloadApp();
    await new Promise(r => setTimeout(r, RELOAD_SETTLE_MS));
  } else if (step.open_url) {
    await run('xcrun', ['simctl', 'openurl', 'booted', step.open_url], { timeout: 10000 });
  } else if (step.wait) {
    await new Promise(r => setTimeout(r, step.wait * 1000));
  }
}

export function createScenarios({ dir = SCENARIOS_DIR } = {}) {
  const file = name => path.join(dir, `${slug(name)}.json`);
  return {
    save(name, steps) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file(name), JSON.stringify({ name, steps: validateSteps(steps) }, null, 2));
    },
    load(name) {
      return fs.existsSync(file(name)) ? JSON.parse(fs.readFileSync(file(name), 'utf8')) : null;
    },
    list() {
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) : [];
    },
  };
}

export function createRuns({ engine, root, dir = RUNS_DIR }) {
  let active = null;

  const previousRun = name => {
    const folder = path.join(dir, slug(name));
    if (!fs.existsSync(folder)) return null;
    const files = fs.readdirSync(folder).filter(f => f.endsWith('.json')).sort();
    return files.length ? JSON.parse(fs.readFileSync(path.join(folder, files.at(-1)), 'utf8')) : null;
  };

  const measure = async () => {
    if (!active) throw new Error('no run is recording; start one first');
    const run = active;
    active = null;
    engine.stopProfileWindow?.();
    // Freezes still being written up land in history a moment later.
    await new Promise(r => setTimeout(r, 1500));
    const to = Date.now();
    return { run, summary: summarizeRun(engine.history(), run.startedAt, to, engine.renders?.(run.startedAt, to)) };
  };

  const save = (run, summary) => {
    const record = { name: run.name, startedAt: new Date(run.startedAt).toISOString(), app: engine.status().appId, git: gitInfo(root()), summary };
    const previous = previousRun(run.name);
    const folder = path.join(dir, slug(run.name));
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `${record.startedAt.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
    return { run: record, file, previous, comparison: previous ? compareRuns(previous.summary, summary) : null };
  };

  return {
    active: () => (active ? { name: active.name, startedAt: active.startedAt } : null),
    start(name) {
      if (active) throw new Error(`run "${active.name}" is still recording; stop it first`);
      active = { name: name || 'run', startedAt: Date.now() };
      engine.profileWindow?.(RUN_PROFILE_MS, 'run');
      return active;
    },
    async stop() {
      const { run, summary } = await measure();
      return save(run, summary);
    },

    // Plays a scenario's steps `times` times as one run: single runs of the
    // same code vary a lot, so the saved numbers are the medians.
    async play(name, steps, times = 1) {
      validateSteps(steps);
      const summaries = [];
      let first = null;
      for (let i = 0; i < times; i++) {
        this.start(name);
        try {
          for (const step of steps) await playStep(step, engine);
        } catch (error) {
          await measure().catch(() => {});
          throw error;
        }
        const { run, summary } = await measure();
        first ??= run;
        summaries.push(summary);
      }
      return save(first, medianSummary(summaries));
    },
    list(name) {
      if (!fs.existsSync(dir)) return [];
      const names = name ? [slug(name)] : fs.readdirSync(dir);
      return names.flatMap(n => {
        const folder = path.join(dir, n);
        if (!fs.existsSync(folder)) return [];
        return fs
          .readdirSync(folder)
          .filter(f => f.endsWith('.json'))
          .sort()
          .map(f => JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8')));
      });
    },
  };
}
