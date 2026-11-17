import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { countXText, createQueue } from '../server/queue.mjs';

const platforms = ['x', 'linkedin', 'xiaohongshu'];
const connected = () => platforms.map((id) => ({ id, connected: true }));
const image = { path: '/local/photo.png', mime: 'image/png', size: 1200, name: 'photo.png' };
const defaults = {
  getChannels: connected,
  publishTarget: async () => ({ remoteId: 'confirmed' }),
  loadMedia: (id) => (id === 'photo' ? image : undefined),
  pollMs: 5,
};

function setup(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  const queue = createQueue({ ...defaults, ...options, db });
  t.after(async () => {
    await queue.stop();
    db.close();
  });
  return queue;
}

function payload(overrides = {}) {
  return {
    requestId: 'draft-1',
    mode: 'live',
    targets: platforms.map((platform) => ({ platform, title: '一个话题', text: '共享的文案 👨‍👩‍👦' })),
    mediaIds: ['photo'],
    ...overrides,
  };
}

async function waitFor(jobQueue, expected) {
  for (let i = 0; i < 400; i++) {
    const states = jobQueue.list()[0].targets.map((item) => item.status);
    if (states.join() === expected.join()) return jobQueue.list()[0];
    await pause(5);
  }
  assert.deepEqual(
    jobQueue.list()[0].targets.map((item) => item.status),
    expected,
  );
}

test('one durable job per request, target-specific receipts and no duplicate retries', async (t) => {
  const calls = [];
  const queue = setup(t, {
    publishTarget: async (input) => {
      calls.push(input);
      return { remoteId: input.platform, url: 'https://example.com/post/1' };
    },
  });
  const first = queue.enqueue(payload());
  assert.equal(queue.enqueue(payload()).id, first.id);
  assert.throws(() => queue.enqueue(payload({ mode: 'demo' })), { statusCode: 409 });
  assert.equal(queue.list().length, 1);
  queue.start();
  const finished = await waitFor(queue, ['published', 'published', 'published']);
  assert.deepEqual(
    calls.map((call) => call.platform),
    platforms,
  );
  assert.ok(calls.every((call) => call.jobId === first.id && call.images[0].path === image.path));
  assert.equal(finished.targets[1].remoteId, 'linkedin');
  assert.ok(finished.targets.every((target) => target.canRetry === false));
  assert.throws(() => queue.retry(first.id, 'x'), { status: 409 });
  assert.equal(queue.enqueue(payload()).id, first.id);
  assert.equal(calls.length, 3);
});

test('invalid channel data rejects the entire batch, including demos', (t) => {
  const queue = setup(t);
  for (const data of [
    {
      targets: [
        { platform: 'x', text: 'valid' },
        { platform: 'linkedin', text: '字'.repeat(3001) },
      ],
    },
    { targets: [{ platform: 'x', text: '汉'.repeat(141) }] },
    {
      targets: [
        { platform: 'x', text: 'copy' },
        { platform: 'x', text: 'again' },
      ],
    },
    { mode: 'demo', mediaIds: [] },
    { targets: [{ platform: 'xiaohongshu', title: '汉'.repeat(21), text: '试' }] },
    { mediaIds: ['missing'] },
    { mode: 'unsupported' },
  ])
    assert.throws(() => queue.enqueue(payload(data)), { status: 400 });
  assert.deepEqual(queue.list(), []);
  assert.deepEqual(countXText('👨‍👩‍👦 汉 https://example.com/path?stuff=long'), {
    valid: true,
    weightedLength: 29,
  });
  assert.equal(
    queue.enqueue(
      payload({
        targets: [{ platform: 'xiaohongshu', title: 'a'.repeat(40), text: '♥' }],
      }),
    ).targets[0].title.length,
    40,
  );
});

test('demo processes every target without contacting any provider, even for connection checks', async (t) => {
  const queue = setup(t, { getChannels: assert.fail, publishTarget: assert.fail });
  queue.start();
  queue.enqueue(payload({ mode: 'demo' }));
  await waitFor(queue, ['demo', 'demo', 'demo']);
});

test('disconnected target can be resumed independently after authorization', async (t) => {
  let online = false;
  const calls = [];
  const queue = setup(t, {
    getChannels: () =>
      platforms.map((id) => ({ id, connected: id !== 'linkedin' || online, detail: '请先登录。' })),
    publishTarget: async ({ platform }) => {
      calls.push(platform);
      return { remoteId: platform };
    },
  });
  const { id } = queue.enqueue(payload());
  queue.start();
  const blocked = await waitFor(queue, ['published', 'blocked', 'published']);
  assert.equal(blocked.targets[1].canRetry, true);
  assert.equal(blocked.targets[1].message, '请先登录。');
  online = true;
  queue.retry(id, 'linkedin');
  assert.throws(() => queue.retry(id, 'linkedin'), { status: 409 });
  await waitFor(queue, ['published', 'published', 'published']);
  assert.deepEqual(calls, ['x', 'xiaohongshu', 'linkedin']);
});

test('ambiguous failures, unknown exceptions and empty receipts are never redelivered', async (t) => {
  const calls = [];
  const queue = setup(t, {
    publishTarget: async ({ platform }) => {
      calls.push(platform);
      if (platform === 'x') throw Object.assign(new Error('timeout'), { retryable: true, uncertain: true });
      if (platform === 'linkedin') throw new Error('connection closed');
      return {};
    },
  });
  const { id } = queue.enqueue(payload());
  queue.start();
  await waitFor(queue, ['uncertain', 'uncertain', 'uncertain']);
  for (const platform of platforms) assert.throws(() => queue.retry(id, platform), { status: 409 });
  assert.deepEqual(calls, platforms);
});

test('bounded retries only for definitive transient rejections and pre-publish errors', async (t) => {
  let count = 0;
  const queue = setup(t, {
    publishTarget: async () => {
      count++;
      throw Object.assign(new Error('rate limited'), { retryable: true, uncertain: false });
    },
    retryDelays: [10, 10],
  });
  queue.enqueue(payload({ targets: [{ platform: 'x', text: 'hello' }] }));
  queue.start();
  const job = await waitFor(queue, ['failed']);
  assert.equal(job.targets[0].attempts, 3);
  assert.equal(count, 3);
  assert.equal(job.targets[0].canRetry, true);
});

test('reopening disk storage preserves queued work and isolates an interrupted delivery', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'open-social-queue-'));
  const dbFile = join(dir, 'queue.sqlite');
  const initial = new DatabaseSync(dbFile);
  const first = createQueue({ ...defaults, db: initial });
  const { id } = first.enqueue(payload());
  initial.exec("UPDATE publish_targets SET status = 'running' WHERE platform = 'x'");
  initial.close();
  const reopened = new DatabaseSync(dbFile);
  const calls = [];
  const second = createQueue({
    ...defaults,
    db: reopened,
    publishTarget: async ({ platform }) => {
      calls.push(platform);
      return { remoteId: platform };
    },
  });
  t.after(async () => {
    await second.stop();
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });
  second.start();
  const job = await waitFor(second, ['uncertain', 'published', 'published']);
  assert.equal(job.id, id);
  assert.deepEqual(calls, ['linkedin', 'xiaohongshu']);
});

test('concurrent submissions and wakeups serialize calls while a provider is awaiting its receipt', async (t) => {
  const calls = [];
  let active = 0;
  let peak = 0;
  const queue = setup(t, {
    publishTarget: async ({ platform }) => {
      calls.push(platform);
      peak = Math.max(peak, ++active);
      await pause(10);
      active--;
      return { remoteId: platform };
    },
  });
  queue.start();
  const first = queue.enqueue(payload());
  await waitFor(queue, ['running', 'queued', 'queued']);
  assert.equal(queue.enqueue(payload()).id, first.id);
  queue.enqueue(payload({ requestId: 'another', targets: [{ platform: 'x', text: 'next' }] }));
  await waitFor(queue, ['published']);
  assert.equal(peak, 1);
  assert.deepEqual(calls, [...platforms, 'x']);
});

test('media compatibility is checked across all selected destinations before starting any', (t) => {
  const queue = setup(t, {
    loadMedia: (id) => ({
      ...image,
      mime: id === 'webp' ? 'image/webp' : image.mime,
      size: id === 'large' ? 5 * 1024 * 1024 + 1 : image.size,
    }),
  });
  const xOnly = [{ platform: 'x', text: 'hi' }];
  for (const part of [
    { mediaIds: ['webp'] },
    { mediaIds: ['large'] },
    { targets: xOnly, mediaIds: ['a', 'b', 'c', 'd', 'e'] },
  ])
    assert.throws(() => queue.enqueue(payload(part)), { status: 400 });
  assert.deepEqual(queue.list(), []);
  assert.equal(queue.enqueue(payload({ targets: xOnly, mediaIds: ['webp'] })).mediaIds[0], 'webp');
});

test('retry respects the upstream rate-limit time, even when local backoff is shorter', async (t) => {
  let current = Date.now();
  let calls = 0;
  const queue = setup(t, {
    now: () => current,
    retryDelays: [100],
    publishTarget: async () => {
      if (++calls === 1) throw Object.assign(new Error('限流'), { retryable: true, retryAfterMs: 60_000 });
      return { remoteId: 'published-after-429' };
    },
  });
  queue.enqueue(payload({ targets: [{ platform: 'x', text: 'test' }] }));
  queue.start();
  await pause(12);
  const delayed = queue.list()[0].targets[0];
  assert.equal(delayed.status, 'queued');
  assert.equal(Date.parse(delayed.nextAttemptAt), current + 60_000);
  current += 30_000;
  await pause(12);
  assert.equal(calls, 1);
  current += 30_000;
  await waitFor(queue, ['published']);
});
