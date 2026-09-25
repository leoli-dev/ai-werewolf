import { describe, expect, it } from 'vitest';
import type { GameEvent, PlayerView, TargetRequest } from '../game/types';
import { cleanSpeech, parseTarget, sharedNotebook, speechProgress, speechTask, systemPrompt } from './prompts';

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
  it('removes a trailing self-reported word count', () => {
    expect(cleanSpeech('我票先记6号，请5号接唱。\n\n（约190字）', view, '艾德')).toBe('我票先记6号，请5号接唱。');
    expect(cleanSpeech('我是好人。(共120字)', view, '艾德')).toBe('我是好人。');
    expect(cleanSpeech('我查验了3号，查杀。', view, '艾德')).toBe('我查验了3号，查杀。');
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
    expect(text).toContain('由 5号 开始顺时针');
    expect(text).toContain('号码从小到大，12号之后接1号');
    expect(text).toContain('已发言（按顺序）：5号 → 6号 → 8号');
    expect(text).toContain('轮到你：9号，第 4 位（共 11 人）');
    expect(text).toContain('还没轮到（按发言顺序）：10号 → 11号 → 12号 → 1号 → 2号 → 3号 → 4号，共 7 人');
    expect(text).toContain('不是沉默');
    expect(text).not.toContain('未发言');
    expect(text).toContain('由 5号 做归纳总结');
  });

  it('tells the last speaker to wrap up', () => {
    const text = speechProgress({ kind: 'speech', purpose: 'discussion', day: 1, order, spoken: order.slice(0, 10), first: 4, clockwise: true }, view(3));
    expect(text).toContain('在你之后没有人了');
    expect(text).toContain('最后一个发言');
  });

  it('explains counter-clockwise wrap-around (2 → 1 → 12 → … → 3)', () => {
    const ccw = [1, 0, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
    const all = Array.from({ length: 12 }, (_, id) => ({ id, name: `P${id + 1}`, alive: true }));
    const v = { self: { id: 11 }, players: all } as unknown as PlayerView;
    const text = speechProgress({ kind: 'speech', purpose: 'discussion', day: 1, order: ccw, spoken: [1, 0], first: 1, clockwise: false }, v);
    expect(text).toContain('由 2号 开始逆时针（号码从大到小，1号之后接12号）发言');
    expect(text).toContain('已发言（按顺序）：2号 → 1号');
    expect(text).toMatch(/还没轮到（按发言顺序）：11号 → .* → 3号，共 9 人/);
  });

  it('covers tie defences', () => {
    const text = speechProgress({ kind: 'speech', purpose: 'defense', day: 1, order: [2, 9], spoken: [] }, view(2));
    expect(text).toContain('平票玩家：3号、10号');
    expect(text).toContain('还有 1 位平票玩家正名');
  });
});

describe('wolf chat task', () => {
  const chat = (speaker: number, text: string) =>
    ({ type: 'wolfChat', day: 1, speaker, text, visibility: { kind: 'private', to: [2, 4, 9] } }) as GameEvent;
  const view = (events: GameEvent[]) =>
    ({ self: { id: 2 }, day: 1, players: [2, 4, 9].map((id) => ({ id, name: '', alive: true })), events }) as unknown as PlayerView;
  const req = (round: number) => ({ kind: 'wolfChat', round, rounds: 3, day: 1 }) as const;

  it('quotes teammates who spoke since my last line and forbids passing over an objection', () => {
    const t = speechTask(req(2), view([chat(4, '刀 6 号'), chat(2, '同意'), chat(9, '（没有补充）'), chat(4, '我不同意，改刀 7')]));
    expect(t).toContain('5号：我不同意，改刀 7');
    expect(t).not.toContain('刀 6 号');
    expect(t).not.toContain('没有补充');
    expect(t).toContain('不能 pass');
  });
  it('asks round-1 speakers to answer the teammates before them', () => {
    expect(speechTask(req(1), view([chat(4, '刀 6 号')]))).toContain('先回应在你之前发言的队友');
    expect(speechTask(req(1), view([]))).not.toContain('队友说了');
  });
  it('just passes in later rounds when nothing new was said', () => {
    expect(speechTask(req(2), view([chat(4, '刀 6 号'), chat(2, '同意')]))).toContain('只回复：pass');
  });
});

describe('day speech prompt', () => {
  const players = Array.from({ length: 12 }, (_, id) => ({ id, name: `P${id + 1}`, alive: id !== 1 }));
  const speech = (speaker: number, text: string) =>
    ({ type: 'speech', day: 1, speaker, speechKind: 'discussion', text, visibility: { kind: 'public' } }) as GameEvent;
  const view = (self: number, role: string, events: GameEvent[] = []) =>
    ({ self: { id: self, role }, day: 1, players, events }) as unknown as PlayerView;
  const req = { kind: 'speech', purpose: 'discussion', day: 1 } as const;

  it('puts the speaker on a header line and fences the words', () => {
    const t = sharedNotebook(view(0, 'villager', [speech(6, '6号你承认刀了4号？')]), { onlyDay: 1 });
    expect(t).toBe('[第1天 发言] 发言人：7号（P7）\n「6号你承认刀了4号？」');
  });
  it('asks to check who said a quoted line', () => {
    expect(speechTask(req, view(7, 'villager', [speech(6, '…')]))).toContain('【引用自检】');
    expect(speechTask(req, view(7, 'villager'))).not.toContain('【引用自检】');
  });
  it('keeps the wolf channel secret and rules out dead seats', () => {
    const t = speechTask(req, view(5, 'werewolf'));
    expect(t).toContain('狼队频道的内容');
    expect(t).toContain('不能再当作怀疑或放逐对象');
    expect(speechTask(req, view(4, 'villager'))).not.toContain('狼队频道');
  });
});

describe('system prompt', () => {
  it('says town trades in names are not game roles', () => {
    const view = { self: { id: 0, role: 'villager' }, known: {} } as unknown as PlayerView;
    expect(systemPrompt(view, { name: '药师伊索', trait: '', look: {} as never })).toContain('药师不是女巫');
  });
});
