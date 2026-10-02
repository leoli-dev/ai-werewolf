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
