const localUrl = 'http://127.0.0.1:18060';
const maxQrBytes = 512 * 1024;
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpegSignature = Buffer.from([0xff, 0xd8, 0xff]);

async function readJson(response, limit) {
  if (!response.body || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('Response exceeds limit');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('Response exceeds limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function detectLocalBridge(fetcher = fetch) {
  const missing = { detected: false, message: '未在本机默认端口检测到桥接。请先启动服务或填写实际地址。' };
  try {
    const response = await fetcher(localUrl + '/api/v1/login/status', {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    });
    if (response.status === 401) {
      await response.body?.cancel();
      return {
        detected: false,
        authRequired: true,
        message: '本机 18060 端口要求鉴权。请确认桥接地址并填写访问凭证。',
      };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return missing;
    }
    const json = await readJson(response, 16 * 1024);
    if (json?.success !== true || typeof json.data?.is_logged_in !== 'boolean') return missing;
    const login = json.data.is_logged_in;
    return {
      detected: true,
      url: localUrl,
      login,
      message: login ? '已找到本机桥接，账号已登录。' : '已找到本机桥接，保存配置后可扫码登录。',
    };
  } catch {
    return missing;
  }
}

function qrImage(value) {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(maxQrBytes / 3) + 32) return null;
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return null;
  const [, format, encoded] = match;
  const buffer = Buffer.from(encoded, 'base64');
  const signature = format === 'png' ? pngSignature : jpegSignature;
  if (
    buffer.length > maxQrBytes ||
    buffer.length <= signature.length ||
    !buffer.subarray(0, signature.length).equals(signature) ||
    buffer.toString('base64') !== encoded
  ) {
    return null;
  }
  return value;
}

export async function getBridgeQr(env = process.env, fetcher = fetch) {
  if (!env.XHS_BRIDGE_URL?.trim()) return { connected: false, message: '请先保存小红书桥接地址。' };
  const unavailable = { connected: false, message: '未能获取有效的登录二维码，请检查桥接是否在线后重试。' };
  try {
    const base = new URL(env.XHS_BRIDGE_URL);
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      base.search ||
      base.hash ||
      base.username ||
      base.password
    ) {
      return { connected: false, message: '请填写有效的桥接 HTTP 或 HTTPS 根地址。' };
    }
    const headers = { Accept: 'application/json' };
    if (env.XHS_BRIDGE_TOKEN?.trim()) headers.Authorization = 'Bearer ' + env.XHS_BRIDGE_TOKEN.trim();
    const url = base.href.replace(/\/+$/, '') + '/api/v1/login/qrcode';
    const response = await fetcher(url, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      return { connected: false, message: '桥接拒绝了访问凭证，请检查渠道配置。' };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return unavailable;
    }
    const json = await readJson(response, 4 * Math.ceil(maxQrBytes / 3) + 16 * 1024);
    if (json?.success !== true) return unavailable;
    if (json.data?.is_logged_in === true) return { connected: true, message: '此小红书账号已登录。' };
    const image = json.data?.is_logged_in === false ? qrImage(json.data.img) : null;
    if (!image) return unavailable;
    return { connected: false, image, message: '请用小红书 App 扫码，完成后刷新渠道状态。' };
  } catch {
    return unavailable;
  }
}
