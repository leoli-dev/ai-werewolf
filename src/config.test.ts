import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { browserEnv, envServerKeys, providerFromEnv } from './config';

describe('providerFromEnv', () => {
  it('reads every field', () => {
    const { config, missing, keyOnServer } = providerFromEnv({
      LLM_BASE_URL: 'http://host:9000/v1/',
      LLM_API_KEY: 'sk-x',
      LLM_MODELS: ' m, n ,,m',
      LLM_REASONING: 'HIGH',
      LLM_DECISION_REASONING: 'none',
      LLM_USE_PROXY: 'false',
      LLM_TIMEOUT_MS: '5000',
      LLM_CONCURRENCY: '4',
      LLM_HAS_KEY: '1',
    });
    expect(config).toEqual({ provider: 'local', baseUrl: 'http://host:9000/v1', apiKey: 'sk-x', model: 'm', reasoning: 'high', decisionReasoning: 'none', useProxy: false, timeoutMs: 5000, concurrency: 4 });
    expect(missing).toEqual([]);
    expect(keyOnServer).toBe(true);
    expect(providerFromEnv({ LLM_MODELS: ' m, n ,,m' }).models).toEqual(['m', 'n']);
  });

  it('accepts an older single LLM_MODEL', () => {
    const { config, models, missing } = providerFromEnv({ LLM_BASE_URL: 'http://h/v1', LLM_MODEL: 'old' });
    expect(models).toEqual(['old']);
    expect(config.model).toBe('old');
    expect(missing).toEqual([]);
    // LLM_MODELS wins when both are set
    expect(providerFromEnv({ LLM_MODELS: 'a,b', LLM_MODEL: 'old' }).models).toEqual(['a', 'b']);
  });

  it('reports missing required keys and falls back sensibly', () => {
    const { config, missing } = providerFromEnv({ LLM_REASONING: 'bogus', LLM_TIMEOUT_MS: 'x' });
    expect(missing).toEqual(['LLM_BASE_URL', 'LLM_MODELS']);
    expect(config.reasoning).toBe('medium');
    expect(config.decisionReasoning).toBe('low');
    expect(config.useProxy).toBe(true);
    expect(config.timeoutMs).toBe(180_000);
    expect(config.concurrency).toBe(1); // one request at a time unless .env says otherwise
  });

  it('the committed .env.example is complete', () => {
    const env = Object.fromEntries(
      readFileSync('.env.example', 'utf8')
        .split('\n')
        .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
    );
    expect(providerFromEnv(env).missing).toEqual([]);
  });

  it('lists extra servers from suffixed keys, the unsuffixed one first', () => {
    const { servers, config, missing } = providerFromEnv({
      LLM_BASE_URL_PC: 'http://pc.lan:1234/v1',
      LLM_MODELS_PC: 'qwen3-8b',
      LLM_BASE_URL_10: 'http://192.168.1.30:8000/v1',
      LLM_MODELS_10: 'x',
      LLM_BASE_URL_2: 'http://192.168.1.20:8001/v1/',
      LLM_MODELS_2: 'qwen3-32b, qwen3-14b',
      LLM_NAME_2: '书房',
      LLM_CONCURRENCY_2: '3',
      LLM_API_KEY_2: 'sk-2',
      LLM_BASE_URL: 'http://127.0.0.1:8001/v1',
      LLM_MODELS: 'mtplx',
      LLM_CONCURRENCY: '2',
    });
    expect(servers.map((s) => s.baseUrl)).toEqual(['http://127.0.0.1:8001/v1', 'http://192.168.1.20:8001/v1', 'http://192.168.1.30:8000/v1', 'http://pc.lan:1234/v1']);
    expect(servers[1]).toMatchObject({ name: '书房', models: ['qwen3-32b', 'qwen3-14b'], concurrency: 3, apiKey: 'sk-2', source: { kind: 'env', suffix: '_2' } });
    // name defaults to the host, concurrency to LLM_CONCURRENCY
    expect(servers[3]).toMatchObject({ name: 'pc.lan:1234', concurrency: 2 });
    // the first server stays what the tools use
    expect(config).toMatchObject({ baseUrl: 'http://127.0.0.1:8001/v1', model: 'mtplx', concurrency: 2 });
    expect(missing).toEqual([]);
  });

  it('skips empty or repeated extra addresses and reports extra servers without models', () => {
    const { servers, missing } = providerFromEnv({ LLM_BASE_URL: 'http://a/v1', LLM_MODELS: 'm', LLM_BASE_URL_2: '', LLM_BASE_URL_3: 'http://a/v1/', LLM_MODELS_3: 'n', LLM_BASE_URL_4: 'http://b/v1' });
    expect(servers.map((s) => s.baseUrl)).toEqual(['http://a/v1', 'http://b/v1']);
    expect(missing).toEqual(['LLM_MODELS_4']);
  });

  it('keeps every key out of the browser and maps each to its own address', () => {
    const env = { LLM_BASE_URL: 'http://a/v1', LLM_API_KEY: 'sk-a', LLM_BASE_URL_2: 'http://b/v1/', LLM_API_KEY_2: 'sk-b', LLM_API_KEY_3: '', LLM_MODELS: 'm', OTHER: 'x' };
    const out = browserEnv(env);
    expect(JSON.stringify(out)).not.toContain('sk-');
    expect(out).toEqual({ LLM_BASE_URL: 'http://a/v1', LLM_HAS_KEY: '1', LLM_BASE_URL_2: 'http://b/v1/', LLM_HAS_KEY_2: '1', LLM_MODELS: 'm' });
    expect(providerFromEnv(out).servers.map((s) => s.keyOnServer)).toEqual([true, true]);
    expect([...envServerKeys(env)]).toEqual([['http://a/v1', 'sk-a'], ['http://b/v1', 'sk-b']]);
  });
});
