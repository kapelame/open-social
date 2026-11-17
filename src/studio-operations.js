import { browserMaterials, browserTarget, createBrowserActions } from './browser-publish.js';
import { platformComposerUrl, platformLoginUrl } from './platform-web.js';
import { api, escapeHtml, glyph, heading, platformBadge, platforms, safeHref } from './studio-ui.js';

const channelInfo = {
  x: {
    service: 'X API',
    site: 'x.com',
    webAction: '打开发帖页',
    summary: '从队列打开 X 时会带入文案。添加配图后即可在 X 发布。',
    config: ['X_CLIENT_ID', 'X_CLIENT_SECRET'],
    guide:
      '在 X 开发者控制台启用 OAuth 2.0 用户授权并允许读写，登记显示的回调地址，在「配置渠道」内填写 Client ID。机密客户端还需填写 Client Secret。',
    consoleUrl: 'https://console.x.com/',
    consoleLabel: 'X 开发者控制台',
  },
  xiaohongshu: {
    service: 'xiaohongshu-mcp',
    site: 'creator.xiaohongshu.com',
    webAction: '进入创作中心',
    summary: '在创作中心登录或扫码，选择图文笔记，添加准备好的图片、标题和正文。',
    config: ['XHS_BRIDGE_URL'],
    guide:
      '在本机启动 xiaohongshu-mcp，扫码登录本人账号。在「配置渠道」内检测本机连接器或填写服务地址。容器部署还需映射共享图片目录。',
    consoleUrl: 'https://github.com/xpzouying/xiaohongshu-mcp',
    consoleLabel: '连接器项目',
  },
  linkedin: {
    service: 'LinkedIn Posts API',
    site: 'linkedin.com',
    webAction: '打开动态页',
    summary: '在动态页选择「发起动态」，粘贴文案并添加配图。',
    config: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
    guide:
      '在 LinkedIn 应用中启用 Share on LinkedIn，和 Sign In with LinkedIn using OpenID Connect。网页应用需登记 HTTPS 回调，已获批原生 PKCE 的应用可使用本机回环地址。已有个人令牌的配置见完整文档。',
    consoleUrl: 'https://www.linkedin.com/developers/apps',
    consoleLabel: 'LinkedIn 开发者平台',
  },
};

const targetStates = {
  awaiting_user: ['待网页发布', 'warn'],
  user_confirmed: ['本人已确认', 'good'],
  queued: ['等待执行', ''],
  running: ['发布中', 'warn'],
  published: ['已发布', 'good'],
  demo: ['演练完成', 'good'],
  failed: ['发布失败', 'bad'],
  uncertain: ['结果待核实', 'warn'],
  blocked: ['等待连接', 'warn'],
};

const activeStates = new Set(['queued', 'running']);
const attentionStates = new Set(['uncertain', 'failed', 'blocked']);
const filters = { all: '全部记录', browser: '待网页发布', active: '进行中', attention: '需处理', done: '已完成' };

function statusChip(text, tone = '') {
  return `<span class="st-status ops-chip ${tone}"><i aria-hidden="true"></i>${escapeHtml(text)}</span>`;
}

function nameOf(id) {
  return platforms.find((platform) => platform.id === id)?.name || '未知渠道';
}

function channelCard(channel) {
  const { id, configured, connected, detail, connectable } = channel;
  const info = channelInfo[id];
  const name = nameOf(id);
  const status = connected ? '已连接' : configured ? '待连接' : '';
  const callback = safeHref(channel.redirectUri);
  const callbackMarkup = callback
    ? `<div class="ops-callback"><span>OAuth 回调地址</span><code>${escapeHtml(callback)}</code><button type="button" class="ops-secondary" data-copy="${escapeHtml(callback)}">${glyph('copy', 12)}复制地址</button></div>`
    : '';
  const oauth = id !== 'xiaohongshu' && connectable;
  const authorize = oauth && !connected
    ? `<a class="ops-direct-auth" href="/api/connect/${id}">${glyph('link', 14)}授权自动投递</a>`
    : '';
  return `<article class="st-card ops-channel">
    <div class="ops-channel-main">
      <div class="ops-channel-top">${platformBadge(id)}<span class="ops-service">${info.site}</span></div>
      <h2>${name}</h2><p class="ops-channel-summary">${info.summary}</p>
    </div>
    <div class="ops-channel-actions">
      <a class="st-btn st-btn-dark" href="${platformComposerUrl(id)}" target="_blank" rel="noopener noreferrer" aria-label="${name} · ${info.webAction}（新窗口）">${info.webAction}${glyph('external', 14)}</a>
      <a class="ops-secondary" href="${platformLoginUrl(id)}" target="_blank" rel="noopener noreferrer" aria-label="登录 ${name} 官网（新窗口）">官网登录</a>
    </div>
    ${authorize}
    <details class="ops-guide" id="ops-guide-${id}">
      <summary><span>自动投递设置${status ? ` · ${status}` : ''}</span>${glyph('chevron', 14)}</summary>
      <div class="ops-guide-body">
        <p><strong>${info.service}</strong></p><p>${info.guide}</p>
        ${detail ? `<p class="ops-connection-detail">${escapeHtml(detail)}</p>` : ''}
        <div class="ops-env">${info.config.map((key) => `<code>${key}</code>`).join('')}</div>${callbackMarkup}
        <div class="ops-advanced-actions">
          <button type="button" class="st-btn" data-setup="${id}">${glyph('plug', 14)}配置渠道</button>
          ${connected && oauth ? `<button class="ops-secondary" type="button" data-disconnect="${id}">断开授权</button>` : ''}
          <button class="ops-secondary" type="button" data-refresh>${glyph('refresh', 13)}刷新状态</button>
        </div>
        <a href="${info.consoleUrl}" target="_blank" rel="noopener noreferrer">${info.consoleLabel}${glyph('external', 13)}</a>
      </div>
    </details></article>`;
}

const setupFields = {
  x: [
    ['X_CLIENT_ID', 'Client ID', 'text'],
    ['X_CLIENT_SECRET', 'Client Secret（机密客户端）', 'password'],
    ['X_REDIRECT_URI', '自定义回调地址', 'url', true],
    ['X_ACCESS_TOKEN', '固定用户访问令牌', 'password', true],
    ['X_BEARER_TOKEN', '话题搜索 Bearer Token', 'password', true],
  ],
  linkedin: [
    ['LINKEDIN_CLIENT_ID', 'Client ID', 'text'],
    ['LINKEDIN_CLIENT_SECRET', 'Client Secret', 'password'],
    ['LINKEDIN_REDIRECT_URI', '授权回调地址（网页应用使用 HTTPS）', 'url'],
    ['LINKEDIN_NATIVE_PKCE', '原生 PKCE（需平台批准）', 'mode', true],
    ['LINKEDIN_ACCESS_TOKEN', '固定用户访问令牌', 'password', true],
    ['LINKEDIN_AUTHOR_URN', '作者 URN（固定令牌必填）', 'text', true],
  ],
  xiaohongshu: [
    ['XHS_BRIDGE_URL', '连接器服务地址', 'url'],
    ['XHS_BRIDGE_TOKEN', '连接器令牌', 'password', true],
    ['XHS_LOCAL_MEDIA_DIR', '本机共享图片目录', 'text', true],
    ['XHS_BRIDGE_MEDIA_DIR', '连接器中的图片目录', 'text', true],
  ],
};

const setupTips = {
  x: '开发者应用启用 OAuth 2.0 用户授权和读写权限后，填写 Client ID。固定用户令牌与话题搜索令牌可在更多选项中设置。',
  linkedin:
    '网页应用需登记可转发到本机的 HTTPS 回调地址。已获批原生 PKCE 的应用可在更多选项中启用回环授权。',
  xiaohongshu:
    '先启动自托管的 xiaohongshu-mcp，再检测本机服务或填写地址。容器环境可在更多选项中映射图片目录。',
};

function fieldMarkup([key, label, type], configured, locked) {
  const fixed = locked.includes(key);
  const exists = configured.includes(key);
  const id = `ops-field-${key}`;
  const state = fixed ? '环境变量管理' : exists ? '已设置' : '';
  const placeholder = exists ? '留空保留现有值' : key === 'XHS_BRIDGE_URL' ? 'http://127.0.0.1:18060' : '';
  const config = `id="${id}" name="${key}" ${fixed ? 'disabled' : ''}`;
  const edit =
    type === 'mode'
      ? `<select ${config}><option value="">保留当前设置</option><option value="1">启用原生 PKCE</option><option value="0">使用标准网页授权</option></select>`
      : `<input ${config} type="${type}" autocomplete="${type === 'password' ? 'new-password' : 'off'}" spellcheck="false" placeholder="${placeholder}">`;
  return `<div class="ops-field"><div><label for="${id}">${label}</label>${state ? `<span>${state}</span>` : ''}${exists && !fixed ? `<label class="ops-clear"><input type="checkbox" data-clear="${key}" aria-label="清除 ${label}">清除</label>` : ''}</div>${edit}</div>`;
}

function showSetup(root, channel, ctx, refresh) {
  const id = channel.id;
  const info = channelInfo[id];
  const dialog = document.createElement('dialog');
  dialog.className = 'ops-dialog';
  dialog.setAttribute('aria-labelledby', 'ops-setup-title');
  dialog.innerHTML = `<div class="ops-dialog-top"><div>${platformBadge(id)}<h2 id="ops-setup-title">配置 ${escapeHtml(nameOf(id))}</h2></div><button type="button" class="st-icon-btn" data-close aria-label="关闭渠道配置">${glyph('close', 16)}</button></div><div data-content><p class="st-muted">正在读取配置状态…</p></div>`;
  root.append(dialog);
  dialog.showModal();
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.addEventListener('click', (event) => {
    if (event.target.closest('[data-close]')) dialog.close();
  });
  const content = dialog.querySelector('[data-content]');
  const endpoint = `/api/settings/${id}`;
  const post = (url, values) =>
    api(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
  async function load() {
    try {
      const { configured, locked } = await api(endpoint);
      if (!dialog.isConnected) return;
      const isBridge = id === 'xiaohongshu';
      const fields = setupFields[id];
      const group = (advanced) =>
        fields
          .filter((field) => Boolean(field[3]) === advanced)
          .map((field) => fieldMarkup(field, configured, locked))
          .join('');
      const redirect = safeHref(channel.redirectUri);
      const callback = redirect
        ? `<div class="ops-callback"><span>当前授权回调地址</span><code>${escapeHtml(redirect)}</code><button type="button" class="ops-secondary" data-copy="${escapeHtml(redirect)}">${glyph('copy', 12)}复制地址</button></div>`
        : '';
      content.innerHTML = `<p class="ops-setup-tip">${setupTips[id]} <a href="${info.consoleUrl}" target="_blank" rel="noopener noreferrer">${info.consoleLabel}${glyph('external', 12)}</a></p>
        <form autocomplete="off"><fieldset>${isBridge ? `<button type="button" class="st-btn ops-probe" data-detect>${glyph('activity', 15)}检测本机连接器</button>` : ''}${group(false)}${callback}
        <details class="ops-advanced"><summary>更多选项</summary>${group(true)}${isBridge ? '<p>更换连接器地址时，需重新填入对应的连接器令牌。</p>' : ''}</details>
        <div class="ops-setup-feedback" role="status" aria-live="polite" hidden></div><div class="ops-qr" hidden></div>
        <div class="ops-dialog-actions"><button type="submit" class="st-btn st-btn-primary">保存配置</button>${isBridge ? '<button type="button" class="st-btn" data-qr>获取登录二维码</button>' : ''}<a class="st-inline-link" href="/docs/channels.md" target="_blank" rel="noopener noreferrer">配置文档${glyph('external', 12)}</a></div></fieldset></form>`;
      const form = content.querySelector('form');
      const fieldset = form.querySelector('fieldset');
      const feedback = form.querySelector('.ops-setup-feedback');
      const qr = form.querySelector('.ops-qr');
      function report(message, error = false) {
        feedback.textContent = message;
        feedback.hidden = false;
        feedback.classList.toggle('error', error);
      }
      function collect() {
        const values = {};
        for (const [key] of fields) {
          const input = form.elements.namedItem(key);
          if (!input.disabled && input.value.trim()) values[key] = input.value.trim();
        }
        return {
          values,
          clear: [...form.querySelectorAll('[data-clear]:checked')].map((el) => el.dataset.clear),
        };
      }
      async function busy(fn) {
        fieldset.disabled = true;
        try {
          await fn();
        } catch (err) {
          report(err.message || '操作失败，请重试。', true);
        } finally {
          fieldset.disabled = false;
        }
      }
      form.addEventListener('change', (event) => {
        const key = event.target.dataset.clear;
        if (key) {
          const field = form.elements.namedItem(key);
          field.disabled = event.target.checked;
          if (field.disabled) field.value = '';
        }
      });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const payload = collect();
        if (!Object.keys(payload.values).length && !payload.clear.length) {
          report('请填写要保存的字段或选择清除。');
          return;
        }
        for (const input of form.querySelectorAll('input[type="password"]')) input.value = '';
        busy(async () => {
          await post(endpoint, payload);
          await refresh();
          if (!dialog.isConnected) return;
          channel = root.channelList?.find((entry) => entry.id === id) || channel;
          if (isBridge) {
            await load();
            const savedNotice = content.querySelector('.ops-setup-feedback');
            if (savedNotice) {
              savedNotice.textContent = '配置已保存，可获取二维码或检查当前连接状态。';
              savedNotice.hidden = false;
            }
          } else {
            dialog.close();
            ctx.toast('配置已保存，渠道状态已刷新');
            root.querySelector(`a[href="/api/connect/${id}"]`)?.focus();
          }
        });
      });
      form.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (!button || fieldset.disabled) return;
        if (button.hasAttribute('data-detect'))
          busy(async () => {
            const result = await post(`${endpoint}/detect`, {});
            if (result.detected && result.url && !form.elements.XHS_BRIDGE_URL.disabled)
              form.elements.XHS_BRIDGE_URL.value = result.url;
            report(
              result.message ||
                (result.detected
                  ? '已检测到本机连接器，保存配置后继续。'
                  : '没有检测到默认连接器，请先启动服务。'),
              !result.detected,
            );
          });
        if (button.hasAttribute('data-qr')) {
          const changes = collect();
          if (Object.keys(changes.values).length || changes.clear.length) {
            report('请先保存本次修改，再获取登录二维码。');
            return;
          }
          if (!configured.includes('XHS_BRIDGE_URL')) {
            report('先检测本机连接器或填写服务地址，然后保存配置。');
            return;
          }
          qr.replaceChildren();
          qr.hidden = true;
          busy(async () => {
            const result = await post(`${endpoint}/qr`, {});
            report(result.message || (result.connected ? '账号已登录。' : '请使用小红书 App 扫码登录。'));
            if (result.connected) {
              await refresh();
              return;
            }
            if (
              typeof result.image !== 'string' ||
              !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(result.image)
            )
              return;
            const image = new Image();
            image.src = result.image;
            image.alt = '小红书登录二维码';
            const check = document.createElement('button');
            check.type = 'button';
            check.className = 'st-btn';
            check.textContent = '已扫码，检查状态';
            check.setAttribute('data-check-login', '');
            qr.append(image, check);
            qr.hidden = false;
          });
        }
        if (button.hasAttribute('data-check-login'))
          busy(async () => {
            await refresh();
            const updated = root.channelList?.find((entry) => entry.id === id);
            if (updated?.connected) {
              qr.replaceChildren();
              qr.hidden = true;
              report('账号已连接，可在编辑器中选择小红书。');
            } else report(updated?.detail || '等待扫码登录，请完成后再次检查。');
          });
      });
    } catch (err) {
      content.innerHTML = errorBox(err);
      content.querySelector('button').addEventListener('click', (event) => {
        event.stopPropagation();
        load();
      });
    }
  }
  load();
}

function groupFor(job) {
  if (job.targets.some((target) => target.status === 'awaiting_user')) return 'browser';
  if (job.targets.some((target) => attentionStates.has(target.status))) return 'attention';
  if (job.targets.some((target) => activeStates.has(target.status))) return 'active';
  return 'done';
}

function dateTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function externalLink(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return '';
  return safeHref(value);
}

function entryCard(job) {
  const title = job.targets.find((target) => target.title)?.title || job.targets[0]?.text || '图片帖子';
  const excerpt =
    String(title)
      .split('\n')
      .find((line) => line.trim()) || '图片帖子';
  const imageCount = Array.isArray(job.mediaIds) ? job.mediaIds.length : 0;
  const mode = job.mode === 'browser' ? ['网页发布', 'bp-mode'] : job.mode === 'demo' ? ['本地演练', 'ops-demo'] : ['自动投递', ''];
  return `<article class="st-card ops-job">
    <div class="ops-job-heading"><div class="ops-job-meta"><span class="ops-job-mode ${mode[1]}">${mode[0]}</span><time>${escapeHtml(dateTime(job.createdAt))}</time></div>
    <h2 title="${escapeHtml(excerpt)}">${escapeHtml(excerpt)}</h2><span class="ops-job-attachments">${escapeHtml(job.targets.length)} 个渠道${imageCount ? ` · ${imageCount} 张图片` : ''}</span></div>
    ${job.mode === 'browser' ? browserMaterials(job) : ''}
    <div class="ops-results">${job.targets
      .map((target) => {
        const [label, tone] = targetStates[target.status] || ['状态未知', 'warn'];
        if (job.mode === 'browser') return browserTarget(job, target, statusChip(label, tone));
        const url = target.status === 'published' ? externalLink(target.url) : '';
        let message = typeof target.message === 'string' ? target.message.trim() : '';
        if (target.status === 'uncertain' && !message) message = '请到平台核实是否送达，避免重复发布。';
        const retry = target.canRetry === true && ['failed', 'blocked'].includes(target.status);
        return `<div class="ops-result"><div class="ops-result-name">${platformBadge(target.platform)}<strong>${escapeHtml(nameOf(target.platform))}</strong></div>
      <div class="ops-result-details">${statusChip(label, tone)}${message ? `<small>${escapeHtml(message)}</small>` : ''}</div>
      <div class="ops-result-actions">${url && url !== '#' ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">查看帖子${glyph('external', 13)}</a>` : ''}${target.status === 'blocked' ? `<button type="button" class="ops-secondary" data-manage>管理连接</button>` : ''}
      ${retry ? `<button type="button" class="ops-secondary" data-retry="${escapeHtml(target.platform)}" data-job="${escapeHtml(job.id)}">${glyph('refresh', 13)}重试</button>` : ''}</div></div>`;
      })
      .join('')}</div></article>`;
}

function emptyState(title, text, actionLabel, attr) {
  return `<div class="st-card ops-empty"><div class="ops-empty-icon">${glyph('inbox', 29)}</div><h2>${title}</h2><p>${text}</p><button class="st-btn" type="button" ${attr}>${actionLabel}${glyph('arrow', 14)}</button></div>`;
}

function errorBox(error) {
  return `<div class="st-card ops-error" role="alert">${glyph('alert', 20)}<div><strong>暂时无法载入</strong><p>${escapeHtml(error?.message || '连接工作台后重试。')}</p></div><button type="button" class="st-btn" data-refresh>重试</button></div>`;
}

function renderChannels(root, ctx) {
  root.innerHTML = `${heading('渠道连接', '网页登录沿用当前浏览器的账号。请在平台官网查看登录状态。', `<button type="button" class="st-btn st-btn-primary" data-write>${glyph('plus', 16)}撰写帖子</button>`)}
    <div class="ops-channels-body"></div>`;
  const body = root.querySelector('.ops-channels-body');
  let version = 0;
  function draw(list, warning = '') {
    const openDetails = new Set([...body.querySelectorAll('details[open]')].map((el) => el.id));
    const byId = new Map(list.map((channel) => [channel.id, channel]));
    const cards = platforms.map(({ id }) => byId.get(id) || { id });
    root.channelList = cards;
    body.innerHTML = `<section aria-label="平台网站"><div class="ops-channel-grid">${cards.map(channelCard).join('')}</div></section>
      ${warning ? `<p role="status" class="ops-connection-detail">自动投递状态暂时无法读取。${escapeHtml(warning)} <button class="ops-secondary" type="button" data-refresh>重试</button></p>` : ''}
      <div class="ops-help"><div class="ops-help-icon">${glyph('queue', 21)}</div><div><h2>从队列完成网页发布</h2><p>在编辑器准备好各平台的图文。队列会保留每一份文案和配图，供你在对应网站发布并逐项确认。</p></div><a class="st-btn" href="#queue">查看发布队列${glyph('arrow', 14)}</a></div>`;
    for (const detail of body.querySelectorAll('details')) detail.open = openDetails.has(detail.id);
  }
  async function load() {
    const request = ++version;
    try {
      const { channels } = await api('/api/channels');
      if (request === version && root.isConnected) draw(channels);
    } catch (error) {
      if (request === version && root.isConnected) draw([], error.message);
    }
  }
  // Native website links work even while a configured background connector is offline.
  draw([]);
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-refresh')) return load();
    if (button.hasAttribute('data-write')) return ctx.navigate('compose');
    if (button.dataset.setup) {
      const channel = root.channelList?.find((entry) => entry.id === button.dataset.setup);
      if (channel) showSetup(root, channel, ctx, load);
      return;
    }
    if (button.dataset.copy) {
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
        ctx.toast('已复制回调地址');
      } catch {
        ctx.toast('可选中回调地址并复制');
      }
      return;
    }
    if (button.dataset.disconnect) {
      const id = button.dataset.disconnect;
      if (!confirm(`断开 ${nameOf(id)} 的授权连接？后续自动投递需重新授权。`)) return;
      button.disabled = true;
      try {
        await api(`/api/channels/${encodeURIComponent(id)}/disconnect`, { method: 'POST' });
        ctx.toast('连接状态已更新');
        await load();
      } catch (error) {
        ctx.toast(error.message);
      } finally {
        button.disabled = false;
      }
    }
  });
  return load();
}

function renderQueue(root, ctx) {
  root.innerHTML = `${heading('发布队列', '查看每个渠道的发布进度与结果。', `<button type="button" class="st-btn st-btn-primary" data-write>${glyph('plus', 16)}撰写帖子</button>`)}
  <div class="ops-queue-body"><p class="st-muted">正在载入发布记录…</p></div>`;
  const body = root.querySelector('.ops-queue-body');
  let selected = 'all';
  let jobs = [];
  const runBrowserAction = createBrowserActions(ctx.toast);
  let lastPayload = '';
  let revision = 0;
  let timer;
  let pending = false;
  function draw() {
    const shown = jobs.filter((job) => selected === 'all' || groupFor(job) === selected);
    const counts = { browser: 0, active: 0, attention: 0, done: 0, all: jobs.length };
    for (const job of jobs) counts[groupFor(job)] += 1;
    const chips = Object.entries(filters)
      .map(
        ([id, label]) =>
          `<button type="button" class="ops-filter ${selected === id ? 'selected' : ''}" aria-pressed="${selected === id}" data-filter="${id}">${label}<span>${counts[id]}</span></button>`,
      )
      .join('');
    const empty = jobs.length
      ? emptyState('这里还没有对应记录', '切换筛选可查看其他发布任务。', '查看全部', 'data-filter="all"')
      : emptyState(
          '还没有发布任务',
          '提交图文后，三个渠道的执行结果都会出现在这里。',
          '写第一条帖子',
          'data-write',
        );
    body.innerHTML = `<div class="ops-queue-tools"><div class="ops-filters" aria-label="发布状态筛选">${chips}</div><button type="button" class="st-icon-btn" data-refresh title="刷新发布记录" aria-label="刷新发布记录">${glyph('refresh', 16)}</button></div><div class="ops-job-list">${shown.length ? shown.map(entryCard).join('') : empty}</div>`;
  }
  async function load() {
    if (pending || !root.isConnected) return;
    clearTimeout(timer);
    pending = true;
    const requestedRevision = revision;
    let keepChecking = false;
    try {
      const response = await api('/api/jobs');
      if (!root.isConnected) return;
      if (requestedRevision !== revision) {
        keepChecking = true;
        return;
      }
      jobs = response.jobs;
      const payload = JSON.stringify(jobs);
      if (payload !== lastPayload) {
        draw();
        lastPayload = payload;
      }
      keepChecking = jobs.some((job) => job.targets.some((target) => activeStates.has(target.status)));
    } catch (error) {
      if (root.isConnected) body.innerHTML = errorBox(error);
      keepChecking = jobs.some((job) => job.targets.some((target) => activeStates.has(target.status)));
      lastPayload = '';
    } finally {
      pending = false;
      if (keepChecking && root.isConnected) timer = setTimeout(load, 2400);
    }
  }
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('button, a[data-browser-action]');
    if (!button) return;
    if (button.hasAttribute('data-write')) return ctx.navigate('compose');
    if (button.hasAttribute('data-refresh')) return load();
    if (button.hasAttribute('data-manage')) return ctx.navigate('channels');
    if (Object.hasOwn(filters, button.dataset.filter)) {
      selected = button.dataset.filter;
      draw();
      return;
    }
    if (button.dataset.browserAction) {
      event.preventDefault();
      const row = button.closest('[data-job-id]');
      const job = jobs.find(item => item.id === row?.dataset.jobId);
      if (job?.mode !== 'browser') return;
      const target = job.targets.find(item => item.platform === row.dataset.platformId);
      const updated = await runBrowserAction(button, job, target);
      if (updated?.id === job.id && root.isConnected) {
        revision++;
        const confirmed = updated.targets.find(item => item.platform === target.platform);
        jobs = jobs.map(item => item.id === updated.id ? {
          ...item, targets: item.targets.map(t => t.platform === target.platform ? confirmed : t),
        } : item);
        lastPayload = JSON.stringify(jobs);
        draw();
      }
      return;
    }
    if (button.dataset.retry) {
      button.disabled = true;
      try {
        await api(`/api/jobs/${encodeURIComponent(button.dataset.job)}/retry`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform: button.dataset.retry }),
        });
        ctx.toast('已提交渠道重试');
        await load();
      } catch (error) {
        ctx.toast(error.message);
      } finally {
        button.disabled = false;
      }
    }
  });
  return load();
}

export function renderOperations(view, container, ctx) {
  const root = document.createElement('div');
  root.className = 'st-page ops-page';
  container.replaceChildren(root);
  return view === 'channels' ? renderChannels(root, ctx) : renderQueue(root, ctx);
}
