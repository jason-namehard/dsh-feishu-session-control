import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  approveBuilds,
  runSetup,
} from '../../../src/cli/commands/setup.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));


const tempDirs: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('dsh-lark-bot setup', () => {
  it('pins Corepack to the pnpm version recorded by the existing profile install', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-setup-pnpm-'));
    tempDirs.push(home);
    const profileDir = join(home, 'profile');
    await mkdir(join(profileDir, 'node_modules'), { recursive: true });
    await writeFile(
      join(profileDir, 'package.json'),
      `${JSON.stringify({ name: 'dsh-profile-demo', private: true, packageManager: 'pnpm@11.21.0' }, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      join(profileDir, 'node_modules', '.modules.yaml'),
      `${JSON.stringify({ packageManager: 'pnpm@10.33.0-rc.1+managed.2', storeDir: '/store/v10' }, null, 2)}\n`,
      'utf8',
    );

    await approveBuilds(profileDir);

    const profilePackage = JSON.parse(
      await readFile(join(profileDir, 'package.json'), 'utf8'),
    ) as { packageManager?: string };
    expect(profilePackage.packageManager).toBe('pnpm@10.33.0-rc.1+managed.2');
  });

  it('does not create package.json for a fresh profile without pnpm install metadata', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-setup-fresh-'));
    tempDirs.push(home);

    await approveBuilds(home);

    await expect(readFile(join(home, 'package.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('pre-approves pnpm builds and installs the bundle', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-setup-'));
    tempDirs.push(home);
    const pkg = JSON.parse(
      await readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    const stdout: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const spawnMock = vi.mocked(spawn);
      spawnMock.mockImplementation((() => {
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('exit', 0));
        return child as unknown as ReturnType<typeof spawn>;
      }) as never);

      await runSetup({
        profile: 'demo',
        webProfile: false,
        dshHome: home,
        bin: '/fake/dsh/bin.js',
      });

      const workspaceYaml = await readFile(join(home, 'profiles', 'demo', 'pnpm-workspace.yaml'), 'utf8');
      expect(workspaceYaml).toContain('allowBuilds:');
      expect(workspaceYaml).toContain('protobufjs: true');
      expect(spawnMock).toHaveBeenCalledWith(
        'node',
        ['/fake/dsh/bin.js', 'plugin', '--profile', 'demo', 'add', `dsh-lark-bot@${pkg.version}`],
        { stdio: 'inherit', env: expect.objectContaining({ DSH_HOME: home }) },
      );
      expect(stdout.join('')).toContain('dsh --profile demo');
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  it('honours an explicit package spec instead of the pinned version', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-setup-spec-'));
    tempDirs.push(home);
    const stdout: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const spawnMock = vi.mocked(spawn);
      spawnMock.mockImplementation((() => {
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('exit', 0));
        return child as unknown as ReturnType<typeof spawn>;
      }) as never);

      await runSetup({
        profile: 'demo',
        webProfile: false,
        dshHome: home,
        bin: '/fake/dsh/bin.js',
        packageSpec: '/tmp/dsh-lark-bot-0.9.1.tgz',
      });

      expect(spawnMock).toHaveBeenCalledWith(
        'node',
        ['/fake/dsh/bin.js', 'plugin', '--profile', 'demo', 'add', '/tmp/dsh-lark-bot-0.9.1.tgz'],
        { stdio: 'inherit', env: expect.objectContaining({ DSH_HOME: home }) },
      );
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  it('installs the same bundle into the bridge and Web profiles by default', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-setup-both-'));
    tempDirs.push(home);
    const spawnMock = vi.mocked(spawn);
    spawnMock.mockImplementation((() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0));
      return child as unknown as ReturnType<typeof spawn>;
    }) as never);

    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await runSetup({
        profile: 'demo',
        dshHome: home,
        bin: '/fake/dsh/bin.js',
      });

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(spawnMock).toHaveBeenNthCalledWith(
        1,
        'node',
        ['/fake/dsh/bin.js', 'plugin', '--profile', 'demo', 'add', expect.stringMatching(/^dsh-lark-bot@/u)],
        { stdio: 'inherit', env: expect.objectContaining({ DSH_HOME: home }) },
      );
      expect(spawnMock).toHaveBeenNthCalledWith(
        2,
        'node',
        ['/fake/dsh/bin.js', 'plugin', '--profile', 'web', 'add', expect.stringMatching(/^dsh-lark-bot@/u)],
        { stdio: 'inherit', env: expect.objectContaining({ DSH_HOME: home }) },
      );
      await expect(readFile(join(home, 'profiles', 'web', 'pnpm-workspace.yaml'), 'utf8'))
        .resolves.toContain('allowBuilds:');
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});
