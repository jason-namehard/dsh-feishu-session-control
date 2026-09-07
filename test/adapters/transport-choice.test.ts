import { describe, expect, it } from 'vitest';
import { buildAgentAdapter } from '../../src/adapters/index.js';
import { loadRuntimeEnv, type RuntimeEnv } from '../../src/config/env.js';

function envFor(adapter: string | undefined): RuntimeEnv {
  return loadRuntimeEnv({
    ...(adapter === undefined ? {} : { DSH_LARK_ADAPTER: adapter }),
    DSH_LARK_MODEL: 'test-model',
  });
}

/** A context shaped like a dsh host that provides the agent registry. */
const hostContext = {
  get: (name: string) =>
    name === 'agents'
      ? {
          create: async () => ({ agent: {}, dispose: async () => undefined }),
          resume: async () => ({ agent: {}, dispose: async () => undefined }),
          get: () => undefined,
          list: () => [],
        }
      : undefined,
  on: () => () => undefined,
};

describe('adapter transport choice', () => {
  it('uses the in-process transport when mounted inside dsh', async () => {
    const adapter = await buildAgentAdapter(envFor('web'), {
      stopGraceMs: undefined,
      model: undefined,
      hostContext,
    });
    expect(adapter.id).toBe('dsh-host');
    expect(adapter.resumeCapable).toBe(true);
  });

  it('is the default transport, not something the user must opt into', async () => {
    const adapter = await buildAgentAdapter(envFor(undefined), {
      stopGraceMs: undefined,
      model: undefined,
      hostContext,
    });
    expect(adapter.id).toBe('dsh-host');
  });

  it('falls back to the HTTP web transport when there is no host to run inside', async () => {
    const adapter = await buildAgentAdapter(envFor('web'), {
      stopGraceMs: undefined,
      model: undefined,
    });
    expect(adapter.id).toBe('dsh-web');
  });

  it('does not probe the registry, so a still-booting host is not downgraded', async () => {
    // Services appear asynchronously during boot: a context that has no
    // `agents` yet must still take the in-process path rather than silently
    // falling back to HTTP against the very process it is running in.
    const booting = { get: () => undefined, on: () => () => undefined };
    const adapter = await buildAgentAdapter(envFor('web'), {
      stopGraceMs: undefined,
      model: undefined,
      hostContext: booting,
    });
    expect(adapter.id).toBe('dsh-host');
  });

  it('fails loudly when host is demanded but the bridge runs out of process', async () => {
    await expect(
      buildAgentAdapter(envFor('host'), { stopGraceMs: undefined, model: undefined }),
    ).rejects.toThrow(/requires running as a plugin inside dsh/);
  });

  it('leaves the legacy headless transport reachable', async () => {
    const adapter = await buildAgentAdapter(envFor('headless'), {
      stopGraceMs: undefined,
      model: undefined,
      hostContext,
    });
    expect(adapter.id).not.toBe('dsh-host');
  });
});
