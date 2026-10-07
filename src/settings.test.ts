import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addServer, getConfig, loadGamePrefs, localServers, removeServer, resolveProvider, saveGamePrefs, updateProfile } from './settings';

describe('AI autoplay preferences', () => {
  beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps manual control for new users and legacy preferences', () => {
    expect(loadGamePrefs().autoPlay).toBe(false);
    localStorage.setItem('ai-werewolf:settings:v1', JSON.stringify({ playerName: '旧玩家', role: 'seer', godView: true }));
    expect(loadGamePrefs()).toMatchObject({ playerName: '旧玩家', role: 'seer', godView: true, autoPlay: false });
  });

  it('remembers enabling and disabling autoplay independently of god view', () => {
    saveGamePrefs({ ...loadGamePrefs(), autoPlay: true, godView: false });
    expect(loadGamePrefs()).toMatchObject({ autoPlay: true, godView: false });
    saveGamePrefs({ ...loadGamePrefs(), autoPlay: false });
    expect(loadGamePrefs().autoPlay).toBe(false);
  });
});

describe('local / LAN servers', () => {
  beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('adds a server, switches to it and falls back when it is removed', () => {
    const envFirst = localServers()[0];
    expect(envFirst.source).toEqual({ kind: 'env', suffix: '' });
    expect(addServer({ baseUrl: 'ftp://x', models: ['m'] })).toBeNull();
    expect(addServer({ baseUrl: 'http://192.168.1.20:8001/v1', models: [] })).toBeNull();

    const added = addServer({ baseUrl: 'http://192.168.1.20:8001/v1/', models: [' qwen3-32b', 'qwen3-14b', 'qwen3-32b'], concurrency: 2 });
    expect(added).toEqual({ name: '192.168.1.20:8001', baseUrl: 'http://192.168.1.20:8001/v1', models: ['qwen3-32b', 'qwen3-14b'], concurrency: 2 });
    expect(getConfig().llm.profiles.local).toMatchObject({ baseUrl: 'http://192.168.1.20:8001/v1', model: 'qwen3-32b' });
    expect(resolveProvider(getConfig(), 'local')).toMatchObject({ baseUrl: 'http://192.168.1.20:8001/v1', concurrency: 2 });
    // a model the server does not list is not taken
    updateProfile('local', { model: 'qwen3-14b' });
    updateProfile('local', { model: 'nope' });
    expect(getConfig().llm.profiles.local.model).toBe('qwen3-32b');
    // switching servers keeps the model only if the new server lists it
    updateProfile('local', { baseUrl: envFirst.baseUrl });
    expect(getConfig().llm.profiles.local).toMatchObject({ baseUrl: envFirst.baseUrl, model: envFirst.models[0] });

    updateProfile('local', { baseUrl: 'http://192.168.1.20:8001/v1' });
    removeServer('http://192.168.1.20:8001/v1');
    expect(getConfig().llm.servers).toEqual([]);
    expect(getConfig().llm.profiles.local).toMatchObject({ baseUrl: envFirst.baseUrl, model: envFirst.models[0] });
  });
});
