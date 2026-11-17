import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { countXText, createQueue } from './queue.mjs';
import { createLocalSettings } from './setup-settings.mjs';
import { detectLocalBridge, getBridgeQr } from './setup-bridge.mjs';

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const maxImageSize = 5 * 1024 * 1024;
const localNames = new Set(['localhost', '127.0.0.1', '[::1]']);
const channelNames = new Set(['x', 'linkedin', 'xiaohongshu']);
const docs = new Set(['/docs/channels.md', '/docs/xiaohongshu.md', '/docs/setup.md']);
const mimeByExt = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};
const extByMime = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
]);

function problem(status, message) {
  return Object.assign(new Error(message), { statusCode: status });
}

function checkedOrigin(req) {
  const rawHost = req.headers.host ?? '';
  // Compare the entire authority. URL parsing alone accepts userinfo, paths and trailing dots.
  const port = req.socket.localPort;
  for (const name of localNames) {
    const authority = `${name}:${port}`;
    if (rawHost.toLowerCase() === authority || (port === 80 && rawHost.toLowerCase() === name)) {
      return new URL(`http://${rawHost}`).origin;
    }
  }
  throw problem(403, '请使用本机地址打开 Open Social。');
}

function assertSameSite(req, origin) {
  const supplied = req.headers.origin;
  if ((supplied !== undefined && supplied !== origin) || req.headers['sec-fetch-site'] === 'cross-site') {
    throw problem(403, '请从本机工作台重新操作。');
  }
}

function assertMethod(req, ...methods) {
  if (!methods.includes(req.method)) throw problem(405, '当前接口不支持该请求方式。');
}

function respond(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function redirect(res, destination) {
  res.writeHead(303, { Location: destination, 'Cache-Control': 'no-store' });
  res.end();
}

function contentType(req) {
  return String(req.headers['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

function limitSize(req, limit) {
  if (Number(req.headers['content-length'] || 0) > limit) throw problem(413, '上传内容超过大小限制。');
}

async function readJson(req) {
  if (contentType(req) !== 'application/json') throw problem(415, '请提交 JSON 格式的数据。');
  const limit = 256 * 1024;
  limitSize(req, limit);
  let length = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > limit) throw problem(413, '文案与请求内容超过大小限制。');
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw problem(400, 'JSON 格式有误。');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw problem(400, '请提交有效的请求对象。');
  return body;
}

function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  return null;
}

function imageName(req, extension) {
  let value;
  try {
    value = decodeURIComponent(String(req.headers['x-filename'] ?? ''));
  } catch {
    throw problem(400, '图片文件名编码有误。');
  }
  const base = value
    .split(/[\\/]/u)
    .pop()
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim();
  return Array.from(base || `image${extension}`)
    .slice(0, 180)
    .join('');
}

function createMediaStore(db, dataDir) {
  const mediaDir = join(dataDir, 'media');
  mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
  db.exec(
    'CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL)',
  );
  const find = db.prepare('SELECT id, name, mime, size FROM media WHERE id=?');
  const insert = db.prepare('INSERT INTO media(id,name,mime,size) VALUES(?,?,?,?)');
  function loadMedia(id) {
    if (typeof id !== 'string') return undefined;
    const row = find.get(id);
    if (!row) return undefined;
    const path = join(mediaDir, row.id + extByMime.get(row.mime));
    if (existsSync(path)) return { ...row, path };
  }
  async function upload(req) {
    const mime = contentType(req);
    const extension = extByMime.get(mime);
    if (!extension) throw problem(415, '请选择 JPG、PNG 或 WebP 图片。');
    limitSize(req, maxImageSize);
    const name = imageName(req, extension);
    const id = randomUUID();
    const temporary = join(mediaDir, id + '.part');
    const destination = join(mediaDir, id + extension);
    const file = await open(temporary, 'wx', 0o600);
    let header = Buffer.alloc(0);
    let size = 0;
    try {
      try {
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          size += chunk.length;
          if (size > maxImageSize) throw problem(413, '每张图片最多 5 MiB。');
          if (header.length < 12) header = Buffer.concat([header, chunk.subarray(0, 12 - header.length)]);
          await file.writeFile(chunk);
        }
        if (imageMime(header) !== mime) throw problem(415, '图片内容与提交的文件类型不符。');
      } finally {
        await file.close();
      }
      await rename(temporary, destination);
      try {
        insert.run(id, name, mime, size);
      } catch (err) {
        await unlink(destination);
        throw err;
      }
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return { id, name, url: `/media/${id}`, mime, size };
  }
  return { loadMedia, upload };
}

async function serveFile(req, res, path, mime) {
  const info = await stat(path);
  if (!info.isFile()) throw problem(404, '没有找到该文件。');
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') return res.end();
  await pipeline(createReadStream(path), res);
}

async function serveStatic(req, res, pathname, directories) {
  assertMethod(req, 'GET', 'HEAD');
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw problem(400, '路径编码有误。');
  }
  const parts = decoded.split('/');
  if (parts.some((part) => part.startsWith('.') || /[\\\x00-\x1f]/.test(part)))
    throw problem(404, '没有找到该资源。');
  let root = directories.publicDir;
  let segments = parts.slice(1);
  if (parts[1] === 'src') {
    root = directories.sourceDir;
    segments = parts.slice(2);
  } else if (parts[1] === 'docs') {
    if (!docs.has(decoded)) throw problem(404, '没有找到该文档。');
    root = directories.docsDir;
    segments = parts.slice(2);
  }
  const requested = join(root, ...(decoded === '/' ? ['index.html'] : segments));
  const resolvedFile = await realpath(requested);
  const subpath = relative(await realpath(root), resolvedFile);
  if (subpath === '..' || subpath.startsWith('../') || isAbsolute(subpath))
    throw problem(404, '没有找到该资源。');
  const mime = mimeByExt[extname(resolvedFile).toLowerCase()];
  if (!mime) throw problem(404, '没有找到该资源。');
  await serveFile(req, res, resolvedFile, mime);
}

function readDiscoveryQuery(params) {
  const topic = (params.get('topic') ?? 'AI Agents').trim();
  const days = Number(params.get('days') ?? 7);
  const platform = params.get('platform') || 'all';
  if (!topic || Array.from(topic).length > 120) throw problem(400, '话题请输入 1 到 120 个字符。');
  if (![7, 30].includes(days)) throw problem(400, '请选择 7 天或 30 天。');
  if (!/^[a-z][a-z0-9_-]{0,30}$/.test(platform)) throw problem(400, '无效的平台名称。');
  return { topic, days, platform, refresh: params.get('refresh') === '1' };
}

function safeError(error) {
  const status = Number(error.statusCode ?? error.status);
  if (Number.isInteger(status) && status >= 400 && status < 500) return { status, message: error.message };
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    return { status: 404, message: '没有找到该资源。' };
  return { status: 500, message: '暂时无法完成请求，请稍后重试或检查本机配置。' };
}

function oauthFailure(res, origin) {
  res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>账号连接未完成 · Open Social</title><main><h1>账号连接未完成</h1><p>请检查应用回调地址和授权范围，然后回到渠道页重新连接。</p><a href="${origin}/#channels">回到渠道管理</a></main></html>`,
  );
}

export async function createApp(options = {}) {
  const dataDir = resolve(options.dataDir || process.env.OPEN_SOCIAL_DATA_DIR || join(projectDir, '.data'));
  const directories = {
    publicDir: options.publicDir ?? join(projectDir, 'public'),
    sourceDir: options.sourceDir ?? join(projectDir, 'src'),
    docsDir: options.docsDir ?? join(projectDir, 'docs'),
  };
  const providers = options.providers || (await import('./providers.mjs'));
  const discover = options.discover || (await import('./discovery.mjs')).discover;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'workspace.sqlite'));
  let media, queue, settings;
  try {
    // A second process sharing this data directory must not revive another worker's in-flight targets.
    db.exec(
      'PRAGMA busy_timeout=750; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;',
    );
    media = createMediaStore(db, dataDir);
    settings = createLocalSettings(dataDir, options.settingsEnv || process.env);
    queue = createQueue({
      db,
      loadMedia: media.loadMedia,
      publishTarget: providers.publishTarget,
      getChannels: providers.getChannels,
    });
  } catch (error) {
    settings?.close();
    db.close();
    throw error;
  }
  const server = http.createServer({ requestTimeout: 35_000, headersTimeout: 15_000 }, async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' blob: data:; connect-src 'self'",
    );
    try {
      const origin = checkedOrigin(req);
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw problem(400, '请求地址有误。');
      const url = new URL(req.url, origin);
      const pathname = url.pathname;
      const parts = pathname.split('/');
      const callback =
        parts.length === 5 &&
        parts[1] === 'api' &&
        parts[2] === 'oauth' &&
        parts[4] === 'callback' &&
        channelNames.has(parts[3]);
      if (pathname.startsWith('/api/') && !callback) assertSameSite(req, origin);
      if (callback) {
        assertMethod(req, 'GET');
        try {
          const workspace = await providers.finishOAuth(parts[3], url.searchParams, origin);
          return redirect(res, new URL('/#channels', workspace).href);
        } catch {
          return oauthFailure(res, origin);
        }
      }
      if (
        parts.length === 4 &&
        parts[1] === 'api' &&
        parts[2] === 'connect' &&
        channelNames.has(parts[3])
      ) {
        assertMethod(req, 'GET');
        return redirect(res, await providers.startOAuth(parts[3], origin));
      }
      if (
        parts.length === 5 &&
        parts[1] === 'api' &&
        parts[2] === 'channels' &&
        parts[4] === 'disconnect' &&
        channelNames.has(parts[3])
      ) {
        assertMethod(req, 'POST');
        await providers.disconnect(parts[3]);
        return respond(res, 200, { ok: true });
      }
      if (pathname === '/api/channels') {
        assertMethod(req, 'GET');
        return respond(res, 200, { channels: await providers.getChannels(origin) });
      }
      if (
        parts.length === 4 &&
        parts[1] === 'api' &&
        parts[2] === 'settings' &&
        channelNames.has(parts[3])
      ) {
        assertMethod(req, 'GET', 'POST');
        if (req.method === 'GET') return respond(res, 200, settings.describe(parts[3]));
        return respond(res, 200, settings.save(parts[3], await readJson(req)));
      }
      if (pathname === '/api/settings/xiaohongshu/detect' || pathname === '/api/settings/xiaohongshu/qr') {
        assertMethod(req, 'POST');
        await readJson(req);
        const state = pathname.endsWith('/detect')
          ? await detectLocalBridge()
          : await getBridgeQr(options.settingsEnv || process.env);
        return respond(res, 200, state);
      }
      if (pathname === '/api/discover') {
        assertMethod(req, 'GET');
        return respond(res, 200, await discover(readDiscoveryQuery(url.searchParams)));
      }
      if (pathname === '/api/media') {
        assertMethod(req, 'POST');
        return respond(res, 201, await media.upload(req));
      }
      if (pathname === '/api/count-x') {
        assertMethod(req, 'POST');
        const { text } = await readJson(req);
        return respond(res, 200, countXText(text));
      }
      if (parts.length === 3 && parts[1] === 'media') {
        assertMethod(req, 'GET', 'HEAD');
        const image = media.loadMedia(parts[2]);
        if (!image) throw problem(404, '没有找到该图片。');
        return await serveFile(req, res, image.path, image.mime);
      }
      if (pathname === '/api/jobs') {
        assertMethod(req, 'GET', 'POST');
        if (req.method === 'GET') return respond(res, 200, { jobs: queue.list() });
        return respond(res, 201, await queue.enqueue(await readJson(req)));
      }
      if (parts.length === 5 && parts[1] === 'api' && parts[2] === 'jobs' && parts[4] === 'retry') {
        assertMethod(req, 'POST');
        const { platform } = await readJson(req);
        return respond(res, 200, await queue.retry(parts[3], platform));
      }
      if (parts[1] === 'api') throw problem(404, '没有找到该接口。');
      await serveStatic(req, res, pathname, directories);
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      req.resume();
      const { status, message } = safeError(error);
      respond(res, status, { error: message });
    }
  });
  return {
    server,
    async listen(port = 4317, host = '127.0.0.1') {
      if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('请使用本机监听地址。');
      await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolveListen();
        });
      });
      queue.start();
      return server.address();
    },
    async close() {
      if (server.listening)
        await new Promise((resolveClose, reject) =>
          server.close((err) => (err ? reject(err) : resolveClose())),
        );
      await queue.stop();
      settings.close();
      db.close();
    },
  };
}

async function main() {
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 需要是有效的 TCP 端口。');
  const app = await createApp();
  try {
    await app.listen(port);
  } catch (err) {
    await app.close();
    throw err;
  }
  console.log(`Open Social is running at http://127.0.0.1:${port}`);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await app.close();
    } catch {
      process.exitCode = 1;
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Open Social 启动失败：${error.message}`);
    process.exitCode = 1;
  });
}
