import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publishXhs, xhsStatus } from '../server/xiaohongshu.mjs';
import { createDiscoveryService } from '../server/discovery.mjs';

const configKeys = ['XHS_BRIDGE_URL', 'XHS_BRIDGE_TOKEN', 'XHS_LOCAL_MEDIA_DIR', 'XHS_BRIDGE_MEDIA_DIR'];

test('工作区使用各自的桥接账号、搜索凭据和图片挂载', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'opensocial-bridge-scopes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const image = path.join(dir, 'cover.png');
  await writeFile(image, 'fixture');
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const { hostname, pathname } = new URL(input);
    const name = hostname.split('.')[0];
    const body = init.body && JSON.parse(init.body);
    requests.push({ name, pathname, auth: init.headers.Authorization, body });
    let data;
    if (pathname === '/api/v1/login/status') data = { is_logged_in: true, username: name };
    if (pathname === '/api/v1/feeds/search') data = { feeds: [] };
    if (pathname === '/api/v1/publish') data = { ...body, status: '发布完成', images: body.images.length };
    return Response.json({ success: Boolean(data), data });
  });

  await Promise.all(['first', 'second'].map(async (name) => {
    const env = {
      XHS_BRIDGE_URL: 'https://' + name + '.example',
      XHS_BRIDGE_TOKEN: name + '-fixture',
      XHS_LOCAL_MEDIA_DIR: dir,
      XHS_BRIDGE_MEDIA_DIR: '/' + name,
    };
    const discover = createDiscoveryService({ env });
    const [channel, results] = await Promise.all([
      xhsStatus(env),
      discover({ topic: '同一主题', platform: 'xiaohongshu' }),
      publishXhs({ title: name, text: name, images: [{ path: image }] }, env),
    ]);
    assert.equal(channel.detail, '已连接 · ' + name);
    assert.equal(results.sources[0].status, 'ok');
    const own = requests.filter((req) => req.name === name);
    assert.ok(own.every((req) => req.auth === 'Bearer ' + name + '-fixture'));
    assert.equal(own.filter((req) => req.pathname === '/api/v1/feeds/search').length, 1);
    assert.deepEqual(own.find((req) => req.pathname === '/api/v1/publish')?.body, {
      title: name, content: name, images: ['/' + name + '/cover.png'],
    });
  }));
});

test('小红书桥接图文发布', async (t) => {
  const original = Object.fromEntries(configKeys.map((key) => [key, process.env[key]]));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'opensocial-xhs-'));
  const local = path.join(dir, 'images');
  await mkdir(local);
  const image = path.join(local, 'cover.png');
  await writeFile(image, 'test');
  const input = { title: '测试标题', text: '测试正文', images: [{ path: image }] };
  let loggedIn = true;
  let publishStatus = 200;
  let mode = 'ok';
  let publishedCount = 0;
  let lastRequest;
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer local-fixture') {
      res.writeHead(401).end('{}');
      return;
    }
    if (req.url === '/api/v1/login/status' && req.method === 'GET') {
      res.end(JSON.stringify({ success: true, data: { is_logged_in: loggedIn, username: '测试账号' } }));
      return;
    }
    if (req.url !== '/api/v1/publish' || req.method !== 'POST') {
      res.writeHead(404).end('{}');
      return;
    }
    publishedCount++;
    let data = '';
    for await (const chunk of req) data += chunk.toString();
    lastRequest = JSON.parse(data);
    if (mode === 'disconnect') {
      res.destroy();
      return;
    }
    res.writeHead(publishStatus).end(
      JSON.stringify({
        success: mode !== 'failure',
        data: {
          ...lastRequest,
          status: '发布完成',
          images: mode === 'wrong-receipt' ? 0 : lastRequest.images.length,
        },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  configKeys.forEach((key) => delete process.env[key]);

  await t.test('未配置、凭证错误及扫码登录状态', async () => {
    assert.equal((await xhsStatus()).configured, false);
    process.env.XHS_BRIDGE_URL = 'http://127.0.0.1:' + server.address().port;
    assert.match((await xhsStatus()).detail, /凭证/);
    process.env.XHS_BRIDGE_TOKEN = 'local-fixture';
    loggedIn = false;
    assert.equal((await xhsStatus()).connected, false);
    await assert.rejects(publishXhs(input), { uncertain: false, retryable: false });
    assert.equal(publishedCount, 0);
    loggedIn = true;
    assert.match((await xhsStatus()).detail, /测试账号/);
  });
  await t.test('同机路径、容器挂载和可验证的发布回执', async () => {
    assert.match((await publishXhs(input)).message, /确认提交/);
    assert.equal(path.basename(lastRequest.images[0]), 'cover.png');
    process.env.XHS_LOCAL_MEDIA_DIR = local;
    process.env.XHS_BRIDGE_MEDIA_DIR = '/app/images';
    const result = await publishXhs(input);
    assert.deepEqual(lastRequest, {
      title: input.title,
      content: input.text,
      images: ['/app/images/cover.png'],
    });
    assert.equal(result.url, undefined);
  });
  await t.test('图片缺失、跨挂载符号链接和超长标题均在发出请求前拒绝', async () => {
    const before = publishedCount;
    const outside = path.join(dir, 'other.png');
    const link = path.join(local, 'linked.png');
    await writeFile(outside, 'test');
    await symlink(outside, link);
    await assert.rejects(publishXhs({ ...input, images: [] }), /至少需要/);
    await assert.rejects(publishXhs({ ...input, images: [{ path: link }] }), /共享目录之外/);
    await assert.rejects(publishXhs({ ...input, title: '😀'.repeat(11) }), /最多 20/);
    assert.equal(publishedCount, before);
  });
  await t.test('损坏回执、桥接错误及提交后掉线禁止自动重试', async () => {
    for (const scenario of ['wrong-receipt', 'failure', 'disconnect']) {
      mode = scenario;
      await assert.rejects(publishXhs(input), { uncertain: true, retryable: false });
    }
    mode = 'ok';
    publishStatus = 500;
    await assert.rejects(publishXhs(input), { uncertain: true, retryable: false });
    publishStatus = 429;
    await assert.rejects(publishXhs(input), { uncertain: false, retryable: true });
  });
});
