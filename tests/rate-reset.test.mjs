import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { publishTarget } from '../server/providers.mjs';
import { createQueue } from '../server/queue.mjs';

const start = Date.UTC(2026, 10, 1, 12);
const startSeconds = start / 1000;

function mockAccount(t, clock, fetcher) {
  const original = process.env.X_ACCESS_TOKEN;
  process.env.X_ACCESS_TOKEN = 'local-test-user';
  t.after(() => {
    if (original === undefined) delete process.env.X_ACCESS_TOKEN;
    else process.env.X_ACCESS_TOKEN = original;
  });
  t.mock.method(Date, 'now', clock);
  t.mock.method(globalThis, 'fetch', fetcher);
}

test('X 429 uses the later valid limit across Retry-After and x-rate-limit-reset', async (t) => {
  let headers;
  mockAccount(t, () => start, async () => new Response(null, { status: 429, headers }));
  const inTwoMinutes = new Date(start + 120_000).toUTCString();
  const cases = [
    [{ 'x-rate-limit-reset': String(startSeconds + 900) }, 900_000],
    [{ 'retry-after': inTwoMinutes }, 120_000],
    [{ 'retry-after': inTwoMinutes, 'x-rate-limit-reset': String(startSeconds + 900) }, 900_000],
    [{ 'retry-after': '901', 'x-rate-limit-reset': String(startSeconds + 900) }, 901_000],
    [{ 'retry-after': '15', 'x-rate-limit-reset': String(startSeconds - 1) }, 15_000],
    [{ 'retry-after': '15', 'x-rate-limit-reset': String(start) }, 15_000],
    [{ 'retry-after': '9999999999999999999999999', 'x-rate-limit-reset': String(startSeconds + 2) }, 2000],
    [{ 'retry-after': 'invalid', 'x-rate-limit-reset': String(startSeconds - 1) }, undefined],
  ];
  for (const [input, expected] of cases) {
    headers = input;
    await assert.rejects(publishTarget({ platform: 'x', text: 'Local mock' }), (error) => {
      assert.equal(error.retryable, true);
      assert.equal(error.uncertain, false);
      assert.equal(error.retryAfterMs, expected, JSON.stringify(input));
      return true;
    });
  }
});

test('a rate-limited X job stays queued until the real reset then publishes once', async (t) => {
  let now = start;
  let calls = 0;
  const reset = start + 900_000;
  mockAccount(t, () => now, async (url) => {
    assert.equal(url, 'https://api.x.com/2/tweets');
    if (++calls === 1) {
      return new Response(null, { status: 429, headers: { 'x-rate-limit-reset': String(reset / 1000) } });
    }
    return Response.json({ data: { id: '42' } });
  });
  const db = new DatabaseSync(':memory:');
  const queue = createQueue({
    db,
    getChannels: async () => [{ id: 'x', connected: true }],
    publishTarget,
    now: () => now,
  });
  t.after(async () => { await queue.stop(); db.close(); });
  const runWorker = async () => {
    queue.start();
    await nextTurn();
    await queue.stop();
  };
  queue.enqueue({ requestId: 'rate-limit-check', mode: 'live', targets: [{ platform: 'x', text: 'Local mock' }] });
  await runWorker();
  const target = queue.list()[0].targets[0];
  assert.equal(target.status, 'queued');
  assert.equal(target.nextAttemptAt, new Date(reset).toISOString());
  now = reset - 1;
  await runWorker();
  assert.equal(calls, 1);
  now = reset;
  await runWorker();
  assert.equal(calls, 2);
  assert.equal(queue.list()[0].targets[0].status, 'published');
});
