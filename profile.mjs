// Hermes sampling profiles (Profiler.stop) as plain stacks: the samples that
// fall inside a time window, and the functions that took the most time.

// Hermes' own bookkeeping nodes ("[root]", "(idle)", "[GC]"…) aren't JS code;
// their url is empty or the same bracketed name.
const isBookkeeping = frame => /^[[(]/.test(frame.functionName ?? '') && (!frame.url || /^[[(]/.test(frame.url));

// { profile, startedAt, scripts } -> [{ at, frames }] with frames innermost first.
export function profileSamples({ profile, startedAt, scripts }) {
  const parent = new Map();
  const nodes = new Map();
  for (const node of profile.nodes) {
    nodes.set(node.id, node);
    for (const child of node.children ?? []) parent.set(child, node.id);
  }
  const stackOf = new Map();
  const framesFor = id => {
    if (stackOf.has(id)) return stackOf.get(id);
    const frames = [];
    for (let at = id; at != null; at = parent.get(at)) {
      const cf = nodes.get(at)?.callFrame;
      if (!cf) continue;
      const frame = { functionName: cf.functionName, url: cf.url || scripts?.get(cf.scriptId) || '', lineNumber: cf.lineNumber, columnNumber: cf.columnNumber };
      if (!isBookkeeping(frame)) frames.push(frame);
    }
    stackOf.set(id, frames);
    return frames;
  };
  const out = [];
  let t = profile.startTime;
  profile.samples.forEach((id, i) => {
    t += profile.timeDeltas[i] ?? 0;
    const frames = framesFor(id);
    if (frames.length) out.push({ at: startedAt + (t - profile.startTime) / 1000, frames });
  });
  return out;
}

// Up to `max` stacks from inside [from, to], spread evenly across it.
export function stacksBetween(samples, from, to, max) {
  const inside = samples.filter(s => s.at >= from && s.at <= to);
  if (inside.length <= max) return inside.map(s => s.frames);
  const step = inside.length / max;
  return Array.from({ length: max }, (_, i) => inside[Math.floor(i * step)].frames);
}

// Self time per function (innermost frame) and total time (anywhere on the
// stack), from samples already turned into described frames.
export function hotFunctions(described, sampleMs) {
  const self = new Map();
  const total = new Map();
  const keyOf = f => (f.file ? `${f.name} · ${f.file}:${f.line}` : `${f.name} [${f.kind}]`);
  for (const frames of described) {
    const leaf = frames[0];
    if (!leaf) continue;
    self.set(keyOf(leaf), { frame: leaf, n: (self.get(keyOf(leaf))?.n ?? 0) + 1 });
    for (const key of new Set(frames.map(keyOf))) total.set(key, (total.get(key) ?? 0) + 1);
  }
  const rows = [...self].map(([key, { frame, n }]) => ({ key, frame, selfMs: Math.round(n * sampleMs), totalMs: Math.round((total.get(key) ?? n) * sampleMs) }));
  const app = [...total]
    .map(([key, n]) => ({ key, totalMs: Math.round(n * sampleMs) }))
    .filter(row => !row.key.includes('node_modules/') && /\.(t|j)sx?:\d+$/.test(row.key));
  return {
    self: rows.sort((a, b) => b.selfMs - a.selfMs),
    // Your own functions by total time: where to look, even when a library does the work.
    app: app.sort((a, b) => b.totalMs - a.totalMs),
  };
}
