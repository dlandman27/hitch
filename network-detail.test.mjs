import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HIDDEN, clip, createBodyStore, prettyBody, redactBody, redactHeaders } from './network-detail.mjs';

test('credentials in headers are hidden, everything else kept', () => {
  assert.deepEqual(redactHeaders({ Authorization: 'Bearer abc', Cookie: 'sid=1', 'X-Api-Key': 'k', appType: 'DFS', deviceid: '42' }), {
    Authorization: HIDDEN,
    Cookie: HIDDEN,
    'X-Api-Key': HIDDEN,
    appType: 'DFS',
    deviceid: '42',
  });
  assert.equal(redactHeaders(null), null);
});

test('secret-looking JSON fields are hidden at any depth; other bodies untouched', () => {
  const out = JSON.parse(redactBody('{"email":"a@b.c","password":"hunter2","session":{"accessToken":"xyz","id":3},"items":[{"pin":"1234"}]}'));
  assert.equal(out.email, 'a@b.c');
  assert.equal(out.password, HIDDEN);
  assert.equal(out.session.accessToken, HIDDEN);
  assert.equal(out.session.id, 3);
  assert.equal(out.items[0].pin, HIDDEN);
  assert.equal(redactBody('plain=text&password=x'), 'plain=text&password=x');
  assert.equal(redactBody('{broken'), '{broken');
});

test('bodies are clipped, pretty-printed and kept for recent requests only', () => {
  assert.deepEqual(clip('abcdef', 4), { text: 'abcd', truncated: true, size: 6 });
  assert.deepEqual(clip('ab', 4), { text: 'ab', truncated: false, size: 2 });
  assert.equal(prettyBody('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(prettyBody('not json'), 'not json');
  const store = createBodyStore(2);
  store.set(1, 'a');
  store.set(2, 'b');
  store.set(3, 'c');
  assert.equal(store.get(1), null);
  assert.equal(store.get(3), 'c');
});
