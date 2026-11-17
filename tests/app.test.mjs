import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { get } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createApp } from '../server/app.mjs';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl25CYAAAAASUVORK5CYII=',
  'base64',
);
const providerCalls = [];
const authWorkspaces = new Map();
const channels = [{ id: 'x', connected: true }];
const providers = {
  getChannels: async (origin) => {
    providerCalls.push(['channels', origin]);
    return channels;
  },
  startOAuth: async (id, origin) => {
    providerCalls.push(['start', id, origin]);
    authWorkspaces.set(id, origin);
    return 'https://example.com/auth';
  },
  finishOAuth: async (id, params, origin) => {
    if (params.get('state') !== 'ok') throw new Error('bad state');
    providerCalls.push(['finish', id, origin]);
    return authWorkspaces.get(id);
  },
  disconnect: async (id) => {
    providerCalls.push(['disconnect', id]);
  },
  publishTarget: async () => {
    throw new Error('Demo must never call a publisher');
  },
};
const discover = async (args) => args;
let dir, app, origin;
let directories;

async function listen() {
  app = await createApp({ ...directories, providers, discover });
  const { port } = await app.listen(0);
  origin = `http://127.0.0.1:${port}`;
}
const call = (path, opts) => fetch(origin + path, opts);
const post = (path, payload) =>
  call(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

test('a symlinked command starts the CLI from another working directory', async () => {
  const command = join(dir, 'launch.mjs');
  await symlink(new URL('../server/app.mjs', import.meta.url), command);
  const result = spawnSync(process.execPath, [command], {
    cwd: dir,
    env: { ...process.env, PORT: 'invalid' },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /有效的 TCP 端口/);
});

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'open-social-http-'));
  directories = {
    dataDir: join(dir, 'data'),
    publicDir: join(dir, 'public'),
    sourceDir: join(dir, 'src'),
    docsDir: join(dir, 'docs'),
  };
  for (const path of Object.values(directories)) await mkdir(path);
  await writeFile(join(directories.publicDir, 'index.html'), '<!doctype html>hello');
  await writeFile(join(directories.sourceDir, 'main.js'), 'export let ok = 1;');
  await writeFile(join(directories.docsDir, 'channels.md'), '# Channel settings');
  await writeFile(join(dir, 'private.js'), 'private');
  await symlink(join(dir, 'private.js'), join(directories.publicDir, 'outside.js'));
  await listen();
});

after(async () => {
  if (app) await app.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('serves the actual app, modules and selected guide, confines static paths', async () => {
  const page = await call('/');
  assert.equal(page.status, 200);
  assert.equal(await page.text(), '<!doctype html>hello');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const module = await call('/src/main.js');
  assert.match(module.headers.get('content-type'), /javascript/);
  const head = await call('/src/main.js', { method: 'HEAD' });
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('content-length'), module.headers.get('content-length'));
  assert.match(await (await call('/docs/channels.md')).text(), /Channel/);
  for (const file of [
    '/.env',
    '/private.js',
    '/outside.js',
    '/docs/unknown.md',
    '/src/.hidden.js',
    '/src/%2e%2e%2fprivate.js',
  ]) {
    assert.equal((await call(file)).status, 404, file);
  }
});

test('rejects untrusted Host, Origin and browser cross-site control requests', async () => {
  const status = await new Promise((resolve, reject) => {
    get(origin + '/api/channels', { headers: { host: 'other.invalid' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 403);
  for (const headers of [{ origin: 'https://other.invalid' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await call('/api/channels/x/disconnect', { method: 'POST', headers })).status, 403);
  }
  assert.deepEqual(providerCalls, []);
});

test('passes search, filters and refresh through, returns service-shaped JSON', async () => {
  const query = new URLSearchParams({ topic: ' 智能体 ', days: '30', platform: 'hn', refresh: '1' });
  assert.deepEqual(await (await call(`/api/discover?${query}`)).json(), {
    topic: '智能体',
    days: 30,
    platform: 'hn',
    refresh: true,
  });
  assert.equal((await call('/api/discover?days=-1')).status, 400);
  const counter = await post('/api/count-x', { text: '中文' });
  assert.deepEqual(await counter.json(), { weightedLength: 4, valid: true });
});

test('forwards OAuth callbacks from the external provider while checking state', async () => {
  const start = await call('/api/connect/x', { redirect: 'manual' });
  assert.equal(start.headers.get('location'), 'https://example.com/auth');
  const callback = await call('/api/oauth/x/callback?state=ok', {
    redirect: 'manual',
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('location'), origin + '/#channels');
  const failed = await call('/api/oauth/x/callback?state=no', { redirect: 'manual' });
  assert.equal(failed.status, 400);
  assert.match(await failed.text(), /回到渠道管理/);
  const result = await call('/api/channels/x/disconnect', { method: 'POST', headers: { origin } });
  assert.equal(result.status, 200);
  assert.deepEqual(await (await call('/api/channels')).json(), { channels });
  assert.deepEqual(providerCalls.at(-1), ['channels', origin]);
});

test('callback proxied from HTTPS returns to the hostname and port that initiated LinkedIn auth', async () => {
  const workspaceHost = 'localhost:' + new URL(origin).port;
  await new Promise((resolve, reject) => {
    get(origin + '/api/connect/linkedin', { headers: { host: workspaceHost } }, (res) => {
      res.resume();
      resolve();
    }).on('error', reject);
  });
  const callback = await call('/api/oauth/linkedin/callback?state=ok', {
    redirect: 'manual',
    headers: { 'x-forwarded-host': 'callback.example.org', 'x-forwarded-proto': 'https' },
  });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('location'), 'http://' + workspaceHost + '/#channels');
});

test('rejects fake/oversized media, stores real images, and completes an idempotent demo after closing the client', async () => {
  const upload = (bytes) =>
    call('/api/media', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'x-filename': encodeURIComponent('../话题.png') },
      body: bytes,
    });
  const wrong = await upload(Buffer.from('<svg onload=alert(1)>'));
  assert.equal(wrong.status, 415);
  const large = await upload(Buffer.alloc(5 * 1024 * 1024 + 1));
  assert.equal(large.status, 413);
  assert.deepEqual(await readdir(join(directories.dataDir, 'media')), []);
  const posted = await upload(png);
  assert.equal(posted.status, 201);
  const image = await posted.json();
  assert.equal(image.name, '话题.png');
  assert.equal(image.mime, 'image/png');
  assert.equal(image.size, png.length);
  assert.equal('path' in image, false);
  assert.deepEqual(Buffer.from(await (await call(image.url)).arrayBuffer()), png);
  const payload = {
    requestId: 'http-test',
    mode: 'demo',
    targets: [
      { platform: 'x', text: 'Hello' },
      { platform: 'xiaohongshu', title: '测试', text: '图文' },
    ],
    mediaIds: [image.id],
  };
  const jobs = await Promise.all([post('/api/jobs', payload), post('/api/jobs', payload)]);
  assert.ok(jobs.every((response) => response.status === 201));
  assert.equal((await jobs[0].json()).id, (await jobs[1].json()).id);
  const incompatible = await post('/api/jobs', { ...payload, mediaIds: [] });
  assert.equal(incompatible.status, 409);
  const list = await (await call('/api/jobs')).json();
  assert.equal(list.jobs.length, 1);
  assert.ok(list.jobs[0].targets.every((target) => target.status === 'demo'));
  assert.equal((await post('/api/jobs/' + list.jobs[0].id + '/retry', { platform: 'x' })).status, 409);
  await app.close();
  await listen();
  const persisted = await (await call('/api/jobs')).json();
  assert.deepEqual(list, persisted);
  assert.deepEqual(await readFile(join(directories.dataDir, 'media', image.id + '.png')), png);
});

test('a second server cannot run another worker over the same data store', async () => {
  await assert.rejects(createApp({ ...directories, providers, discover }), /locked/);
});

test('website handoff persists the media and independently confirms each platform by user action', async () => {
  const upload = await call('/api/media', {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'x-filename': 'photo.png' },
    body: png,
  });
  assert.equal(upload.status, 201);
  const image = await upload.json();
  const payload = {
    requestId: 'website-handoff',
    mode: 'browser',
    targets: [
      { platform: 'x', text: '短帖' },
      { platform: 'xiaohongshu', text: '小红书专属文案', title: '小红书专属标题' },
    ],
    mediaIds: [image.id],
  };
  const response = await post('/api/jobs', payload);
  assert.equal(response.status, 201);
  const job = await response.json();
  const confirm = (id, platform) => post(`/api/jobs/${id}/confirm`, { platform });
  const confirmations = await Promise.all([confirm(job.id, 'x'), confirm(job.id, 'x')]);
  assert.ok(confirmations.every(result => result.status === 200));
  const [one, two] = await Promise.all(confirmations.map(result => result.json()));
  assert.deepEqual(one, two);
  assert.deepEqual(one.targets.map(target => target.status), ['user_confirmed', 'awaiting_user']);
  assert.ok(one.targets.every(target => target.attempts === 0 && !target.canRetry && !target.remoteId));
  for (const mode of ['demo', 'live']) {
    const other = await (await post('/api/jobs', { ...payload, requestId: 'confirm-' + mode, mode })).json();
    assert.equal((await confirm(other.id, 'x')).status, 409);
  }
  await app.close();
  await listen();
  const persisted = (await (await call('/api/jobs')).json()).jobs.find(entry => entry.id === job.id);
  assert.deepEqual(persisted, one);
  assert.equal(persisted.targets[1].title, payload.targets[1].title);
  assert.equal(persisted.targets[1].text, payload.targets[1].text);
  assert.deepEqual(persisted.mediaIds, [image.id]);
  assert.deepEqual(persisted.media, [{ id: image.id, name: 'photo.png', mime: 'image/png' }]);
  assert.deepEqual(Buffer.from(await (await call('/media/' + image.id)).arrayBuffer()), png);
});
