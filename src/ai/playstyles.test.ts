import { describe, expect, it } from 'vitest';
import { Rng } from '../game/rng';
import { STANDARD_BOARD, isWolf, type Role } from '../game/types';
import { MockAgent } from './mockAgent';
import { PLAYSTYLES, dealPlaystyles, playstyleById } from './playstyles';
import type { PlayerView, SpeechRequest, TargetRequest } from '../game/types';

describe('dealPlaystyles', () => {
  it('gives every role a style that fits it', () => {
    for (const role of new Set(STANDARD_BOARD)) expect(PLAYSTYLES.some((s) => s.roles.includes(role))).toBe(true);
    for (let seed = 1; seed <= 50; seed++) {
      const rng = new Rng(seed);
      const roles = rng.shuffle(STANDARD_BOARD);
      dealPlaystyles(roles, () => rng.next()).forEach((s, i) => expect(s!.roles).toContain(roles[i]));
    }
  });
  it('gives the wolves and the villagers four different styles, with at most one 悍跳狼', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const rng = new Rng(seed);
      const roles = rng.shuffle(STANDARD_BOARD);
      const styles = dealPlaystyles(roles, () => rng.next());
      const of = (f: (r: Role) => boolean) => styles.filter((_, i) => f(roles[i])).map((s) => s!.id);
      expect(new Set(of(isWolf)).size).toBe(4);
      expect(new Set(of((r) => r === 'villager')).size).toBe(4);
      expect(of(isWolf).filter((id) => id === 'wolfJump').length).toBeLessThanOrEqual(1);
    }
  });
  it('skips the human seat without using up a style', () => {
    const roles: (Role | null)[] = ['werewolf', null, 'werewolf'];
    const styles = dealPlaystyles(roles, () => 0);
    expect(styles[1]).toBeNull();
    expect(styles[0]!.id).toBe('wolfJump');
    expect(styles[2]!.id).not.toBe('wolfJump');
  });
  it('varies from game to game', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      const rng = new Rng(seed);
      seen.add(dealPlaystyles(STANDARD_BOARD, () => rng.next())[0]!.id);
    }
    expect(seen.size).toBeGreaterThan(2);
  });
});

describe('rule AI playstyles', () => {
  const players = Array.from({ length: 12 }, (_, id) => ({ id, name: `P${id + 1}`, alive: true }));
  const view = (role: string, known: Record<number, string> = {}) =>
    ({ self: { id: 0, role }, day: 1, players, events: [], known: { 0: role, ...known } }) as unknown as PlayerView;
  const campaign: SpeechRequest = { kind: 'speech', purpose: 'campaign', day: 1 };

  it('a 悍跳狼 claims seer with a 查杀 on a good player, and keeps it', async () => {
    const a = new MockAgent(1, 0, playstyleById('wolfJump'));
    const v = view('werewolf', { 3: 'werewolf', 5: 'wolfKing', 7: 'werewolf' });
    const said = (await a.speak(campaign, v)) as string;
    expect(said).toMatch(/^我是预言家，昨晚验了 (\d+)号，查杀/);
    const x = Number(said.match(/验了 (\d+)号/)![1]) - 1;
    expect([3, 5, 7]).not.toContain(x);
    expect(await a.speak({ ...campaign, purpose: 'discussion' }, v)).toContain(`${x + 1}号 是我验出来的查杀`);
    expect(await a.choose({ kind: 'target', action: 'withdraw', day: 1, candidates: [0], allowSkip: true, prompt: '' }, v)).toBeNull();
  });
  it('an 装神民 poses as a god', async () => {
    expect(await new MockAgent(1, 0, playstyleById('villFake')).speak(campaign, view('villager'))).toContain('我是猎人');
  });
  it('a hiding seer stays off the stage with a 金水', async () => {
    const a = new MockAgent(1, 0, playstyleById('seerHidden'));
    const run: TargetRequest = { kind: 'target', action: 'runForSheriff', day: 1, candidates: [0], allowSkip: true, prompt: '' };
    expect(await a.choose(run, view('seer', { 4: 'good' }))).toBeNull();
    expect(await a.choose(run, view('seer', { 4: 'wolf' }))).toBe(0);
  });
});

describe('rule AI wolf tactics and guns', () => {
  const players = Array.from({ length: 12 }, (_, id) => ({ id, name: `P${id + 1}`, alive: true }));
  const pack = { 0: 'werewolf', 3: 'werewolf', 5: 'wolfKing', 7: 'werewolf' } as const;
  const say = (speaker: number, text: string, type = 'speech', day = 1) => ({ type, day, speaker, text, visibility: { kind: 'public' } });
  const view = (self: number, role: string, events: unknown[] = [], extra: object = {}) =>
    ({ self: { id: self, role }, day: 1, players, events, known: { ...pack, [self]: role }, ...extra }) as unknown as PlayerView;
  const chat = { kind: 'wolfChat', round: 1, rounds: 2, day: 1 } as const;
  const kill = (c: number[]): TargetRequest => ({ kind: 'target', action: 'wolfKill', day: 1, candidates: c, allowSkip: true, prompt: '' });

  it('a 自刀狼 offers itself on night 1 and the pack follows the first proposal', async () => {
    expect(await new MockAgent(1, 0, playstyleById('wolfBait')).speak(chat, view(3, 'werewolf'))).toMatch(/^今晚自刀 4号/);
    const heard = [say(3, '今晚自刀 4号（我），骗女巫的解药。', 'wolfChat')];
    expect(await new MockAgent(2).speak(chat, view(7, 'werewolf', heard))).toBe('同意刀 4号。');
    expect(await new MockAgent(2).choose(kill([1, 2, 3, 4]), view(7, 'werewolf', heard))).toBe(3);
  });
  it('a 狼王 with a loaded gun never blows up; a cornered wolf may', async () => {
    const checked = [say(9, '我是预言家，查杀 6号'), say(10, '6号是狼'), say(11, '出6号')];
    const speech: SpeechRequest = { kind: 'speech', purpose: 'discussion', day: 1, canExplode: true };
    for (let seed = 1; seed <= 30; seed++) {
      const r = await new MockAgent(seed).speak(speech, view(5, 'wolfKing', checked, { wolfKing: { hasShot: false } }));
      expect(typeof r === 'string' || !r.explode).toBe(true);
    }
    const blew = await Promise.all(
      Array.from({ length: 30 }, (_, seed) => new MockAgent(seed).speak(speech, view(3, 'werewolf', [say(9, '我是预言家，查杀 4号')]))),
    );
    expect(blew.some((r) => typeof r !== 'string' && r.explode)).toBe(true);
  });
  it('the hunter shoots a 查杀 and the 狼王 shoots the claimed seer', async () => {
    const shot = (action: 'hunterShot' | 'wolfKingShot'): TargetRequest => ({ kind: 'target', action, day: 2, candidates: [1, 2, 4, 8, 9], allowSkip: true, prompt: '' });
    const ev = [say(9, '我是预言家，查杀 9号')];
    expect(await new MockAgent(1).choose(shot('hunterShot'), view(6, 'hunter', ev, { known: { 6: 'hunter' } }))).toBe(8);
    expect(await new MockAgent(1).choose(shot('wolfKingShot'), view(5, 'wolfKing', ev))).toBe(9);
  });
});
