import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { providerFromEnv } from './config';

describe('providerFromEnv', () => {
  it('reads every field', () => {
    const { config, missing, keyOnServer } = providerFromEnv({
      LLM_BASE_URL: 'http://host:9000/v1/',
      LLM_API_KEY: 'sk-x',
      LLM_MODEL: 'm',
      LLM_REASONING: 'HIGH',
      LLM_DECISION_REASONING: 'none',
      LLM_USE_PROXY: 'false',
      LLM_TIMEOUT_MS: '5000',
      LLM_HAS_KEY: '1',
    });
    expect(config).toEqual({ baseUrl: 'http://host:9000/v1', apiKey: 'sk-x', model: 'm', reasoning: 'high', decisionReasoning: 'none', useProxy: false, timeoutMs: 5000 });
    expect(missing).toEqual([]);
    expect(keyOnServer).toBe(true);
  });

  it('reports missing required keys and falls back sensibly', () => {
    const { config, missing } = providerFromEnv({ LLM_REASONING: 'bogus', LLM_TIMEOUT_MS: 'x' });
    expect(missing).toEqual(['LLM_BASE_URL', 'LLM_MODEL']);
    expect(config.reasoning).toBe('medium');
    expect(config.decisionReasoning).toBe('low');
    expect(config.useProxy).toBe(true);
    expect(config.timeoutMs).toBe(180_000);
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
});
