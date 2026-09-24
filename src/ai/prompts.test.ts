import { describe, expect, it } from 'vitest';
import type { PlayerView, TargetRequest } from '../game/types';
import { cleanSpeech, parseTarget } from './prompts';

const req = (candidates: number[], allowSkip = true): TargetRequest => ({
  kind: 'target', action: 'vote', day: 1, candidates, allowSkip, prompt: '',
});

describe('parseTarget', () => {
  it('reads JSON with 1-based seats', () => {
    expect(parseTarget('{"target": 5, "reason": "可疑"}', req([2, 4, 6]))).toEqual({ target: 4, reason: '可疑' });
  });
  it('treats 0 as skip when allowed', () => {
    expect(parseTarget('{"target": 0}', req([1, 2])).target).toBeNull();
    expect(parseTarget('{"target": 0}', req([1, 2], false)).target).toBeUndefined();
  });
  it('rejects seats outside the candidate list', () => {
    expect(parseTarget('{"target": 9}', req([1, 2], false)).target).toBeUndefined();
  });
  it('falls back to loose formats', () => {
    expect(parseTarget('我决定 target: 3', req([2, 5])).target).toBe(2);
    expect(parseTarget('我投 6 号', req([5, 7])).target).toBe(5);
    expect(parseTarget('我选择不开枪', req([1, 2])).target).toBeNull();
  });
});

describe('cleanSpeech', () => {
  const view = { self: { id: 2 } } as PlayerView;
  it('strips a self-attribution prefix', () => {
    expect(cleanSpeech('3号艾德：我是好人。', view, '艾德')).toBe('我是好人。');
    expect(cleanSpeech('「我觉得5号是狼」', view, '艾德')).toBe('我觉得5号是狼');
  });
  it('removes stage directions', () => {
    expect(cleanSpeech('*打了个嗝，眯着眼*\n我觉得5号是狼。', view, '艾德')).toBe('我觉得5号是狼。');
    expect(cleanSpeech('（清了清嗓子）我是好人。', view, '艾德')).toBe('我是好人。');
  });
  it('keeps colons that are part of the speech', () => {
    expect(cleanSpeech('我的结论：5号是狼', view, '艾德')).toBe('我的结论：5号是狼');
  });
});
