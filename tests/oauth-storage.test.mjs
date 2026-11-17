import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.mjs';

const localFetch = globalThis.fetch;

async function workspaces(t) {
  const root = await mkdtemp(join(tmpdir(), 'open-social-workspaces-'));
  const active = new Set();
  const previousDir = process.env.OPEN_SOCIAL_DATA_DIR;
  process.env.OPEN_SOCIAL_DATA_DIR = join(root, 'fallback');
  t.after(async () => {
    try {
      await Promise.all([...active].map((app) => app.close()));
    } finally {
      if (previousDir === undefined) delete process.env.OPEN_SOCIAL_DATA_DIR;
      else process.env.OPEN_SOCIAL_DATA_DIR = previousDir;
      await rm(root, { recursive: true, force: true });
    }
  });
  return async (name, settingsEnv) => {
    const dataDir = join(root, name);
    const app = await createApp({ dataDir, settingsEnv });
    active.add(app);
    const { port } = await app.listen(0);
    const origin = 'http://127.0.0.1:' + port;
    const call = (path, options) => localFetch(origin + path, { redirect: 'manual', ...options });
    return {
      origin, call,
      tokenFile: join(dataDir, 'oauth', 'x.json'),
      async json(path) {
        const response = await call(path);
        assert.equal(response.status, 200);
        return response.json();
      },
      post(path, body) {
        return call(path, {
          method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
      },
      async close() {
        await app.close();
        active.delete(app);
      },
    };
  };
}

async function beginOAuth(space) {
  const response = await space.call('/api/connect/x');
  assert.equal(response.status, 303);
  const auth = new URL(response.headers.get('location'));
  assert.equal(auth.origin, 'https://x.com');
  assert.equal(auth.searchParams.get('redirect_uri'), space.origin + '/api/oauth/x/callback');
  const state = auth.searchParams.get('state');
  assert.ok(state);
  return state;
}

async function connected(space) {
  const { channels } = await space.json('/api/channels');
  return channels.find(({ id }) => id === 'x').connected;
}

async function submit(space, text) {
  const response = await space.post('/api/jobs', {
    requestId: 'shared-request-id', mode: 'live', targets: [{ platform: 'x', text }],
  });
  assert.equal(response.status, 201);
  for (let i = 0; i < 100; i++) {
    const { jobs } = await space.json('/api/jobs');
    assert.equal(jobs.length, 1);
    const target = jobs[0].targets[0];
    assert.equal(target.text, text);
    if (['queued', 'running'].includes(target.status)) {
      await delay(25);
      continue;
    }
    assert.equal(target.status, 'published', target.message);
    return jobs[0].id;
  }
  assert.fail('Timed out waiting for the local publish worker');
}

test('default providers isolate concurrent X authorization, saved accounts, queue credentials and disconnect', async (t) => {
  const open = await workspaces(t);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.method, 'POST');
    if (url === 'https://api.x.com/2/oauth2/token') {
      const code = init.body.get('code');
      calls.push('exchange ' + code);
      return Response.json({ access_token: 'token-' + code, expires_in: 3600 });
    }
    if (url === 'https://api.x.com/2/tweets') {
      const { text } = JSON.parse(init.body);
      calls.push(new Headers(init.headers).get('authorization') + ' ' + text);
      return Response.json({ data: { id: '42' } });
    }
    assert.fail('Unexpected outbound request');
  });
  const openAccount = (name) => open(name, { X_CLIENT_ID: 'same-fixture-client' });
  let a = await openAccount('a');
  const b = await openAccount('b');
  const [stateA, stateB] = await Promise.all([beginOAuth(a), beginOAuth(b)]);
  assert.notEqual(stateA, stateB);
  const callback = (space, state, code) => space.call('/api/oauth/x/callback?' + new URLSearchParams({ state, code }));
  assert.equal((await callback(b, stateA, 'wrong')).status, 400);
  assert.deepEqual(calls, []);
  assert.equal((await callback(a, stateA, 'a')).status, 303);
  assert.equal(await connected(a), true);
  assert.equal(await connected(b), false);
  assert.equal(JSON.parse(await readFile(a.tokenFile, 'utf8')).accessToken, 'token-a');
  await assert.rejects(readFile(b.tokenFile), { code: 'ENOENT' });
  assert.equal((await callback(b, stateB, 'b')).status, 303);
  assert.equal(JSON.parse(await readFile(b.tokenFile, 'utf8')).accessToken, 'token-b');

  await a.close();
  a = await openAccount('a');
  assert.equal(await connected(a), true);
  const ids = await Promise.all([submit(a, 'post-a'), submit(b, 'post-b')]);
  assert.notEqual(ids[0], ids[1]);
  assert.deepEqual(calls.sort(), ['Bearer token-a post-a', 'Bearer token-b post-b', 'exchange a', 'exchange b']);
  assert.equal((await a.post('/api/channels/x/disconnect', {})).status, 200);
  await assert.rejects(readFile(a.tokenFile), { code: 'ENOENT' });
  assert.equal(await connected(a), false);
  assert.equal(await connected(b), true);
  assert.equal(JSON.parse(await readFile(b.tokenFile, 'utf8')).accessToken, 'token-b');
});

test('X native search advertises paid search only for the workspace that configured it', async (t) => {
  const open = await workspaces(t);
  const outbound = t.mock.method(globalThis, 'fetch', () => assert.fail('Unexpected outbound request'));
  const ordinary = await open('ordinary', {});
  const paid = await open('paid', { X_BEARER_TOKEN: 'mock-bearer' });
  const path = '/api/discover?platform=x&topic=opensocial';
  const [a, b] = await Promise.all([ordinary.json(path), paid.json(path)]);
  assert.equal(a.mode, 'web');
  assert.equal(b.mode, 'web');
  assert.equal(Boolean(a.paidSearchAvailable), false);
  assert.equal(b.paidSearchAvailable, true);
  assert.equal(outbound.mock.callCount(), 0);
});
