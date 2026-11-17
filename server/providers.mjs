import { readFile, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { getAccess, getOAuthStatus, markAccessRejected } from './oauth.mjs';
import { publishXhs, xhsStatus } from './xiaohongshu.mjs';

export { startOAuth, finishOAuth, disconnect } from './oauth.mjs';

export async function getChannels(origin) {
  const [x, linkedin, xiaohongshu] = await Promise.all([
    getOAuthStatus('x', origin),
    getOAuthStatus('linkedin', origin),
    xhsStatus(),
  ]);
  return [
    { id: 'x', label: 'X', ...x },
    { id: 'linkedin', label: 'LinkedIn', ...linkedin },
    { id: 'xiaohongshu', label: '小红书', ...xiaohongshu },
  ];
}

function failure(message, { uncertain = false, retryable = false } = {}) {
  return Object.assign(new Error(message), { uncertain, retryable: retryable && !uncertain });
}

const labels = { x: 'X', linkedin: 'LinkedIn' };

// Uploads can be repeated. A lost response while creating the actual post cannot.
async function request(platform, url, init, creatingPost = false) {
  let response;
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(45000) });
  } catch {
    throw failure(
      creatingPost
        ? `${labels[platform]} 未返回发帖结果，请到账号主页核实。`
        : `${labels[platform]} 媒体服务暂时不可用。`,
      { uncertain: creatingPost, retryable: true },
    );
  }
  if (response.ok) return response;

  const { status } = response;
  if (response.body) await response.body.cancel().catch(() => {});
  // A signed upload URL can expire independently of a member token.
  if (status === 401 && ['api.x.com', 'api.linkedin.com'].includes(new URL(url).hostname)) {
    const token = init.headers.Authorization?.slice('Bearer '.length);
    if (token) await markAccessRejected(platform, token);
  }
  const uncertain = creatingPost && (status >= 500 || status === 408);
  let detail = '请核对渠道权限和内容格式。';
  if (status === 429) detail = '请求达到平台限额，请稍后重试。';
  if (status === 401) detail = '授权失效，请重新连接账号。';
  if (status === 403) detail = '请检查应用的发帖权限和账号状态。';
  if (status === 402) detail = '请检查开发者应用的 API 余额。';
  if (uncertain) detail = '发帖结果待核实，请先查看账号主页。';
  const error = failure(`${labels[platform]} 返回 HTTP ${status}。${detail}`, {
    uncertain,
    retryable: status === 429 || (!creatingPost && (status >= 500 || status === 408)),
  });
  error.statusCode = status;
  const after = response.headers.get('retry-after');
  if (after && /^\d{1,8}$/.test(after)) error.retryAfterMs = Number(after) * 1000;
  throw error;
}

async function jsonBody(response, platform, creatingPost = false) {
  try {
    return await response.json();
  } catch {
    throw failure(`${labels[platform]} 响应不完整。`, {
      uncertain: creatingPost,
      retryable: !creatingPost,
    });
  }
}

function jsonPost(headers, payload) {
  return {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

async function readImage(image, platform) {
  const allowed =
    platform === 'x' ? ['image/jpeg', 'image/png', 'image/webp'] : ['image/jpeg', 'image/png'];
  if (!allowed.includes(image?.mime))
    throw failure(
      `${labels[platform]} 支持的图片格式为 ${allowed.map((m) => m.slice(6).toUpperCase()).join('、')}。`,
    );
  const metadata = await stat(image.path);
  if (!metadata.isFile() || !metadata.size) throw failure('素材为空或不可读取，请重新上传。');
  if (platform === 'x' && metadata.size > 5 * 1024 * 1024) throw failure('X 单张图片上限为 5 MB。');
  return readFile(image.path);
}

async function uploadX(image, authorization) {
  const bytes = await readImage(image, 'x');
  const endpoint = 'https://api.x.com/2/media/upload';
  const payload = { media: bytes.toString('base64'), media_category: 'tweet_image' };
  const response = await request('x', endpoint, jsonPost(authorization, payload));
  const { data } = (await jsonBody(response, 'x')) ?? {};
  if (typeof data?.id !== 'string' || !/^\d+$/.test(data.id)) throw failure('X 上传结果中缺少素材编号。');
  const deadline = Date.now() + 90000;
  let info = data.processing_info;
  while (info && info.state !== 'succeeded') {
    if (!['pending', 'in_progress'].includes(info.state)) throw failure('X 图片处理失败。');
    const wait = Math.max(1, Number(info.check_after_secs) || 1) * 1000;
    if (Date.now() + wait >= deadline) throw failure('X 图片仍在处理，请稍后重试。', { retryable: true });
    await sleep(wait);
    const checked = await request('x', `${endpoint}?media_id=${data.id}&command=STATUS`, {
      headers: authorization,
    });
    const result = await jsonBody(checked, 'x');
    info = result?.data?.processing_info;
    if (!info) throw failure('X 未返回素材处理状态。', { retryable: true });
  }
  return data.id;
}

async function publishX({ text, images }) {
  if (images.length > 4) throw failure('X 每条帖子最多可附 4 张图片。');
  const credentials = await getAccess('x');
  const authorization = bearer(credentials.accessToken);
  const ids = [];
  for (const image of images) ids.push(await uploadX(image, authorization));
  const payload = { text };
  if (ids.length) payload.media = { media_ids: ids };
  const response = await request('x', 'https://api.x.com/2/tweets', jsonPost(authorization, payload), true);
  const body = await jsonBody(response, 'x', true);
  if (typeof body?.data?.id !== 'string' || !/^\d+$/.test(body.data.id)) {
    throw failure('X 未返回帖子编号，请到账号主页核实。', { uncertain: true });
  }
  return { remoteId: body.data.id, url: `https://x.com/i/web/status/${body.data.id}` };
}

async function uploadLinkedIn(image, author, headers) {
  const bytes = await readImage(image, 'linkedin');
  const response = await request(
    'linkedin',
    'https://api.linkedin.com/rest/images?action=initializeUpload',
    jsonPost(headers, { initializeUploadRequest: { owner: author } }),
  );
  const { value } = (await jsonBody(response, 'linkedin')) ?? {};
  if (!/^urn:li:image:[\w-]+$/.test(value?.image ?? '')) throw failure('LinkedIn 未返回图片编号。');
  let destination;
  try {
    destination = new URL(value.uploadUrl);
  } catch {
    throw failure('LinkedIn 未返回上传地址。');
  }
  // The returned upload URL receives a member token. Restrict it to LinkedIn-owned hosts.
  if (
    destination.protocol !== 'https:' ||
    destination.username ||
    destination.password ||
    destination.port ||
    !/^(?:[\w-]+\.)*(?:linkedin\.com|licdn\.com)$/.test(destination.hostname)
  ) {
    throw failure('LinkedIn 返回了无法验证的上传地址。');
  }
  const uploaded = await request('linkedin', destination, {
    method: 'PUT',
    headers: { Authorization: headers.Authorization, 'Content-Type': image.mime },
    body: bytes,
  });
  if (uploaded.body) await uploaded.body.cancel().catch(() => {});
  return { id: value.image };
}

async function publishLinkedIn({ text, images }) {
  if (images.length > 20) throw failure('LinkedIn 每条帖子最多可附 20 张图片。');
  const { accessToken, author } = await getAccess('linkedin');
  if (!/^urn:li:person:[\w-]+$/.test(author ?? ''))
    throw failure('请重新连接 LinkedIn 个人账号，或设置有效的 LINKEDIN_AUTHOR_URN。');
  const version = process.env.LINKEDIN_API_VERSION || '202609';
  if (!/^20\d{2}(0[1-9]|1[0-2])$/.test(version)) throw failure('LINKEDIN_API_VERSION 需使用 YYYYMM 格式。');
  const headers = {
    ...bearer(accessToken),
    'Linkedin-Version': version,
    'X-Restli-Protocol-Version': '2.0.0',
  };
  const media = [];
  for (const image of images) media.push(await uploadLinkedIn(image, author, headers));
  // The Posts API interprets punctuation in its "little" text format. Preserve the user's literal copy.
  const commentary = text.replace(/[|{}@[\]()<>#\\*_~]/g, '\\$&');
  const payload = {
    author,
    commentary,
    visibility: 'PUBLIC',
    lifecycleState: 'PUBLISHED',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    isReshareDisabledByAuthor: false,
  };
  if (media.length === 1) payload.content = { media: media[0] };
  if (media.length > 1) payload.content = { multiImage: { images: media } };
  const response = await request(
    'linkedin',
    'https://api.linkedin.com/rest/posts',
    jsonPost(headers, payload),
    true,
  );
  const id = response.headers.get('x-restli-id');
  if (response.body) await response.body.cancel().catch(() => {});
  if (response.status !== 201 || !/^urn:li:(?:share|ugcPost):\d+$/.test(id ?? '')) {
    throw failure('LinkedIn 未返回有效帖子编号，请到账号主页核实。', { uncertain: true });
  }
  return { remoteId: id, url: `https://www.linkedin.com/feed/update/${id}/` };
}

export async function publishTarget({ platform, text = '', title = '', images = [], jobId }) {
  try {
    if (typeof text !== 'string' || !Array.isArray(images) || (!text.trim() && !images.length)) {
      throw failure('请填写文案或添加图片。');
    }
    const draft = { text, title, images, jobId };
    if (platform === 'x') return await publishX(draft);
    if (platform === 'linkedin') return await publishLinkedIn(draft);
    if (platform === 'xiaohongshu') return await publishXhs(draft);
    throw failure('所选平台不支持发布。');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES')
      throw failure('无法读取发布素材或渠道配置，请检查本地文件。');
    error.uncertain ??= false;
    error.retryable ??= false;
    throw error;
  }
}
