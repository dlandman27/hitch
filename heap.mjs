// JS heap snapshots (HeapProfiler.takeHeapSnapshot) reduced to counts and
// bytes per constructor, and the difference between two of them: which kinds
// of objects piled up between "before" and "after" (open a screen, leave it).

// Node types that are the app's own objects; code, strings and internals are
// summarized under their type instead of every distinct string.
const BY_NAME = new Set(['object', 'closure', 'array', 'regexp', 'native']);

export function summarizeHeapSnapshot(snapshot) {
  const { meta } = snapshot.snapshot;
  const fields = meta.node_fields;
  const types = meta.node_types[fields.indexOf('type')];
  const width = fields.length;
  const typeAt = fields.indexOf('type');
  const nameAt = fields.indexOf('name');
  const sizeAt = fields.indexOf('self_size');
  const { nodes, strings } = snapshot;
  const groups = new Map();
  let totalSize = 0;
  let count = 0;
  for (let i = 0; i < nodes.length; i += width) {
    const type = types[nodes[i + typeAt]];
    const size = nodes[i + sizeAt];
    const name = BY_NAME.has(type) ? `${strings[nodes[i + nameAt]] || '(anonymous)'}${type === 'closure' ? '()' : ''}` : `(${type})`;
    const group = groups.get(name) ?? { name, count: 0, size: 0 };
    group.count += 1;
    group.size += size;
    groups.set(name, group);
    totalSize += size;
    count += 1;
  }
  return { at: Date.now(), count, size: totalSize, groups: [...groups.values()].sort((a, b) => b.size - a.size) };
}

// Growth from `before` to `after`, biggest first (by count, then bytes).
export function diffHeap(before, after, limit = 25) {
  const was = new Map(before.groups.map(g => [g.name, g]));
  const grew = after.groups
    .map(g => ({ name: g.name, count: g.count - (was.get(g.name)?.count ?? 0), size: g.size - (was.get(g.name)?.size ?? 0), total: g.count }))
    .filter(g => g.count > 0 || g.size > 1024)
    .sort((a, b) => b.size - a.size || b.count - a.count);
  return { countDelta: after.count - before.count, sizeDelta: after.size - before.size, grew: grew.slice(0, limit) };
}
