import { icons } from './icons.js';
import { escapeHtml, safeHref } from './studio-ui.js';

export const radarState = { topic: 'AI Agents', days: 7, platform: 'all', sort: 'popular', limit: 5 };

const platformNames = {
  all: '全部平台',
  hn: 'Hacker News',
  github: 'GitHub',
  x: 'X',
  xiaohongshu: '小红书',
  bluesky: 'Bluesky',
};
const commonPlatforms = ['all', 'hn', 'github'];
const extraPlatforms = ['x', 'xiaohongshu', 'bluesky'];
const modes = {
  snapshot: '已保存快照',
  live: '实时采集',
  partial: '部分来源可用',
  unavailable: '来源暂不可用',
};
const sampleNote =
  '曲线按 UTC 日期统计检索到的帖子和新建仓库。HN、GitHub、X 和 Bluesky 每次各取最多 40 条，小红书抽取最多 6 篇笔记。HN 按积分、GitHub 按累计星标、社交平台按互动数排序。综合榜交替展示各来源。';
const emptyResult = { posts: [], sources: [], links: [], series: [], total: 0, mode: '', asOf: '' };

export function selectTopic(topic) {
  radarState.topic = topic;
  radarState.platform = 'all';
  radarState.limit = 5;
}

function sourceMark(id) {
  if (id === 'github') return icons('github', 13);
  const mark = { hn: 'Y', x: '𝕏', xiaohongshu: '红', bluesky: 'B' };
  return mark[id] || icons('globe', 13);
}

function isoDay(date) {
  return /^\d{4}-\d\d-\d\d/.exec(date || '')?.[0] || '';
}

function shortDate(date) {
  return isoDay(date).slice(5).replace('-', '/') || '—';
}

function trendChart(series) {
  if (!series.some((day) => day.count > 0))
    return '<div class="chart-empty">当前筛选暂无可绘制的样本</div>';

  const left = 3,
    right = 330,
    top = 7,
    bottom = 67;
  const max = Math.max(2, Math.ceil(Math.max(...series.map((day) => day.count)) / 2) * 2);
  const points = series.map((day, index) => ({
    x: left + (index * (right - left)) / Math.max(1, series.length - 1),
    y: bottom - (day.count / max) * (bottom - top),
    date: day.date,
    count: Number(day.count),
  }));

  let path = `M${points[0].x},${points[0].y}`;
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1],
      next = points[index];
    const middle = (previous.x + next.x) / 2;
    path += ` C${middle},${previous.y} ${middle},${next.y} ${next.x},${next.y}`;
  }
  const grid = [0, 0.5, 1]
    .map((fraction) => {
      const y = bottom - (bottom - top) * fraction;
      return `<line x1="${left}" x2="${right}" y1="${y}" y2="${y}" stroke="#dce0d7" stroke-dasharray="3 4"/>
      <text x="359" y="${y + 3}" text-anchor="end">${max * fraction}</text>`;
    })
    .join('');
  const dots = points
    .map(
      (point) => `<circle cx="${point.x}" cy="${point.y}" r="${points.length > 7 ? 2 : 3.4}"
      fill="#fff" stroke="#f15b35" stroke-width="1.8"><title>${escapeHtml(point.date)} · ${point.count} 条</title></circle>`,
    )
    .join('');
  const description = points.map((point) => `${point.date} ${point.count} 条`).join('，');
  const ticks = [points[0], points[Math.floor((points.length - 1) / 2)], points.at(-1)];
  return `<svg class="trend-chart" viewBox="0 0 360 72" preserveAspectRatio="none" role="img"
      aria-label="每天收录样本数：${escapeHtml(description)}">
    <defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fb7b4f" stop-opacity=".30"/>
      <stop offset="100%" stop-color="#fb7b4f" stop-opacity=".04"/>
    </linearGradient></defs>
    ${grid}
    <path d="${path} L${right},${bottom} L${left},${bottom} Z" fill="url(#area)"/>
    <path d="${path}" fill="none" stroke="#f15b35" stroke-width="2.4" vector-effect="non-scaling-stroke"/>
    ${dots}
  </svg>
  <div class="chart-axis">${ticks.map((point) => `<span>${shortDate(point.date)}</span>`).join('')}</div>`;
}

function overview(result, counts, loading, pinned) {
  const { topic, days } = radarState;
  const date = isoDay(result.asOf);
  const stale = result.mode === 'snapshot' && date && date < isoDay(new Date().toISOString());
  const period = stale ? `截至 ${date} · ${days} 天` : `近 ${days} 天`;
  const label = loading ? '正在获取…' : modes[result.mode] || '采集中';
  const periods = [7, 30]
    .map(
      (value) => `<button type="button" data-days="${value}"
      aria-pressed="${value === days}">${value} 天</button>`,
    )
    .join('');
  return `<div class="radar-grid radar-overview">
    <section class="topic-cover" aria-label="当前话题"><div class="cover-interior">
      <div class="cover-eyebrow"><i></i>TOPIC IN FOCUS</div>
      <h2>${escapeHtml(topic)}</h2>
      <div class="cover-sub"><span>${icons('layers', 13)}${loading ? '…' : counts.length} 个来源</span><i></i><span>${period}</span></div>
      <div class="cover-controls">
        <button type="button" id="draft-topic">${icons('compose', 14)}以此创作</button>
        <button type="button" id="follow-topic" aria-pressed="${pinned}">${icons(pinned ? 'check' : 'plus', 14)}${pinned ? '已关注' : '关注话题'}</button>
      </div>
    </div></section>
    <section class="chart-panel panel">
      <div class="panel-header"><h2>${icons('activity', 18)}讨论热度</h2><div class="period-switch">${periods}</div></div>
      <div class="chart-total"><strong>${loading ? '—' : Number(result.total).toLocaleString()}</strong><span>条收录样本</span></div>
      <div class="chart-plot">${trendChart(result.series)}</div>
      <div class="chart-status"><span><i class="mode-dot ${escapeHtml(result.mode)}"></i>${escapeHtml(label)}${date ? ` · ${date}` : ''}</span>
        <button type="button" id="refresh" ${loading ? 'disabled' : ''}>${icons('refresh', 12)}刷新</button>
      </div>
    </section>
  </div>`;
}

function postRow(post, index) {
  const href = escapeHtml(safeHref(post.url));
  const title = escapeHtml(post.title);
  const metric = escapeHtml(
    { points: '积分', stars: '星标', likes: '赞' }[post.scoreLabel] || post.scoreLabel || '互动',
  );
  return `<div class="post-row">
    <span class="row-rank">${String(index + 1).padStart(2, '0')}</span>
    <div class="post-main">
      <div class="post-meta">
        <span class="source-tag ${escapeHtml(post.platform)}"><i>${sourceMark(post.platform)}</i>${escapeHtml(platformNames[post.platform] || post.platform)}</span>
        <span class="meta-dot">·</span><span>${escapeHtml(post.author)}</span><span class="meta-dot">·</span><time>${shortDate(post.publishedAt)}</time>
      </div>
      <a class="post-title" href="${href}" rel="noopener noreferrer" target="_blank">${title}</a>
      <div class="post-foot">
        <span class="post-score" title="${metric}">${icons(post.platform === 'github' ? 'star' : 'chart', 13)}${Number(post.score || 0).toLocaleString()} ${metric}</span>
        <button class="write-from" data-pick="${index}" type="button" title="将这条内容引用到草稿">${icons('edit', 12)}引用创作</button>
      </div>
    </div>
    <a class="out-link" href="${href}" aria-label="打开原文：${title}" rel="noopener noreferrer" target="_blank">${icons('external', 15)}</a>
  </div>`;
}

function emptyPosts(mode, loading) {
  let title = '这个时间段没有匹配的内容',
    help = '试试其他关键词，或查看近 30 天的结果。';
  if (loading) {
    title = '正在检索话题…';
    help = '正在读取来源数据';
  } else if (mode === 'unavailable') {
    title = '当前来源暂不可用';
    help = '可切换到其他来源，或在配置后刷新。';
  }
  return `<div class="empty-list"><span>${icons('radar', 24)}</span><b>${title}</b><p>${help}</p></div>`;
}

function sourceNotice(sources) {
  const messages = sources
    .filter((source) => {
      if (source.status === 'snapshot')
        return source.refreshStatus || (source.message && source.message !== '已保存的公开数据样本');
      return source.status !== 'ok';
    })
    .map((source) => `${source.label} · ${source.message || '暂时无法连接'}`);
  return messages.length
    ? `<div class="source-notice">${icons('info', 14)}<span>${escapeHtml(messages.join('；'))}</span></div>`
    : '';
}

function feed(result, posts, loading) {
  const { sort, platform, limit } = radarState;
  const tabs = commonPlatforms
    .map((id) => {
      const mark = id === 'all' ? icons('layers', 13) : `<i class="filter-ic ${id}">${sourceMark(id)}</i>`;
      return `<button type="button" data-platform="${id}" class="filter-tab" aria-pressed="${platform === id}">${mark}${platformNames[id]}</button>`;
    })
    .join('');
  const options = extraPlatforms
    .map((id) => `<option value="${id}" ${platform === id ? 'selected' : ''}>${platformNames[id]}</option>`)
    .join('');
  const hasExtra = extraPlatforms.includes(platform);
  const more =
    posts.length > limit
      ? `<button type="button" class="more-button" id="more-posts">查看更多内容 ${icons('chevron', 14)}</button>`
      : '';
  return `<section class="feed-panel panel">
    <div class="panel-header">
      <h2><span class="section-glyph">${icons('chart', 17)}</span>热门内容</h2>
      <label class="sort-control">${icons('filter', 14)}
        <select aria-label="内容排序"><option value="popular">按热度</option><option value="new" ${sort === 'new' ? 'selected' : ''}>按时间</option></select>
        ${icons('chevron', 11)}</label>
    </div>
    <div class="filters" aria-label="筛选来源">${tabs}
      <label class="more-filter ${hasExtra ? 'chosen' : ''}"><select aria-label="更多来源">
        <option value="" ${hasExtra ? '' : 'selected'}>更多来源</option>${options}
      </select>${icons('chevron', 11)}</label>
    </div>
    ${sourceNotice(result.sources)}
    <div class="post-list">${posts.length ? posts.slice(0, limit).map(postRow).join('') : emptyPosts(result.mode, loading)}</div>
    ${more}
  </section>`;
}

function referenceRow(link, index) {
  const domain = String(link.domain || '').replace(/^www\./, '');
  const initial =
    domain
      .split('.')[0]
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 1)
      .toUpperCase() || '↗';
  return `<a class="reference-link" href="${escapeHtml(safeHref(link.url))}" rel="noopener noreferrer" target="_blank">
    <span class="domain-avatar tone-${index % 4}">${initial}</span>
    <span class="ref-text"><strong>${escapeHtml(link.title)}</strong><small>${escapeHtml(domain)}</small></span>
    ${icons('external', 13)}
  </a>`;
}

function references(result, counts, allLinks) {
  const { links, total } = result;
  const entries = (allLinks ? links : links.slice(0, 3)).map(referenceRow).join('');
  const toggle =
    links.length > 3
      ? `<button type="button" class="more-button" id="more-links">
    ${allLinks ? '收起链接' : '查看全部链接'} ${icons(allLinks ? 'chevron' : 'arrow', 14)}</button>`
      : '';
  const sourceRows = counts
    .map(
      (source) => `<div class="source-stat"><span>${escapeHtml(source.label)}</span>
    <span class="meter"><i data-ratio="${total ? source.count / total : 0}"></i></span><b>${Number(source.count)}</b></div>`,
    )
    .join('');
  const search = new URL('https://www.linkedin.com/search/results/content/');
  search.searchParams.set('keywords', radarState.topic);
  return `<aside class="radar-rail">
    <section class="reference-panel panel">
      <div class="panel-header"><h2><span class="section-glyph">${icons('link', 16)}</span>相关链接</h2><span class="small-count">${links.length}</span></div>
      <div class="reference-list">${entries || '<p class="no-links">匹配的原文链接会显示在这里。</p>'}</div>${toggle}
    </section>
    <section class="source-panel panel">
      <div class="panel-header"><h2>${icons('layers', 17)}来源分布</h2><span class="sub-unit">条</span></div>
      ${sourceRows || '<p class="no-links">暂无来源样本</p>'}
      <details class="method"><summary>热度如何计算？</summary><p>${sampleNote}</p></details>
    </section>
    <a class="external-search" target="_blank" rel="noopener noreferrer" href="${escapeHtml(search.href)}">在 LinkedIn 搜索此话题 ${icons('external', 14)}</a>
  </aside>`;
}

export function renderRadar(container, ctx) {
  let result = emptyResult,
    generation = 0,
    allLinks = false,
    loading = false;
  container.className = 'radar-view';
  container.innerHTML = `<div class="radar-heading">
    <div><h1>话题雷达<span class="heading-dot">.</span></h1><p>发现热门讨论，追踪话题在各平台的热度。</p></div>
    <form class="topic-form" role="search">${icons('search', 18)}
      <input type="search" id="topic-input" aria-label="搜索话题" placeholder="搜索任意话题…" maxlength="120" required autocomplete="off">
      <kbd>⌘ K</kbd><button type="submit" aria-label="搜索">${icons('arrow', 16)}</button>
    </form></div>
    <div id="radar-results" aria-live="polite"></div>`;
  const out = container.querySelector('#radar-results');
  const input = container.querySelector('#topic-input');
  container.querySelector('form').onsubmit = (event) => {
    event.preventDefault();
    const topic = input.value.trim();
    if (!topic) {
      input.focus();
      return;
    }
    selectTopic(topic);
    input.value = '';
    ctx.refreshShell();
    load();
  };

  function switchPlatform(id) {
    if (radarState.platform === id) return;
    radarState.platform = id;
    radarState.limit = 5;
    load();
  }

  function render() {
    if (!container.isConnected) return;
    const posts = [...result.posts];
    if (radarState.sort === 'new') posts.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    const counts = result.sources.filter((source) => source.count > 0);
    out.innerHTML = `${overview(result, counts, loading, ctx.isFollowed(radarState.topic))}
      <div class="radar-grid radar-body">${feed(result, posts, loading)}${references(result, counts, allLinks)}</div>`;

    for (const meter of out.querySelectorAll('[data-ratio]'))
      meter.style.width = `${Number(meter.dataset.ratio) * 100}%`;
    out.querySelector('#follow-topic').onclick = () => {
      ctx.toggleFollow(radarState.topic);
      render();
    };
    out.querySelector('#draft-topic').onclick = () => ctx.composeFrom(radarState.topic);
    out.querySelector('#refresh').onclick = () => load(true);
    for (const button of out.querySelectorAll('[data-days]')) {
      button.onclick = () => {
        const days = Number(button.dataset.days);
        if (radarState.days === days) return;
        radarState.days = days;
        radarState.limit = 5;
        load();
      };
    }
    for (const button of out.querySelectorAll('[data-platform]'))
      button.onclick = () => switchPlatform(button.dataset.platform);
    out.querySelector('.more-filter select').onchange = (event) =>
      switchPlatform(event.target.value || 'all');
    out.querySelector('.sort-control select').onchange = (event) => {
      radarState.sort = event.target.value;
      render();
    };
    for (const button of out.querySelectorAll('[data-pick]')) {
      button.onclick = () => {
        const post = posts[Number(button.dataset.pick)];
        ctx.composeFrom(`${post.title}\n${post.url}`);
      };
    }
    const more = out.querySelector('#more-posts'),
      links = out.querySelector('#more-links');
    if (more)
      more.onclick = () => {
        radarState.limit += 8;
        render();
      };
    if (links)
      links.onclick = () => {
        allLinks = !allLinks;
        render();
      };
  }

  async function load(refresh = false) {
    const revision = ++generation;
    loading = true;
    result = emptyResult;
    allLinks = false;
    render();
    const params = new URLSearchParams({
      topic: radarState.topic,
      days: String(radarState.days),
      platform: radarState.platform,
    });
    if (refresh) params.set('refresh', '1');
    let next;
    try {
      const response = await fetch(`/api/discover?${params}`);
      if (!response.ok) throw new Error(`话题服务返回 ${response.status}`);
      next = await response.json();
    } catch {
      next = {
        ...emptyResult,
        mode: 'unavailable',
        sources: [{ label: '话题服务', status: 'unavailable', message: '未能读取数据，请稍后重试。' }],
      };
    }
    if (revision !== generation || !container.isConnected) return;
    result = next;
    loading = false;
    render();
  }
  load();
}
