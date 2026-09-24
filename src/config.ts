import type { ProviderConfig, ReasoningLevel } from './ai/provider';

/**
 * LLM connection settings come from `.env` (see `.env.example`), for both the
 * game and the tools/tests:
 *
 * - browser: Vite injects the non-secret values as `__LLM_ENV__` at build time;
 *   `LLM_API_KEY` never reaches the browser — the dev-server proxy adds it.
 * - node (tools/*): `process.loadEnvFile('.env')`, then `process.env`.
 */
export interface LlmEnv {
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_REASONING?: string;
  LLM_DECISION_REASONING?: string;
  LLM_USE_PROXY?: string;
  LLM_TIMEOUT_MS?: string;
  /** Browser only: '1' when the dev server holds an API key for the proxy. */
  LLM_HAS_KEY?: string;
}

export interface EnvProvider {
  config: ProviderConfig;
  /** The proxy injects `LLM_API_KEY`; the browser does not know the key itself. */
  keyOnServer: boolean;
  /** Required keys missing from `.env`. */
  missing: string[];
}

const LEVELS: ReasoningLevel[] = ['none', 'low', 'medium', 'high'];

function level(v: string | undefined, fallback: ReasoningLevel): ReasoningLevel {
  const s = (v ?? '').trim().toLowerCase() as ReasoningLevel;
  return LEVELS.includes(s) ? s : fallback;
}

export function providerFromEnv(env: LlmEnv): EnvProvider {
  const missing = (['LLM_BASE_URL', 'LLM_MODEL'] as const).filter((k) => !env[k]?.trim());
  const timeout = Number(env.LLM_TIMEOUT_MS);
  return {
    config: {
      baseUrl: (env.LLM_BASE_URL ?? '').trim().replace(/\/+$/, ''),
      apiKey: (env.LLM_API_KEY ?? '').trim(),
      model: (env.LLM_MODEL ?? '').trim(),
      reasoning: level(env.LLM_REASONING, 'medium'),
      decisionReasoning: level(env.LLM_DECISION_REASONING, 'low'),
      useProxy: !/^(0|false|no|off)$/i.test((env.LLM_USE_PROXY ?? '').trim()),
      timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 180_000,
    },
    keyOnServer: env.LLM_HAS_KEY === '1',
    missing,
  };
}

declare const __LLM_ENV__: LlmEnv | undefined;

/** Settings from `.env` for the current runtime (browser build or node). */
export function envProvider(): EnvProvider {
  if (typeof __LLM_ENV__ !== 'undefined') return providerFromEnv(__LLM_ENV__);
  const proc = (globalThis as { process?: { env: Record<string, string | undefined> } }).process;
  return providerFromEnv(proc?.env ?? {});
}
