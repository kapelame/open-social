import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getChannels, publishTarget } from '../server/providers.mjs';

const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
const json = (data) => Response.json(data);
const post = (platform, options = {}) =>
  publishTarget({ platform, text: 'Hello world', images: [], ...options });

async function fixture(t, transport) {
  const dir = await mkdtemp(join(tmpdir(), 'open-social-providers-'));
  const environment = {
    OPEN_SOCIAL_DATA_DIR: dir,
    X_ACCESS_TOKEN: 'test-x',
    LINKEDIN_ACCESS_TOKEN: 'test-linkedin',
    LINKEDIN_AUTHOR_URN: 'urn:li:person:member',
    LINKEDIN_API_VERSION: '202609',
    XHS_BRIDGE_URL: '',
  };
  const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.mock.method(globalThis, 'fetch', transport || (() => assert.fail('Unexpected HTTP request')));
  t.after(async () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { force: true, recursive: true });
  });
  const path = join(dir, 'sample.png');
  await writeFile(path, bytes);
  return { name: 'sample.png', mime: 'image/png', path };
}

test('Channel detection exposes only connection metadata', async (t) => {
  await fixture(t);
  const channels = await getChannels();
  assert.deepEqual(
    channels.map((c) => [c.id, c.connected]),
    [
      ['x', true],
      ['linkedin', true],
      ['xiaohongshu', false],
    ],
  );
  assert.doesNotMatch(JSON.stringify(channels), /test-linkedin|test-x/);
});

test('X uploads each photo, preserves order, and returns a post receipt', async (t) => {
  let uploads = 0;
  const image = await fixture(t, async (url, options) => {
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer test-x');
    const body = JSON.parse(options.body);
    if (url.endsWith('/2/media/upload')) {
      assert.equal(body.media_category, 'tweet_image');
      assert.equal(body.media, bytes.toString('base64'));
      return json({ data: { id: String(++uploads) } });
    }
    assert.equal(url, 'https://api.x.com/2/tweets');
    assert.deepEqual(body, { text: 'Hello world', media: { media_ids: ['1', '2'] } });
    return json({ data: { id: '98765' } });
  });
  const result = await post('x', { images: [image, image] });
  assert.deepEqual(result, { remoteId: '98765', url: 'https://x.com/i/web/status/98765' });
});

test('LinkedIn uploads bytes to the returned host and posts the correct single or multi-image shape', async (t) => {
  let uploads = 0;
  const requests = [];
  const image = await fixture(t, async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-linkedin');
    if (options.method === 'PUT') {
      assert.equal(new URL(url).hostname, 'www.linkedin.com');
      assert.equal(options.headers['Content-Type'], 'image/png');
      assert.deepEqual(options.body, bytes);
      return new Response(null, { status: 201 });
    }
    assert.equal(options.headers['Linkedin-Version'], '202609');
    const body = JSON.parse(options.body);
    if (String(url).includes('initializeUpload')) {
      assert.equal(body.initializeUploadRequest.owner, 'urn:li:person:member');
      return json({
        value: {
          image: 'urn:li:image:' + ++uploads,
          uploadUrl: 'https://www.linkedin.com/dms-uploads/blob',
        },
      });
    }
    requests.push(body);
    assert.equal(url, 'https://api.linkedin.com/rest/posts');
    return new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:321' } });
  });
  const result = await post('linkedin', { images: [image], text: 'Hello (#AI)' });
  assert.equal(result.remoteId, 'urn:li:share:321');
  assert.equal(requests[0].commentary, 'Hello \\(\\#AI\\)');
  assert.deepEqual(requests[0].content, { media: { id: 'urn:li:image:1' } });
  await post('linkedin', { images: [image, image] });
  assert.deepEqual(requests[1].content, {
    multiImage: { images: [{ id: 'urn:li:image:2' }, { id: 'urn:li:image:3' }] },
  });
});

test('Rejected, ambiguous, and rate-limited final post requests have distinct recovery semantics', async (t) => {
  let response;
  await fixture(t, async () => {
    if (!response) throw new TypeError('network error');
    return response;
  });
  const rejected = (uncertain, retryable) => (err) =>
    err.uncertain === uncertain && err.retryable === retryable;
  await assert.rejects(post('x'), rejected(true, false));
  response = new Response(null, { status: 503 });
  await assert.rejects(post('linkedin'), rejected(true, false));
  response = json({ data: {} });
  await assert.rejects(post('x'), rejected(true, false));
  response = new Response(null, { status: 201 });
  await assert.rejects(post('linkedin'), rejected(true, false));
  process.env.X_ACCESS_TOKEN = 'test-expired-user-token';
  response = new Response(null, { status: 401 });
  await assert.rejects(post('x'), rejected(false, false));
  assert.equal((await getChannels()).find((c) => c.id === 'x').connected, false);
  process.env.X_ACCESS_TOKEN = 'test-replacement-user-token';
  assert.equal((await getChannels()).find((c) => c.id === 'x').connected, true);
  response = new Response(null, { status: 429, headers: { 'retry-after': '60' } });
  await assert.rejects(post('linkedin'), (err) => err.retryAfterMs === 60000 && rejected(false, true)(err));
});

test('Failed image uploads never create posts, and LinkedIn cannot forward credential headers to an unknown host', async (t) => {
  const requests = [];
  const image = await fixture(t, async (url) => {
    requests.push(String(url));
    if (url.includes('api.x.com')) throw new Error('network unavailable');
    return json({ value: { image: 'urn:li:image:1', uploadUrl: 'https://unrelated.invalid/upload' } });
  });
  await assert.rejects(post('x', { images: [image] }), (err) => err.retryable && !err.uncertain);
  await assert.rejects(post('linkedin', { images: [image] }), /无法验证/);
  assert.deepEqual(requests, [
    'https://api.x.com/2/media/upload',
    'https://api.linkedin.com/rest/images?action=initializeUpload',
  ]);
});

test('Empty and oversized batches fail before network access', async (t) => {
  const image = await fixture(t);
  await assert.rejects(post('x', { images: Array(5).fill(image) }), /4 张/);
  await assert.rejects(post('linkedin', { images: Array(21).fill(image) }), /20 张/);
  await assert.rejects(post('linkedin', { text: ' ' }), /填写文案/);
});
