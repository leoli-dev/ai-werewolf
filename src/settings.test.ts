import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadGamePrefs, saveGamePrefs } from './settings';

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
