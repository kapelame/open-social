import test from 'node:test';
import assert from 'node:assert/strict';
import { searchXhs } from '../server/xhs-search.mjs';

const period = {
  topic: '开源社区',
  start: new Date('2026-11-11T00:00:00Z'),
  end: new Date('2026-11-17T12:00:00Z'),
};
const feed = (id) => ({
  id,
  modelType: 'note',
  noteCard: { displayTitle: '笔记', user: { nickname: '作者' } },
  xsecToken: 'sample&+/=',
});
const reply = (data) => ({ response: { ok: true, status: 200 }, json: { success: true, data } });

test('Xiaohongshu search uses note detail timestamps and original-note links', async () => {
  const requests = [];
  async function bridgeRequest(path, options) {
    requests.push({ path, ...options });
    if (path.endsWith('/search'))
      return reply({ feeds: [feed('a'), feed('a'), feed('b'), { modelType: 'ad' }] });
    const id = options.body.feed_id;
    const time = Date.parse(id === 'a' ? '2026-11-15T09:08:07Z' : '2026-11-10T12:00:00Z');
    return reply({
      data: { note: { noteId: id, title: '开源社区活动', time, interactInfo: { likedCount: '1.7万+' } } },
    });
  }
  const results = await searchXhs({ ...period, bridgeRequest });
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0].body.filters, { sort_by: '最多点赞', publish_time: '一周内' });
  assert.equal(results.length, 1);
  assert.equal(results[0].score, 17000);
  assert.equal(results[0].title, '开源社区活动');
  assert.equal(results[0].publishedAt, '2026-11-15T09:08:07.000Z');
  assert.equal(new URL(results[0].url).searchParams.get('xsec_token'), 'sample&+/=');
});

test('monthly results rank by likes within six recent candidates and the requested dates', async () => {
  const start = new Date('2026-10-19T00:00:00Z');
  const end = period.end;
  const dates = [
    end,
    new Date('2026-11-15'),
    new Date('2026-11-14'),
    start,
    new Date(start.getTime() - 1),
    new Date('2026-09-01'),
    new Date('2026-08-01'),
  ];
  const likes = [15, 100, 25, 50, 1000, 2000, 3000];
  const details = [];
  async function bridgeRequest(path, { body }) {
    if (path.endsWith('/search')) {
      assert.deepEqual(body.filters, { sort_by: '最新', publish_time: '半年内' });
      return reply({ feeds: dates.map((_, i) => feed(String(i))) });
    }
    const id = body.feed_id;
    details.push(id);
    return reply({
      data: { note: { noteId: id, time: dates[id].getTime(), interactInfo: { likedCount: likes[id] } } },
    });
  }
  const posts = await searchXhs({ topic: period.topic, start, end, bridgeRequest });
  assert.deepEqual(details, ['0', '1', '2', '3', '4', '5']);
  assert.deepEqual(
    posts.map((post) => post.score),
    [100, 50, 25, 15],
  );
});

test('bridge and date errors are distinct from an empty search', async () => {
  assert.deepEqual(await searchXhs({ ...period, bridgeRequest: async () => reply({ feeds: [] }) }), []);
  await assert.rejects(
    searchXhs({ ...period, bridgeRequest: async () => ({ response: { ok: false, status: 401 } }) }),
    /401/,
  );
  await assert.rejects(
    searchXhs({
      ...period,
      bridgeRequest: async (path) =>
        path.endsWith('/search')
          ? reply({ feeds: [feed('a')] })
          : reply({ data: { note: { noteId: 'a' } } }),
    }),
    /发布时间/,
  );
});
