import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectUpgradeState,
  readInstalledPackage,
} from '../../src/upgrade/detect.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-detect-'));
  tempDirs.push(home);
  return home;
}

describe('readInstalledPackage', () => {
  it('reads the version from the profile node_modules manifest', async () => {
    const home = await makeHome();
    const manifest = join(home, 'profiles', 'dsh-lark', 'node_modules', 'dsh-lark-bot', 'package.json');
    await mkdir(join(manifest, '..'), { recursive: true });
    await writeFile(manifest, JSON.stringify({ name: 'dsh-lark-bot', version: '0.10.2' }), 'utf8');

    const info = await readInstalledPackage(home, 'dsh-lark', 'dsh-lark-bot');
    expect(info).toMatchObject({ name: 'dsh-lark-bot', version: '0.10.2' });
  });

  it('returns undefined when the package is not installed', async () => {
    const home = await makeHome();
    await expect(readInstalledPackage(home, 'dsh-lark', 'dsh-lark-bot')).resolves.toBeUndefined();
  });
});

describe('detectUpgradeState', () => {
  it('reports the installed version and no running profile process', async () => {
    const home = await makeHome();
    const manifest = join(home, 'profiles', 'dsh-lark', 'node_modules', 'dsh-lark-bot', 'package.json');
    await mkdir(join(manifest, '..'), { recursive: true });
    await writeFile(manifest, JSON.stringify({ name: 'dsh-lark-bot', version: '0.10.2' }), 'utf8');

    const state = await detectUpgradeState({
      dshHome: home,
      listProcessesFn: async () => [],
    });

    expect(state.installed?.version).toBe('0.10.2');
    expect(state.profileProcess).toBeUndefined();
    expect(state.bridgeProfile).toBe('default');
  });

  it('detects a running dsh profile process and ignores unrelated processes', async () => {
    const home = await makeHome();
    const state = await detectUpgradeState({
      dshHome: home,
      listProcessesFn: async () => [
        {
          pid: 1001,
          cmdline: 'node /home/x/@deepseek-ai/dsh/lib/bin.js --profile dsh-lark',
        },
        { pid: 1002, cmdline: 'node /pkg/dist/cli.js unrelated run' },
      ],
    });

    expect(state.profileProcess?.pid).toBe(1001);
  });

  it('never treats `dsh plugin` invocations as the profile being up', async () => {
    const home = await makeHome();
    const state = await detectUpgradeState({
      dshHome: home,
      listProcessesFn: async () => [
        {
          pid: 2001,
          cmdline: 'node /home/x/dsh/lib/bin.js plugin --profile dsh-lark add dsh-lark-bot@0.11.0',
        },
      ],
    });

    expect(state.profileProcess).toBeUndefined();
  });

  it('uses the explicit bridge profile for post-upgrade doctor checks', async () => {
    const home = await makeHome();
    const state = await detectUpgradeState({
      dshHome: home,
      bridgeProfile: 'bridge-a',
      listProcessesFn: async () => [],
    });
    expect(state.bridgeProfile).toBe('bridge-a');
  });
});
