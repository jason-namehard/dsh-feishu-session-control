/**
 * Single source of truth for the DeepSeek Harness compatibility matrix.
 *
 * Managed runtimes and the compatibility probe use exact pre-release versions.
 * The host plugin's supported versions are declared in package peer dependencies.
 * When updating this matrix, run `pnpm ci:local` and the compatibility probe,
 * then refresh `verifiedAt`. See `docs/COMPATIBILITY.md`.
 */
export interface DshCompatibility {
  /** DeepSeek Harness CLI (`dsh`) version verified against this bot release. */
  harness: string;
  /** `@deepseek-ai/dsh-sdk-client` version used by the compatibility probe. */
  sdkClient: string;
  /** `@deepseek-ai/dsh-sdk-jsonrpc-server` version installed into SDK runtime profiles. */
  sdkServer: string;
  /** `@deepseek-ai/dsh-acp` version installed into ACP runtime profiles. */
  acp: string;
  /** Node.js engine requirement. */
  node: string;
  /** ISO date of the last end-to-end verification. */
  verifiedAt: string;
}

export const DSH_COMPATIBILITY: DshCompatibility = {
  harness: '0.1.5-rc.3',
  sdkClient: '0.1.5-rc.3',
  sdkServer: '0.1.5-rc.3',
  acp: '0.1.5-rc.3',
  node: '>=22.19.0',
  verifiedAt: '2026-09-13',
};
