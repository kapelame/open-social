import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftStore, draftKey } from '../src/studio-draft.js';

function tabs(legacy) {
  const data = new Map(legacy ? [[draftKey, JSON.stringify(legacy)]] : []);
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
  let tail = Promise.resolve();
  const locks = {
    request(name, action) {
      assert.equal(name, draftKey);
      const result = tail.then(action);
      tail = result.catch(() => {});
      return result;
    },
  };
  return [createDraftStore(storage, locks), createDraftStore(storage, locks)];
}

function payload(draft, mode = 'live') {
  return { mode, targets: [{ platform: 'x', text: draft.text }], mediaIds: [] };
}

test('concurrent submissions and a retry after a lost receipt reuse the same durable request ID', async () => {
  for (const mode of ['live', 'browser', 'demo']) {
    const [a, b] = tabs({ text: 'one draft', selected: ['x'], mode });
    const draftA = a.read(),
      draftB = b.read();
    const request = payload(draftA, mode);
    const [first, second] = await Promise.all([a.reserve(draftA, request), b.reserve(draftB, request)]);
    assert.equal(first.id, second.id);
    assert.equal((await b.reserve(b.read(), request)).id, first.id);
    await a.finish(draftA, first.id, mode);
    await b.finish(draftB, second.id, mode);
    assert.equal(b.read().text, mode === 'demo' ? draftA.text : '');
    assert.notEqual(b.read().id, draftA.id);
    await assert.rejects(b.reserve(draftB, request), /草稿已在其他标签页更新/);
  }
});

test('a stale platform selection cannot replace newer text or remove a concurrent attachment', async () => {
  const [a, b] = tabs({ text: 'old copy', selected: ['x'] });
  const stale = b.read();
  await Promise.all([
    a.edit(stale.id, (current) => {
      current.text = 'revised';
    }),
    b.edit(stale.id, (current) => {
      current.selected.push('linkedin');
    }),
    a.edit(stale.id, (current) => {
      current.media.push({ id: 'photo', name: 'card.png', mime: 'image/png' });
    }),
  ]);
  assert.equal(a.read().text, 'revised');
  assert.deepEqual(a.read().selected, ['x', 'linkedin']);
  assert.equal(a.read().media[0].id, 'photo');
  assert.equal(a.read().revision, 3);
  await assert.rejects(b.reserve(stale, payload(stale)), /请检查最新内容/);
});

test('a delayed completion keeps edits and cannot clear a later generation', async () => {
  const [a, b] = tabs({ text: 'original', selected: ['x'] });
  const draft = a.read();
  const first = await a.reserve(draft, payload(draft));
  const updated = await b.edit(draft.id, (current) => {
    current.text = 'work in progress';
  });
  await a.finish(draft, first.id, 'live');
  assert.equal(a.read().text, 'work in progress');
  const second = await b.reserve(updated, payload(updated));
  await b.finish(updated, second.id, 'live');
  const fresh = await b.edit(b.read().id, (current) => {
    current.text = 'next article';
  });
  await a.finish(draft, first.id, 'live');
  await assert.rejects(
    a.edit(draft.id, (current) => {
      current.text = 'stale input';
    }),
    /已在其他标签页更新/,
  );
  assert.equal(a.read().id, fresh.id);
  assert.equal(a.read().text, 'next article');
});

test('migrating a pre-upgrade draft preserves its saved content and pending delivery identity', async () => {
  const old = {
    text: '待确认',
    selected: ['x'],
    mode: 'auto',
    title: '旧草稿',
    overrides: { x: '平台文案' },
  };
  const original = { mode: 'live', targets: [{ platform: 'x', text: '平台文案' }], mediaIds: [] };
  old.pending = { key: JSON.stringify(original), id: 'previous-request' };
  const [a] = tabs(old);
  assert.equal(a.read().mode, 'auto');
  assert.deepEqual(a.read().overrides, { x: '平台文案' });
  assert.equal((await a.reserve(a.read(), original)).id, 'previous-request');
});
