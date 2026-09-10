import { describe, expect, it, vi } from 'vitest';
import {
  captureOutput,
  listProcesses,
  matchProfileProcess,
} from '../../src/platform/process.js';

describe('platform process helpers', () => {
  it('matches only the requested running dsh profile', () => {
    expect(matchProfileProcess('node /x/@deepseek-ai/dsh/lib/bin.js --profile web', 'web')).toBe(true);
    expect(matchProfileProcess('node /x/@deepseek-ai/dsh/lib/bin.js --profile web-old', 'web')).toBe(false);
    expect(matchProfileProcess('dsh plugin --profile web add local-package', 'web')).toBe(false);
  });

  it('parses Windows CIM process JSON', async () => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([
        { ProcessId: 42, ParentProcessId: 1, CommandLine: 'dsh --profile web' },
        { ProcessId: 43, ParentProcessId: 1, CommandLine: null },
      ]),
      stderr: '',
    });
    await expect(listProcesses('win32', run)).resolves.toEqual([
      { pid: 42, ppid: 1, cmdline: 'dsh --profile web' },
    ]);
  });

  it('captures command output', async () => {
    const result = await captureOutput(process.execPath, ['-e', 'process.stdout.write("ok")']);
    expect(result).toMatchObject({ code: 0, stdout: 'ok', stderr: '' });
  });
});
