export const platforms = [
  { id: 'x', name: 'X' },
  { id: 'xiaohongshu', name: '小红书' },
  { id: 'linkedin', name: 'LinkedIn' },
];

export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
}

export function safeHref(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

export async function api(path, options = {}) {
  const response = await fetch(path, options);
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      String(
        result?.message || result?.error?.message || result?.error || `请求失败（${response.status}）`,
      ),
    );
  }
  if (result === null) throw new Error('服务返回了无法读取的结果，请刷新重试。');
  return result;
}

const shapes = {
  refresh: '<path d="M20 7v5h-5M20 12a8 8 0 1 0-2.4 5.7"/>',
  plug: '<path d="m12 22 2-6m-6-8 9 3-1 4a4.7 4.7 0 0 1-9-3l1-4Zm3 1 1-5m3 6 2-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  queue:
    '<rect x="3" y="3" width="18" height="5" rx="1.5"/><rect x="3" y="11" width="18" height="5" rx="1.5"/><path d="M5 20h14"/>',
  send: '<path d="m21 3-6.2 18-3.7-7.9L3 9.3 21 3Zm-9.9 10.1L21 3"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8.5" r="1.2"/><path d="m4 18 5-5 3 2 4-5 4 5"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  edit: '<path d="m14 5 5 5M4 20l5-1L20 8a2.1 2.1 0 0 0-4-4L5 15l-1 5Z"/>',
  chevron: '<path d="m8 10 4 4 4-4"/>',
  external: '<path d="M13 4h7v7m0-7L10 14m1-9H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  activity: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
  inbox: '<path d="m3 15 3-10h12l3 10v4H3v-4Zm0 0h5l2 2h4l2-2h5"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V4H3v13h5"/>',
  link: '<path d="m10 14 4-4m-6 3-2 2a3 3 0 0 0 5 5l3-3m-4-10 3-3a3 3 0 0 1 5 5l-2 2"/>',
  alert: '<path d="m12 3 10 18H2L12 3Zm0 6v5m0 3v.1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',
  more: '<circle cx="4" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="20" cy="12" r="1"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="2.6"/>',
  save: '<path d="M4 4h14l2 2v14H4V4Zm4 0v6h8V4m-8 16v-6h8v6"/>',
};

export function glyph(name, size = 18) {
  if (!shapes[name]) return '';
  return `<svg aria-hidden="true" viewBox="0 0 24 24" width="${Number(size) || 18}" height="${Number(size) || 18}" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${shapes[name]}</svg>`;
}

export function platformBadge(platform) {
  const badges = { x: '𝕏', xiaohongshu: '小红书', linkedin: 'in' };
  return badges[platform]
    ? `<span aria-hidden="true" class="st-platform-badge st-brand-${platform}">${badges[platform]}</span>`
    : '';
}

export function heading(title, description, actionHtml = '') {
  return `<header class="st-heading"><div><h1>${escapeHtml(title)}</h1>${description ? `<p>${escapeHtml(description)}</p>` : ''}</div>${actionHtml}</header>`;
}
