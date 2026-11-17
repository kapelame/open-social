import { api, escapeHtml as esc, glyph, heading, platformBadge, platforms } from './studio-ui.js';
import { renderOperations } from './studio-operations.js';
import { normalizeWebP } from './studio-media.js';

const draftKey = 'open-social.studio.draft.v1';
const selectedIds = new Set(platforms.map((platform) => platform.id));
const acceptedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const platformName = (id) => platforms.find((platform) => platform.id === id)?.name || '';
const mediaURL = (media) => '/media/' + encodeURIComponent(media.id);
const textValue = (value) => (typeof value === 'string' ? value : '');
const freshDraft = () => ({
  text: '',
  title: '',
  overrides: {},
  selected: ['x', 'xiaohongshu', 'linkedin'],
  media: [],
  mode: 'auto',
  pending: null,
});

function loadDraft() {
  try {
    const raw = JSON.parse(localStorage.getItem(draftKey));
    if (!raw || typeof raw !== 'object') return freshDraft();
    const draft = freshDraft();
    draft.text = textValue(raw.text);
    draft.title = textValue(raw.title);
    draft.mode = ['live', 'demo'].includes(raw.mode) ? raw.mode : 'auto';
    draft.selected = Array.isArray(raw.selected)
      ? [...new Set(raw.selected.filter((id) => selectedIds.has(id)))]
      : draft.selected;
    draft.overrides = Object.fromEntries(
      Object.entries(raw.overrides || {}).filter(
        ([id, value]) => selectedIds.has(id) && typeof value === 'string',
      ),
    );
    draft.media = Array.isArray(raw.media)
      ? raw.media
          .filter(
            (item) =>
              item && typeof item.id === 'string' && item.id.length < 200 && acceptedTypes.has(item.mime),
          )
          .map(({ id, name, mime }) => ({ id, name: textValue(name), mime }))
      : [];
    draft.pending =
      raw.pending && typeof raw.pending.key === 'string' && typeof raw.pending.id === 'string'
        ? raw.pending
        : null;
    return draft;
  } catch {
    return freshDraft();
  }
}

function storeDraft(draft) {
  try {
    localStorage.setItem(draftKey, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function seedStudioDraft({ text, title, append = true } = {}) {
  const draft = loadDraft();
  const seed = textValue(text).trim();
  if (seed) draft.text = append && draft.text.trim() ? draft.text.trimEnd() + '\n\n' + seed : seed;
  if (title && (!append || !draft.title)) draft.title = title;
  storeDraft(draft);
}

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

function renderComposer(container, ctx) {
  const draft = loadDraft();
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
        : 'demo';
  const content = (id) => (Object.hasOwn(draft.overrides, id) ? draft.overrides[id] : draft.text);
  const noteTitle = () => draft.title.trim() || suggestedTitle(content('xiaohongshu'));
  const selected = (id) => draft.selected.includes(id);
  const countText = (text) => Array.from(text).length;
  const showSave = () => {
    el('save').innerHTML =
      glyph(saved ? 'check' : 'alert', 14) + (saved ? '草稿已在本机保存' : '浏览器未能保存草稿');
  };
  const save = () => {
    saved = storeDraft(draft);
    submittingError = '';
    showSave();
  };

  function drawTargets() {
    el('destinations').innerHTML = platforms
      .map(
        ({
          id,
          name,
        }) => `<button type="button" data-destination="${id}" class="st-destination ${selected(id) ? 'is-selected' : ''}" aria-pressed="${selected(id)}">
      ${platformBadge(id)}<span class="st-destination-info"><strong>${name}</strong><small><i class="st-indicator ${isConnected(id) ? 'is-online' : ''}"></i>${fetchingChannels ? '检查中' : isConnected(id) ? '已连接' : channelError ? '状态未知' : '未连接'}</small></span><span class="st-selection">${selected(id) ? glyph('check', 11) : ''}</span></button>`,
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
      if (missing.length) return '请先连接' + missing.map(platformName).join('、') + '，或切换为本机演练。';
    }
    return '';
  }

  function drawSubmission() {
    const demo = actualMode() === 'demo';
    el('modes').innerHTML =
      `<button type="button" data-mode="demo" aria-pressed="${demo}" class="${demo ? 'active' : ''}">本机演练</button><button type="button" data-mode="live" aria-pressed="${!demo}" class="${demo ? '' : 'active'}">真实发布</button>`;
    el('hint').textContent = demo
      ? '在本机演练发布流程，内容仅保存在当前工作区。'
      : '所选渠道将收到这篇帖子，提交后可关闭此页面。';
    el('submit').disabled = busy || uploading || (fetchingChannels && draft.mode === 'auto');
    el('submit').innerHTML =
      glyph(demo ? 'activity' : 'send', 17) +
      (busy ? '正在提交…' : demo ? '提交演练' : '发布到所选平台') +
      `<span>${draft.selected.length} 个平台</span>`;
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

  async function updateLegacyImages() {
    if (!selected('xiaohongshu') && !selected('linkedin')) return;
    let convertedCount = 0;
    for (const [index, media] of draft.media.entries()) {
      if (media.mime !== 'image/webp') continue;
      const response = await fetch(mediaURL(media));
      if (!response.ok) throw new Error('草稿里的 WebP 图片无法读取，请重新添加。');
      const original = new File([await response.blob()], media.name || 'image.webp', { type: media.mime });
      const converted = await saveImage(original);
      if (!current()) return;
      draft.media[index] = converted.media;
      convertedCount++;
      el('upload-status').hidden = false;
      el('upload-status').textContent = `已将草稿中的 ${convertedCount} 张 WebP 转为跨平台配图。`;
      save();
      drawMedia();
      drawPreview();
    }
  }

  async function upload(files) {
    if (busy || uploading || !files.length) return;
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
        draft.media.push(prepared.media);
        if (file.type === 'image/webp') converted++;
        if (prepared.animated) animated = true;
        complete++;
        save();
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
      await updateLegacyImages();
      if (!current()) return;
      const payload = { mode, targets, mediaIds: draft.media.map((media) => media.id) };
      const key = JSON.stringify(payload);
      const requestId = draft.pending?.key === key ? draft.pending.id : crypto.randomUUID();
      draft.pending = { id: requestId, key };
      save();
      await api('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, requestId }),
      });
      // Preserve the text and images after a rehearsal so the same draft can go live.
      const latest = loadDraft();
      if (latest.pending?.id === requestId && JSON.stringify(latest) === JSON.stringify(draft)) {
        if (payload.mode === 'demo') {
          latest.pending = null;
          storeDraft(latest);
        } else storeDraft(freshDraft());
      }
      if (current()) {
        ctx.toast?.(payload.mode === 'demo' ? '演练已提交，草稿已保留' : '已加入发布队列');
        ctx.refreshShell?.();
        ctx.navigate('queue');
      }
    } catch (error) {
      if (current()) submittingError = error.message;
    } finally {
      busy = false;
      if (current()) {
        page.removeAttribute('inert');
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
      draft.selected = selected(id)
        ? draft.selected.filter((value) => value !== id)
        : [...draft.selected, id];
      save();
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
      draft.mode = button.dataset.mode;
      save();
      drawSubmission();
    } else if (button.hasAttribute('data-remove') && !uploading) {
      draft.media.splice(Number(button.dataset.remove), 1);
      save();
      drawMedia();
      drawPreview();
      drawSubmission();
    } else if (button.hasAttribute('data-revert') && editing !== 'shared') {
      delete draft.overrides[editing];
      save();
      drawEditor(true);
      drawPreview();
      drawSubmission();
    } else if (button.hasAttribute('data-submit')) {
      void submit();
    }
  });
  el('copy').addEventListener('input', (event) => {
    if (editing === 'shared') draft.text = event.target.value;
    else draft.overrides[editing] = event.target.value;
    save();
    drawEditor();
    drawPreview();
    drawSubmission();
  });
  el('title').addEventListener('input', (event) => {
    draft.title = event.target.value;
    save();
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
