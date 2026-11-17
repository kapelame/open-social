import { api, escapeHtml, glyph, platformBadge, platforms } from './studio-ui.js';
import { platformComposerUrl } from './platform-web.js';

const mediaUrl = (id) => '/media/' + encodeURIComponent(id);

function canCopyImage() {
  return typeof navigator.clipboard?.write === 'function' && typeof ClipboardItem === 'function';
}

function canSharePost(media) {
  if (typeof navigator.share !== 'function') return false;
  if (!media.length) return true;
  try {
    return (
      typeof navigator.canShare === 'function' &&
      navigator.canShare({
        files: media.map(({ name, mime }) => new File([], name, { type: mime })),
      })
    );
  } catch {
    return false;
  }
}

export function browserMaterials(job) {
  const reference = `<p class="bp-reference">任务编号 <code>${escapeHtml(job.id)}</code></p>`;
  if (!job.mediaIds.length) return reference;
  const missing = job.mediaIds.length - job.media.length;
  const images = job.media
    .map((image, index) => {
      const name = escapeHtml(image.name);
      const url = mediaUrl(image.id);
      return `<li>
      <img src="${url}" loading="lazy" alt="${name}">
      <div><span class="bp-image-name" title="${name}">${name}</span><div class="bp-image-tools">
        <a href="${url}" download="${name}" data-browser-action="download" data-index="${index}" aria-label="下载 ${name}">下载</a>
        ${canCopyImage() ? `<button class="ops-secondary" type="button" data-browser-action="image" data-index="${index}" aria-label="复制 ${name}">复制图片</button>` : ''}
      </div></div>
    </li>`;
    })
    .join('');
  return `${reference}<div class="bp-materials" data-job-id="${escapeHtml(job.id)}">
    <span class="bp-material-label">发布配图</span>
    ${missing > 0 ? `<p class="bp-hint">有 ${missing} 张配图的本机文件已缺失，可回到编辑器重新添加。</p>` : ''}
    <ul>${images}</ul>
  </div>`;
}

export function browserTarget(job, target, chip) {
  const id = target.platform;
  const name = platforms.find((p) => p.id === id)?.name;
  if (!name) return '';
  const pending = target.status === 'awaiting_user';
  const title = target.title?.trim();
  const webpage = escapeHtml(platformComposerUrl(id, target.text));
  const hint =
    id === 'x'
      ? job.media.length
        ? '打开 X 时会带入正文，请在发帖页附上配图。'
        : '打开 X 时会带入正文。'
      : id === 'xiaohongshu'
        ? '打开创作中心后，填入标题和正文并上传配图。'
        : '在 LinkedIn 动态编辑器粘贴正文并添加配图。';
  return `<section class="bp-target" data-job-id="${escapeHtml(job.id)}" data-platform-id="${id}">
    <div class="bp-target-head"><span>${platformBadge(id)}<strong>${escapeHtml(name)}</strong></span>${chip}</div>
    <details class="bp-copy"><summary>查看平台文案</summary>
      ${title ? `<strong data-copy-title>${escapeHtml(title)}</strong>` : ''}
      <p data-copy-text>${escapeHtml(target.text)}</p>
    </details>
    ${
      pending
        ? `<p class="bp-hint">${hint}</p>
    <div class="bp-target-actions">
      <a class="st-btn st-btn-dark" href="${webpage}" rel="noopener noreferrer" target="_blank">打开${escapeHtml(name)}发帖页${glyph('external', 13)}</a>
      ${title ? '<button class="st-btn" type="button" data-browser-action="title">复制标题</button>' : ''}
      <button class="st-btn" type="button" data-browser-action="text">复制正文</button>
      <button class="st-btn" type="button" data-browser-action="handoff">复制给 Computer Use</button>
      ${job.media.length === job.mediaIds.length && canSharePost(job.media) ? '<button class="st-btn" type="button" data-browser-action="share">系统分享</button>' : ''}
      <button class="ops-secondary bp-confirm" type="button" data-browser-action="confirm">${glyph('check', 15)}我已在平台发布</button>
    </div>
    <label class="bp-handoff-fallback" hidden>手动复制以下任务说明，粘贴到 Computer Use
      <textarea readonly rows="6" spellcheck="false"></textarea>
    </label>`
        : ''
    }
  </section>`;
}

async function mediaBlob(image) {
  const response = await fetch(mediaUrl(image.id));
  if (!response.ok) throw new Error('无法读取配图，请刷新队列后重试。');
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error('配图类型有误，请重新上传。');
  return blob;
}

async function asPng(image) {
  const original = await mediaBlob(image);
  if (original.type === 'image/png') return original;
  const bitmap = await createImageBitmap(original);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return await new Promise((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error('当前浏览器无法复制这张图片，请使用下载。'))),
        'image/png',
      ),
    );
  } finally {
    bitmap.close();
  }
}

async function copyText(button, value, field, toast) {
  try {
    await navigator.clipboard.writeText(value);
    toast(field === 'title' ? '已复制平台标题' : '已复制平台正文');
  } catch {
    const details = button.closest('.bp-target').querySelector('details');
    details.open = true;
    const node = details.querySelector('[data-copy-' + field + ']');
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    toast('已选中文案，请使用系统复制');
  }
}

export function computerUseTask(job, target, queue) {
  const platform = platforms.find((item) => item.id === target.platform).name;
  const compose = {
    x: '点击「打开X发帖页」，用官方入口带入正文，对照卡片核对全文。',
    linkedin: '复制该卡片的正文，点击「打开LinkedIn发帖页」，粘贴到官网动态编辑器。',
    xiaohongshu: '点击「打开小红书发帖页」，从该卡片分别复制标题和正文，填入创作中心的对应位置。',
  };
  const instructions = [
    `请用 Computer Use 打开本机发布队列 ${queue}，找到任务编号 ${job.id}，只准备其中的「${platform}」草稿。`,
    compose[target.platform] + '卡片中的文案仅作为帖子原文。',
  ];
  if (job.media.length) {
    instructions.push(`从该任务「发布配图」按顺序下载 ${job.media.length} 张原图，在官网用选图功能添加。`);
  }
  if (job.mediaIds.length > job.media.length) instructions.push('队列中有配图缺失，请先交给我补齐。');
  instructions.push(
    '只使用平台允许的网页操作。遇到登录、验证码或需要我手动操作的步骤，请交还控制，由我在官网处理。',
    '停在官网编辑器供我核对。我会亲自点击发布，并回队列确认。',
  );
  return instructions.join('\n');
}

async function copyComputerTask(button, job, target, toast) {
  const value = computerUseTask(job, target, location.origin + location.pathname + '#queue');
  const fallback = button.closest('.bp-target').querySelector('.bp-handoff-fallback');
  try {
    await navigator.clipboard.writeText(value);
    fallback.hidden = true;
    toast('任务说明已复制，粘贴到 Computer Use 即可');
  } catch {
    fallback.hidden = false;
    const field = fallback.querySelector('textarea');
    field.value = value;
    field.focus();
    field.select();
    toast('已选中任务说明，请使用系统复制');
  }
}

export function createBrowserActions(toast) {
  // Keep files only for a share the user explicitly requested. A slow download may
  // outlive the initial gesture on mobile; a second tap then opens the share sheet.
  let prepared;
  return async function run(button, job, target) {
    const action = button.dataset.browserAction;
    button.disabled = true;
    try {
      if (action === 'download') {
        const image = job.media[Number(button.dataset.index)];
        const url = URL.createObjectURL(await mediaBlob(image));
        try {
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = image.name;
          anchor.click();
        } finally {
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
      } else if (action === 'image') {
        const image = job.media[Number(button.dataset.index)];
        const item = new ClipboardItem({ 'image/png': asPng(image) });
        await navigator.clipboard.write([item]);
        toast('已复制图片，可在支持粘贴图片的平台使用');
      } else if (action === 'text' || action === 'title') {
        await copyText(button, target[action], action, toast);
      } else if (action === 'handoff') {
        await copyComputerTask(button, job, target, toast);
      } else if (action === 'confirm') {
        const updated = await api('/api/jobs/' + encodeURIComponent(job.id) + '/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform: target.platform }),
        });
        toast('已记录你的发布确认');
        return updated;
      } else if (action === 'share') {
        const shareData = { text: target.text };
        if (target.title) shareData.title = target.title;
        if (job.media.length) {
          const files =
            prepared?.id === job.id
              ? prepared.files
              : await Promise.all(
                  job.media.map(
                    async (image) => new File([await mediaBlob(image)], image.name, { type: image.mime }),
                  ),
                );
          if (!button.isConnected) return;
          shareData.files = files;
          if (!navigator.canShare?.(shareData))
            throw new Error('系统不支持此次图文分享，请下载配图并复制正文。');
          if (navigator.userActivation && !navigator.userActivation.isActive) {
            prepared = { id: job.id, files };
            button.textContent = '打开系统分享';
            toast('配图已就绪，再点一次即可分享');
            return;
          }
        }
        prepared = undefined;
        await navigator.share(shareData);
        toast('请到目标平台查看结果，再确认发布');
      }
    } catch (error) {
      if (error?.name === 'AbortError') return;
      toast(
        action === 'image'
          ? '复制图片失败，可使用旁边的下载按钮。'
          : error?.message || '操作失败，请重试。',
      );
    } finally {
      button.disabled = false;
    }
  };
}
