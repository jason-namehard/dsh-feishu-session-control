import { describe, expect, it } from 'vitest';
import { loadRuntimeEnv } from '../../src/config/env.js';

describe('loadRuntimeEnv', () => {
  it('uses safe defaults', () => {
    const env = loadRuntimeEnv({
      DSH_LARK_DSH_COMMAND: 'node',
      DSH_LARK_DSH_ARGS: 'lib/bin.js,cordis.yml',
    });

    expect(env.home.endsWith('.dsh-lark')).toBe(true);
    expect(env.tenant).toBe('feishu');
    expect(env.dshCommand).toBe('node');
    expect(env.dshArgs).toEqual(['lib/bin.js', 'cordis.yml']);
    expect(env.provider).toBe('');
    expect(env.model).toBe('');
    expect(env.adapterMode).toBe('web');
    expect(env.runTimeoutMs).toBe(300_000);
    expect(env.stopGraceMs).toBe(5_000);
    expect(env.groupNoAt).toBe(false);
    expect(env.groupPollMs).toBe(3_000);
    expect(env.botHandoffMax).toBe(6);
    expect(env.notificationDefault).toBe('off');
    expect(env.sessionProjectionEnabled).toBe(true);
    expect(env.sessionBackfillMessages).toBe(20);
    expect(env.sessionBackfillBytes).toBe(64 * 1024);
    expect(env.sessionStreamUpdateMs).toBe(800);
  });

  it('parses Web settings defaults for concurrency and notifications', () => {
    const env = loadRuntimeEnv({
      DSH_LARK_SCOPE_CONCURRENCY: '4',
      DSH_LARK_NOTIFICATION_DEFAULT: 'completed',
    });
    expect(env.scopeConcurrency).toBe(4);
    expect(env.notificationDefault).toBe('completed');
    expect(() => loadRuntimeEnv({ DSH_LARK_NOTIFICATION_DEFAULT: 'sometimes' })).toThrow(
      /DSH_LARK_NOTIFICATION_DEFAULT/,
    );
  });

  it('parses explicit command args and tenant', () => {
    const env = loadRuntimeEnv({
      DSH_LARK_TENANT: 'lark',
      DSH_LARK_DSH_ARGS: 'dist/bin.js, agent.cordis.yml',
      DSH_LARK_RUN_TIMEOUT_MS: '120000',
      DSH_LARK_STOP_GRACE_MS: '2000',
    });

    expect(env.tenant).toBe('lark');
    expect(env.dshArgs).toEqual(['dist/bin.js', 'agent.cordis.yml']);
    expect(env.runTimeoutMs).toBe(120_000);
    expect(env.stopGraceMs).toBe(2_000);
  });

  it('rejects invalid tenant and timeout values', () => {
    expect(() => loadRuntimeEnv({ DSH_LARK_TENANT: 'invalid' })).toThrow(
      /DSH_LARK_TENANT/,
    );
    expect(() => loadRuntimeEnv({ DSH_LARK_RUN_TIMEOUT_MS: '-1' })).toThrow(
      /DSH_LARK_RUN_TIMEOUT_MS/,
    );
    expect(() => loadRuntimeEnv({ DSH_LARK_STOP_GRACE_MS: 'invalid' })).toThrow(
      /DSH_LARK_STOP_GRACE_MS/,
    );
  });

  it('parses group no-at polling settings and rejects unsafe intervals', () => {
    const env = loadRuntimeEnv({
      DSH_LARK_GROUP_NO_AT: 'true',
      DSH_LARK_GROUP_POLL_MS: '5000',
    });
    expect(env.groupNoAt).toBe(true);
    expect(env.groupPollMs).toBe(5_000);
    expect(() => loadRuntimeEnv({ DSH_LARK_GROUP_POLL_MS: '999' })).toThrow(
      /DSH_LARK_GROUP_POLL_MS/,
    );
  });

  it('parses the trusted bot handoff limit and rejects an unsafe value', () => {
    expect(loadRuntimeEnv({ DSH_LARK_BOT_HANDOFF_MAX: '8' }).botHandoffMax).toBe(8);
    expect(() => loadRuntimeEnv({ DSH_LARK_BOT_HANDOFF_MAX: '1' })).toThrow(
      /DSH_LARK_BOT_HANDOFF_MAX/,
    );
  });

  it('parses session projection limits and honors the deprecated web-push disable alias', () => {
    const env = loadRuntimeEnv({
      DSH_LARK_SESSION_PROJECTION: '1',
      DSH_LARK_SESSION_BACKFILL_MESSAGES: '12',
      DSH_LARK_SESSION_BACKFILL_BYTES: '8192',
      DSH_LARK_SESSION_STREAM_UPDATE_MS: '1200',
    });
    expect(env.sessionProjectionEnabled).toBe(true);
    expect(env.sessionBackfillMessages).toBe(12);
    expect(env.sessionBackfillBytes).toBe(8192);
    expect(env.sessionStreamUpdateMs).toBe(1200);
    expect(loadRuntimeEnv({ DSH_LARK_WEB_PUSH: '0' }).sessionProjectionEnabled).toBe(false);
    expect(() => loadRuntimeEnv({ DSH_LARK_SESSION_STREAM_UPDATE_MS: '399' })).toThrow(
      /DSH_LARK_SESSION_STREAM_UPDATE_MS/,
    );
  });
});

describe('group polling switch', () => {
  it('turns polling off for 0/off/false, and keeps the floor otherwise', () => {
    // Once `im:message.group_msg` is granted the event stream delivers
    // un-mentioned messages directly, and the poll only re-reads what has
    // already arrived — so "off" has to be expressible.
    const at = (value: string | undefined) =>
      loadRuntimeEnv({ ...(value === undefined ? {} : { DSH_LARK_GROUP_POLL_MS: value }) }).groupPollMs;

    expect(at('0')).toBe(0);
    expect(at('off')).toBe(0);
    expect(at('false')).toBe(0);
    expect(at(undefined)).toBe(3_000);
    expect(at('10000')).toBe(10_000);
    // Below the floor still fails loudly, rather than quietly becoming a busy
    // loop that hammers the Feishu API.
    expect(() => at('50')).toThrow(/>= 1000/);
  });
});
