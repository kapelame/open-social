import { api, escapeHtml as esc, glyph, heading, platformBadge, platforms } from './studio-ui.js';
import { renderOperations } from './studio-operations.js';
import { normalizeWebP } from './studio-media.js';

import { acceptedTypes, browserDraftStore, draftContent, draftKey } from './studio-draft.js';
export { seedStudioDraft } from './studio-draft.js';

const platformName = (id) => platforms.find((platform) => platform.id === id)?.name || '';
const mediaURL = (media) => '/media/' + encodeURIComponent(media.id);

const titleLimit = (text) =>
  Math.ceil(
    [...text].reduce(
      (length, character) => length + (character.charCodeAt(0) < 128 ? 0.5 : character.length),
      0,
    ),
  );

function suggestedTitle(text) {
  let title = '';
  for (const character of text.trim().split('\n')[0] || '') {
    if (titleLimit(title + character) > 20) break;
    title += character;
  }
  return title;
}

const deliveryModes = {
  browser: {
    label: '网页发布',
    hint: '在队列中打开平台网页，用当前浏览器账号确认发布。',
    icon: 'external',
    action: count => `准备 ${count} 个平台`,
    accepted: '图文已就绪，请到平台网页完成发布',
  },
  live: {
    label: '自动投递',
    hint: '后台将用已连接的发布渠道发送图文，提交后可关闭网页。',
    icon: 'send',
    action: count => `自动投递到 ${count} 个平台`,
    accepted: '已加入自动投递队列',
  },
  demo: {
    label: '本机演练',
    hint: '演练记录保存在本机，草稿可继续编辑。',
    icon: 'activity',
    action: count => `演练 ${count} 个平台`,
    accepted: '演练已提交，草稿已保留',
  },
};

function renderComposer(container, ctx) {
  const store = browserDraftStore();
  let draft = store.read();
  let writes = 0;
  let lastSave = Promise.resolve(true);
  let editing = 'shared';
  let preview = draft.selected[0] || 'x';
  let channels = [];
  let channelError = '';
  let fetchingChannels = true;
  let uploading = false;
  let busy = false;
  let submittingError = '';
  let saved = true;
  let countTimer;
  let countState = { text: null, length: null };

  container.innerHTML = `<div class="st-page st-compose">
    ${heading('创作工作台', '写下想法，为每个平台调整内容，一次提交。', '<span class="st-save-status" data-save role="status"></span>')}
    <div class="st-compose-grid">
      <div class="st-write-column">
        <section class="st-card st-destinations">
          <div class="st-card-head"><h2>发布到</h2><button class="st-inline-link" type="button" data-channels>管理渠道 ${glyph('arrow', 15)}</button></div>
          <div class="st-destination-list" data-destinations></div>
        </section>
        <section class="st-card st-editor">
          <div class="st-card-head"><h2>编辑文案</h2><span class="st-muted" data-counter></span></div>
          <div class="st-editor-tabs" data-edit-tabs aria-label="编辑平台版本"></div>
          <div data-title-section class="st-title-field" hidden>
            <label for="st-note-title">小红书标题 <span data-title-count></span></label>
            <input id="st-note-title" autocomplete="off" maxlength="160" data-title>
          </div>
          <label class="st-visually-hidden" for="st-caption">帖子正文</label>
          <textarea id="st-caption" data-copy rows="6" maxlength="60000" placeholder="有什么想分享的？写下你的正文或粘贴链接…"></textarea>
          <div class="st-editor-foot"><span class="st-muted" data-editor-help></span><button type="button" class="st-inline-link" data-revert hidden>恢复共用文案</button></div>
          <div class="st-attachments">
            <div class="st-media-label"><h3>图片</h3><span class="st-muted" data-media-count></span></div>
            <div class="st-media-strip" data-media></div>
            <label class="st-drop" data-drop><input class="st-file" data-file type="file" accept="image/jpeg,image/png,image/webp" multiple><span class="st-drop-icon">${glyph('upload', 20)}</span><span><strong>选择图片</strong> 或拖放到这里<small>JPG、PNG 或 WebP · 每张最多 5 MiB</small></span></label>
            <p data-upload-status class="st-muted" role="status" hidden></p>
          </div>
        </section>
      </div>
      <div class="st-read-column">
        <section class="st-card st-preview">
          <div class="st-card-head"><h2>平台预览</h2>${glyph('eye', 18)}</div>
          <div class="st-preview-picks" aria-label="选择预览平台" data-preview-tabs></div>
          <div class="st-preview-frame" data-preview></div>
        </section>
        <section class="st-card st-delivery">
          <div class="st-card-head"><h2>提交方式</h2>${glyph('send', 17)}</div>
          <div class="st-mode-picks" data-modes></div>
          <p class="st-mode-hint" data-hint></p>
          <div class="st-submit-error" role="alert" data-error hidden></div>
          <button type="button" data-submit class="st-btn st-btn-primary st-submit"></button>
        </section>
      </div>
    </div>
  </div>`;

  const page = container.querySelector('.st-compose');
  const el = (key) => page.querySelector('[data-' + key + ']');
  const current = () => page.isConnected;
  const isConnected = (id) => Boolean(channels.find((channel) => channel.id === id)?.connected);
  const actualMode = () =>
    draft.mode !== 'auto'
      ? draft.mode
      : draft.selected.length && draft.selected.every(isConnected)
        ? 'live'
        : 'browser';
  const content = (id) => (Object.hasOwn(draft.overrides, id) ? draft.overrides[id] : draft.text);
  const noteTitle = () => draft.title.trim() || suggestedTitle(content('xiaohongshu'));
  const selected = (id) => draft.selected.includes(id);
  const countText = (text) => Array.from(text).length;
  const showSave = () => {
    const [icon, message] = writes ? ['clock', '正在保存草稿']
      : saved ? ['check', '草稿已在本机保存'] : ['alert', '浏览器未能保存草稿'];
    el('save').innerHTML = glyph(icon, 14) + message;
  };
  function guardPendingSave(event) {
    event.preventDefault();
    event.returnValue = true;
  }
  function syncDraft() {
    if (writes || busy || !saved || !current()) return;
    const latest = store.read();
    const changed = draftContent(latest) !== draftContent(draft);
    draft = latest;
    if (changed) {
      drawTargets();
      drawEditor(true);
      drawMedia();
      drawPreview();
      drawSubmission();
    }
  }
  const syncStorage = event => {
    if (event.key === draftKey || event.key === null) syncDraft();
  };
  window.addEventListener('storage', syncStorage, { signal: ctx.signal });
  window.addEventListener('focus', syncDraft, { signal: ctx.signal });

  function edit(change, id = draft.id) {
    if (id !== draft.id) return Promise.resolve(false);
    change(draft);
    submittingError = '';
    writes++;
    if (writes === 1) {
      showSave();
      window.addEventListener('beforeunload', guardPendingSave, { signal: ctx.signal });
    }
    lastSave = store.edit(id, change).then(() => {
      saved = true;
      return true;
    }, error => {
      saved = error.name === 'DraftConflictError';
      submittingError = saved ? error.message : '浏览器未能保存草稿，请先保留当前文案。';
      return false;
    }).finally(() => {
      writes--;
      if (!writes) window.removeEventListener('beforeunload', guardPendingSave);
      if (current()) {
        showSave();
        syncDraft();
        if (submittingError) drawSubmission();
      }
    });
    return lastSave;
  }

  function drawTargets() {
    const mode = actualMode();
    const destinationStatus = (id) => {
      if (mode === 'browser') return '网页发布';
      if (mode === 'demo') return '本机演练';
      if (fetchingChannels) return '检查中';
      if (isConnected(id)) return '自动投递已连接';
      return channelError ? '连接状态未知' : '自动投递待连接';
    };
    el('destinations').innerHTML = platforms
      .map(
        ({
          id,
          name,
        }) => `<button type="button" data-destination="${id}" class="st-destination ${selected(id) ? 'is-selected' : ''}" aria-pressed="${selected(id)}">
      ${platformBadge(id)}<span class="st-destination-info"><strong>${name}</strong><small><i class="st-indicator ${mode === 'live' && isConnected(id) ? 'is-online' : ''}"></i>${destinationStatus(id)}</small></span><span class="st-selection">${selected(id) ? glyph('check', 11) : ''}</span></button>`,
      )
      .join('');
  }

  function drawEditor(changeValue = false) {
    const tabs = [{ id: 'shared', name: '共用文案' }, ...platforms.filter(({ id }) => selected(id))];
    if (!tabs.some((tab) => tab.id === editing)) {
      editing = 'shared';
      changeValue = true;
    }
    el('edit-tabs').innerHTML = tabs
      .map(
        ({ id, name }) =>
          `<button type="button" class="st-edit-tab ${editing === id ? 'active' : ''}" data-edit="${id}" aria-pressed="${editing === id}">${id === 'shared' ? glyph('layers', 14) : ''}${name}${id !== 'shared' && Object.hasOwn(draft.overrides, id) ? '<i class="st-overridden" title="已单独编辑"></i>' : ''}</button>`,
      )
      .join('');
    const text = editing === 'shared' ? draft.text : content(editing);
    if (changeValue) el('copy').value = text;
    drawCounter(text);
    el('editor-help').textContent =
      editing === 'shared'
        ? '默认用于所有所选平台'
        : editing === 'x'
          ? 'X 按平台规则计数，上限 280'
          : editing === 'linkedin'
            ? 'LinkedIn 正文上限 3,000 字符'
            : '小红书正文上限 1,000 字符';
    el('revert').hidden = editing === 'shared' || !Object.hasOwn(draft.overrides, editing);
    el('title-section').hidden = editing !== 'xiaohongshu';
    if (changeValue) el('title').value = draft.title;
    el('title').placeholder = suggestedTitle(content('xiaohongshu')) || '输入标题，或使用正文首行';
    el('title-count').textContent = titleLimit(noteTitle()) + ' / 20';
  }

  function drawCounter(text) {
    const counter = el('counter');
    const showsX =
      editing === 'x' || (editing === 'shared' && selected('x') && !Object.hasOwn(draft.overrides, 'x'));
    clearTimeout(countTimer);
    counter.classList.remove('st-limit-exceeded');
    if (!showsX) {
      counter.textContent = countText(text).toLocaleString() + ' 字符';
      return;
    }
    const showLength = (value) => {
      counter.textContent = 'X · ' + value + ' / 280';
      counter.classList.toggle('st-limit-exceeded', value > 280);
    };
    if (!text) {
      showLength(0);
      return;
    }
    if (countState.text === text) {
      showLength(countState.length);
      return;
    }
    counter.textContent = countText(text).toLocaleString() + ' 字符';
    countTimer = setTimeout(async () => {
      if (!current()) return;
      try {
        const result = await api('/api/count-x', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (
          current() &&
          el('copy').value === text &&
          (editing === 'x' ||
            (editing === 'shared' && selected('x') && !Object.hasOwn(draft.overrides, 'x')))
        ) {
          countState = { text, length: result.weightedLength };
          showLength(countState.length);
        }
      } catch {
        /* Local length remains visible. The queue validates before accepting a post. */
      }
    }, 220);
  }

  function drawMedia() {
    el('media-count').textContent = draft.media.length ? '已添加 ' + draft.media.length + ' 张' : '可多选';
    el('media').innerHTML = draft.media
      .map(
        (media, index) =>
          `<figure class="st-thumb"><img alt="${esc(media.name || '附件')}" src="${esc(mediaURL(media))}"><button type="button" aria-label="移除第 ${index + 1} 张图片" data-remove="${index}">${glyph('close', 13)}</button></figure>`,
      )
      .join('');
    el('media').hidden = !draft.media.length;
    el('file').disabled = uploading || busy;
    el('drop').classList.toggle('disabled', uploading || busy);
  }

  function drawPreview() {
    if (!selected(preview)) preview = draft.selected[0] || 'x';
    el('preview-tabs').innerHTML = platforms
      .filter(({ id }) => selected(id))
      .map(
        ({ id, name }) =>
          `<button type="button" class="st-preview-tab ${id === preview ? 'active' : ''}" data-preview-platform="${id}" aria-pressed="${id === preview}">${name}</button>`,
      )
      .join('');
    const frame = el('preview');
    if (!draft.selected.length) {
      frame.innerHTML = '<p class="st-preview-empty">选择一个发布平台以查看预览。</p>';
      return;
    }
    const text = content(preview).trim();
    const imageGrid = draft.media.length
      ? `<div class="st-preview-images ${draft.media.length > 1 ? 'many' : ''}">${draft.media
          .slice(0, 4)
          .map(
            (media, index) =>
              `<div><img src="${esc(mediaURL(media))}" alt="${esc(media.name || '配图')}">${index === 3 && draft.media.length > 4 ? `<b>+${draft.media.length - 4}</b>` : ''}</div>`,
          )
          .join('')}</div>`
      : '';
    const title = preview === 'xiaohongshu' && noteTitle() ? `<h3>${esc(noteTitle())}</h3>` : '';
    const body = `<div class="st-post-copy ${text ? '' : 'placeholder'}">${title}<p>${esc(text || '在左侧输入文案，即可预览帖子。')}</p></div>`;
    frame.innerHTML = `<article class="st-post is-${preview}"><div class="st-post-profile"><span class="st-profile-avatar">${glyph('edit', 18)}</span><span><strong>你的账号</strong><small>${platformName(preview)} · 帖子预览</small></span>${platformBadge(preview)}</div>${preview === 'xiaohongshu' ? imageGrid + body : body + imageGrid}</article>`;
  }

  function validation() {
    if (!draft.selected.length) return '请选择至少一个发布平台。';
    for (const id of draft.selected) {
      if (!content(id).trim()) return `请填写${platformName(id)}的正文，或在「共用文案」中写稿。`;
    }
    if (selected('xiaohongshu')) {
      if (!draft.media.length) return '小红书图文需要至少一张图片。';
      if (draft.media.length > 18) return '小红书单篇最多支持 18 张图片。';
      if (titleLimit(noteTitle()) > 20) return '请在小红书版本中将标题缩短至 20 个显示单位以内。';
      if (countText(content('xiaohongshu')) > 1000) return '小红书正文超过 1,000 字符，请单独调整文案。';
    }
    if (selected('linkedin') && countText(content('linkedin')) > 3000)
      return 'LinkedIn 正文超过 3,000 字符，请单独调整文案。';
    if (selected('linkedin') && draft.media.length > 20) return 'LinkedIn 单篇最多支持 20 张图片。';
    if (selected('x') && draft.media.length > 4) return 'X 单篇最多支持 4 张图片。';
    if (actualMode() === 'live') {
      if (fetchingChannels) return '正在检查渠道连接。';
      if (channelError) return '渠道状态读取失败。请前往「管理渠道」检查连接。';
      const missing = draft.selected.filter((id) => !isConnected(id));
      if (missing.length) return '请先连接' + missing.map(platformName).join('、') + '的自动投递，或切换为网页发布。';
    }
    return '';
  }

  function drawSubmission() {
    const mode = actualMode();
    const count = draft.selected.length;
    const option = deliveryModes[mode];
    el('modes').innerHTML = Object.entries(deliveryModes).map(([id, item]) =>
      `<button type="button" data-mode="${id}" aria-pressed="${mode === id}" class="${mode === id ? 'active' : ''}">${item.label}</button>`,
    ).join('');
    el('hint').textContent = option.hint;
    el('submit').disabled = busy || uploading || (fetchingChannels && draft.mode === 'auto');
    el('submit').innerHTML = glyph(option.icon, 17) + (busy ? '正在提交…' : option.action(count));
    el('error').hidden = !submittingError;
    el('error').textContent = submittingError;
  }

  async function saveImage(file) {
    const prepared = file.type === 'image/webp' ? await normalizeWebP(file) : { file };
    const image = prepared.file;
    const media = await api('/api/media', {
      method: 'POST',
      body: image,
      headers: { 'Content-Type': image.type, 'X-Filename': encodeURIComponent(image.name) },
    });
    return { media: { id: media.id, name: media.name, mime: media.mime }, animated: prepared.animated };
  }

  async function updateLegacyImages(snapshot) {
    if (!selected('xiaohongshu') && !selected('linkedin')) return;
    let convertedCount = 0;
    for (const [index, media] of snapshot.media.entries()) {
      if (media.mime !== 'image/webp') continue;
      const response = await fetch(mediaURL(media));
      if (!response.ok) throw new Error('草稿里的 WebP 图片无法读取，请重新添加。');
      const original = new File([await response.blob()], media.name || 'image.webp', { type: media.mime });
      const converted = await saveImage(original);
      if (!current()) return;
      await store.edit(snapshot.id, latest => {
        const index = latest.media.findIndex(image => image.id === media.id);
        if (index < 0) throw new Error('配图已在其他标签页更改，请检查草稿。');
        latest.media[index] = converted.media;
      });
      snapshot.media[index] = converted.media;
      convertedCount++;
      el('upload-status').hidden = false;
      el('upload-status').textContent = `已将草稿中的 ${convertedCount} 张 WebP 转为跨平台配图。`;
    }
  }

  async function upload(files) {
    if (busy || uploading || !files.length) return;
    const draftId = draft.id;
    uploading = true;
    submittingError = '';
    el('upload-status').hidden = false;
    let complete = 0;
    let converted = 0;
    let animated = false;
    try {
      if (files.length + draft.media.length > 20) throw new Error('每篇草稿最多添加 20 张图片。');
      for (const file of files) {
        if (!acceptedTypes.has(file.type)) throw new Error(file.name + ' 需要转换为 JPG、PNG 或 WebP。');
        if (file.size > 5 * 1024 * 1024) throw new Error(file.name + ' 超过单张 5 MiB 限制。');
      }
      drawMedia();
      drawSubmission();
      for (const file of files) {
        if (!current()) return;
        el('upload-status').textContent = `正在处理图片 ${complete + 1} / ${files.length}…`;
        const prepared = await saveImage(file);
        if (!current()) return;
        if (!await edit(latest => latest.media.push(prepared.media), draftId)) {
          throw new Error('草稿已更改或图片未能保存，请检查当前草稿。');
        }
        if (file.type === 'image/webp') converted++;
        if (prepared.animated) animated = true;
        complete++;
        drawPreview();
        drawMedia();
      }
    } catch (error) {
      if (current()) submittingError = error.message + (complete ? ` 已保存 ${complete} 张图片。` : '');
    } finally {
      uploading = false;
      if (current()) {
        el('file').value = '';
        el('upload-status').hidden = !converted;
        el('upload-status').textContent = converted
          ? `${converted} 张 WebP 已转为跨平台配图。${animated ? '动图使用首帧。' : ''}`
          : '';
        drawMedia();
        drawSubmission();
      }
    }
  }

  async function submit() {
    if (busy || uploading) return;
    submittingError = validation();
    if (submittingError) {
      drawSubmission();
      return;
    }
    const snapshot = structuredClone(draft);
    const mode = actualMode();
    const targets = platforms
      .filter(({ id }) => selected(id))
      .map(({ id }) => ({
        platform: id,
        text: content(id).trim(),
        ...(id === 'xiaohongshu' ? { title: noteTitle() } : {}),
      }));
    busy = true;
    drawSubmission();
    page.setAttribute('inert', '');
    try {
      if (!(await lastSave)) throw new Error('请先确认草稿已保存，再次提交。');
      await updateLegacyImages(snapshot);
      if (!current()) return;
      const payload = { mode, targets, mediaIds: snapshot.media.map((media) => media.id) };
      const { id: requestId, revision } = await store.reserve(snapshot, payload);
      snapshot.revision = revision;
      await api('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, requestId }),
      });
      await store.finish(snapshot, requestId, mode);
      if (current()) {
        ctx.toast?.(deliveryModes[payload.mode].accepted);
        ctx.refreshShell?.();
        ctx.navigate('queue');
      }
    } catch (error) {
      if (current()) submittingError = error.message;
    } finally {
      busy = false;
      if (current()) {
        page.removeAttribute('inert');
        syncDraft();
        drawSubmission();
        drawMedia();
      }
    }
  }

  page.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || busy) return;
    if (button.hasAttribute('data-channels')) return ctx.navigate('channels');
    if (button.dataset.destination) {
      const id = button.dataset.destination;
      const enable = !selected(id);
      edit(latest => {
        if (enable && !latest.selected.includes(id)) latest.selected.push(id);
        if (!enable) latest.selected = latest.selected.filter(value => value !== id);
      });
      drawTargets();
      drawEditor(true);
      drawPreview();
      drawSubmission();
    } else if (button.dataset.edit) {
      editing = button.dataset.edit;
      if (editing !== 'shared') preview = editing;
      drawEditor(true);
      drawPreview();
    } else if (button.dataset.previewPlatform) {
      preview = button.dataset.previewPlatform;
      drawPreview();
    } else if (button.dataset.mode) {
      const mode = button.dataset.mode;
      edit(latest => { latest.mode = mode; });
      drawTargets();
      drawSubmission();
    } else if (button.hasAttribute('data-remove') && !uploading) {
      const id = draft.media[Number(button.dataset.remove)]?.id;
      edit(latest => { latest.media = latest.media.filter(image => image.id !== id); });
      drawMedia();
      drawPreview();
      drawSubmission();
    } else if (button.hasAttribute('data-revert') && editing !== 'shared') {
      const platform = editing;
      edit(latest => { delete latest.overrides[platform]; });
      drawEditor(true);
      drawPreview();
      drawSubmission();
    } else if (button.hasAttribute('data-submit')) {
      void submit();
    }
  });
  el('copy').addEventListener('input', (event) => {
    const platform = editing;
    const value = event.target.value;
    edit(latest => {
      if (platform === 'shared') latest.text = value;
      else latest.overrides[platform] = value;
    });
    drawEditor();
    drawPreview();
    drawSubmission();
  });
  el('title').addEventListener('input', (event) => {
    const title = event.target.value;
    edit(latest => { latest.title = title; });
    drawEditor();
    drawPreview();
    drawSubmission();
  });
  el('file').addEventListener('change', (event) => void upload([...event.target.files]));
  for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
    el('drop').addEventListener(type, (event) => {
      event.preventDefault();
      el('drop').classList.toggle('dragging', type === 'dragenter' || type === 'dragover');
      if (type === 'drop') void upload([...event.dataTransfer.files]);
    });
  }
  showSave();
  drawTargets();
  drawEditor(true);
  drawMedia();
  drawPreview();
  drawSubmission();
  return api('/api/channels')
    .then((data) => {
      channels = Array.isArray(data.channels) ? data.channels : [];
    })
    .catch((error) => {
      channelError = error.message;
    })
    .finally(() => {
      fetchingChannels = false;
      if (current()) {
        drawTargets();
        drawSubmission();
      }
    });
}

export function renderStudio(view, container, context) {
  if (view === 'compose') return renderComposer(container, context);
  return renderOperations(view, container, context);
}
