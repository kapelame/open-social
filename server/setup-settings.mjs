import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const fields = {
  x: ['X_CLIENT_ID', 'X_CLIENT_SECRET', 'X_ACCESS_TOKEN', 'X_BEARER_TOKEN', 'X_REDIRECT_URI'],
  linkedin: [
    'LINKEDIN_CLIENT_ID',
    'LINKEDIN_CLIENT_SECRET',
    'LINKEDIN_ACCESS_TOKEN',
    'LINKEDIN_AUTHOR_URN',
    'LINKEDIN_REDIRECT_URI',
    'LINKEDIN_NATIVE_PKCE',
  ],
  xiaohongshu: ['XHS_BRIDGE_URL', 'XHS_BRIDGE_TOKEN', 'XHS_LOCAL_MEDIA_DIR', 'XHS_BRIDGE_MEDIA_DIR'],
};
const allKeys = Object.values(fields).flat();
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function problem(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function channelFields(id) {
  if (!Object.hasOwn(fields, id)) throw problem('未知的配置渠道。', 404);
  return fields[id];
}

function validUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw problem('请输入完整的 HTTP 或 HTTPS 地址。');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw problem('地址只能包含协议、主机、端口与路径。令牌请填入专用字段。');
  }
  return url;
}

function fieldValue(key, value) {
  if (typeof value !== 'string' || value.length > 16384 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw problem('配置值只能使用单行文本，最多 16384 个字符。');
  }
  const cleaned = value.trim();
  if (!cleaned) return '';
  if (key === 'XHS_BRIDGE_URL') return validUrl(cleaned).href.replace(/\/+$/, '');
  if (key.endsWith('_REDIRECT_URI')) {
    const url = validUrl(cleaned);
    const id = key.split('_')[0].toLowerCase();
    if (
      url.pathname !== '/api/oauth/' + id + '/callback' ||
      (url.protocol === 'http:' && !loopback.has(url.hostname))
    ) {
      throw problem('请使用当前渠道的完整 OAuth 回调地址；HTTP 仅可使用本机回环地址。');
    }
    return url.href;
  }
  if (key === 'LINKEDIN_NATIVE_PKCE' && !['0', '1'].includes(cleaned))
    throw problem('原生 PKCE 开关应为 0 或 1。');
  if (key === 'LINKEDIN_AUTHOR_URN' && !/^urn:li:person:[A-Za-z0-9_-]+$/.test(cleaned)) {
    throw problem('请输入以 urn:li:person: 开头的有效个人 URN。');
  }
  if (key === 'XHS_BRIDGE_MEDIA_DIR' && !cleaned.startsWith('/'))
    throw problem('请填写桥接容器内的绝对图片目录。');
  return cleaned;
}

function readStored(path) {
  let body;
  try {
    body = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { values: {} };
    throw new Error('无法读取本机渠道配置文件 local-settings.json。');
  }
  try {
    const parsed = JSON.parse(body);
    if (
      !isRecord(parsed) ||
      !isRecord(parsed.values) ||
      !Object.keys(parsed.values).every((key) => allKeys.includes(key))
    )
      throw new Error();
    const values = Object.fromEntries(
      Object.entries(parsed.values).map(([key, value]) => [key, fieldValue(key, value)]),
    );
    return {
      values,
      bridgeTokenTarget:
        typeof parsed.bridgeTokenTarget === 'string' ? parsed.bridgeTokenTarget : undefined,
    };
  } catch {
    throw new Error('本机渠道配置文件 local-settings.json 格式错误，请检查文件或从备份恢复。');
  }
}

function saveStored(dataDir, path, document) {
  const temporary = join(dataDir, '.settings-' + randomUUID() + '.tmp');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporary, JSON.stringify(document, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function bridgeTarget(url) {
  if (!url) return '';
  try {
    return validUrl(url).href.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function createLocalSettings(dataDir, env = process.env) {
  const path = join(dataDir, 'local-settings.json');
  const explicit = Object.fromEntries(allKeys.filter((k) => env[k]?.trim()).map((k) => [k, env[k]]));
  let stored = readStored(path);

  function effective(document) {
    const merged = { ...document.values, ...explicit };
    // A bridge credential belongs to the precise endpoint it was entered for.
    // A changed URL in .env must not inherit a form-saved bearer token.
    if (!explicit.XHS_BRIDGE_TOKEN && document.bridgeTokenTarget !== bridgeTarget(merged.XHS_BRIDGE_URL)) {
      delete merged.XHS_BRIDGE_TOKEN;
    }
    // An environment-managed bearer needs its destination in the same configuration source.
    if (explicit.XHS_BRIDGE_TOKEN && !explicit.XHS_BRIDGE_URL) delete merged.XHS_BRIDGE_URL;
    return merged;
  }
  function apply(document) {
    const active = effective(document);
    for (const key of allKeys) {
      if (Object.hasOwn(explicit, key)) continue;
      if (active[key]) env[key] = active[key];
      else delete env[key];
    }
  }

  apply(stored);
  return {
    describe(id) {
      const keys = channelFields(id);
      return {
        configured: keys.filter((k) => Boolean(env[k]?.trim())),
        locked: keys.filter((k) => Object.hasOwn(explicit, k)),
      };
    },
    save(id, payload) {
      const allowed = channelFields(id);
      if (
        !isRecord(payload) ||
        !isRecord(payload.values) ||
        (payload.clear !== undefined && !Array.isArray(payload.clear))
      ) {
        throw problem('请提交有效的渠道配置。');
      }
      const next = { ...stored, values: { ...stored.values } };
      const clearKeys = new Set(payload.clear || []);
      const patch = new Map();
      for (const [key, raw] of Object.entries(payload.values)) {
        if (!allowed.includes(key)) throw problem('配置包含当前渠道不支持的字段。');
        const value = fieldValue(key, raw);
        if (value) patch.set(key, value);
      }
      for (const key of [...clearKeys, ...patch.keys()]) {
        if (!allowed.includes(key)) throw problem('配置包含当前渠道不支持的字段。');
        if (Object.hasOwn(explicit, key)) throw problem('字段 ' + key + ' 已由启动环境或 .env 管理。', 409);
        if (clearKeys.has(key) && patch.has(key)) throw problem('同一字段不可同时清除和更新。');
      }
      if (!clearKeys.size && !patch.size) return { saved: true };
      for (const key of clearKeys) delete next.values[key];
      for (const [key, value] of patch) next.values[key] = value;
      const candidate = { ...next.values, ...explicit };
      if (id === 'xiaohongshu') {
        if (explicit.XHS_BRIDGE_TOKEN && !explicit.XHS_BRIDGE_URL && patch.has('XHS_BRIDGE_URL')) {
          throw problem(
            '桥接令牌已由环境变量管理。请在同一环境中设置桥接地址，或移除该令牌后通过本机表单重新配置。',
            409,
          );
        }
        if (Boolean(candidate.XHS_LOCAL_MEDIA_DIR) !== Boolean(candidate.XHS_BRIDGE_MEDIA_DIR))
          throw problem('使用容器映射时，请同时填写宿主机与容器的图片目录。');
        const target = bridgeTarget(candidate.XHS_BRIDGE_URL);
        if (patch.has('XHS_BRIDGE_TOKEN')) {
          if (!target) throw problem('保存桥接令牌时需要同时指定服务地址。');
          next.bridgeTokenTarget = target;
        } else if (next.bridgeTokenTarget !== target || clearKeys.has('XHS_BRIDGE_TOKEN')) {
          delete next.values.XHS_BRIDGE_TOKEN;
          delete next.bridgeTokenTarget;
        }
      }
      if (id === 'linkedin' && candidate.LINKEDIN_REDIRECT_URI) {
        const url = validUrl(candidate.LINKEDIN_REDIRECT_URI);
        if (candidate.LINKEDIN_NATIVE_PKCE === '1' && !['127.0.0.1', '[::1]'].includes(url.hostname)) {
          throw problem('LinkedIn 原生 PKCE 请使用 127.0.0.1 或 [::1] 的回调地址。');
        }
        if (candidate.LINKEDIN_NATIVE_PKCE !== '1' && url.protocol !== 'https:')
          throw problem('LinkedIn 标准网页 OAuth 需要已登记的 HTTPS 回调地址。');
      }
      saveStored(dataDir, path, next);
      stored = next;
      apply(next);
      return { saved: true };
    },
    close() {
      const active = effective(stored);
      for (const key of allKeys) {
        if (!Object.hasOwn(explicit, key) && env[key] === active[key]) delete env[key];
      }
    },
  };
}
