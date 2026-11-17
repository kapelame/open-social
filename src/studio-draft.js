export const draftKey = 'open-social.studio.draft.v1';
export const acceptedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const platforms = ['x', 'xiaohongshu', 'linkedin'];
const textValue = (value) => (typeof value === 'string' ? value : '');

// Two tabs opening an empty workspace or a v1 draft must agree on its generation
// before either tab makes the first edit. Each successful submission rotates it.
function freshDraft(id = 'initial') {
  return {
    id,
    revision: 0,
    text: '',
    title: '',
    overrides: {},
    selected: [...platforms],
    media: [],
    mode: 'browser',
    pending: null,
  };
}

function decode(raw) {
  if (!raw || typeof raw !== 'object') return freshDraft();
  const draft = freshDraft(textValue(raw.id) || 'initial');
  draft.revision = Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
  draft.text = textValue(raw.text);
  draft.title = textValue(raw.title);
  // Older drafts without a mode used automatic selection.
  draft.mode = ['live', 'demo', 'browser', 'auto'].includes(raw.mode) ? raw.mode : 'auto';
  if (Array.isArray(raw.selected)) {
    draft.selected = [...new Set(raw.selected.filter((id) => platforms.includes(id)))];
  }
  draft.overrides = Object.fromEntries(
    Object.entries(raw.overrides || {}).filter(
      ([id, value]) => platforms.includes(id) && typeof value === 'string',
    ),
  );
  if (Array.isArray(raw.media)) {
    draft.media = raw.media
      .filter((m) => m && typeof m.id === 'string' && m.id.length < 200 && acceptedTypes.has(m.mime))
      .map(({ id, name, mime }) => ({ id, name: textValue(name), mime }));
  }
  if (raw.pending && typeof raw.pending.key === 'string' && typeof raw.pending.id === 'string') {
    draft.pending = { key: raw.pending.key, id: raw.pending.id };
  }
  return draft;
}

export function draftContent(draft) {
  return JSON.stringify([
    draft.id,
    draft.text,
    draft.title,
    draft.selected,
    draft.overrides,
    draft.media,
    draft.mode,
  ]);
}

function staleDraft() {
  return Object.assign(new Error('草稿已在其他标签页更新，请检查最新内容后再提交。'), {
    name: 'DraftConflictError',
  });
}

export function createDraftStore(storage, locks) {
  function readStored() {
    const raw = storage.getItem(draftKey);
    if (raw === null) return freshDraft();
    try {
      return decode(JSON.parse(raw));
    } catch {
      return freshDraft();
    }
  }

  function transaction(action) {
    // Background tabs can miss storage events; always reread *inside* a shared lock.
    if (!locks) return Promise.reject(new Error('请使用支持标签页同步的浏览器打开本机工作台。'));
    return locks.request(draftKey, () => action(readStored()));
  }
  function write(draft) {
    storage.setItem(draftKey, JSON.stringify(draft));
    return draft;
  }

  return {
    read() {
      // An unavailable browser store still allows editing and copying visible text.
      // Reservations use the strict read/write path so delivery IDs stay durable.
      try {
        return readStored();
      } catch {
        return freshDraft();
      }
    },
    edit(id, change) {
      return transaction((latest) => {
        if (id !== null && latest.id !== id) throw staleDraft();
        change(latest);
        latest.revision++;
        return write(latest);
      });
    },
    reserve(expected, payload) {
      return transaction((latest) => {
        if (draftContent(latest) !== draftContent(expected)) throw staleDraft();
        const key = JSON.stringify(payload);
        if (latest.pending?.key !== key) {
          latest.pending = { key, id: crypto.randomUUID() };
          write(latest);
        }
        return { id: latest.pending.id, revision: latest.revision };
      });
    },
    finish(expected, requestId, mode) {
      return transaction((latest) => {
        // A delayed receipt must never erase changes made since the click.
        if (latest.id !== expected.id || latest.pending?.id !== requestId) return latest;
        if (latest.revision !== expected.revision || draftContent(latest) !== draftContent(expected)) {
          latest.pending = null;
          return write(latest);
        }
        const fresh = freshDraft(crypto.randomUUID());
        if (mode === 'demo') return write({ ...latest, id: fresh.id, revision: 0, pending: null });
        return write(fresh);
      });
    },
  };
}

export function browserDraftStore() {
  return createDraftStore(
    {
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
    },
    navigator.locks,
  );
}

export async function seedStudioDraft({ text, title, append = true } = {}) {
  await browserDraftStore().edit(null, (draft) => {
    const seed = textValue(text).trim();
    if (seed) draft.text = append && draft.text.trim() ? draft.text.trimEnd() + '\n\n' + seed : seed;
    if (title && (!append || !draft.title)) draft.title = title;
  });
}
