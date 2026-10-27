import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fingerprint, formatConsoleArgs, previewFromProperties } from './console-format.mjs';

const str = value => ({ type: 'string', value });
const num = value => ({ type: 'number', value, description: String(value) });

test('fills printf placeholders the way React warnings use them', () => {
  const args = [str('Warning: Each child in a list should have a unique "key" prop.%s%s See https://react.dev/link/warning-keys'), str('\n\nCheck the render method of `PlayerList`.'), str('')];
  assert.equal(formatConsoleArgs(args), 'Warning: Each child in a list should have a unique "key" prop.\n\nCheck the render method of `PlayerList`. See https://react.dev/link/warning-keys');
});

test('handles %d, %f, %c, %% and leftover arguments', () => {
  assert.equal(formatConsoleArgs([str('%d items at %f%% %cstyled'), num(3.7), num(2.5), str('color: red'), str('extra')]), '3 items at 2.5% styled extra');
  assert.equal(formatConsoleArgs([str('missing %s')]), 'missing %s');
});

test('shows objects by their contents', () => {
  const obj = {
    type: 'object',
    description: 'Object',
    preview: {
      type: 'object',
      description: 'Object',
      overflow: false,
      properties: [
        { name: 'id', type: 'number', value: '42' },
        { name: 'name', type: 'string', value: 'Maxey' },
        { name: 'tags', type: 'object', subtype: 'array', value: 'Array(2)' },
      ],
    },
  };
  assert.equal(formatConsoleArgs([str('save failed'), obj]), "save failed {id: 42, name: 'Maxey', tags: Array(2)}");
  const arr = { type: 'object', subtype: 'array', description: 'Array(2)', preview: { subtype: 'array', properties: [{ name: '0', type: 'number', value: '1' }, { name: '1', type: 'string', value: 'b' }] } };
  assert.equal(formatConsoleArgs([arr]), "[1, 'b']");
});

test('uses fetched properties when the debugger sent no preview', () => {
  const remote = { type: 'object', description: 'Object', objectId: '1' };
  const props = [
    { name: 'status', enumerable: true, value: { type: 'number', value: 500 } },
    { name: 'body', enumerable: true, value: { type: 'object', description: 'Object' } },
    { name: '__proto__', enumerable: false, value: { type: 'object', description: 'Object' } },
  ];
  assert.equal(formatConsoleArgs([remote], new Map([[0, previewFromProperties(remote, props)]])), '{status: 500, body: Object}');
});

test('prints errors by name and message', () => {
  assert.equal(formatConsoleArgs([{ type: 'object', subtype: 'error', description: 'TypeError: x is undefined\n    at foo (bundle:1:2)' }]), 'TypeError: x is undefined\n    at foo (bundle:1:2)');
  const bare = { type: 'object', subtype: 'error', description: 'Error', objectId: '2' };
  const props = [
    { name: 'message', enumerable: false, value: { type: 'string', value: 'Network request failed' } },
    { name: 'name', enumerable: false, value: { type: 'string', value: 'TypeError' } },
  ];
  assert.equal(formatConsoleArgs([bare], new Map([[0, previewFromProperties(bare, props)]])), 'TypeError: Network request failed');
});

test('null, undefined and special numbers', () => {
  assert.equal(formatConsoleArgs([{ type: 'object', subtype: 'null', value: null }, { type: 'undefined' }, { type: 'number', unserializableValue: 'NaN', description: 'NaN' }]), 'null undefined NaN');
});

test('fingerprint ignores ids, numbers and times', () => {
  assert.equal(fingerprint('fetch 3f2a9c1e-1b2c-4d5e-8f90-123456789abc failed after 1200ms'), fingerprint('fetch 00000000-1111-2222-3333-444444444444 failed after 87ms'));
  assert.equal(fingerprint('user 123 at 2026-10-27T10:00:00.123Z'), fingerprint('user 9 at 2026-10-28T11:12:13.000Z'));
  assert.notEqual(fingerprint('save failed'), fingerprint('load failed'));
});
