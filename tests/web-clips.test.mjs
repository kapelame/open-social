import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addWebClips,
  computerUsePrompt,
  parseWebClips,
  readWebClips,
  removeWebClip,
} from '../src/web-clips.js';
import { nativeSearchUrl } from '../src/platform-web.js';

function localStore() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

const first = { title: 'Open Social 实测', url: 'https://example.org/notes/1' };
const second = { title: 'Agent & automation', url: 'https://example.net/story?q=automation' };

test('imports title and URL pairs from browser text with blank lines and CRLF', () => {
  const input = [first.title, first.url, '', second.title, second.url, ''].join('\r\n');
  assert.deepEqual(parseWebClips(input), [first, second]);
});

test('rejects malformed batches before accepting any item', () => {
  for (const bad of [
    '只有标题',
    '错误链接\nexample.org/1',
    '错误协议\nfile:///tmp/local-only',
    '含认证信息\nhttps://username:password@example.net/notes/1',
    'https://example.net/notes/2',
  ]) {
    assert.throws(() => parseWebClips(first.title + '\n' + first.url + '\n\n' + bad), bad);
  }
  const pairs = Array.from({ length: 26 }, (_, i) => '条目 ' + i + '\nhttps://example.net/' + i);
  assert.equal(parseWebClips(pairs.slice(0, 25).join('\n')).length, 25);
  assert.throws(() => parseWebClips(pairs.join('\n')));
});

test('keeps clips by topic, deduplicates links, and retains the first title', () => {
  const store = localStore();
  const initial = addWebClips('AI Agents', [first, second], store);
  assert.equal(initial.added, 2);
  assert.equal(initial.items.length, 2);
  const duplicate = { title: '另一个标题', url: first.url + '#paragraph' };
  const repeated = addWebClips('ai agents', [duplicate], store);
  assert.equal(repeated.added, 0);
  const existing = readWebClips('AI AGENTS', store);
  assert.equal(existing.length, 2);
  assert.deepEqual(
    existing.find((item) => item.url === first.url),
    first,
  );
  assert.deepEqual(readWebClips('Robotics', store), []);
  addWebClips('Robotics', [first], store);
  assert.deepEqual(removeWebClip('ai agents', first.url, store), [second]);
  assert.deepEqual(readWebClips('AI AGENTS', store), [second]);
  assert.deepEqual(readWebClips('Robotics', store), [first]);
});

test('enforces the per-topic cap without discarding an earlier selection', () => {
  const store = localStore();
  for (let start = 0; start < 100; start += 25) {
    const batch = Array.from({ length: 25 }, (_, i) => ({
      title: '选中原帖 ' + (start + i),
      url: 'https://example.org/posts/' + (start + i),
    }));
    addWebClips('选题', batch, store);
  }
  const before = readWebClips('选题', store);
  assert.equal(before.length, 100);
  assert.throws(() => addWebClips('选题', [first], store));
  assert.deepEqual(readWebClips('选题', store), before);
});

test('a Computer Use task includes only the specified native search and local workspace', () => {
  const workspace = 'http://127.0.0.1:4317/#discover';
  const topic = '城市 "书店" & 咖啡';
  for (const platform of ['x', 'xiaohongshu', 'linkedin', 'news']) {
    const prompt = computerUsePrompt(topic, platform, workspace);
    assert.ok(prompt.includes(nativeSearchUrl(platform, topic)));
    assert.ok(prompt.includes(workspace));
    for (const other of ['x', 'xiaohongshu', 'linkedin', 'news'].filter((item) => item !== platform)) {
      assert.ok(!prompt.includes(nativeSearchUrl(other, topic)));
    }
  }
});
