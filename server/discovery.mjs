import { readFileSync } from 'node:fs';
import { nativeSearchUrl } from '../src/platform-web.js';

const DAY = 86_400_000;
const SAMPLE_LIMIT = 40;
const LABELS = {
  hn: 'Hacker News',
  github: 'GitHub',
  x: 'X',
  linkedin: 'LinkedIn',
  xiaohongshu: '小红书',
  bluesky: 'Bluesky',
};

function windowStart(asOf, days) {
  return new Date(Date.parse(asOf.toISOString().slice(0, 10)) - (days - 1) * DAY);
}

function publicUrl(value) {
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch {}
}

function endpoint(base, params) {
  const url = new URL(base);
  url.search = new URLSearchParams(params).toString();
  return url;
}

function count(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function firstLine(value) {
  const text = String(value ?? '')
    .trim()
    .replace(/\s+/gu, ' ');
  return text.length <= 140 ? text : text.slice(0, 139) + '…';
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'OpenSocial-Discovery/1.0', Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    const error = new Error('来源请求失败');
    error.httpStatus = response.status;
    throw error;
  }
  return response.json();
}

async function hackerNews({ topic, start, end, request }) {
  const data = await request(
    endpoint('https://hn.algolia.com/api/v1/search', {
      query: topic,
      tags: 'story',
      hitsPerPage: SAMPLE_LIMIT,
      numericFilters:
        'created_at_i>=' + start.getTime() / 1000 + ',created_at_i<=' + Math.floor(end.getTime() / 1000),
    }),
  );
  return data.hits
    .filter((row) => /^\d+$/.test(row.objectID) && row.title)
    .map((row) => ({
      id: 'hn-' + row.objectID,
      platform: 'hn',
      title: row.title,
      url: 'https://news.ycombinator.com/item?id=' + row.objectID,
      externalUrl: publicUrl(row.url),
      author: row.author,
      score: count(row.points),
      scoreLabel: 'points',
      publishedAt: row.created_at,
    }));
}

async function github({ topic, start, end, env, request }) {
  const phrase = topic.replaceAll('"', ' ').trim();
  const dates = start.toISOString().slice(0, 10) + '..' + end.toISOString().slice(0, 10);
  const url = endpoint('https://api.github.com/search/repositories', {
    q: '"' + phrase + '" in:name,description is:public created:' + dates,
    sort: 'stars',
    order: 'desc',
    per_page: SAMPLE_LIMIT,
  });
  const headers = env.GITHUB_TOKEN ? { Authorization: 'Bearer ' + env.GITHUB_TOKEN } : {};
  const data = await request(url, headers);
  const descriptions = new Set();
  const items = data.items.filter((row) => {
    if (!row.full_name || !publicUrl(row.html_url)) return false;
    // Mirror campaigns often create dozens of repositories with the same description.
    const description = row.description?.trim().toLowerCase();
    if (!description || description.length < 40) return true;
    if (descriptions.has(description)) return false;
    descriptions.add(description);
    return true;
  });
  return items.map((row) => ({
    id: 'github-' + row.id,
    platform: 'github',
    title: row.full_name,
    url: publicUrl(row.html_url),
    externalUrl: publicUrl(row.homepage),
    description: row.description || '',
    author: row.owner.login,
    score: count(row.stargazers_count),
    scoreLabel: 'stars',
    publishedAt: row.created_at,
  }));
}

async function x({ topic, start, days, env, request }) {
  if (!env.X_BEARER_TOKEN)
    throw new SourceCondition('unconfigured', '设置 X_BEARER_TOKEN 并开通 X 搜索权限后可查询。');
  if (days > 7) throw new SourceCondition('unsupported', 'X 近期搜索支持最近 7 天，请切换时间范围。');
  const query = '"' + topic.replaceAll('"', ' ').trim() + '" -is:retweet';
  const data = await request(
    endpoint('https://api.x.com/2/tweets/search/recent', {
      query,
      start_time: start.toISOString(),
      max_results: SAMPLE_LIMIT,
      sort_order: 'relevancy',
      'tweet.fields': 'created_at,public_metrics,author_id,entities',
      expansions: 'author_id',
      'user.fields': 'username',
    }),
    { Authorization: 'Bearer ' + env.X_BEARER_TOKEN },
  );
  if (!Array.isArray(data.data) && data.meta?.result_count !== 0) throw new Error('X 响应异常');
  const users = new Map((data.includes?.users || []).map((user) => [user.id, user.username]));
  return (data.data || []).map((row) => {
    const metrics = row.public_metrics || {};
    const author = users.get(row.author_id);
    const externalUrl = row.entities?.urls?.map((item) => publicUrl(item.expanded_url)).find(Boolean);
    return {
      id: 'x-' + row.id,
      platform: 'x',
      title: firstLine(row.text),
      description: row.text,
      url:
        'https://x.com/' +
        (author ? encodeURIComponent(author) : 'i') +
        '/status/' +
        encodeURIComponent(row.id),
      externalUrl,
      author: author || row.author_id,
      score:
        count(metrics.like_count) +
        count(metrics.retweet_count) +
        count(metrics.reply_count) +
        count(metrics.quote_count),
      scoreLabel: '互动',
      publishedAt: row.created_at,
    };
  });
}

async function bluesky({ topic, start, end, request }) {
  const data = await request(
    endpoint('https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts', {
      q: topic,
      sort: 'top',
      limit: SAMPLE_LIMIT,
      since: start.toISOString(),
      until: end.toISOString(),
    }),
  );
  return data.posts.map((row) => {
    const key = row.uri.split('/').at(-1);
    const profile = encodeURIComponent(row.author.did);
    return {
      id: 'bluesky-' + row.uri,
      platform: 'bluesky',
      title: firstLine(row.record.text),
      description: row.record.text,
      url: 'https://bsky.app/profile/' + profile + '/post/' + encodeURIComponent(key),
      externalUrl: publicUrl(row.embed?.external?.uri),
      author: row.author.handle,
      score: count(row.likeCount) + count(row.repostCount) + count(row.replyCount) + count(row.quoteCount),
      scoreLabel: '互动',
      publishedAt: row.record.createdAt,
    };
  });
}

async function xiaohongshu(args) {
  if (!args.env.XHS_BRIDGE_URL)
    throw new SourceCondition('unconfigured', '配置 XHS_BRIDGE_URL 并登录小红书桥接后可查询。');
  const { searchXhs } = await import('./xhs-search.mjs');
  return searchXhs(args);
}

const PROVIDERS = { hn: hackerNews, github, x, bluesky, xiaohongshu };

class SourceCondition extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function sourceError(id, error) {
  if (error instanceof SourceCondition)
    return { id, label: LABELS[id], status: error.code, message: error.message };
  const http = error.httpStatus ?? error.status;
  let message = '暂时无法连接来源，请稍后刷新。';
  if ([401, 402, 403].includes(http)) message = '来源拒绝了本次访问，请检查接口权限或配额。';
  if (http === 429) message = '来源请求次数已达上限，请稍后刷新。';
  if (id === 'xiaohongshu') message = '小红书桥接未能读取笔记，请检查服务与登录状态。';
  return { id, label: LABELS[id], status: 'unavailable', message };
}

function summarize({ topic, days, asOf, mode, sources, posts }) {
  const end = new Date(asOf);
  const start = windowStart(end, days);
  const series = Array.from({ length: days }, (_, i) => ({
    date: new Date(start.getTime() + i * DAY).toISOString().slice(0, 10),
    count: 0,
    byPlatform: {},
  }));
  const seen = new Set();
  const groups = new Map(sources.map((source) => [source.id, []]));
  for (const post of posts) {
    const timestamp = Date.parse(post.publishedAt);
    if (!Number.isFinite(timestamp) || timestamp < start || timestamp > end || seen.has(post.id)) continue;
    if (!groups.has(post.platform)) continue;
    seen.add(post.id);
    const day = series[Math.floor((timestamp - start.getTime()) / DAY)];
    day.count++;
    day.byPlatform[post.platform] = (day.byPlatform[post.platform] || 0) + 1;
    groups.get(post.platform).push(post);
  }

  // Stars, points and likes measure different actions. Interleave source-local ranks.
  const ranked = [...groups.values()];
  for (const group of ranked)
    group.sort((a, b) => b.score - a.score || Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const result = [];
  for (let i = 0; i < Math.max(0, ...ranked.map((group) => group.length)); i++) {
    for (const group of ranked) if (group[i]) result.push(group[i]);
  }
  const links = new Map();
  for (const post of result) {
    const url =
      publicUrl(post.externalUrl) || (post.platform === 'github' ? publicUrl(post.url) : undefined);
    if (!url || links.has(url)) continue;
    links.set(url, { title: post.title, domain: new URL(url).hostname.replace(/^www\./, ''), url });
  }
  const summary = sources.map((source) => ({ ...source, count: groups.get(source.id).length }));
  return {
    topic,
    days,
    asOf,
    mode,
    sources: summary,
    posts: result,
    series,
    links: [...links.values()],
    total: result.length,
  };
}

let fixture;
function snapshot(topic, days, ids, currentDay) {
  if (topic.toLowerCase() !== 'ai agents' || !ids.every((id) => id === 'hn' || id === 'github')) return;
  fixture ??= JSON.parse(readFileSync(new URL('./fixtures/ai-agents.json', import.meta.url), 'utf8'));
  const saved = fixture.windows[days];
  if (currentDay && saved.asOf.slice(0, 10) !== currentDay) return;
  return summarize({
    topic,
    days,
    asOf: saved.asOf,
    mode: 'snapshot',
    posts: saved.posts,
    sources: ids.map((id) => ({
      id,
      label: LABELS[id],
      status: 'snapshot',
      message: '已保存的公开数据样本',
    })),
  });
}

function badInput(message) {
  return Object.assign(new Error(message), { status: 400, statusCode: 400 });
}

export function createDiscoveryService({
  env = process.env,
  request = getJson,
  now = () => new Date(),
} = {}) {
  const cache = new Map();
  const running = new Map();
  function remember(key, value, until) {
    if (cache.size >= 96 && !cache.has(key)) cache.delete(cache.keys().next().value);
    cache.set(key, { value, until });
  }
  return async function discover({
    topic = 'AI Agents',
    days = 7,
    platform = 'all',
    refresh = false,
  } = {}) {
    if (typeof topic !== 'string' || !topic.trim() || Array.from(topic.trim()).length > 120)
      throw badInput('请输入 1 至 120 字的话题。');
    topic = topic.trim();
    days = Number(days);
    if (![7, 30].includes(days)) throw badInput('时间范围可选 7 天或 30 天。');
    const native =
      platform === 'x' || platform === 'linkedin' || (platform === 'xiaohongshu' && !env.XHS_BRIDGE_URL);
    if (native) {
      return {
        topic,
        days,
        mode: 'web',
        asOf: null,
        sources: [{ id: platform, label: LABELS[platform], status: 'web', count: 0 }],
        posts: [],
        links: [],
        series: [],
        total: 0,
        nativeSearchUrl: nativeSearchUrl(platform, topic),
        ...(platform === 'x' && env.X_BEARER_TOKEN ? { paidSearchAvailable: true } : {}),
      };
    }
    if (platform !== 'all' && platform !== 'x-api' && !Object.hasOwn(PROVIDERS, platform))
      throw badInput('此平台没有接入话题搜索。');
    // Only the explicit x-api request may contact X's metered search endpoint.
    const enabled = ['hn', 'github'];
    if (env.XHS_BRIDGE_URL) enabled.push('xiaohongshu');
    if (env.ENABLE_BLUESKY_SEARCH === 'true') enabled.push('bluesky');
    const ids = platform === 'all' ? enabled : [platform === 'x-api' ? 'x' : platform];
    const end = now();
    const key = JSON.stringify([topic.toLowerCase(), days, ids]);
    const cached = cache.get(key);
    if (!refresh && cached && cached.until > end.getTime()) return { ...cached.value, topic };
    if (!refresh && !cached) {
      const saved = snapshot(topic, days, ids, end.toISOString().slice(0, 10));
      if (saved) return saved;
    }
    if (running.has(key)) return running.get(key);
    const lookup = async () => {
      const args = { topic, days, start: windowStart(end, days), end, request, env };
      const responses = await Promise.allSettled(ids.map((id) => PROVIDERS[id](args)));
      const posts = [];
      const sources = ids.map((id, i) => {
        const response = responses[i];
        if (response.status === 'rejected') return sourceError(id, response.reason);
        posts.push(...response.value);
        if (id === 'xiaohongshu') {
          const ordering = days === 7 ? '高赞' : '最新';
          return {
            id,
            label: LABELS[id],
            status: 'ok',
            message: '抽取最多 6 篇' + ordering + '笔记，按实际发布日期筛选并按点赞数排序。',
          };
        }
        return { id, label: LABELS[id], status: 'ok' };
      });
      const good = sources.filter((source) => source.status === 'ok').length;
      const mode = good === sources.length ? 'live' : good === 0 ? 'unavailable' : 'partial';
      let value = summarize({ topic, days, mode, asOf: end.toISOString(), sources, posts });
      if (mode === 'unavailable') {
        const archiveIds = ids.filter((id) => id === 'hn' || id === 'github');
        const fallback =
          cached && cached.value.mode !== 'unavailable'
            ? cached.value
            : archiveIds.length && snapshot(topic, days, archiveIds);
        if (fallback) {
          const statuses = sources.map((source) => {
            const saved = fallback.sources.find((s) => s.id === source.id);
            if (!saved || !['ok', 'snapshot'].includes(saved.status)) return { ...source, count: 0 };
            return { ...saved, status: 'snapshot', refreshStatus: source.status, message: source.message };
          });
          value = { ...fallback, topic, mode: 'snapshot', sources: statuses };
        }
      }
      const until = end.getTime() + (mode === 'live' ? 300_000 : 30_000);
      remember(key, value, until);
      if (platform === 'all') {
        for (const source of sources.filter((s) => s.status === 'ok')) {
          const single = summarize({ ...value, mode: 'live', sources: [source] });
          remember(JSON.stringify([topic.toLowerCase(), days, [source.id]]), single, until);
        }
      }
      return value;
    };
    const work = lookup().finally(() => running.delete(key));
    running.set(key, work);
    return work;
  };
}

export const discover = createDiscoveryService();
