/**
 * Read-only detection of the current installation state for `dsh-lark-bot
 * upgrade`: which package version is installed in the dsh profile, which
 * version the running CLI is, and whether the dsh profile is currently up.
 *
 * Nothing here mutates anything — the command composes these facts to decide
 * what (if anything) needs upgrading and how to surface running-instance
 * guidance safely.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ownPackageInfo, type OwnPackageInfo } from '../adapters/dsh/own-package.js';
import { resolveDshHome } from '../config/dsh-runtime.js';
import {
  listProcesses,
  matchProfileProcess,
  type ProfileProcess,
} from '../platform/process.js';

export interface InstalledPackageInfo {
  name: string;
  version: string;
  root: string;
}

export interface UpgradeDetection {
  /** The CLI package currently executing this command. */
  own: OwnPackageInfo;
  /** The package version installed inside the dsh profile (if any). */
  installed: InstalledPackageInfo | undefined;
  dshHome: string;
  profile: string;
  /** A running `dsh --profile <name>` process, if any. */
  profileProcess: ProfileProcess | undefined;
  /** Bridge configuration profile checked by doctor after the upgrade. */
  bridgeProfile: string;
}

export interface DetectUpgradeStateOptions {
  profile?: string;
  dshHome?: string;
  bridgeProfile?: string;
  /** Injectable process lister (tests). */
  listProcessesFn?: typeof listProcesses;
}

/**
 * Read the installed package manifest from the profile's node_modules.
 * Follows symlinks, so both pnpm layouts and direct installs resolve.
 */
export async function readInstalledPackage(
  dshHome: string,
  profile: string,
  packageName: string,
): Promise<InstalledPackageInfo | undefined> {
  const manifest = join(
    dshHome,
    'profiles',
    profile,
    'node_modules',
    packageName,
    'package.json',
  );
  try {
    const raw = await readFile(manifest, 'utf8');
    const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
    if (typeof parsed.name !== 'string' || typeof parsed.version !== 'string') {
      return undefined;
    }
    return { name: parsed.name, version: parsed.version, root: join(manifest, '..') };
  } catch {
    return undefined;
  }
}

export async function detectUpgradeState(
  options: DetectUpgradeStateOptions = {},
): Promise<UpgradeDetection> {
  const own = ownPackageInfo();
  const dshHome = options.dshHome ?? resolveDshHome(homedir(), process.env);
  const profile = options.profile ?? 'dsh-lark';
  const bridgeProfile = options.bridgeProfile ?? process.env.DSH_LARK_PROFILE ?? 'default';

  const installed = await readInstalledPackage(dshHome, profile, own.name);
  const list = options.listProcessesFn ?? listProcesses;
  const processes = await list();
  const profileProcess = processes.find((entry) =>
    matchProfileProcess(entry.cmdline, profile),
  );
  return {
    own,
    installed,
    dshHome,
    profile,
    profileProcess,
    bridgeProfile,
  };
}
