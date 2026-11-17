import assert from 'node:assert/strict';
import test from 'node:test';
import { detectLocalBridge, getBridgeQr } from '../server/setup-bridge.mjs';

const example =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9ZKPoAAAAASUVORK5CYII=';
const config = { XHS_BRIDGE_URL: 'http://127.0.0.1:18060/bridge/', XHS_BRIDGE_TOKEN: 'test-fixture-only' };
const result = (data) => Response.json({ success: true, data });

test('默认探测只向已知本机端口查询登录状态，无鉴权和跳转', async () => {
  const outcome = await detectLocalBridge(async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:18060/api/v1/login/status');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.signal.aborted, false);
    return result({ is_logged_in: false });
  });
  assert.equal(outcome.detected, true);
  assert.equal(outcome.login, false);
  assert.equal(outcome.url, 'http://127.0.0.1:18060');
  const locked = await detectLocalBridge(async () => new Response(null, { status: 401 }));
  assert.equal(locked.detected, false);
  assert.equal(locked.authRequired, true);
  const other = await detectLocalBridge(async () => result({ status: 'ok' }));
  assert.equal(other.detected, false);
});

test('授权桥接二维码固定端点，响应只传回验证后的图片和已登录状态', async () => {
  const outcome = await getBridgeQr(config, async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:18060/bridge/api/v1/login/qrcode');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer test-fixture-only');
    return result({ is_logged_in: false, img: example, private: 'upstream account information' });
  });
  assert.equal(outcome.image, example);
  assert.equal(outcome.connected, false);
  assert.deepEqual(Object.keys(outcome).sort(), ['connected', 'image', 'message']);
  const loggedIn = await getBridgeQr(config, async () => result({ is_logged_in: true, img: example }));
  assert.equal(loggedIn.connected, true);
  assert.equal(loggedIn.image, undefined);
});

test('错误或超限的二维码不会传至浏览器', async () => {
  for (const badImage of [
    example.replace('image/png', 'image/jpeg'),
    'https://example.org/qr',
    example + '!',
    'data:image/png;base64,' + 'A'.repeat(721000),
  ]) {
    const outcome = await getBridgeQr(config, async () => result({ is_logged_in: false, img: badImage }));
    assert.equal(outcome.image, undefined);
    assert.equal(outcome.connected, false);
  }
  const badConfigured = await getBridgeQr({ XHS_BRIDGE_URL: 'https://user:secret@example.org' }, () =>
    assert.fail('应在请求前拦下'),
  );
  assert.equal(badConfigured.image, undefined);
  const missingAccess = await getBridgeQr(config, async () =>
    Response.json({ private: 'sensitive response' }, { status: 403 }),
  );
  assert.match(missingAccess.message, /凭证/);
  assert.doesNotMatch(missingAccess.message, /sensitive/);
});
