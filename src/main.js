import { icons } from './icons.js';
import { renderRadar, radarState, selectTopic } from './radar.js';
import { renderStudio, seedStudioDraft } from './studio.js';

const pages = { discover: '话题雷达', compose: '创作编辑器', queue: '发布队列', channels: '渠道连接' };
const navIcons = { discover: 'radar', compose: 'compose', queue: 'queue', channels: 'channels' };
const main = document.getElementById('content');
let current = '';
let follows = ['AI Agents', 'Open Source', 'Robotics'];
try {
  const stored = JSON.parse(localStorage.getItem('open-social.follows'));
  if (Array.isArray(stored)) follows = stored.filter((s) => typeof s === 'string' && s.trim()).slice(0, 60);
} catch {}
function navigate(view) {
  if (!Object.hasOwn(pages, view)) return;
  if (location.hash === '#' + view) {
    if (view === 'discover') renderPage();
    return;
  }
  location.hash = view;
}
function hideMenu() {
  document.querySelector('.side').classList.remove('open');
  document.getElementById('backdrop').hidden = true;
  document.getElementById('mobile-nav').setAttribute('aria-expanded', 'false');
}
function displayFollows() {
  const list = document.getElementById('followed');
  list.replaceChildren();
  for (const topic of follows) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className =
      'topic-shortcut' +
      (current === 'discover' && radarState.topic.toLowerCase() === topic.toLowerCase() ? ' selected' : '');
    button.innerHTML = icons('hash', 14) + '<span></span>';
    button.lastElementChild.textContent = topic;
    button.addEventListener('click', () => {
      hideMenu();
      selectTopic(topic);
      if (current === 'discover') renderPage();
      else navigate('discover');
    });
    list.append(button);
  }
  if (!list.children.length) {
    const hint = document.createElement('p');
    hint.className = 'empty-follows';
    hint.textContent = '关注的话题会显示在这里';
    list.append(hint);
  }
}
function isFollowed(topic) {
  return follows.some((s) => s.toLowerCase() === topic.toLowerCase());
}
function toggleFollow(topic) {
  const had = isFollowed(topic);
  if (!had && follows.length >= 60) {
    toast('已关注 60 个话题，请先取消一个再添加');
    return;
  }
  follows = had ? follows.filter((s) => s.toLowerCase() !== topic.toLowerCase()) : [topic, ...follows];
  try {
    localStorage.setItem('open-social.follows', JSON.stringify(follows));
  } catch {}
  displayFollows();
  toast(had ? '已取消关注' : '已添加到关注话题');
}
let toastTimer;
function toast(message) {
  const box = document.getElementById('toast');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), 3400);
}
const ctx = {
  navigate,
  toast,
  icons,
  isFollowed,
  toggleFollow,
  refreshShell: displayFollows,
  async composeFrom(text) {
    try {
      await seedStudioDraft({ text, append: true });
      navigate('compose');
    } catch { toast('引用未能写入本机草稿，请重试。'); }
  },
};
let pageEvents;
function renderPage() {
  pageEvents?.abort();
  pageEvents = new AbortController();
  const requested = location.hash.slice(1);
  current = Object.hasOwn(pages, requested) ? requested : 'discover';
  document.getElementById('breadcrumb').textContent = pages[current];
  document.title = pages[current] + ' · Open Social';
  for (const a of document.querySelectorAll('.nav-item')) {
    const active = a.dataset.view === current;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  displayFollows();
  hideMenu();
  main.replaceChildren();
  const pane = document.createElement('div');
  main.append(pane);
  if (current === 'discover') renderRadar(pane, ctx);
  else renderStudio(current, pane, { ...ctx, signal: pageEvents.signal });
}
function focusSearch() {
  hideMenu();
  if (current !== 'discover') {
    navigate('discover');
    setTimeout(() => document.querySelector('#topic-input')?.focus(), 50);
  } else document.querySelector('#topic-input')?.focus();
}
const navigation = document.getElementById('navigation');
const groups = [
  ['工作空间', ['discover', 'compose', 'queue']],
  ['管理', ['channels']],
];
navigation.innerHTML = groups
  .map(([name, views]) => {
    const items = views
      .map(
        (view) => `
    <a class="nav-item" data-view="${view}" href="#${view}">
      ${icons(navIcons[view], 18)}<span>${pages[view]}</span>
    </a>`,
      )
      .join('');
    return `<div class="nav-group"><div class="nav-label">${name}</div>${items}</div>`;
  })
  .join('');
navigation.addEventListener('click', (event) => {
  if (event.target.closest('a')) hideMenu();
});
document.querySelector('.skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  main.focus();
});
document.getElementById('new-post').innerHTML = icons('plus', 15) + '新建帖子';
document.querySelector('.github-link').innerHTML = icons('github', 19);
document.getElementById('mobile-nav').innerHTML = icons('menu', 18);
document.getElementById('mobile-nav').onclick = () => {
  document.querySelector('.side').classList.add('open');
  document.getElementById('backdrop').hidden = false;
  document.getElementById('mobile-nav').setAttribute('aria-expanded', 'true');
  navigation.querySelector('.active')?.focus();
};
document.getElementById('backdrop').onclick = hideMenu;
document.getElementById('add-topic').onclick = focusSearch;
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    focusSearch();
  }
  if (e.key === 'Escape' && document.querySelector('.side.open')) {
    hideMenu();
    document.getElementById('mobile-nav').focus();
  }
});
window.addEventListener('hashchange', () => {
  renderPage();
  window.scrollTo(0, 0);
});
renderPage();
