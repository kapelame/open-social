import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

function failure(message, { retryable = false, uncertain = false } = {}) {
  return Object.assign(new Error(message), { retryable, uncertain });
}

function bridgeBase(env) {
  if (!env.XHS_BRIDGE_URL?.trim()) {
    throw failure('请先设置 XHS_BRIDGE_URL，启动小红书桥接并扫码登录。');
  }
  let base;
  try {
    base = new URL(env.XHS_BRIDGE_URL);
  } catch {
    throw failure('XHS_BRIDGE_URL 应为桥接服务的 HTTP 或 HTTPS 根地址。');
  }
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.search ||
    base.hash ||
    base.username ||
    base.password
  ) {
    throw failure('请用服务根地址配置 XHS_BRIDGE_URL，用 XHS_BRIDGE_TOKEN 配置鉴权。');
  }
  return base.href.replace(/\/+$/, '');
}

// Only server-side callers select endpoints. Never follow redirects carrying a private
// image path, text, or the self-hosted bridge's access token.
export async function xhsBridgeRequest(endpoint, { method = 'GET', body, timeoutMs = 12000, env = process.env } = {}) {
  if (!endpoint.startsWith('/api/v1/')) throw failure('无效的小红书桥接接口。');
  const url = bridgeBase(env) + endpoint;
  const token = env.XHS_BRIDGE_TOKEN?.trim();
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const isPublish = method === 'POST' && endpoint === '/api/v1/publish';
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch (error) {
    const refused = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(error.cause?.code);
    if (isPublish && !refused)
      throw failure('未收到小红书发布回执，请先到创作中心核对结果。', { uncertain: true });
    throw failure('连接小红书桥接失败，请检查服务地址及运行状态。', { retryable: true });
  }
  const json = await response.json().catch(() => null);
  return { response, json };
}

async function checkLogin(env) {
  const { response, json } = await xhsBridgeRequest('/api/v1/login/status', { timeoutMs: 25000, env });
  if (response.status === 401 || response.status === 403) {
    throw failure('小红书桥接拒绝了凭证，请检查 XHS_BRIDGE_TOKEN。');
  }
  if (!response.ok || json?.success !== true || typeof json.data?.is_logged_in !== 'boolean') {
    throw failure('小红书桥接未返回有效登录状态，请检查服务版本和运行状态。', {
      retryable: response.status >= 500,
    });
  }
  if (!json.data.is_logged_in) throw failure('请先在小红书桥接中扫码登录。');
  const account = typeof json.data.username === 'string' ? json.data.username.trim() : '';
  return account ? `已连接 · ${account}` : '已通过自托管桥接登录';
}

export async function xhsStatus(env = process.env) {
  const configured = !!env.XHS_BRIDGE_URL?.trim();
  const status = { configured, connected: false, connectable: false };
  if (!configured) return { ...status, detail: '配置自托管桥接并扫码后，即可发布图文。' };
  try {
    const detail = await checkLogin(env);
    return { ...status, connected: true, detail };
  } catch (error) {
    return { ...status, detail: error.message };
  }
}

async function bridgeImagePaths(images, env) {
  const hostDir = env.XHS_LOCAL_MEDIA_DIR?.trim();
  const serviceDir = env.XHS_BRIDGE_MEDIA_DIR?.trim();
  if (!!hostDir !== !!serviceDir || (serviceDir && !path.posix.isAbsolute(serviceDir))) {
    throw failure('容器映射需要同时填写 XHS_LOCAL_MEDIA_DIR 和容器内的绝对目录 XHS_BRIDGE_MEDIA_DIR。');
  }
  let root;
  if (hostDir) {
    root = await realpath(hostDir).catch(() => {
      throw failure('无法读取 XHS_LOCAL_MEDIA_DIR，请检查图片目录。');
    });
  }
  return Promise.all(
    images.map(async (image) => {
      if (!image?.path) throw failure('小红书附件缺少本地文件。');
      const file = await realpath(image.path).catch(() => {
        throw failure('小红书附件不存在，请重新上传图片。');
      });
      if (!(await stat(file)).isFile()) throw failure('小红书附件必须是图片文件。');
      if (!root) return file;
      const relative = path.relative(root, file);
      if (
        !relative ||
        relative === '..' ||
        relative.startsWith('..' + path.sep) ||
        path.isAbsolute(relative)
      ) {
        throw failure('选中的图片位于桥接共享目录之外，请检查 XHS_LOCAL_MEDIA_DIR。');
      }
      return path.posix.join(serviceDir, ...relative.split(path.sep));
    }),
  );
}

export async function publishXhs({ title, text, images }, env = process.env) {
  if (typeof title !== 'string' || !title.trim()) throw failure('小红书图文需要标题。');
  // The bridge counts each ASCII UTF-16 code unit as half a Chinese character.
  if (title.replace(/[^\x00-\x7F]/g, 'xx').length > 40) throw failure('小红书标题最多 20 个中文字宽度。');
  if (typeof text !== 'string' || !text.trim()) throw failure('请填写小红书正文。');
  if (!Array.isArray(images) || !images.length) throw failure('小红书图文至少需要一张图片。');
  const localPaths = await bridgeImagePaths(images, env);
  await checkLogin(env);
  const { response, json } = await xhsBridgeRequest('/api/v1/publish', {
    env,
    method: 'POST',
    timeoutMs: 330000,
    body: { title, content: text, images: localPaths },
  });
  if ([400, 401, 403, 404, 405, 413, 415, 422, 429].includes(response.status)) {
    throw failure(`小红书桥接拒绝发布（HTTP ${response.status}），请核对授权、图片和服务版本。`, {
      retryable: response.status === 429,
    });
  }
  const receipt = json?.data;
  if (
    !response.ok ||
    json?.success !== true ||
    receipt?.status !== '发布完成' ||
    receipt.title !== title ||
    receipt.content !== text ||
    receipt.images !== images.length
  ) {
    throw failure('小红书桥接未确认本次图文发布完成，请到创作中心核对结果。', { uncertain: true });
  }
  return { message: '小红书桥接已确认提交，可在创作中心查看公开状态。' };
}
