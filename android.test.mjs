import { test } from 'node:test';
import assert from 'node:assert/strict';

import { laneName, parseDevices, parseSimpleperf, parseStat, splitFrames, startedAtFrom } from './android.mjs';

test('parseDevices keeps ready devices with readable models', () => {
  const text = 'List of devices attached\nemulator-5554          device product:sdk_gphone16k_arm64 model:sdk_gphone16k_arm64 transport_id:1\nR5CT    unauthorized usb:1-1\n';
  assert.deepEqual(parseDevices(text), [{ serial: 'emulator-5554', model: 'sdk gphone16k arm64' }]);
});

test('parseStat reads names with spaces and parentheses', () => {
  const line = '13120 (OkHttp TaskRunn) S 13094 1 0 0 -1 1077952576 100 0 0 0 7 5 0 0 20 0 30 0 654700 0 0';
  assert.deepEqual(parseStat(line), { tid: 13120, name: 'OkHttp TaskRunn', ticks: 12 });
});

test('laneName maps React Native and ART threads', () => {
  assert.equal(laneName('com.alphatalid', 100, 100), 'Main/UI thread');
  assert.equal(laneName('mqt_v_js', 101, 100), 'JS thread');
  assert.equal(laneName('mqt_v_native', 102, 100), 'Native modules thread');
  assert.equal(laneName('hades', 103, 100), 'Hermes GC (hades)');
  assert.equal(laneName('HeapTaskDaemon', 104, 100), 'Java GC (ART)');
  assert.equal(laneName('.0.2.2:8081/...', 105, 100), 'Metro connection (dev only)');
  assert.equal(laneName('pool-23-thread-', 106, 100), 'unnamed threads (pool)');
});

test('startedAtFrom turns boot ticks into a wall-clock time', () => {
  const stat = '13094 (com.alphatalid) S 1 1 0 0 -1 0 0 0 0 0 0 0 0 0 20 0 50 0 654613 0';
  // Booted 7239.65s ago; the process started 6546.13s after boot.
  assert.equal(startedAtFrom(stat, '7239.65 14473.51', 1_000_000_000), 1_000_000_000 - 693520);
});

test('parseSimpleperf groups samples by lane and attributes past generic leaves', () => {
  let time = 0;
  const sample = (tid, name, frames) =>
    ['sample:', '  event_type: cpu-clock', `  time: ${(time += 500_000_000)}`, '  event_count: 1000000', `  thread_id: ${tid}`, `  thread_name: ${name}`, ...frames.flatMap(([file, symbol], i) => [...(i === 1 ? ['  callchain:'] : []), '    vaddr_in_file: 1f', `    file: ${file}`, `    symbol: ${symbol}`])].join('\n');
  const text = [
    'meta_info:\n  event_type: cpu-clock',
    sample(101, 'mqt_v_js', [['/system/lib64/libc.so', '__ioctl'], ['/system/lib64/libc.so', 'memcpy'], ['/data/app/lib/arm64/libhermes.so', 'hermes::vm::Interpreter::interpretFunction'], ['/system/lib64/libc.so', '__start_thread']]),
    sample(101, 'mqt_v_js', [['/data/app/lib/arm64/libhermes.so', 'hermes::vm::Interpreter::interpretFunction']]),
    sample(100, 'com.alphatalid', [['/data/app/lib/arm64/libyoga.so', 'facebook::yoga::calculateLayout (.__uniq.1234)'], ['/system/framework/framework.jar', 'android.os.Looper.loop']]),
    sample(107, 'hermes-sampling', [['/data/app/lib/arm64/libhermes.so', 'hermes::vm::SamplingProfiler::timerLoop']]),
  ].join('\n');
  const threads = parseSimpleperf(text, 100);
  const js = threads.find(t => t.label === 'JS thread');
  assert.equal(js.busyMs, 2);
  assert.deepEqual([...js.categories], [['Hermes JS execution', 2]]);
  assert.equal(js.self.get('hermes::vm::Interpreter::interpretFunction  (libhermes.so)\u0000Hermes JS execution'), 2);
  const ui = threads.find(t => t.label === 'Main/UI thread');
  assert.deepEqual([...ui.categories], [['Yoga layout', 1]]);
  assert.ok(ui.self.has('facebook::yoga::calculateLayout  (libyoga.so)\u0000Yoga layout'));
  // Hitch's own sampler thread is left out, but its samples still bound the window.
  assert.equal(threads.find(t => /sampling/.test(t.label)), undefined);
  assert.equal(js.windowMs, 1500);
});

test('splitFrames keeps a partial frame for the next chunk', () => {
  assert.deepEqual(splitFrames('1 (a) S\n@@\n2 (b) S\n@@\n3 (c'), { frames: ['1 (a) S\n', '2 (b) S\n'], rest: '3 (c' });
  assert.deepEqual(splitFrames('1 (a'), { frames: [], rest: '1 (a' });
});
