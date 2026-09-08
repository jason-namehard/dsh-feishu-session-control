import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write.js';
import { log } from '../core/logger.js';

/** Whether a group chat needs the bot @-mentioned before it answers. */
export type MentionPolicy = 'require' | 'open';

interface MentionData {
  schemaVersion: 1;
  chats: Record<string, MentionPolicy>;
}

/**
 * Per-chat @-mention policy, over a profile-wide default.
 *
 * `DSH_LARK_GROUP_NO_AT` decides the default for every group. That is a single
 * switch for a fleet of chats with different jobs: a working group where the
 * bot should read everything, and a busy one where it must stay quiet unless
 * addressed. This store is the exception list — the default still comes from
 * the env flag, and only the chats named here depart from it.
 *
 * P2P is unaffected: a private chat has no one else to address, so it never
 * required a mention and never consults this store.
 */
export class MentionPolicyStore {
  private data: MentionData = { schemaVersion: 1, chats: {} };
  private saving: Promise<void> = Promise.resolve();

  /**
   * @param path - JSON file backing the overrides.
   * @param defaultPolicy - what a chat with no entry does; derived from
   *   `DSH_LARK_GROUP_NO_AT`.
   */
  constructor(
    private readonly path: string,
    private readonly defaultPolicy: MentionPolicy = 'require',
  ) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<MentionData>;
      this.data = {
        schemaVersion: 1,
        chats: Object.fromEntries(
          Object.entries(parsed.chats ?? {}).filter(
            (entry): entry is [string, MentionPolicy] =>
              entry[1] === 'require' || entry[1] === 'open',
          ),
        ),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.data = { schemaVersion: 1, chats: {} };
    }
  }

  /** The policy in force for one chat. */
  get(chatId: string): MentionPolicy {
    return this.data.chats[chatId] ?? this.defaultPolicy;
  }

  /** What a chat with no override does. */
  fallback(): MentionPolicy {
    return this.defaultPolicy;
  }

  /** Whether this chat departs from the profile default. */
  isOverridden(chatId: string): boolean {
    return this.data.chats[chatId] !== undefined;
  }

  set(chatId: string, policy: MentionPolicy): void {
    this.data.chats[chatId] = policy;
    this.schedulePersist();
  }

  /** Drop the override so the chat follows the profile default again. */
  clear(chatId: string): void {
    if (this.data.chats[chatId] === undefined) return;
    delete this.data.chats[chatId];
    this.schedulePersist();
  }

  /** Every chat that departs from the default, for `/mention list`. */
  overrides(): Array<{ chatId: string; policy: MentionPolicy }> {
    return Object.entries(this.data.chats)
      .map(([chatId, policy]) => ({ chatId, policy }))
      .sort((a, b) => a.chatId.localeCompare(b.chatId));
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    const snapshot: MentionData = {
      schemaVersion: 1,
      chats: { ...this.data.chats },
    };
    this.saving = this.saving
      .then(() => writeFileAtomic(this.path, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 }))
      .catch((error: unknown) => log.fail('mention-policy-store', error, { step: 'persist' }));
  }
}
