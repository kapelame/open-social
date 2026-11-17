import { createHash, randomUUID } from 'node:crypto';
import twitterText from 'twitter-text';

const platforms = new Set(['x', 'linkedin', 'xiaohongshu']);
const fieldId = /^[a-zA-Z0-9_.:-]{1,128}$/;
const retryableStates = new Set(['blocked', 'failed']);
const interrupted = '上次发送中断，请先到平台核实是否已发布。';
const backoffMs = [5_000, 30_000];

function reject(message, status = 400) {
  throw Object.assign(new Error(message), { status, statusCode: status });
}

export function countXText(text) {
  if (typeof text !== 'string' || text.length > 65_536) reject('请输入有效的 X 帖文。');
  const { weightedLength, valid } = twitterText.parseTweet(text);
  return { weightedLength, valid };
}

// The local bridge measures each UTF-16 unit, with two ASCII units per title character.
function xhsTitleLength(title) {
  let width = 0;
  for (let i = 0; i < title.length; i++) width += title.charCodeAt(i) <= 127 ? 1 : 2;
  return Math.ceil(width / 2);
}

function validateContent(target, images) {
  const { platform, title, text } = target;
  if (!text.trim()) reject('每个平台都需要填写正文。');
  if (platform === 'x') {
    if (!countXText(text).valid) reject('X 正文含无效字符或超过 280 个加权字符。');
    if (images.length > 4 || images.some((image) => image.size > 5 * 1024 * 1024)) {
      reject('X 最多支持 4 张图片，每张上限为 5 MiB。');
    }
    return;
  }
  if (images.some((image) => image.mime !== 'image/png' && image.mime !== 'image/jpeg')) {
    reject('LinkedIn 和小红书的配图请使用 JPEG 或 PNG。');
  }
  if (platform === 'linkedin') {
    if ([...text].length > 3000) reject('LinkedIn 正文最多 3000 个字符。');
    return;
  }
  if (!title.trim() || xhsTitleLength(title) > 20)
    reject('请填写小红书标题，最多 20 个汉字或 40 个 ASCII 字符。');
  if ([...text].length > 1000) reject('小红书正文最多 1000 个字符。');
  if (images.length < 1 || images.length > 18) reject('小红书图文笔记需要 1 到 18 张图片。');
}

function normalize(payload) {
  const { requestId, mode, mediaIds = [], targets } = payload ?? {};
  if (typeof requestId !== 'string' || !fieldId.test(requestId)) reject('请提供有效的请求编号。');
  if (!['browser', 'live', 'demo'].includes(mode)) reject('请选择网页发布、自动投递或本机演练。');
  if (
    !Array.isArray(mediaIds) ||
    mediaIds.length > 20 ||
    new Set(mediaIds).size !== mediaIds.length ||
    mediaIds.some((id) => typeof id !== 'string' || !fieldId.test(id))
  )
    reject('请选择最多 20 张不同的图片。');
  if (!Array.isArray(targets) || !targets.length || targets.length > platforms.size)
    reject('请选择有效的平台。');
  const items = targets.map((item) => {
    if (
      !platforms.has(item?.platform) ||
      typeof item.text !== 'string' ||
      (item.title !== undefined && typeof item.title !== 'string')
    )
      reject('平台或文案格式错误。');
    return { platform: item.platform, text: item.text, title: item.title ?? '' };
  });
  if (new Set(items.map((item) => item.platform)).size !== items.length) reject('同一平台只能选择一次。');
  return { requestId, mode, targets: items, mediaIds };
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function createQueue({
  db,
  publishTarget,
  getChannels,
  loadMedia,
  now = Date.now,
  pollMs = 1_000,
  retryDelays = backoffMs,
}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS publish_jobs (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL,
      mode TEXT NOT NULL, created_at TEXT NOT NULL, media_ids TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS publish_targets (
      job_id TEXT NOT NULL REFERENCES publish_jobs(id), position INTEGER NOT NULL,
      platform TEXT NOT NULL, text TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
      message TEXT, url TEXT, remote_id TEXT,
      PRIMARY KEY (job_id, platform)
    );
    CREATE INDEX IF NOT EXISTS publish_targets_due ON publish_targets(status, next_at);
  `);

  const findJob = db.prepare('SELECT * FROM publish_jobs WHERE id = ?');
  const byRequest = db.prepare('SELECT * FROM publish_jobs WHERE request_id = ?');
  const allJobs = db.prepare('SELECT * FROM publish_jobs ORDER BY rowid DESC');
  const targetsFor = db.prepare('SELECT * FROM publish_targets WHERE job_id = ? ORDER BY position');
  // The server holds the database exclusively. Any surviving claim belongs to the previous process.
  const recover = db.prepare(
    "UPDATE publish_targets SET status = 'uncertain', message = ? WHERE status = 'running'",
  );
  recover.run(interrupted);
  const due = db.prepare(`SELECT t.*, j.mode, j.media_ids FROM publish_targets t
    JOIN publish_jobs j ON t.job_id = j.id WHERE j.mode IN ('live', 'demo') AND t.status = 'queued' AND t.next_at <= ?
    ORDER BY j.rowid, t.position LIMIT 1`);
  const insertJob = db.prepare(
    'INSERT INTO publish_jobs(id, request_id, digest, mode, created_at, media_ids) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertTarget = db.prepare(
    'INSERT INTO publish_targets(job_id, position, platform, text, title, status) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const claim = db.prepare(
    "UPDATE publish_targets SET status = 'running', attempts = attempts + 1 WHERE job_id = ? AND platform = ?",
  );
  const update = db.prepare(`UPDATE publish_targets SET status = ?, message = ?, url = ?, remote_id = ?,
    next_at = ? WHERE job_id = ? AND platform = ?`);
  const requeue = db.prepare(`UPDATE publish_targets SET status = 'queued', attempts = 0, next_at = 0,
    message = NULL WHERE job_id = ? AND platform = ? AND status IN ('blocked', 'failed')`);
  const confirmTarget = db.prepare(`UPDATE publish_targets SET status = 'user_confirmed'
    WHERE job_id = ? AND platform = ? AND status IN ('awaiting_user', 'user_confirmed')`);

  let started = false;
  let active;
  let recoverInterrupted = false;
  let timer;

  function jobView(row) {
    const mediaIds = JSON.parse(row.media_ids);
    const browserMedia = row.mode === 'browser' ? mediaIds.flatMap((id) => {
      const image = loadMedia(id);
      return image ? [{ id, name: image.name, mime: image.mime }] : [];
    }) : undefined;
    return {
      id: row.id,
      mode: row.mode,
      createdAt: row.created_at,
      mediaIds,
      ...(browserMedia && { media: browserMedia }),
      targets: targetsFor.all(row.id).map((target) => ({
        platform: target.platform,
        title: target.title,
        text: target.text,
        status: target.status,
        attempts: target.attempts,
        canRetry: retryableStates.has(target.status),
        ...(target.message && { message: target.message }),
        ...(target.url && { url: target.url }),
        ...(target.remote_id && { remoteId: target.remote_id }),
        ...(target.status === 'queued' &&
          target.next_at > 0 && { nextAttemptAt: new Date(target.next_at).toISOString() }),
      })),
    };
  }

  function imagesFor(ids) {
    return ids.map((id) => {
      const image = loadMedia(id);
      if (!image) reject('找不到已选择的图片，请重新上传。');
      return image;
    });
  }

  function enqueue(payload) {
    const { requestId, mode, targets, mediaIds } = normalize(payload);
    const digest = createHash('sha256').update(JSON.stringify({ mode, targets, mediaIds })).digest('hex');
    const job = transaction(db, () => {
      const existing = byRequest.get(requestId);
      if (existing) {
        if (digest !== existing.digest) reject('该请求编号已被另一份发布内容使用。', 409);
        return jobView(existing);
      }
      const images = imagesFor(mediaIds);
      for (const target of targets) validateContent(target, images);
      const id = randomUUID();
      insertJob.run(id, requestId, digest, mode, new Date(now()).toISOString(), JSON.stringify(mediaIds));
      const status = mode === 'browser' ? 'awaiting_user' : 'queued';
      targets.forEach(({ platform, text, title }, i) => insertTarget.run(id, i, platform, text, title, status));
      return jobView(findJob.get(id));
    });
    if (mode !== 'browser') wake();
    return job;
  }

  function confirm(id, platform) {
    if (!platforms.has(platform)) reject('请选择有效的平台。');
    return transaction(db, () => {
      const row = findJob.get(id);
      if (!row) reject('找不到发布任务。', 404);
      if (row.mode !== 'browser' || !confirmTarget.run(id, platform).changes) {
        reject('只有此任务包含的网页发布渠道可以手动确认。', 409);
      }
      return jobView(row);
    });
  }

  function retry(id, platform) {
    if (!platforms.has(platform)) reject('请选择有效的平台。');
    const job = transaction(db, () => {
      const row = findJob.get(id);
      if (!row) reject('找不到发布任务。', 404);
      if (!requeue.run(id, platform).changes) reject('此平台的当前状态不支持重试。', 409);
      return jobView(row);
    });
    wake();
    return job;
  }

  function finish(target, status, message = null, receipt = {}, nextAt = 0) {
    update.run(
      status,
      message,
      receipt.url || null,
      receipt.remoteId || null,
      nextAt,
      target.job_id,
      target.platform,
    );
  }

  function takeNext() {
    return transaction(db, () => {
      const target = due.get(now());
      if (target) claim.run(target.job_id, target.platform);
      return target;
    });
  }

  function onFailure(target, error, attemptedPublish) {
    // Once delivery has started, an unclassified exception could mean the receipt was lost.
    const uncertain = attemptedPublish && (error?.uncertain || typeof error?.retryable !== 'boolean');
    if (uncertain) {
      finish(target, 'uncertain', '发送结果待核实，请到平台查看发帖记录。');
      return;
    }
    const message = error?.message || '发送失败，请检查平台连接。';
    const delay = retryDelays[target.attempts];
    if (error?.retryable === true && delay !== undefined) {
      const serverDelay = Number.isFinite(error.retryAfterMs) ? Math.max(0, error.retryAfterMs) : 0;
      finish(target, 'queued', message, {}, now() + Math.max(serverDelay, delay));
      return;
    }
    finish(target, 'failed', message);
  }

  async function drain() {
    if (recoverInterrupted) {
      recover.run(interrupted);
      recoverInterrupted = false;
    }
    while (started) {
      const target = takeNext();
      if (!target) return;
      if (target.mode === 'demo') {
        finish(target, 'demo', '演练完成，未向平台发送。');
        continue;
      }
      let images;
      let channel;
      try {
        images = imagesFor(JSON.parse(target.media_ids));
        channel = (await getChannels()).find((item) => item.id === target.platform);
      } catch (error) {
        onFailure(target, error, false);
        continue;
      }
      if (!channel?.connected) {
        finish(target, 'blocked', channel?.detail || '请在渠道设置中连接此平台，再重试。');
        continue;
      }
      let receipt;
      try {
        receipt = await publishTarget({
          platform: target.platform,
          text: target.text,
          title: target.title,
          images,
          jobId: target.job_id,
        });
      } catch (error) {
        onFailure(target, error, true);
        continue;
      }
      if (!receipt || ![receipt.remoteId, receipt.url, receipt.message].some(Boolean)) {
        finish(target, 'uncertain', '平台未返回可识别的发布回执，请核实。');
        continue;
      }
      finish(target, 'published', receipt.message, receipt);
    }
  }

  function wake() {
    if (!started || active) return;
    active = Promise.resolve()
      .then(drain)
      .catch((error) => {
        // A storage failure may have left a claim without a durable receipt.
        recoverInterrupted = true;
        console.error('发布队列存储错误', error.code ?? error.name);
      })
      .finally(() => {
        active = undefined;
      });
  }

  return {
    enqueue,
    confirm,
    retry,
    list: () => allJobs.all().map(jobView),
    start() {
      if (started) return;
      started = true;
      timer = setInterval(wake, pollMs);
      timer.unref();
      wake();
    },
    async stop() {
      started = false;
      clearInterval(timer);
      await active;
    },
  };
}
