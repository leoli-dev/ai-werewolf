/** OpenAI-compatible chat completion adapter. */
import { PROVIDERS, buildChatBody, clampEffort, effortsFor, lanFetchInit, type ProviderId } from './catalog';

export interface ProviderConfig {
  /** Which entry of the provider matrix (decides the request dialect). */
  provider: ProviderId;
  baseUrl: string;
  /** Plain key, for node tools only; the browser reads keys from the vault via `keySource`. */
  apiKey?: string;
  model: string;
  /** Official reasoning value for speeches ('' = model has no reasoning control). */
  reasoning: string;
  /** Reasoning for votes, night skills and wolf chat (short, frequent calls). */
  decisionReasoning: string;
  /** Route through the Vite dev server (`/__llm`) to avoid CORS on local servers. */
  useProxy: boolean;
  timeoutMs: number;
  /** Requests in flight at once (votes go out together); 1 = strictly one at a time. Default 1. */
  concurrency?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  content: string;
  reasoning?: string;
  ms: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class ProviderError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
  /** Server overload / OOM (e.g. MTPLX 507) or network blips are worth retrying after a pause. */
  get retryable() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

/** Supplies the API key for a provider at request time (null = none / locked). */
export type KeySource = (provider: ProviderId) => Promise<string | null>;

/** A key only ever goes to its own provider's official address (local servers: any of them). */
export function keyMayGoTo(provider: ProviderId, baseUrl: string): boolean {
  const preset = PROVIDERS[provider];
  if (preset.fromEnv) return true;
  try {
    return new URL(baseUrl).origin === new URL(preset.baseUrl).origin;
  } catch {
    return false;
  }
}

/** The `/__llm` proxy only exists on the Vite dev server (not in a static build such as GitHub Pages). */
export const PROXY_AVAILABLE = import.meta.env?.DEV === true;

export class OpenAICompatibleProvider {
  constructor(public config: ProviderConfig, private keySource?: KeySource) {}

  private async key(): Promise<string | null> {
    const { provider, baseUrl } = this.config;
    const key = this.keySource ? await this.keySource(provider) : this.config.apiKey || null;
    if (!key) {
      if (PROVIDERS[provider].needsKey) throw new ProviderError(`未设置 ${PROVIDERS[provider].label} 的 API Key，或密钥库未解锁（配置 → AI 引擎）`, 401);
      return null;
    }
    if (!keyMayGoTo(provider, baseUrl)) throw new ProviderError(`拒绝把 ${PROVIDERS[provider].label} 的 Key 发往非官方地址 ${baseUrl}`, 400);
    return key;
  }

  private async url(path: string): Promise<{ url: string; headers: Record<string, string> }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const key = await this.key();
    if (key) headers.Authorization = `Bearer ${key}`;
    const base = this.config.baseUrl.replace(/\/+$/, '');
    if (this.config.useProxy && PROXY_AVAILABLE) {
      headers['x-llm-base'] = base;
      return { url: `/__llm${path}`, headers };
    }
    return { url: base + path, headers };
  }

  private async request(path: string, init: { method: string; body?: unknown }, timeoutMs = this.config.timeoutMs) {
    const { url, headers } = await this.url(path);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...lanFetchInit(url),
        method: init.method,
        headers,
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ProviderError(`HTTP ${res.status}: 非 JSON 响应 ${text.slice(0, 200)}`, res.status);
      }
      if (!res.ok) throw new ProviderError(`HTTP ${res.status}: ${json?.error?.message ?? text.slice(0, 200)}`, res.status);
      return json;
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new ProviderError(`请求超时（${Math.round(timeoutMs / 1000)}s）`, 408);
      if (e instanceof ProviderError) throw e;
      throw new ProviderError(`网络错误：${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async listModels(): Promise<string[]> {
    const json = await this.request('/models', { method: 'GET' }, 15_000);
    return (json?.data ?? []).map((m: { id: string }) => m.id);
  }

  async chat(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; reasoning?: string } = {}): Promise<ChatResult> {
    const { provider, model } = this.config;
    // never send a value the model does not accept (e.g. after switching models)
    const efforts = effortsFor(provider, model);
    const want = opts.reasoning ?? this.config.reasoning;
    const body = buildChatBody({
      dialect: PROVIDERS[provider].dialect,
      model,
      messages,
      maxTokens: opts.maxTokens ?? 1500,
      temperature: opts.temperature ?? 0.9,
      effort: clampEffort(want, efforts),
    });
    const t0 = performance.now();
    const json = await this.request('/chat/completions', { method: 'POST', body });
    const msg = json?.choices?.[0]?.message ?? {};
    const content = stripThinking(String(msg.content ?? ''));
    return {
      content,
      reasoning: msg.reasoning_content ?? msg.reasoning,
      ms: performance.now() - t0,
      usage: json?.usage,
    };
  }

  /** Connectivity test: list models + one tiny completion. */
  async test(): Promise<{ ok: boolean; message: string; models?: string[] }> {
    let models: string[] | undefined;
    try {
      models = await this.listModels();
    } catch (e) {
      // some providers do not implement /models — keep going
      models = undefined;
      if (!(e instanceof ProviderError)) throw e;
    }
    try {
      const r = await this.chat([{ role: 'user', content: '只回复两个字：在线' }], { maxTokens: 400 });
      return {
        ok: true,
        message: `连接成功，${Math.round(r.ms)}ms，回复：「${r.content.slice(0, 30)}」`,
        models,
      };
    } catch (e) {
      return { ok: false, message: (e as Error).message, models };
    }
  }
}

/** Some models inline their chain-of-thought as <think>…</think>. */
export function stripThinking(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*<\/think>/, '').trim();
}

/**
 * FIFO for all AI calls with a cap on how many are in flight. Speeches still come
 * one at a time (each speaker waits for the one before); simultaneous decisions
 * (votes, 上警, 退水) are asked together and run side by side up to the cap: a
 * cloud API takes them all at once, a local server one by one. `limit` is read
 * per call, so a provider switched mid-game applies at once.
 */
export class RequestQueue {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private limit: () => number = () => 1) {}

  get pending() {
    return this.active + this.waiting.length;
  }

  private get cap() {
    return Math.max(1, Math.floor(this.limit()) || 1);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.cap) this.active++;
    else await new Promise<void>((r) => this.waiting.push(r)); // the slot is handed over, already counted
    try {
      return await fn();
    } finally {
      // pass the slot on, unless the cap has since been lowered
      if (this.waiting.length && this.active <= this.cap) this.waiting.shift()!();
      else this.active--;
    }
  }
}

/** Requests in flight for a provider config. */
export function concurrencyOf(config: Pick<ProviderConfig, 'concurrency'>): number {
  return config.concurrency ?? 1;
}
