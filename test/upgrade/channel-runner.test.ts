import { describe, expect, it, vi } from 'vitest';
import { InProcessChannelUpdater } from '../../src/upgrade/channel-runner.js';

const route = { chatId: 'oc_chat', threadId: 'omt_thread', requesterId: 'ou_admin' };

describe('InProcessChannelUpdater', () => {
  it('runs one update and reports successful completion', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const complete = vi.fn().mockResolvedValue(undefined);
    const updater = new InProcessChannelUpdater({ run, complete, id: () => 'update-1' });

    await expect(updater.start('0.20.0', route)).resolves.toEqual({ accepted: true, id: 'update-1' });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(run).toHaveBeenCalledWith('0.20.0');
    expect(complete).toHaveBeenCalledWith({
      id: 'update-1', targetVersion: '0.20.0', route, status: 'succeeded',
    });
  });

  it('reports failure and becomes available again after completion', async () => {
    const complete = vi.fn().mockResolvedValue(undefined);
    const ids = ['update-failed', 'update-next'];
    const updater = new InProcessChannelUpdater({
      run: vi.fn().mockRejectedValueOnce(new Error('install failed')).mockResolvedValueOnce(undefined),
      complete,
      id: () => ids.shift()!,
    });

    await expect(updater.start('0.20.0', route)).resolves.toEqual({ accepted: true, id: 'update-failed' });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      id: 'update-failed', status: 'failed', error: 'install failed',
    })));
    await expect(updater.start('0.20.1', route)).resolves.toEqual({ accepted: true, id: 'update-next' });
  });

  it('returns the active update id while busy', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const complete = vi.fn().mockResolvedValue(undefined);
    const updater = new InProcessChannelUpdater({
      run: () => gate,
      complete,
      id: () => 'update-active',
    });

    await expect(updater.start('0.20.0', route)).resolves.toEqual({ accepted: true, id: 'update-active' });
    await expect(updater.start('0.20.1', route)).resolves.toEqual({
      accepted: false, reason: 'busy', id: 'update-active',
    });
    release();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
  });

  it('ignores completion delivery failures without leaving the updater busy', async () => {
    const ids = ['update-1', 'update-2'];
    const updater = new InProcessChannelUpdater({
      run: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn().mockRejectedValue(new Error('Feishu offline')),
      id: () => ids.shift()!,
    });

    await expect(updater.start('0.20.0', route)).resolves.toEqual({ accepted: true, id: 'update-1' });
    await new Promise((resolve) => setImmediate(resolve));
    await expect(updater.start('0.20.1', route)).resolves.toEqual({ accepted: true, id: 'update-2' });
  });
});
