import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDiscoveryService } from '../server/discovery.mjs';

const now = () => new Date('2026-11-17T12:34:56Z');
const make = (request, env = {}) => createDiscoveryService({ request, env, now });
const fail = async () => {
  throw new Error('offline');
};

test('the built-in snapshot can be filtered offline and its chart reconciles with the sample', async () => {
  let requests = 0;
  const discover = make(async () => {
    requests++;
    throw new Error('offline');
  });
  for (const days of [7, 30]) {
    const all = await discover({ days });
    const hn = await discover({ days, platform: 'hn' });
    const gh = await discover({ days, platform: 'github' });
    assert.equal(all.mode, 'snapshot');
    assert.ok(all.sources.every((source) => !source.refreshStatus));
    assert.equal(all.total, hn.total + gh.total);
    assert.ok(hn.total > 0 && gh.total > 0);
    assert.equal(all.series.length, days);
    assert.equal(
      all.total,
      all.series.reduce((n, d) => n + d.count, 0),
    );
    assert.ok(
      hn.posts.every(
        (p) => p.platform === 'hn' && p.url.startsWith('https://news.ycombinator.com/item?id='),
      ),
    );
  }
  assert.equal(requests, 0);
});

test('after UTC midnight the default topic prefers a live result, including a healthy empty result', async () => {
  let requests = 0;
  const discover = createDiscoveryService({
    env: {},
    now: () => new Date('2026-11-18T00:00:01Z'),
    request: async (url) => {
      requests++;
      if (url.hostname === 'api.github.com') throw new Error('offline');
      return { hits: [] };
    },
  });
  const first = await discover();
  assert.equal(first.mode, 'partial');
  assert.equal(first.total, 0);
  assert.equal(first.asOf, '2026-11-18T00:00:01.000Z');
  assert.equal(requests, 2);
  assert.deepEqual(await discover(), first);
  assert.equal(requests, 2);
});

test('after an outage an old archive keeps its date, caches the failure and retries', async () => {
  let clock = new Date('2026-11-20T12:00:00Z');
  let online = false;
  let requests = 0;
  const discover = createDiscoveryService({
    env: { ENABLE_BLUESKY_SEARCH: 'true' },
    now: () => clock,
    request: async (url) => {
      requests++;
      if (!online) throw new Error('offline');
      if (url.hostname === 'api.github.com') return { items: [] };
      if (url.hostname === 'hn.algolia.com') return { hits: [] };
      return { posts: [] };
    },
  });
  const report = await discover();
  assert.equal(requests, 3);
  assert.equal(report.mode, 'snapshot');
  assert.match(report.asOf, /^2026-11-17/);
  for (const id of ['hn', 'github']) {
    const source = report.sources.find((item) => item.id === id);
    assert.equal(source.status, 'snapshot');
    assert.equal(source.refreshStatus, 'unavailable');
    assert.ok(source.message);
  }
  assert.equal(report.sources.find((s) => s.id === 'bluesky').status, 'unavailable');
  assert.ok(report.total > 0);
  assert.deepEqual(report, await discover());
  assert.equal(requests, 3);
  clock = new Date(clock.getTime() + 31_000);
  online = true;
  const refreshed = await discover();
  assert.equal(refreshed.mode, 'live');
  assert.equal(refreshed.total, 0);
  assert.equal(refreshed.asOf, clock.toISOString());
  assert.equal(requests, 6);
});

test('multilingual queries are encoded, ranks interleave, out-of-window and duplicate posts are excluded', async () => {
  const urls = [];
  const story = {
    objectID: '1',
    title: '中文话题',
    author: 'sam',
    points: 4,
    created_at: '2026-11-17T01:00:00Z',
    url: 'javascript:alert(0)',
  };
  const repo = {
    id: 7,
    full_name: 'org/代码',
    owner: { login: 'org' },
    created_at: '2026-11-16T21:22:49Z',
    html_url: 'https://github.com/org/example',
    stargazers_count: 70,
  };
  const discover = make(async (url) => {
    urls.push(url);
    if (url.hostname === 'hn.algolia.com')
      return {
        hits: [
          story,
          story,
          { ...story, objectID: '2', points: 8, url: 'https://example.com/story' },
          { ...story, objectID: '3', created_at: '2026-11-10T23:59:59Z' },
        ],
      };
    return { items: [repo] };
  });
  const [a, b] = await Promise.all([discover({ topic: '机器人' }), discover({ topic: '机器人' })]);
  assert.equal(a.mode, 'live');
  assert.deepEqual(a, b);
  assert.deepEqual(
    a.posts.map((p) => p.id),
    ['hn-2', 'github-7', 'hn-1'],
  );
  assert.deepEqual(
    a.links.map((l) => l.domain),
    ['example.com', 'github.com'],
  );
  assert.equal(a.series.at(-1).byPlatform.hn, 2);
  assert.ok(urls.some((url) => url.searchParams.get('query') === '机器人'));
  const single = await discover({ topic: '机器人', platform: 'hn' });
  assert.equal(single.total, 2);
  assert.equal(urls.length, 2);
});

test('one unavailable source retains the other, and upstream failure is distinct from zero matches', async () => {
  const discover = make(async (url) => {
    if (url.hostname === 'hn.algolia.com') return { hits: [] };
    throw Object.assign(new Error('limit'), { httpStatus: 429 });
  });
  const data = await discover({ topic: 'xylophone' });
  assert.equal(data.mode, 'partial');
  assert.equal(data.total, 0);
  assert.equal(data.sources[0].status, 'ok');
  assert.equal(data.sources[1].status, 'unavailable');
  assert.match(data.sources[1].message, /上限/);
  const archived = await make(fail)({ topic: 'AI Agents', refresh: true });
  assert.equal(archived.mode, 'snapshot');
  assert.ok(archived.total > 0);
  assert.equal((await make(fail)({ topic: 'other' })).mode, 'unavailable');
});

test('provider prerequisites and parameter errors have actionable statuses', async () => {
  const discover = make(fail);
  const noCredentials = await discover({ topic: 'test', platform: 'x-api' });
  assert.equal(noCredentials.mode, 'unavailable');
  assert.equal(noCredentials.sources[0].status, 'unconfigured');
  const outOfRange = await make(fail, { X_BEARER_TOKEN: 'test' })({ platform: 'x-api', days: 30 });
  assert.equal(outOfRange.sources[0].status, 'unsupported');
  for (const params of [
    { topic: ' ' },
    { topic: 'a'.repeat(121) },
    { days: 14 },
    { platform: '__proto__' },
  ]) {
    await assert.rejects(discover(params), { statusCode: 400 });
  }
});

test('ordinary search and refresh never contact the metered X endpoint, even with credentials', async () => {
  const requests = [];
  const discover = make(
    async (url) => {
      requests.push(url);
      if (url.hostname === 'hn.algolia.com') return { hits: [] };
      if (url.hostname === 'api.github.com') return { items: [] };
      if (url.hostname === 'api.x.com')
        return { data: [{ id: '5', text: 'testing', created_at: now().toISOString(), author_id: '4' }] };
      throw new Error('unexpected host');
    },
    { X_BEARER_TOKEN: 'fixture' },
  );
  assert.equal((await discover({ topic: '机器人' })).mode, 'live');
  await discover({ topic: '机器人', refresh: true });
  const x = await discover({ topic: '机器人', platform: 'x' });
  await discover({ topic: '机器人', platform: 'x', refresh: true });
  assert.ok(x.paidSearchAvailable);
  assert.equal(x.mode, 'web');
  assert.equal(requests.filter((url) => url.hostname === 'api.x.com').length, 0);
  const paid = await discover({ topic: '机器人', platform: 'x-api' });
  assert.equal(paid.total, 1);
  assert.equal(paid.posts[0].platform, 'x');
  assert.equal(requests.filter((url) => url.hostname === 'api.x.com').length, 1);
  assert.equal((await discover({ topic: '机器人', platform: 'x' })).mode, 'web');
});

test('native X, LinkedIn and Xiaohongshu search preserves the topic and produces no activity sample', async () => {
  const urls = [];
  const discover = make((url) => {
    urls.push(url);
  });
  const topic = '机器人 & C++ #1';
  for (const [platform, key, hostname] of [
    ['x', 'q', 'x.com'],
    ['linkedin', 'keywords', 'www.linkedin.com'],
    ['xiaohongshu', 'keyword', 'www.xiaohongshu.com'],
  ]) {
    const result = await discover({ topic, platform, refresh: true });
    assert.equal(result.mode, 'web');
    assert.equal(result.asOf, null);
    assert.equal(result.sources[0].status, 'web');
    const url = new URL(result.nativeSearchUrl);
    assert.equal(url.hostname, hostname);
    assert.equal(url.searchParams.get(key), topic);
    assert.deepEqual(result.posts, []);
    assert.deepEqual(result.series, []);
    assert.equal(result.paidSearchAvailable, undefined);
  }
  assert.equal(urls.length, 0);
});

test('30-day all stays live for the full healthy cache when X credentials are configured', async () => {
  let clock = now().getTime();
  const hosts = [];
  const discover = createDiscoveryService({
    env: { X_BEARER_TOKEN: 'fixture' },
    now: () => new Date(clock),
    request: async (url) => {
      hosts.push(url.hostname);
      if (url.hostname === 'hn.algolia.com') return { hits: [] };
      if (url.hostname === 'api.github.com') return { items: [] };
      throw new Error('unexpected upstream');
    },
  });
  const query = { topic: '咖啡豆', days: 30 };
  const result = await discover(query);
  assert.equal(result.mode, 'live');
  assert.deepEqual(
    result.sources.map((source) => source.id),
    ['hn', 'github'],
  );
  clock += 31_000; // A partial response would have expired here.
  assert.deepEqual(await discover(query), result);
  clock += 268_000;
  assert.deepEqual(await discover(query), result);
  assert.equal(hosts.length, 2);
  clock += 1_001;
  assert.notEqual((await discover(query)).asOf, result.asOf);
  const unsupported = await discover({ ...query, platform: 'x-api', refresh: true });
  assert.equal(unsupported.sources[0].status, 'unsupported');
  assert.equal(unsupported.mode, 'unavailable');
  const manual = await discover({ ...query, refresh: true });
  assert.equal(manual.mode, 'live');
  assert.deepEqual(hosts, [
    'hn.algolia.com',
    'api.github.com',
    'hn.algolia.com',
    'api.github.com',
    'hn.algolia.com',
    'api.github.com',
  ]);
});
