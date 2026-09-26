import type { LLMSnapshot } from './ai/llmAgent';
import type { MockSnapshot } from './ai/mockAgent';
import type { Decision, Phase, Role } from './game/types';
import type { GamePrefs, Settings } from './settings';

/**
 * One save slot in localStorage. A game is rebuilt by dealing from the same
 * seeds and replaying the journal of answers (see `GameOptions.replay`), so a
 * save stays small and restores every detail: the log, bubbles, potions, the
 * seer's checks, what each AI noted to itself.
 */
export interface SaveGame {
  /** 2: 标准流程（警长竞选、屠边）; older journals no longer replay. */
  v: 2;
  savedAt: number;
  /** That game's own choices (pace, sound and the LLM connection come from 配置). */
  prefs: GamePrefs & Pick<Settings, 'mode'>;
  /** Seats the human and shuffles the personas. */
  setupSeed: number;
  gameSeed: number;
  journal: Decision[];
  /** Per seat: the AI's own memory (null for the human). */
  agents: (LLMSnapshot | MockSnapshot | null)[];
  elapsedMs: number;
  /** Shown on the title screen. */
  meta: { seat: number; role: Role; day: number; phase: Phase; alive: number };
}

const KEY = 'ai-werewolf:save:v2';

export function readSave(): SaveGame | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SaveGame;
    return s?.v === 2 && Array.isArray(s.journal) ? s : null;
  } catch {
    return null;
  }
}

/** Returns an error message, or null when saved. */
export function writeSave(s: SaveGame): string | null {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
    return null;
  } catch (e) {
    return (e as Error).name === 'QuotaExceededError' ? '浏览器存储空间不足' : `无法写入浏览器存储：${(e as Error).message}`;
  }
}

export function clearSave() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
