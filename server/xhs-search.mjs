import { xhsBridgeRequest } from './xiaohongshu.mjs';

const SAMPLE_SIZE = 6;
const WEEK = 7 * 86400_000;

function likesOf(value) {
  const match = String(value ?? '')
    .trim()
    .replaceAll(',', '')
    .match(/^(\d+(?:\.\d+)?)\s*([万千亿]?)\+?$/u);
  if (!match) return null;
  const units = { '': 1, 千: 1000, 万: 10000, 亿: 100000000 };
  return Math.round(Number(match[1]) * units[match[2]]);
}

async function requestData(bridgeRequest, path, body) {
  const { response, json } = await bridgeRequest(path, { method: 'POST', body, timeoutMs: 30000 });
  if (!response.ok || json?.success !== true || !json.data) {
    throw new Error(`小红书桥接服务读取失败（HTTP ${response.status}），请确认服务在线并已登录。`);
  }
  return json.data;
}

async function readNote(bridgeRequest, feed, start, end) {
  const data = await requestData(bridgeRequest, '/api/v1/feeds/detail', {
    feed_id: feed.id,
    xsec_token: feed.xsecToken,
    load_all_comments: false,
  });
  const note = data.data?.note;
  const time = note?.time;
  if (!Number.isSafeInteger(time) || time <= 0 || (note.noteId && note.noteId !== feed.id)) {
    throw new Error('小红书桥接服务未返回笔记的有效发布时间。');
  }
  if (time < start.getTime() || time > end.getTime()) return null;

  const card = feed.noteCard;
  const url = new URL(`https://www.xiaohongshu.com/explore/${encodeURIComponent(feed.id)}`);
  url.searchParams.set('xsec_token', feed.xsecToken);
  url.searchParams.set('xsec_source', 'pc_search');
  const likes = likesOf(note.interactInfo?.likedCount ?? card.interactInfo?.likedCount);
  const desc = String(note.desc ?? '').trim();
  return {
    id: `xiaohongshu:${feed.id}`,
    platform: 'xiaohongshu',
    url: url.href,
    title: String(note.title || card.displayTitle || desc.slice(0, 80) || '小红书笔记'),
    description: desc.slice(0, 260),
    author: String(note.user?.nickname || card.user?.nickname || card.user?.nickName || ''),
    score: likes ?? 0,
    scoreLabel: likes === null ? '点赞数未公开' : '点赞',
    publishedAt: new Date(time).toISOString(),
  };
}

/** The bridge only supplies a publication timestamp in the individual note details. */
export async function searchXhs({ topic, start, end, bridgeRequest = xhsBridgeRequest }) {
  // The bridge has no monthly filter. For 30 days, sample its newest candidates
  // before checking exact dates so older, highly liked notes cannot fill the sample.
  const filters =
    end - start <= WEEK
      ? { sort_by: '最多点赞', publish_time: '一周内' }
      : { sort_by: '最新', publish_time: '半年内' };
  const data = await requestData(bridgeRequest, '/api/v1/feeds/search', {
    keyword: topic,
    filters,
  });
  if (!Array.isArray(data.feeds)) throw new Error('小红书桥接服务返回的搜索结果格式有误。');
  const unique = new Map();
  for (const feed of data.feeds) {
    if (feed?.modelType !== 'note' || !feed.id || !feed.noteCard) continue;
    if (typeof feed.xsecToken !== 'string' || !feed.xsecToken) {
      throw new Error('小红书搜索结果缺少详情访问凭据，请重新登录桥接服务。');
    }
    if (!unique.has(feed.id)) unique.set(feed.id, feed);
    if (unique.size >= SAMPLE_SIZE) break;
  }

  const posts = [];
  const samples = [...unique.values()];
  // Each detail request opens a browser page on the configured local bridge.
  for (let index = 0; index < samples.length; index += 2) {
    const batch = await Promise.all(
      samples.slice(index, index + 2).map((feed) => readNote(bridgeRequest, feed, start, end)),
    );
    posts.push(...batch.filter(Boolean));
  }
  return posts.sort((a, b) => b.score - a.score || b.publishedAt.localeCompare(a.publishedAt));
}
