import { describe, expect, it, vi } from 'vitest';
import { adaptLarkChannel } from '../../src/bridge/lark-channel.js';

interface ReactionCall {
  path: { message_id: string; reaction_id?: string };
  data?: { reaction_type: { emoji_type: string } };
}

function fakeChannel(reaction: {
  create?: (payload: ReactionCall) => Promise<unknown>;
  remove?: (payload: ReactionCall) => Promise<unknown>;
}) {
  return {
    rawClient: {
      im: {
        v1: {
          messageReaction: {
            create: reaction.create ?? vi.fn(),
            delete: reaction.remove ?? vi.fn(),
          },
        },
      },
    },
    send: vi.fn(),
    recallMessage: vi.fn(),
    createChat: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as Parameters<typeof adaptLarkChannel>[0];
}

describe('Feishu message reactions', () => {
  it('adds a reaction and returns its id so it can be cleared later', async () => {
    const calls: ReactionCall[] = [];
    const channel = adaptLarkChannel(fakeChannel({
      create: async (payload) => {
        calls.push(payload);
        return { code: 0, data: { reaction_id: 'reaction-1' } };
      },
    }));

    const id = await channel.addReaction?.('om-user-message', 'OnIt');

    expect(id).toBe('reaction-1');
    expect(calls).toEqual([
      { path: { message_id: 'om-user-message' }, data: { reaction_type: { emoji_type: 'OnIt' } } },
    ]);
  });

  it('does not fail the turn when the app lacks the reaction scope', async () => {
    // A missing im:message.reactions:write_only scope comes back as a non-zero code.
    // An acknowledgement is worth less than the run it precedes, so this must
    // degrade to "no reaction" rather than take the run down with it.
    const channel = adaptLarkChannel(fakeChannel({
      create: async () => ({ code: 99991672, msg: 'no permission' }),
    }));

    await expect(channel.addReaction?.('om-1', 'OnIt')).resolves.toBeUndefined();
  });

  it('survives a transport failure while reacting', async () => {
    const channel = adaptLarkChannel(fakeChannel({
      create: async () => {
        throw new Error('socket hang up');
      },
    }));

    await expect(channel.addReaction?.('om-1', 'OnIt')).resolves.toBeUndefined();
  });

  it('clears a reaction by id', async () => {
    const calls: ReactionCall[] = [];
    const channel = adaptLarkChannel(fakeChannel({
      remove: async (payload) => {
        calls.push(payload);
        return { code: 0 };
      },
    }));

    await channel.removeReaction?.('om-1', 'reaction-1');

    expect(calls).toEqual([{ path: { message_id: 'om-1', reaction_id: 'reaction-1' } }]);
  });

  it('treats an unclearable reaction as cosmetic residue, not a failure', async () => {
    const channel = adaptLarkChannel(fakeChannel({
      remove: async () => {
        throw new Error('message recalled');
      },
    }));

    await expect(channel.removeReaction?.('om-1', 'reaction-1')).resolves.toBeUndefined();
  });
});
