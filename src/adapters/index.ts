import { homedir } from 'node:os';
import type { RuntimeEnv } from '../config/env.js';
import { DshProviderManager, type DshModelSelection } from '../config/dsh-config.js';
import { DshAdapter } from './dsh/adapter.js';
import { SdkDshAdapter } from './dsh/sdk-adapter.js';
import { ensureSdkProfile, resolveSdkLaunch } from './dsh/sdk-runtime.js';
import { HostDshAdapter } from './dsh/host-adapter.js';
import type { HostContextLike } from './dsh/host-services.js';
import { WebDshAdapter } from './dsh/web-adapter.js';
import { resolveModelChoice } from './model-choice.js';
import type { AgentAdapter } from './types.js';

export interface AdapterPreferences {
  stopGraceMs: number | undefined;
  model: string | undefined;
  /**
   * The cordis context when the bridge runs as a plugin inside dsh. Its
   * presence is what lets `web` upgrade itself to the in-process transport.
   */
  hostContext?: HostContextLike;
}

type AdapterRouteSource = Pick<
  DshProviderManager,
  'defaultModelSelection' | 'resolveModelRoute'
>;

/** Resolve the startup route before provisioning SDK/ACP managed runtimes. */
export async function resolveAdapterRoute(
  input: { provider: string | undefined; model: string | undefined },
  source: Pick<AdapterRouteSource, 'defaultModelSelection'> &
    Partial<Pick<AdapterRouteSource, 'resolveModelRoute'>>,
): Promise<DshModelSelection | undefined> {
  const provider = input.provider?.trim() || undefined;
  const model = input.model?.trim() || undefined;
  if (provider && model) return { provider, model };
  if (model && source.resolveModelRoute) {
    const resolved = await source.resolveModelRoute(model);
    if (resolved) return resolved;
  }
  const fallback = await source.defaultModelSelection();
  if (!provider && !model) return fallback;
  if (provider && !model && fallback?.provider === provider) {
    return { provider, model: fallback.model };
  }
  if (!provider && model && fallback?.model === model) {
    return { provider: fallback.provider, model };
  }
  return undefined;
}

/**
 * Build the agent adapter for the configured mode:
 * - `web` (default): drive dsh's own sessions as their single writer. In-process
 *   when the bridge is mounted inside dsh (`preferences.hostContext`), which is
 *   both faster and immune to the web transport's version drift; otherwise over
 *   the local web HTTP API.
 * - `host`: require the in-process transport and fail loudly without it.
 * - `sdk`: official `@deepseek-ai/dsh-sdk-client` runtime.
 * - `acp`: official ACP server runtime with approval cards.
 * - `headless`: legacy subprocess fallback (kept for compatibility).
 */
export async function buildAgentAdapter(
  env: RuntimeEnv,
  preferences: AdapterPreferences = { stopGraceMs: undefined, model: undefined },
): Promise<AgentAdapter> {
  // A blank `preferences.model` (the fresh-install default) must be treated as
  // unset so it falls back to `env.model` (DSH_LARK_MODEL) instead of producing
  // an empty AgentOptions.model that fails startup (issue #112 Bug C).
  const configuredModel = resolveModelChoice(preferences.model, env.model);
  const managedRoute = env.adapterMode === 'sdk' || env.adapterMode === 'acp'
    ? await resolveAdapterRoute(
        { provider: env.provider, model: configuredModel },
        new DshProviderManager({ env: process.env }),
      )
    : undefined;
  if ((env.adapterMode === 'sdk' || env.adapterMode === 'acp') && !managedRoute) {
    throw new Error(
      'SDK/ACP runtime requires a provider/model route. Set DSH_LARK_PROVIDER and ' +
        'DSH_LARK_MODEL, or configure object-form dsh agent-default-model { provider, model }.',
    );
  }
  switch (env.adapterMode) {
    case 'headless': {
      const options: ConstructorParameters<typeof DshAdapter>[0] = {
        command: env.dshCommand,
        args: env.dshArgs,
      };
      if (preferences.stopGraceMs !== undefined) {
        options.stopGraceMs = preferences.stopGraceMs;
      }
      return new DshAdapter(options);
    }
    case 'acp': {
      const { buildAcpAgentAdapter } = await import('./dsh/acp-adapter.js');
      return buildAcpAgentAdapter(
        { ...env, provider: managedRoute!.provider, model: managedRoute!.model },
        { ...preferences, model: managedRoute!.model },
      );
    }
    case 'host':
    case 'web': {
      const model = resolveModelChoice(preferences.model, env.model);
      // Use the in-process transport whenever this process hosts dsh: calling
      // the local web server from inside it buys nothing and puts browser
      // authentication, RPC naming and the event-mux endpoint back on the
      // compatibility surface (all three moved in 0.1.2-rc.1).
      //
      // The presence of a host context is the decision, not a probe for the
      // agent registry: services appear asynchronously during boot, so a
      // one-shot check here could lose a race and silently downgrade to HTTP.
      // A dsh host with no agent registry cannot serve sessions over its own
      // web API either, so there is nothing to fall back to — HostServices
      // reports that case with an actionable error instead.
      if (preferences.hostContext) {
        return new HostDshAdapter({
          ctx: preferences.hostContext,
          provider: env.provider,
          model,
        });
      }
      if (env.adapterMode === 'host') {
        throw new Error(
          'DSH_LARK_ADAPTER=host requires running as a plugin inside dsh; ' +
            'use "web" to reach a separate dsh web server over HTTP, or "sdk" ' +
            'for the managed runtime.',
        );
      }
      return new WebDshAdapter({
        baseUrl: env.webBaseUrl,
        provider: env.provider,
        model,
      });
    }
    case 'sdk':
    default: {
      const runtimeOptions = {
        home: homedir(),
        env: process.env,
        ...(env.dshExplicit
          ? { command: env.dshCommand, args: env.dshArgs }
          : {}),
      };
      const ensure = await ensureSdkProfile(runtimeOptions);
      if (!ensure.ok) {
        throw new Error(
          `SDK runtime profile setup failed: ${ensure.error ?? 'unknown error'} ` +
            '(install pnpm, or set DSH_LARK_ADAPTER=headless for the legacy adapter)',
        );
      }
      const launch = resolveSdkLaunch(runtimeOptions);
      return new SdkDshAdapter({
        launch,
        provider: managedRoute!.provider,
        model: managedRoute!.model,
        ...(env.maxTokens === undefined ? {} : { maxTokens: env.maxTokens }),
      });
    }
  }
}
