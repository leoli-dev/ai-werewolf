import { describe, expect, it } from 'vitest';
import type { PlayerView, TargetRequest } from '../game/types';
import { cleanSpeech, parseTarget, speechProgress } from './prompts';

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

describe('speechProgress', () => {
  const players = Array.from({ length: 12 }, (_, id) => ({ id, name: `P${id + 1}`, alive: id !== 6 }));
  const view = (self: number) => ({ self: { id: self }, players }) as unknown as PlayerView;
  const order = [4, 5, 7, 8, 9, 10, 11, 0, 1, 2, 3]; // seat 7 (id 6) is dead

  it('shows the order, your position and how many are left', () => {
    const text = speechProgress({ kind: 'speech', purpose: 'discussion', day: 2, order, spoken: [4, 5, 7], first: 4, clockwise: true }, view(8));
    expect(text).toContain('由 5号 开始顺时针发言');
    expect(text).toContain('5号（已发言） → 6号（已发言） → 8号（已发言） → 9号（你） → 10号（未发言）');
    expect(text).toContain('你是第 4 位（共 11 人），本轮已发言 3 人，还有 7 人未发言');
    expect(text).toContain('由 5号 做归纳总结');
  });

  it('tells the last speaker to wrap up', () => {
    const text = speechProgress({ kind: 'speech', purpose: 'discussion', day: 1, order, spoken: order.slice(0, 10), first: 4, clockwise: true }, view(3));
    expect(text).toContain('还有 0 人未发言');
    expect(text).toContain('最后一个发言');
  });

  it('covers tie defences', () => {
    const text = speechProgress({ kind: 'speech', purpose: 'defense', day: 1, order: [2, 9], spoken: [] }, view(2));
    expect(text).toContain('平票玩家：3号、10号');
    expect(text).toContain('还有 1 位平票玩家正名');
  });
});
