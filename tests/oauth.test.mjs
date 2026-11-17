import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  disconnect,
  finishOAuth,
  getAccess,
  getOAuthStatus,
  markAccessRejected,
  startOAuth,
} from '../server/oauth.mjs';

const origin = 'http://127.0.0.1:4317';

async function environment(t, values, handle) {
  const dir = await mkdtemp(join(tmpdir(), 'open-social-oauth-'));
  const previous = {};
  const names = [
    'OPEN_SOCIAL_DATA_DIR',
    'X_CLIENT_ID',
    'X_CLIENT_SECRET',
    'X_REDIRECT_URI',
    'X_ACCESS_TOKEN',
    'LINKEDIN_CLIENT_ID',
    'LINKEDIN_CLIENT_SECRET',
    'LINKEDIN_REDIRECT_URI',
    'LINKEDIN_ACCESS_TOKEN',
    'LINKEDIN_AUTHOR_URN',
    'LINKEDIN_NATIVE_PKCE',
  ];
  for (const key of names) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, { OPEN_SOCIAL_DATA_DIR: dir, ...values });
  t.mock.method(globalThis, 'fetch', handle || (() => assert.fail('Unexpected network request')));
  t.after(async () => {
    for (const [key, val] of Object.entries(previous)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const callback = (state) => new URLSearchParams({ state, code: 'test-code' });

test('X verifies state and S256 before exchange, stores a private token, and rotates it once for concurrent requests', async (t) => {
  let challenge;
  let refreshes = 0;
  const dir = await environment(t, { X_CLIENT_ID: 'example-x' }, async (url, { body }) => {
    assert.equal(url, 'https://api.x.com/2/oauth2/token');
    assert.equal(body.get('client_id'), 'example-x');
    if (body.get('grant_type') === 'refresh_token') {
      refreshes++;
      assert.equal(body.get('refresh_token'), 'refresh-one');
      return Response.json({ access_token: 'access-two', refresh_token: 'refresh-two', expires_in: 7200 });
    }
    assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), challenge);
    return Response.json({ access_token: 'access-one', refresh_token: 'refresh-one', expires_in: 7200 });
  });
  const auth = new URL(await startOAuth('x', origin));
  challenge = auth.searchParams.get('code_challenge');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('redirect_uri'), origin + '/api/oauth/x/callback');
  assert.match(auth.searchParams.get('scope'), /media.write/);
  await assert.rejects(finishOAuth('x', callback('other-state'), origin), /授权会话/);
  const params = callback(auth.searchParams.get('state'));
  await finishOAuth('x', params, origin);
  await assert.rejects(finishOAuth('x', params, origin), /授权会话/);
  assert.equal((await getAccess('x')).accessToken, 'access-one');
  const file = join(dir, 'oauth/x.json');
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  const token = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...token, expiresAt: 0 }));
  const results = await Promise.all([getAccess('x'), getAccess('x')]);
  assert.equal(results[0].accessToken, 'access-two');
  assert.equal(results[1].accessToken, 'access-two');
  assert.equal(refreshes, 1);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).refreshToken, 'refresh-two');
  await disconnect('x');
  assert.equal((await getOAuthStatus('x')).connected, false);
});

test('LinkedIn uses its registered HTTPS callback and returns to the workspace that initiated authorization', async (t) => {
  const relay = 'https://callback.example.org';
  const registered = relay + '/api/oauth/linkedin/callback';
  const values = {
    LINKEDIN_CLIENT_ID: 'example-li',
    LINKEDIN_CLIENT_SECRET: 'example-secret',
    LINKEDIN_REDIRECT_URI: registered,
  };
  await environment(t, values, async (url, options) => {
    if (url === 'https://api.linkedin.com/v2/userinfo') {
      assert.equal(options.headers.authorization, 'Bearer example-access');
      return Response.json({ sub: 'member_123' });
    }
    assert.equal(options.body.get('client_secret'), 'example-secret');
    assert.equal(options.body.get('redirect_uri'), registered);
    assert.equal(options.body.has('code_verifier'), false);
    return Response.json({
      access_token: 'example-access',
      expires_in: 5184000,
      scope: 'openid,profile,w_member_social',
    });
  });
  const auth = new URL(await startOAuth('linkedin', origin));
  assert.equal(auth.origin + auth.pathname, 'https://www.linkedin.com/oauth/v2/authorization');
  assert.equal(auth.searchParams.has('client_secret'), false);
  assert.equal(auth.searchParams.get('scope'), 'openid profile w_member_social');
  assert.equal(auth.searchParams.get('redirect_uri'), registered);
  assert.equal((await getOAuthStatus('linkedin', origin)).redirectUri, registered);
  assert.equal(await finishOAuth('linkedin', callback(auth.searchParams.get('state')), relay), origin);
  assert.equal((await getAccess('linkedin')).author, 'urn:li:person:member_123');
  delete process.env.LINKEDIN_REDIRECT_URI;
  const authorized = await getOAuthStatus('linkedin', origin);
  assert.deepEqual(
    [authorized.connected, authorized.connectable, authorized.redirectUri],
    [true, false, null],
  );
});

test('LinkedIn web authorization rejects HTTP callbacks and never exposes credentials or query values in channel status', async (t) => {
  await environment(t, { LINKEDIN_CLIENT_ID: 'app', LINKEDIN_CLIENT_SECRET: 'sample' });
  for (const value of ['', origin + '/api/oauth/linkedin/callback', 'malformed']) {
    process.env.LINKEDIN_REDIRECT_URI = value;
    const status = await getOAuthStatus('linkedin', origin);
    assert.deepEqual([status.configured, status.connectable, status.redirectUri], [true, false, null]);
    assert.match(status.detail, /HTTPS.*LINKEDIN_REDIRECT_URI.*LINKEDIN_NATIVE_PKCE/);
    await assert.rejects(startOAuth('linkedin', origin), /LINKEDIN_REDIRECT_URI/);
  }
  process.env.LINKEDIN_REDIRECT_URI =
    'https://user:private-info@callback.example.org/api/oauth/linkedin/callback?private=value';
  const status = await getOAuthStatus('linkedin', origin);
  assert.equal(status.redirectUri, null);
  assert.doesNotMatch(JSON.stringify(status), /private-info|private=value/);
  await assert.rejects(startOAuth('linkedin', 'https://example.org'), /本机工作台/);
});

test('An invalid refresh grant requires reconnection. Status and errors omit upstream response details', async (t) => {
  const dir = await environment(t, { X_CLIENT_ID: 'example-x' }, async () =>
    Response.json(
      { error: 'invalid_grant', error_description: 'private upstream detail' },
      { status: 400 },
    ),
  );
  await mkdir(join(dir, 'oauth'));
  await writeFile(
    join(dir, 'oauth/x.json'),
    JSON.stringify({
      accessToken: 'expired',
      refreshToken: 'revoked',
      clientId: 'example-x',
      expiresAt: 0,
    }),
  );
  const status = await getOAuthStatus('x');
  assert.deepEqual([status.connected, status.connectable], [false, true]);
  assert.match(status.detail, /重新连接/);
  assert.doesNotMatch(status.detail, /private upstream detail/);
  await assert.rejects(getAccess('x'), /请先连接/);
});

test('A confirmed rejection disables only the fixed credential used by the request', async (t) => {
  await environment(t, { X_ACCESS_TOKEN: 'first-fixed-token' });
  await markAccessRejected('x', 'stale-token');
  assert.equal((await getOAuthStatus('x', origin)).connected, true);
  await markAccessRejected('x', 'first-fixed-token');
  assert.equal((await getOAuthStatus('x', origin)).connected, false);
  await assert.rejects(getAccess('x'), /更换令牌/);
  process.env.X_ACCESS_TOKEN = 'replacement-token';
  await markAccessRejected('x', 'first-fixed-token');
  assert.equal((await getAccess('x')).accessToken, 'replacement-token');
});

test('A 401 on an OAuth token triggers refresh when available and prompts reconnect otherwise', async (t) => {
  let refreshes = 0;
  const dir = await environment(t, { X_CLIENT_ID: 'test-app' }, () => {
    refreshes++;
    return Response.json({ access_token: 'replacement', expires_in: 7200 });
  });
  await mkdir(join(dir, 'oauth'));
  const file = join(dir, 'oauth/x.json');
  const token = { accessToken: 'rejected', clientId: 'test-app', expiresAt: Date.now() + 120000 };
  await writeFile(file, JSON.stringify(token));
  await markAccessRejected('x', 'rejected');
  await assert.rejects(getAccess('x'), /重新连接/);
  await writeFile(file, JSON.stringify({ ...token, refreshToken: 'refresh' }));
  await markAccessRejected('x', 'rejected');
  assert.equal((await getAccess('x')).accessToken, 'replacement');
  await markAccessRejected('x', 'rejected');
  assert.equal((await getAccess('x')).accessToken, 'replacement');
  assert.equal(refreshes, 1);
});

test('Fixed LinkedIn credentials require an author URN, and a canceled flow consumes its state', async (t) => {
  await environment(t, { LINKEDIN_ACCESS_TOKEN: 'sample-token', X_CLIENT_ID: 'example-x' });
  assert.equal((await getOAuthStatus('linkedin')).connected, false);
  process.env.LINKEDIN_AUTHOR_URN = 'urn:li:person:member';
  assert.deepEqual(await getAccess('linkedin'), {
    accessToken: 'sample-token',
    author: 'urn:li:person:member',
  });
  await assert.rejects(disconnect('linkedin'), /环境变量/);
  const auth = new URL(await startOAuth('x', origin));
  const params = callback(auth.searchParams.get('state'));
  await assert.rejects(finishOAuth('linkedin', params, origin), /授权会话/);
  await assert.rejects(finishOAuth('x', params, 'http://127.0.0.1:8000'), /授权会话/);
  params.set('error', 'access_denied');
  await assert.rejects(finishOAuth('x', params, origin), /已取消/);
  params.delete('error');
  await assert.rejects(finishOAuth('x', params, origin), /授权会话/);
});

test('LinkedIn native PKCE uses the native endpoint, and registered callback overrides cannot change the callback path', async (t) => {
  await environment(t, {
    LINKEDIN_CLIENT_ID: 'native',
    LINKEDIN_NATIVE_PKCE: '1',
    LINKEDIN_AUTHOR_URN: 'urn:li:person:sample',
  });
  const auth = new URL(await startOAuth('linkedin', origin));
  assert.equal(auth.pathname, '/oauth/native-pkce/authorization');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('scope'), 'w_member_social');
  assert.equal(auth.searchParams.get('redirect_uri'), origin + '/api/oauth/linkedin/callback');
  assert.equal(
    (await getOAuthStatus('linkedin', 'http://[::1]:4317')).redirectUri,
    'http://[::1]:4317/api/oauth/linkedin/callback',
  );
  assert.equal((await getOAuthStatus('linkedin', 'http://localhost:4317')).connectable, false);
  process.env.LINKEDIN_REDIRECT_URI = 'https://example.org/api/oauth/linkedin/callback';
  await assert.rejects(startOAuth('linkedin', origin), /原生 PKCE/);
  process.env.LINKEDIN_REDIRECT_URI = 'http://127.0.0.1:4317/wrong';
  await assert.rejects(startOAuth('linkedin', origin), /回调地址/);
});
