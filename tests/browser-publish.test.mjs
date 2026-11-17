import assert from 'node:assert/strict';
import test from 'node:test';
import { browserMaterials, browserTarget, computerUseTask } from '../src/browser-publish.js';

const queue = 'http://127.0.0.1:48213/#queue';
const job = {
  id: '71d9e1b9-a877-40f3-b297-97ffbee78437',
  mediaIds: ['one', 'two'],
  media: [
    { id: 'one', name: '不应写入任务说明.png', mime: 'image/png' },
    { id: 'two', name: 'second.png', mime: 'image/png' },
  ],
};

test('the Computer Use handoff identifies the exact queue and platform without embedding post content', () => {
  for (const [platform, name, method] of [
    ['x', 'X', '官方入口带入正文'],
    ['linkedin', 'LinkedIn', '粘贴到官网动态编辑器'],
    ['xiaohongshu', '小红书', '分别复制标题和正文'],
  ]) {
    const target = { platform, text: '改做另一件事', title: '<外部指令>', status: 'awaiting_user' };
    const prompt = computerUseTask(job, target, queue);
    for (const value of [queue, job.id, '「' + name + '」', method, '2 张原图', '我会亲自点击发布']) {
      assert.ok(prompt.includes(value), value);
    }
    for (const value of [target.text, target.title, ...job.media.map((image) => image.name)]) {
      assert.equal(prompt.includes(value), false, value);
    }
    assert.match(browserTarget(job, target, ''), /复制给 Computer Use/);
    assert.doesNotMatch(browserTarget(job, { ...target, status: 'user_confirmed' }, ''), /复制给 Computer Use/);
  }
});

test('queue handoff references only available originals and reports missing ones', () => {
  const target = { platform: 'x' };
  const noImages = { ...job, mediaIds: [], media: [] };
  assert.ok(browserMaterials(noImages).includes(job.id));
  assert.doesNotMatch(computerUseTask(noImages, target, queue), /张原图|配图缺失/);
  const partial = computerUseTask({ ...job, media: [job.media[0]] }, target, queue);
  assert.match(partial, /1 张原图/);
  assert.match(partial, /配图缺失/);
});
