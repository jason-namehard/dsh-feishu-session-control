/**
 * Service restart helpers for `dsh-lark-bot upgrade`.
 *
 * Restarting the dsh profile process itself is an explicit opt-in
 * (`--restart`): interactive terminal sessions cannot be meaningfully
 * "restarted" by another process, so this only targets detached / managed
 * profile processes and always explains the manual alternative.
 */

import { homedir } from 'node:os';
import {
  findProfileProcess,
  spawnDetached,
  type DetachedSpawn,
} from '../platform/process.js';
import { discoverDshBin } from '../config/dsh-runtime.js';
import { restartInstalledProfileService } from '../service/integration.js';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunFn = (
  command: string,
  args: readonly string[],
) => Promise<RunResult>;

export interface RestartProfileOptions {
  dshBin?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: typeof spawnDetached;
  findProcess?: typeof findProfileProcess;
  /** Extra args appended to the relaunch (e.g. environment passthrough). */
  extraArgs?: readonly string[];
  restartManagedService?: typeof restartInstalledProfileService;
}

export interface RestartProfileResult {
  ok: boolean;
  message: string;
}

export async function restartProfileProcess(
  profile: string,
  options: RestartProfileOptions = {},
): Promise<RestartProfileResult> {
  const managed = await (
    options.restartManagedService ?? restartInstalledProfileService
  )(profile, {
    ...(options.env ? { env: options.env } : {}),
    ...(options.home ? { home: options.home } : {}),
    respectIntent: false,
  });
  if (managed.installed) {
    return managed.restarted
      ? { ok: true, message: `已通过后台服务重启 dsh --profile ${profile}。` }
      : { ok: false, message: `后台服务重启失败：${managed.detail}` };
  }
  const findProcess = options.findProcess ?? findProfileProcess;
  const proc = await findProcess(profile);
  if (!proc) {
    return {
      ok: false,
      message: `未发现运行中的 dsh profile 进程（${profile}），无需重启。`,
    };
  }
  const bin =
    options.dshBin ??
    discoverDshBin(options.home ?? homedir(), options.env ?? process.env);
  if (!bin) {
    return {
      ok: false,
      message: `未找到 dsh 启动入口，无法自动重启。请手动执行：dsh --profile ${profile}`,
    };
  }
  try {
    process.kill(proc.pid, 'SIGTERM');
  } catch (error) {
    return {
      ok: false,
      message: `终止旧进程失败（pid ${proc.pid}）：${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  // Give the old process a moment to release its resources (Feishu channel,
  // runtime subprocesses) before relaunching.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const spawn = options.spawn ?? spawnDetached;
  const spawned: DetachedSpawn = spawn('node', [
    bin,
    '--profile',
    profile,
    ...(options.extraArgs ?? []),
  ]);
  return spawned.pid !== undefined
    ? {
        ok: true,
        message: `旧进程已终止（pid ${proc.pid}），已重新拉起 dsh --profile ${profile}（pid ${spawned.pid}，后台运行）。`,
      }
    : {
        ok: false,
        message: `旧进程已终止（pid ${proc.pid}），但自动重启失败。请手动执行：dsh --profile ${profile}`,
      };
}
