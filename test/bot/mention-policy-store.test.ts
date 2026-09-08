import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MentionPolicyStore } from '../../src/bot/mention-policy-store.js';

async function storeAt(fallback: 'require' | 'open'): Promise<{ store: MentionPolicyStore; path: string }> {
  const path = join(await mkdtemp(join(tmpdir(), 'dsh-lark-mention-')), 'mention-policies.json');
  const store = new MentionPolicyStore(path, fallback);
  await store.load();
  return { store, path };
}

describe('MentionPolicyStore', () => {
  it('follows the profile default until a chat is given its own entry', async () => {
    const { store } = await storeAt('open');

    expect(store.get('oc-quiet')).toBe('open');
    expect(store.isOverridden('oc-quiet')).toBe(false);

    store.set('oc-quiet', 'require');
    expect(store.get('oc-quiet')).toBe('require');
    expect(store.isOverridden('oc-quiet')).toBe(true);
    // Other chats are untouched by one chat's exception.
    expect(store.get('oc-other')).toBe('open');

    store.clear('oc-quiet');
    expect(store.get('oc-quiet')).toBe('open');
    expect(store.isOverridden('oc-quiet')).toBe(false);
  });

  it('overrides in both directions, and persists them across a restart', async () => {
    // The default is the strict one here, so this is the "open up one group"
    // direction — the mirror of the case above.
    const { store, path } = await storeAt('require');
    store.set('oc-loud', 'open');
    store.set('oc-strict', 'require');
    await store.flush();

    const restored = new MentionPolicyStore(path, 'require');
    await restored.load();

    expect(restored.get('oc-loud')).toBe('open');
    expect(restored.get('oc-unknown')).toBe('require');
    expect(restored.overrides()).toEqual([
      { chatId: 'oc-loud', policy: 'open' },
      { chatId: 'oc-strict', policy: 'require' },
    ]);
  });

  it('starts empty when no file exists, rather than failing to load', async () => {
    const { store } = await storeAt('require');
    expect(store.overrides()).toEqual([]);
    expect(store.get('anything')).toBe('require');
  });
});
