import { spawn } from 'node:child_process';

export interface ProfileProcess {
  pid: number;
  ppid?: number;
  cmdline: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasProfileFlag(cmdline: string, dshProfile: string): boolean {
  const pattern = new RegExp(
    `(?:^|\\s)--profile(?:\\s+|=)${escapeRegExp(dshProfile)}(?:\\s|$)`,
  );
  return pattern.test(cmdline);
}

export function looksLikeDshProcess(cmdline: string): boolean {
  return (
    cmdline.includes('@deepseek-ai/dsh') ||
    /(?:^|[\s/])dsh(?:\.exe)?(?:\s|$)/.test(cmdline)
  );
}

export function matchProfileProcess(
  cmdline: string,
  dshProfile: string,
): boolean {
  if (/(?:^|\s)plugin(?:\s|$)/.test(cmdline)) return false;
  return hasProfileFlag(cmdline, dshProfile) && looksLikeDshProcess(cmdline);
}

export async function listProcesses(
  platform: NodeJS.Platform = process.platform,
  run: typeof captureOutput = captureOutput,
): Promise<ProfileProcess[]> {
  return platform === 'win32'
    ? listProcessesWindows(run)
    : listProcessesPosix(run);
}

async function listProcessesPosix(
  run: typeof captureOutput,
): Promise<ProfileProcess[]> {
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,args='], 10_000);
  const result: ProfileProcess[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (Number.isInteger(ppid) && ppid > 0) {
      result.push({ pid, ppid, cmdline: match[3] ?? '' });
    } else {
      result.push({ pid, cmdline: match[3] ?? '' });
    }
  }
  return result;
}

async function listProcessesWindows(
  run: typeof captureOutput,
): Promise<ProfileProcess[]> {
  const { stdout } = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress',
    ],
    10_000,
  );
  try {
    const parsed: unknown = JSON.parse(stdout);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap((row): ProfileProcess[] => {
      if (typeof row !== 'object' || row === null) return [];
      const record = row as Record<string, unknown>;
      const pid = Number(record.ProcessId);
      const ppid = Number(record.ParentProcessId);
      const cmdline = record.CommandLine;
      if (!Number.isInteger(pid) || pid <= 0 || typeof cmdline !== 'string') return [];
      return Number.isInteger(ppid) && ppid > 0
        ? [{ pid, ppid, cmdline }]
        : [{ pid, cmdline }];
    });
  } catch {
    return [];
  }
}

export async function captureOutput(
  command: string,
  args: readonly string[],
  timeoutMs: number = 30_000,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; umask?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const previousUmask = options.umask !== undefined && process.platform !== 'win32'
      ? process.umask(options.umask)
      : undefined;
    const child = (() => {
      try {
        return spawn(command, [...args], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.env ? { env: options.env } : {}),
        });
      } finally {
        if (previousUmask !== undefined) process.umask(previousUmask);
      }
    })();
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', () => finish(1));
    child.on('close', (code) => finish(code ?? 1));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(1);
    }, timeoutMs);
    child.once('close', () => clearTimeout(timer));
  });
}

export async function findProfileProcess(
  dshProfile: string,
): Promise<ProfileProcess | undefined> {
  const processes = await listProcesses();
  return processes.find((entry) => matchProfileProcess(entry.cmdline, dshProfile));
}

export interface DetachedSpawn {
  pid?: number | undefined;
}

export function spawnDetached(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): DetachedSpawn {
  const child = spawn(command, [...args], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true,
    env: { ...env },
  });
  if (child.pid !== undefined && process.platform !== 'win32') child.unref();
  return { pid: child.pid };
}
