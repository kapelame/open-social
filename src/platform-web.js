// The user's browser supplies its normal platform session when it follows these links.
const websites = {
  x: {
    login: 'https://x.com/i/flow/login',
    composer: 'https://x.com/intent/tweet',
    search: 'https://x.com/search',
    query: 'q',
  },
  xiaohongshu: {
    login: 'https://creator.xiaohongshu.com/login',
    composer: 'https://creator.xiaohongshu.com/publish/publish?target=image',
    search: 'https://www.xiaohongshu.com/search_result',
    query: 'keyword',
  },
  linkedin: {
    login: 'https://www.linkedin.com/login',
    composer: 'https://www.linkedin.com/feed/?shareActive=true',
    search: 'https://www.linkedin.com/search/results/content/',
    query: 'keywords',
  },
  news: { search: 'https://news.google.com/search?hl=zh-CN&gl=US&ceid=US%3Azh-Hans', query: 'q' },
};

export function platformLoginUrl(id) {
  return websites[id].login;
}

export function platformComposerUrl(id, text = '') {
  const url = new URL(websites[id].composer);
  if (id === 'x' && text) url.searchParams.set('text', text);
  return url.href;
}

export function nativeSearchUrl(platform, topic) {
  const { search, query } = websites[platform];
  const url = new URL(search);
  url.searchParams.set(query, topic);
  return url.href;
}
