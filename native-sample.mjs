// Parses macOS `sample` output into per-thread busy time, hottest native
// frames, and subsystem breakdown. Used only for short bursts when a thread
// is already running hot.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const IDLE_LEAVES = /^(mach_msg2_trap|mach_msg_trap|__psynch_cvwait|__psynch_mutexwait|__workq_kernreturn|__semwait_signal|poll|__select|semaphore_\w*wait_trap|kevent\w*|__ulock_wait2?|start_wqthread|__sigsuspend|__accept|__recvfrom|read|__open)\b/;

// Specific subsystems claim a sample if they appear anywhere on its stack
// (priority order); generic layers only count when nearest the leaf.
const SPECIFIC = [
  ['Yoga layout', /facebook::yoga|\bYG[A-Z]/],
  ['Text layout', /TextLayoutManager|RCTTextLayout|CoreText|NSLayoutManager|TextKit/],
  ['Hermes GC', /HadesGC|hermes::vm::GC|markRoots/],
  ['Reanimated / worklets', /reanimated|worklets::/],
  ['Images', /ImageIO|SDWebImage|SDImage|vImage|ExpoImage|AppleJPEG/],
  ['Firestore / gRPC', /firebase::firestore|firestore::|grpc|leveldb/],
  ['Analytics SDKs', /Datadog|DdSdk|RUMMonitor|Amplitude|Segment|Sentry|Crashlytics|Intercom|AppsFlyer/],
  ['Network', /CFNetwork|NSURLSession|boringssl/],
  ['React mounting / shadow tree', /ShadowTree|ShadowNode|Differentiator|calculateShadowViewMutations|MountingCoordinator|RCTMounting|ComponentView|UIManager::|LayoutableShadowNode/],
];
const GENERIC = [
  ['Hermes JS execution', /hermes::|facebook::hermes|jsi::/],
  ['CoreAnimation / render', /QuartzCore|CA::|Metal|IOSurface/],
  ['UIKit', /UIKitCore/],
];
// Leaf frames that say nothing on their own; report the nearest caller instead.
export const GENERIC_LEAF = /^(objc_msgSend|objc_retain|objc_release|objc_autorelease\w*|swift_retain|swift_release|swift_\w*[Rr]etain\w*|swift_\w*[Rr]elease\w*|_?_?platform_mem\w+|_?malloc\w*|nanov2_\w+|free|_free|szone_\w+|CFRetain|CFRelease|pthread_\w+|_pthread_\w+|os_unfair_lock\w*|_os_unfair_lock\w*|memcpy|memmove|bzero|std::__1::\w+|operator new|operator delete)\b/;

// The Hermes sampler (its own thread + the signal handler it injects into the
// JS thread) is the tool's footprint, not the app's.
const PROFILER_THREAD = /^hermes-sampling-profiler/;
const PROFILER_FRAME = /^_sigtramp\b/;

const LINE = /^(\s*)[+!:| ]*?(\d+)\s+(.+)$/;
const THREAD_HEADER = /^ {4}(\d+) (Thread_\d+.*)$/;

export function categoryOf(stack) {
  for (const [name, pattern] of SPECIFIC) {
    if (stack.some(frame => pattern.test(frame))) return name;
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    for (const [name, pattern] of GENERIC) {
      if (pattern.test(stack[i])) return name;
    }
  }
  return 'Other';
}

function cleanFrame(text) {
  // "sym  (in Lib) + 12  [0x..]  /path/file.mm:42" -> "sym  (Lib)  file.mm:42"
  const m = text.match(/^(.*?)\s+\(in ([^)]+)\)(?:\s+load address [^+]+)?(?:\s+\+\s+[0-9a-fx,]+)?\s+\[[0-9a-fx,]+\](?:\s+(.*))?$/);
  if (!m) return text.trim();
  const source = m[3] && !m[3].includes('<compiler-generated>') ? `  ${m[3].trim()}` : '';
  return `${m[1].trim()}  (${m[2]})${source}`;
}

export function threadLabel(header) {
  const name = header.replace(/^Thread_\d+\s*:?\s*/, '').trim();
  if (/com\.apple\.main-thread|^Main Thread\b/.test(name)) return 'Main/UI thread';
  if (/react\.runtime\.JavaScript/.test(name)) return 'JS thread';
  if (/^hades/.test(name)) return 'Hermes GC (hades)';
  return name || 'unnamed threads (pool)';
}

export function parseSample(text, intervalMs) {
  const lines = text.split('\n');
  const start = lines.findIndex(l => l.startsWith('Call graph:'));
  const end = lines.findIndex((l, i) => i > start && l.startsWith('Total number in stack'));
  const threads = [];
  let thread = null;
  let stack = [];

  const flush = () => {
    if (thread) threads.push(thread);
  };

  for (const raw of lines.slice(start + 1, end === -1 ? undefined : end)) {
    const header = raw.match(THREAD_HEADER);
    if (header) {
      flush();
      thread = { label: threadLabel(header[2]), samples: Number(header[1]), nodes: [] };
      stack = [];
      continue;
    }
    if (!thread) continue;
    const m = raw.match(LINE);
    if (!m) continue;
    // Depth is the column where the sample count starts.
    const depth = raw.indexOf(m[2], m[1].length);
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    const node = { depth, count: Number(m[2]), frame: cleanFrame(m[3]), childCount: 0, parent: stack.at(-1) ?? null };
    if (node.parent) node.parent.childCount += node.count;
    stack.push(node);
    thread.nodes.push(node);
  }
  flush();

  return mergeByLabel(threads.map(t => summarizeThread(t, intervalMs)));
}

// Pools and serial queues hop between OS threads; one row per name. Busy can
// exceed wall time for a pool (more than one core in use).
function mergeByLabel(threads) {
  const merged = new Map();
  for (const thread of threads) {
    const existing = merged.get(thread.label);
    if (!existing) {
      merged.set(thread.label, thread);
      continue;
    }
    existing.totalMs = Math.max(existing.totalMs, thread.totalMs);
    existing.busyMs += thread.busyMs;
    existing.overheadMs += thread.overheadMs;
    for (const [key, value] of thread.self) existing.self.set(key, (existing.self.get(key) ?? 0) + value);
    for (const [key, value] of thread.categories) existing.categories.set(key, (existing.categories.get(key) ?? 0) + value);
  }
  return [...merged.values()];
}

function summarizeThread(thread, intervalMs) {
  // The thread name counts as a frame so SDK-owned threads land in their category.
  const self = new Map();
  const categories = new Map();
  let busy = 0;
  let overhead = 0;
  for (const node of thread.nodes) {
    const selfCount = node.count - node.childCount;
    if (selfCount <= 0) continue;
    const symbol = node.frame.split('  ')[0];
    if (IDLE_LEAVES.test(symbol)) continue;
    const path = [];
    for (let n = node; n; n = n.parent) path.unshift(n.frame);
    if (PROFILER_THREAD.test(thread.label) || path.some(frame => PROFILER_FRAME.test(frame))) {
      overhead += selfCount;
      continue;
    }
    busy += selfCount;
    const category = categoryOf([thread.label, ...path]);
    const attributed = path.findLast(frame => !GENERIC_LEAF.test(frame)) ?? node.frame;
    categories.set(category, (categories.get(category) ?? 0) + selfCount);
    const key = `${attributed}\u0000${category}`;
    self.set(key, (self.get(key) ?? 0) + selfCount);
  }
  return {
    label: thread.label,
    totalMs: thread.samples * intervalMs,
    busyMs: busy * intervalMs,
    overheadMs: overhead * intervalMs,
    self: new Map([...self].map(([k, v]) => [k, v * intervalMs])),
    categories: new Map([...categories].map(([k, v]) => [k, v * intervalMs])),
  };
}

export async function findSimulatorPid(appId) {
  try {
    const { stdout } = await run('xcrun', ['simctl', 'spawn', 'booted', 'launchctl', 'list']);
    const row = stdout.split('\n').find(l => l.includes(`UIKitApplication:${appId}[`));
    const pid = Number(row?.trim().split(/\s+/)[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function sampleNative({ pid, seconds, intervalMs }) {
  const { stdout } = await run('sample', [String(pid), String(seconds), String(intervalMs)], {
    maxBuffer: 256 * 1024 * 1024,
  });
  return parseSample(stdout, intervalMs);
}

// Thread names in `ps -M` row order (both list threads in creation order).
export async function threadNames(pid) {
  const { stdout } = await run('sample', [String(pid), '0.3', '10'], { maxBuffer: 64 * 1024 * 1024 });
  return stdout
    .split('\n')
    .map(line => line.match(THREAD_HEADER))
    .filter(Boolean)
    .map(match => threadLabel(match[2]));
}
