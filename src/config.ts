import { LOCAL_EFFORTS } from './ai/catalog';
import type { ProviderConfig } from './ai/provider';

/**
 * LLM connection settings come from `.env` (see `.env.example`), for both the
 * game and the tools/tests:
 *
 * - browser: Vite injects the non-secret values as `__LLM_ENV__` at build time;
 *   `LLM_API_KEY*` never reaches the browser — the dev-server proxy adds it.
 * - node (tools/*): `process.loadEnvFile('.env')`, then `process.env`.
 *
 * Several local servers (e.g. this machine and other hosts on the LAN) can be
 * listed at once: the unsuffixed keys describe the first one, the same keys with
 * a suffix (`LLM_BASE_URL_2`, `LLM_MODELS_2`, … or `_PC`, `_MAC`) each add another.
 */
export interface LlmEnv {
  [key: string]: string | undefined;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  /** Comma-separated model ids; the first one is the default. */
  LLM_MODELS?: string;
  /** Older `.env` files: a single model id (used when LLM_MODELS is empty). */
  LLM_MODEL?: string;
  /** Optional display name of the server. */
  LLM_NAME?: string;
  LLM_REASONING?: string;
  LLM_DECISION_REASONING?: string;
  LLM_USE_PROXY?: string;
  LLM_TIMEOUT_MS?: string;
  /** Requests the local server gets at once (votes are asked together); default 1. */
  LLM_CONCURRENCY?: string;
  /** Browser only: '1' when the dev server holds an API key for the proxy. */
  LLM_HAS_KEY?: string;
}

/** One OpenAI-compatible local / LAN server and the models the game may use on it. */
export interface LocalServer {
  /** Shown in the picker: `LLM_NAME…`, else the host. */
  name: string;
  /** Identifies the server (no trailing slash). */
  baseUrl: string;
  models: string[];
  /** Requests it gets at once; default 1. */
  concurrency: number;
  /** `.env` (with its suffix, '' for the first) or added in the browser (配置 panel). */
  source: { kind: 'env'; suffix: string } | { kind: 'browser' };
  /** Node only: the plain key from `.env`. */
  apiKey?: string;
  /** The proxy injects this server's `LLM_API_KEY…`; the browser does not know the key itself. */
  keyOnServer?: boolean;
}

export interface EnvProvider {
  /** The first server: `model` is the default, the first entry of `models`. */
  config: ProviderConfig;
  /** The first server's models. */
  models: string[];
  /** Every server in `.env`, the first (unsuffixed) one first. */
  servers: LocalServer[];
  /** The proxy injects `LLM_API_KEY` for the first server. */
  keyOnServer: boolean;
  /** Required keys missing from `.env`. */
  missing: string[];
}

function level(v: string | undefined, fallback: string): string {
  const s = (v ?? '').trim().toLowerCase();
  return LOCAL_EFFORTS.includes(s) ? s : fallback;
}

/** `a, b,,a` → `['a', 'b']` */
export function parseModels(v: string | undefined): string[] {
  return [...new Set((v ?? '').split(',').map((m) => m.trim()).filter(Boolean))];
}

/** `http://host:1/v1/ ` → `http://host:1/v1` */
export function normalizeBaseUrl(v: string | undefined): string {
  return (v ?? '').trim().replace(/\/+$/, '');
}

/** `http://192.168.1.20:8001/v1` → `192.168.1.20:8001` */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export function lanes(v: string | undefined): number | undefined {
  const n = Math.floor(Number(v));
  return n >= 1 ? n : undefined;
}

/** Suffixes of the extra servers: `LLM_BASE_URL_2` → `_2`; numbers in order, then names. */
export function envSuffixes(env: LlmEnv): string[] {
  const extra = Object.keys(env)
    .map((k) => /^LLM_BASE_URL(_[A-Za-z0-9]+)$/.exec(k)?.[1])
    .filter((s): s is string => !!s);
  const num = (s: string) => (/^_\d+$/.test(s) ? Number(s.slice(1)) : Infinity);
  return ['', ...extra.sort((a, b) => num(a) - num(b) || a.localeCompare(b))];
}

/** The servers listed in `.env`; a repeated address is kept once (the first). */
export function serversFromEnv(env: LlmEnv): LocalServer[] {
  const out: LocalServer[] = [];
  for (const s of envSuffixes(env)) {
    const baseUrl = normalizeBaseUrl(env[`LLM_BASE_URL${s}`]);
    if (s && !baseUrl) continue;
    if (s && out.some((o) => o.baseUrl === baseUrl)) continue;
    const models = parseModels(env[`LLM_MODELS${s}`]?.trim() ? env[`LLM_MODELS${s}`] : s ? '' : env.LLM_MODEL);
    out.push({
      name: env[`LLM_NAME${s}`]?.trim() || hostOf(baseUrl),
      baseUrl,
      models,
      concurrency: lanes(env[`LLM_CONCURRENCY${s}`]) ?? lanes(env.LLM_CONCURRENCY) ?? 1,
      source: { kind: 'env', suffix: s },
      apiKey: (env[`LLM_API_KEY${s}`] ?? '').trim(),
      keyOnServer: env[`LLM_HAS_KEY${s}`] === '1',
    });
  }
  return out;
}

/** Address → key of every `.env` server that has one (for the dev-server proxy). */
export function envServerKeys(env: LlmEnv): Map<string, string> {
  return new Map(serversFromEnv(env).filter((s) => s.baseUrl && s.apiKey).map((s) => [s.baseUrl, s.apiKey!]));
}

export function providerFromEnv(env: LlmEnv): EnvProvider {
  const servers = serversFromEnv(env);
  const first = servers[0];
  const missing = [
    ...(first.baseUrl ? [] : ['LLM_BASE_URL']),
    ...(first.models.length ? [] : ['LLM_MODELS']),
    ...servers.slice(1).filter((s) => !s.models.length).map((s) => `LLM_MODELS${(s.source as { suffix: string }).suffix}`),
  ];
  const timeout = Number(env.LLM_TIMEOUT_MS);
  return {
    // `.env` describes the local servers (the official APIs are presets, see catalog.ts)
    config: {
      provider: 'local',
      baseUrl: first.baseUrl,
      apiKey: first.apiKey,
      model: first.models[0] ?? '',
      reasoning: level(env.LLM_REASONING, 'medium'),
      decisionReasoning: level(env.LLM_DECISION_REASONING, 'low'),
      useProxy: !/^(0|false|no|off)$/i.test((env.LLM_USE_PROXY ?? '').trim()),
      timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 180_000,
      concurrency: first.concurrency,
    },
    models: first.models,
    servers,
    keyOnServer: !!first.keyOnServer,
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

/**
 * What the browser bundle may know about `.env`: every `LLM_*` value except the
 * keys, which are replaced by `LLM_HAS_KEY…` = '1' (the proxy adds them).
 */
export function browserEnv(env: LlmEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith('LLM_') || v === undefined) continue;
    const key = /^LLM_API_KEY(_[A-Za-z0-9]+)?$/.exec(k);
    if (key) {
      if (v.trim()) out[`LLM_HAS_KEY${key[1] ?? ''}`] = '1';
    } else if (!k.startsWith('LLM_HAS_KEY')) out[k] = v;
  }
  return out;
}
