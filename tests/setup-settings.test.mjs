import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalSettings } from '../server/setup-settings.mjs';
import { createApp } from '../server/app.mjs';

async function isolated(t) {
  const dir = await mkdtemp(join(tmpdir(), 'open-social-options-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('local forms apply immediately, keep empty inputs, store privately, and survive restart', async (t) => {
  const dir = await isolated(t);
  const env = { X_CLIENT_ID: 'explicit-client' };
  const store = createLocalSettings(dir, env);
  assert.deepEqual(store.save('x', { values: { X_ACCESS_TOKEN: 'form-test-value', X_CLIENT_ID: '' } }), {
    saved: true,
  });
  assert.equal(env.X_ACCESS_TOKEN, 'form-test-value');
  assert.deepEqual(store.describe('x'), {
    configured: ['X_CLIENT_ID', 'X_ACCESS_TOKEN'],
    locked: ['X_CLIENT_ID'],
  });
  const file = join(dir, 'local-settings.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(file, 'utf8'), /explicit-client/);
  assert.throws(
    () => store.save('x', { values: { X_ACCESS_TOKEN: 'changed', X_CLIENT_ID: 'new' } }),
    /启动环境/,
  );
  assert.throws(() => store.save('linkedin', { values: { X_ACCESS_TOKEN: 'new' } }), /不支持/);
  assert.equal(env.X_ACCESS_TOKEN, 'form-test-value');
  store.close();
  assert.equal(env.X_ACCESS_TOKEN, undefined);
  const reopened = createLocalSettings(dir, env);
  assert.equal(env.X_ACCESS_TOKEN, 'form-test-value');
  reopened.save('x', { values: {}, clear: ['X_ACCESS_TOKEN'] });
  assert.equal(env.X_ACCESS_TOKEN, undefined);
  assert.equal(env.X_CLIENT_ID, 'explicit-client');
  reopened.close();
});

test('bridge form tokens stay attached to their endpoint across edits and startup environment overrides', async (t) => {
  const dir = await isolated(t);
  const env = {};
  let store = createLocalSettings(dir, env);
  store.save('xiaohongshu', {
    values: { XHS_BRIDGE_URL: 'http://127.0.0.1:18060', XHS_BRIDGE_TOKEN: 'local-test-value' },
  });
  store.close();
  const overridden = { XHS_BRIDGE_URL: 'https://example.invalid/other' };
  const shadow = createLocalSettings(dir, overridden);
  assert.equal(overridden.XHS_BRIDGE_TOKEN, undefined);
  shadow.close();
  store = createLocalSettings(dir, env);
  assert.equal(env.XHS_BRIDGE_TOKEN, 'local-test-value');
  store.save('xiaohongshu', { values: { XHS_BRIDGE_URL: 'https://example.invalid/mcp' } });
  assert.equal(env.XHS_BRIDGE_TOKEN, undefined);
  assert.doesNotMatch(await readFile(join(dir, 'local-settings.json'), 'utf8'), /local-test-value/);
  assert.throws(
    () => store.save('xiaohongshu', { values: { XHS_BRIDGE_URL: 'https://user:secret@example.invalid/' } }),
    /令牌请填入/,
  );
  store.close();
  const lockedToken = { XHS_BRIDGE_TOKEN: 'environment-test-value' };
  const locked = createLocalSettings(dir, lockedToken);
  assert.equal(lockedToken.XHS_BRIDGE_URL, undefined);
  assert.throws(
    () => locked.save('xiaohongshu', { values: { XHS_BRIDGE_URL: 'http://127.0.0.1:18060' } }),
    /同一环境/,
  );
  locked.close();
});

test('LinkedIn callback and folder validation leave the previous settings intact', async (t) => {
  const env = {},
    store = createLocalSettings(await isolated(t), env);
  const callback = 'http://127.0.0.1:4317/api/oauth/linkedin/callback';
  assert.throws(
    () =>
      store.save('linkedin', { values: { LINKEDIN_REDIRECT_URI: callback, LINKEDIN_CLIENT_ID: 'sample' } }),
    /HTTPS/,
  );
  assert.equal(env.LINKEDIN_CLIENT_ID, undefined);
  store.save('linkedin', { values: { LINKEDIN_REDIRECT_URI: callback, LINKEDIN_NATIVE_PKCE: '1' } });
  assert.equal(env.LINKEDIN_REDIRECT_URI, callback);
  assert.throws(
    () => store.save('xiaohongshu', { values: { XHS_LOCAL_MEDIA_DIR: '.data/media' } }),
    /同时填写/,
  );
  store.close();
});

test('HTTP settings responses contain field names only, persist, and obey same-origin controls', async (t) => {
  const dataDir = await isolated(t),
    env = {};
  const app = await createApp({ dataDir, settingsEnv: env });
  try {
    const { port } = await app.listen(0);
    const base = 'http://127.0.0.1:' + port;
    const post = (payload, origin = base) =>
      fetch(base + '/api/settings/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', origin },
        body: JSON.stringify(payload),
      });
    const sample = { values: { X_BEARER_TOKEN: 'local-http-test-value' } };
    assert.equal((await post(sample, 'https://other.invalid')).status, 403);
    assert.equal(env.X_BEARER_TOKEN, undefined);
    const save = await post(sample);
    assert.equal(save.status, 200);
    assert.deepEqual(await save.json(), { saved: true });
    assert.deepEqual(await (await fetch(base + '/api/settings/x')).json(), {
      configured: ['X_BEARER_TOKEN'],
      locked: [],
    });
    assert.equal((await fetch(base + '/.data/local-settings.json')).status, 404);
  } finally {
    await app.close();
  }
});
