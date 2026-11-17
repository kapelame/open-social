import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const randomString = () => randomBytes(32).toString('base64url');
const stateLifetimeMs = 10 * 60 * 1000;
const soon = () => Date.now() + 30_000;
const loopbackNames = new Set(['127.0.0.1', '[::1]', 'localhost']);
const linkedInCallbackHelp =
  'LinkedIn 网页授权需要 HTTPS 回调。请设置 LINKEDIN_REDIRECT_URI，或为已获准原生 PKCE 的应用启用 LINKEDIN_NATIVE_PKCE=1。';

function failure(message, retryable = false) {
  return Object.assign(new Error(message), { retryable, uncertain: false });
}

function config(id, env) {
  if (id !== 'x' && id !== 'linkedin') throw failure('此渠道不支持 OAuth 授权。');
  const prefix = id.toUpperCase();
  const value = (key) => env[`${prefix}_${key}`]?.trim();
  const isX = id === 'x';
  const native = !isX && value('NATIVE_PKCE') === '1';
  const author = !isX && value('AUTHOR_URN');
  if (author && !/^urn:li:person:[A-Za-z0-9_-]+$/.test(author)) {
    throw failure('LINKEDIN_AUTHOR_URN 需要填写有效的个人 URN。');
  }
  return {
    id,
    label: isX ? 'X' : 'LinkedIn',
    clientId: value('CLIENT_ID'),
    secret: value('CLIENT_SECRET'),
    fixedToken: value('ACCESS_TOKEN'),
    callback: value('REDIRECT_URI'),
    author,
    native,
    connectable: Boolean(value('CLIENT_ID') && (isX || native || value('CLIENT_SECRET'))),
    pkce: isX || native,
    authorize: isX
      ? 'https://x.com/i/oauth2/authorize'
      : native
        ? 'https://www.linkedin.com/oauth/native-pkce/authorization'
        : 'https://www.linkedin.com/oauth/v2/authorization',
    tokenEndpoint: isX
      ? 'https://api.x.com/2/oauth2/token'
      : 'https://www.linkedin.com/oauth/v2/accessToken',
    scope: isX
      ? 'tweet.read tweet.write users.read media.write offline.access'
      : author
        ? 'w_member_social'
        : 'openid profile w_member_social',
  };
}

function redirectUri(c, origin) {
  if (!c.callback && !origin) {
    if (c.id === 'linkedin' && !c.native) throw failure(linkedInCallbackHelp);
    return null;
  }
  let url;
  try {
    url = c.callback ? new URL(c.callback) : new URL(`/api/oauth/${c.id}/callback`, origin);
  } catch {
    throw failure(c.id === 'linkedin' && !c.native ? linkedInCallbackHelp : '请填写完整的渠道回调地址。');
  }
  if (c.id === 'linkedin' && !c.native && url.protocol !== 'https:') throw failure(linkedInCallbackHelp);
  const loopback = loopbackNames.has(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.pathname !== `/api/oauth/${c.id}/callback`
  ) {
    throw failure(`回调地址只可包含协议、主机、端口和 /api/oauth/${c.id}/callback 路径。`);
  }
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw failure('回调地址须使用 HTTPS 或本机 HTTP。');
  }
  if (c.native && !['127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw failure('LinkedIn 原生 PKCE 需要使用 127.0.0.1 或 [::1] 回调。');
  }
  return url.href;
}

async function jsonRequest(url, options) {
  let response;
  try {
    response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  } catch {
    throw failure('暂时无法连接授权服务，请稍后重试。', true);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    const error = failure(
      `平台拒绝授权请求（HTTP ${response.status}），请检查应用配置或重新授权。`,
      response.status === 429 || response.status >= 500,
    );
    error.invalidGrant = data?.error === 'invalid_grant';
    throw error;
  }
  return data || {};
}

async function exchange(c, params) {
  const body = new URLSearchParams(params);
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (c.id === 'x' && c.secret) {
    headers.authorization = 'Basic ' + Buffer.from(`${c.clientId}:${c.secret}`).toString('base64');
  } else {
    body.set('client_id', c.clientId);
    if (c.secret && !c.native) body.set('client_secret', c.secret);
  }
  const data = await jsonRequest(c.tokenEndpoint, { method: 'POST', headers, body });
  if (!data.access_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
    throw failure(`${c.label} 未返回有效令牌，请重新授权。`);
  }
  if (data.scope) {
    const granted = new Set(data.scope.split(/[ ,]+/));
    const required =
      c.id === 'x' ? ['tweet.read', 'users.read', 'tweet.write', 'media.write'] : ['w_member_social'];
    if (required.some((scope) => !granted.has(scope))) throw failure(`${c.label} 未授予完整图文发布权限。`);
  }
  return data;
}

function pack(data, previous) {
  return {
    ...previous,
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    refreshToken: data.refresh_token || previous.refreshToken,
    refreshExpiresAt:
      data.refresh_token_expires_in !== undefined
        ? Date.now() + data.refresh_token_expires_in * 1000
        : previous.refreshExpiresAt,
  };
}

function fingerprint(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createOAuth({ dataDir, env = process.env } = {}) {
  const pending = new Map();
  const active = new Map();
  const rejectedFixed = new Map();

  function tokenFile(id) {
    return resolve(dataDir || env.OPEN_SOCIAL_DATA_DIR || '.data', 'oauth', `${id}.json`);
  }

  function readToken(id) {
    try {
      return JSON.parse(readFileSync(tokenFile(id), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw failure('无法读取本地授权文件，请检查数据目录。');
    }
  }

  function saveToken(id, token) {
    const dir = dirname(tokenFile(id));
    const temp = join(dir, `.${id}-${randomString()}.tmp`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(temp, JSON.stringify(token), { mode: 0o600, flag: 'wx' });
      renameSync(temp, tokenFile(id));
    } finally {
      rmSync(temp, { force: true });
    }
  }

  // Refresh tokens can rotate on use. Serialize refresh, replacement and disconnection per channel.
  function exclusive(id, operation) {
    const result = (active.get(id) || Promise.resolve()).then(operation);
    const tail = result.catch(() => {});
    active.set(id, tail);
    tail.then(() => {
      if (active.get(id) === tail) active.delete(id);
    });
    return result;
  }

  async function startOAuth(id, origin) {
    const c = config(id, env);
    if (!c.connectable) throw failure(`请先配置 ${c.label} 开发者应用。参见渠道配置说明。`);
    if (c.fixedToken) throw failure('当前使用环境变量令牌，移除令牌并重启服务后即可连接 OAuth。');
    const workspace = URL.canParse(origin) && new URL(origin);
    if (
      !workspace ||
      !loopbackNames.has(workspace.hostname) ||
      !['http:', 'https:'].includes(workspace.protocol) ||
      workspace.username ||
      workspace.password ||
      workspace.search ||
      workspace.hash ||
      workspace.pathname !== '/'
    ) {
      throw failure('请从本机工作台打开账号连接。');
    }
    const state = randomString();
    const redirect = redirectUri(c, origin);
    const auth = new URL(c.authorize);
    auth.search = new URLSearchParams({
      response_type: 'code',
      client_id: c.clientId,
      state,
      scope: c.scope,
      redirect_uri: redirect,
    });
    const verifier = c.pkce ? randomString() : undefined;
    if (verifier) {
      auth.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
      auth.searchParams.set('code_challenge_method', 'S256');
    }
    pending.set(id, {
      state,
      verifier,
      redirect,
      workspace: workspace.origin,
      clientId: c.clientId,
      expires: Date.now() + stateLifetimeMs,
    });
    return auth.href;
  }

  async function finishOAuth(id, params, origin) {
    const c = config(id, env);
    const attempt = pending.get(id);
    if (
      !attempt ||
      attempt.state !== params.get('state') ||
      attempt.expires <= Date.now() ||
      attempt.redirect !== redirectUri(c, origin) ||
      attempt.clientId !== c.clientId
    ) {
      throw failure('授权会话不匹配或已过期，请重新连接。');
    }
    pending.delete(id);
    const code = params.get('code');
    if (params.has('error') || !code) throw failure('平台授权已取消或未获批准。');
    return exclusive(id, async () => {
      const body = { grant_type: 'authorization_code', code, redirect_uri: attempt.redirect };
      if (attempt.verifier) body.code_verifier = attempt.verifier;
      const data = await exchange(c, body);
      let author = c.author || undefined;
      if (id === 'linkedin' && !author) {
        const member = await jsonRequest('https://api.linkedin.com/v2/userinfo', {
          headers: { authorization: `Bearer ${data.access_token}` },
        });
        if (typeof member.sub !== 'string' || !/^[A-Za-z0-9_-]+$/.test(member.sub)) {
          throw failure('LinkedIn 未返回个人身份，请启用 OpenID Connect 后重新连接。');
        }
        author = `urn:li:person:${member.sub}`;
      }
      saveToken(id, pack(data, { author, clientId: c.clientId }));
      return attempt.workspace;
    });
  }

  async function getAccess(id) {
    const c = config(id, env);
    if (c.fixedToken) {
      if (id === 'linkedin' && !c.author) throw failure('请为环境变量令牌配置 LINKEDIN_AUTHOR_URN。');
      if (rejectedFixed.has(id) && rejectedFixed.get(id) === fingerprint(c.fixedToken)) {
        throw failure(`${c.label} 已拒绝环境变量中的用户令牌，请更换令牌并重启服务。`);
      }
      return { accessToken: c.fixedToken, author: c.author || undefined };
    }
    return exclusive(id, async () => {
      let token = readToken(id);
      if (!token?.accessToken || !c.connectable || token.clientId !== c.clientId) {
        throw failure(`请先连接 ${c.label} 账号。`);
      }
      if (token.expiresAt <= soon()) {
        if (!token.refreshToken || token.refreshExpiresAt <= Date.now()) {
          if (token.expiresAt <= Date.now()) throw failure(`${c.label} 授权已到期，请重新连接。`);
        } else {
          let data;
          try {
            data = await exchange(c, { grant_type: 'refresh_token', refresh_token: token.refreshToken });
          } catch (err) {
            if (err.invalidGrant) {
              rmSync(tokenFile(id), { force: true });
              throw failure(`${c.label} 授权已失效，请重新连接。`);
            }
            throw err;
          }
          token = pack(data, token);
          saveToken(id, token);
        }
      }
      return { accessToken: token.accessToken, author: token.author };
    });
  }

  // A late 401 from an old request must never invalidate a newly authorized account.
  async function markAccessRejected(id, accessToken) {
    if (!accessToken) return;
    const c = config(id, env);
    if (c.fixedToken) {
      if (c.fixedToken === accessToken) rejectedFixed.set(id, fingerprint(accessToken));
      return;
    }
    return exclusive(id, () => {
      const token = readToken(id);
      if (token?.accessToken === accessToken && token.clientId === c.clientId) {
        saveToken(id, { ...token, expiresAt: 0 });
      }
    });
  }

  async function getOAuthStatus(id, origin) {
    let c;
    try {
      c = config(id, env);
    } catch (err) {
      return {
        configured: false,
        connected: false,
        connectable: false,
        redirectUri: null,
        detail: err.message,
      };
    }
    let callback = null;
    let callbackIssue = '';
    try {
      callback = redirectUri(c, origin);
    } catch (err) {
      callbackIssue = err.message;
    }
    const configured = c.connectable || Boolean(c.fixedToken);
    const status = {
      configured,
      connected: false,
      connectable: c.connectable && !c.fixedToken && !callbackIssue,
      redirectUri: callback,
    };
    if (!configured) return { ...status, detail: '等待配置开发者应用或用户令牌。' + callbackIssue };
    try {
      await getAccess(id);
      const detail = c.fixedToken ? '使用环境变量中的用户令牌。' : '已取得用户授权。' + callbackIssue;
      return { ...status, connected: true, detail };
    } catch (err) {
      return { ...status, detail: c.fixedToken ? err.message : callbackIssue || err.message };
    }
  }

  async function disconnect(id) {
    const c = config(id, env);
    if (c.fixedToken) throw failure('请移除环境变量中的用户令牌并重启服务。');
    pending.delete(id);
    return exclusive(id, () => rmSync(tokenFile(id), { force: true }));
  }

  return { startOAuth, finishOAuth, getAccess, markAccessRejected, getOAuthStatus, disconnect };
}

// Standalone callers retain their existing environment-based store. The HTTP app binds its own dataDir.
export const { startOAuth, finishOAuth, getAccess, markAccessRejected, getOAuthStatus, disconnect } = createOAuth();
