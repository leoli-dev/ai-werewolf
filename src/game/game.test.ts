import { describe, expect, it } from 'vitest';
import { MockAgent } from '../ai/mockAgent';
import { Game, circularOrder } from './game';
import type { Agent, PlayerView, TargetRequest } from './types';

const names = Array.from({ length: 12 }, (_, i) => `P${i + 1}`);

function simulate(seed: number, wrap?: (a: Agent, id: number) => Agent) {
  const g = new Game({ names, humanSeat: -1, seed, wolfChatRounds: 2 });
  g.setAgents(names.map((_, i) => (wrap ? wrap(new MockAgent(seed * 31 + i), i) : new MockAgent(seed * 31 + i))));
  return g;
}

describe('Game engine', () => {
  it('deals the standard 12-player board', () => {
    const g = simulate(1);
    const counts = g.players.reduce<Record<string, number>>((m, p) => ((m[p.role] = (m[p.role] ?? 0) + 1), m), {});
    expect(counts).toEqual({ werewolf: 4, villager: 4, seer: 1, witch: 1, hunter: 1, guard: 1 });
  });

  it('forces the human role when requested', () => {
    for (let s = 0; s < 20; s++) {
      const g = new Game({ names, humanSeat: 3, humanRole: 'witch', seed: s });
      expect(g.players[3].role).toBe('witch');
      expect(g.players[3].isHuman).toBe(true);
    }
  });

  it('runs 300 seeded games to a winner while respecting rule invariants', async () => {
    const wins = { good: 0, wolf: 0 };
    for (let seed = 1; seed <= 300; seed++) {
      const requests: { id: number; req: TargetRequest; view: PlayerView }[] = [];
      const g = simulate(seed, (a, id) => ({
        speak: (r, v) => a.speak(r, v),
        choose: (r, v) => {
          requests.push({ id, req: r, view: v });
          return a.choose(r, v);
        },
      }));
      const w = await g.run();
      expect(w === 'good' || w === 'wolf').toBe(true);
      wins[w!]++;
      expect(g.checkWinner()).toBe(w);

      for (const { id, req, view } of requests) {
        // nobody targets themselves with a night skill
        if (['seer', 'guard', 'witchPoison', 'hunterShot'].includes(req.action)) {
          expect(req.candidates).not.toContain(id);
        }
        if (req.action === 'guard' && view.guard?.lastGuarded != null) {
          expect(req.candidates).not.toContain(view.guard.lastGuarded);
        }
        if (req.action === 'witchSave') expect(view.witch?.hasAntidote).toBe(true);
        if (req.action === 'witchPoison') expect(view.witch?.hasPoison).toBe(true);
        if (req.action === 'hunterShot') expect(view.hunter?.hasShot).toBe(false);
        // every asker other than a dying hunter / last words is alive
        if (req.action !== 'hunterShot') expect(view.self.alive).toBe(true);
      }
      // wolf chat never leaks to non-wolves
      for (const e of g.events.filter((e) => e.type === 'wolfChat')) {
        expect(e.visibility.kind).toBe('private');
        if (e.visibility.kind === 'private') {
          for (const id of e.visibility.to) expect(g.players[id].role).toBe('werewolf');
        }
      }
    }
    expect(wins.good + wins.wolf).toBe(300);
  });

  it('seer check info vanishes if the seer dies that night', async () => {
    // wolves always kill the seer; guard/witch never help
    for (let seed = 1; seed <= 20; seed++) {
      const g = new Game({ names, humanSeat: -1, seed, wolfChatRounds: 1 });
      const seer = g.players.find((p) => p.role === 'seer')!.id;
      const agent: Agent = {
        speak: async () => 'pass',
        choose: async (r) => {
          if (r.action === 'wolfKill') return seer;
          if (r.action === 'seer') return r.candidates[0];
          if (r.action === 'vote' || r.action === 'revote') return r.candidates[0];
          return null;
        },
      };
      g.setAgents(names.map(() => agent));
      await g.run();
      expect(g.events.some((e) => e.data?.check !== undefined)).toBe(false);
      expect(Object.keys(g.state.seerChecks)).toHaveLength(0);
    }
  });

  it('seer learns the exact role of the checked player', async () => {
    const g = new Game({ names, humanSeat: -1, seed: 3, wolfChatRounds: 1 });
    const seer = g.players.find((p) => p.role === 'seer')!.id;
    const witch = g.players.find((p) => p.role === 'witch')!.id;
    const agent: Agent = {
      speak: async () => 'pass',
      choose: async (r) => {
        if (r.day > 1) throw new Error('stop');
        if (r.action === 'seer') return witch;
        if (r.action === 'wolfKill') return r.candidates.find((c) => c !== seer && c !== witch)!;
        return null;
      },
    };
    g.setAgents(names.map(() => agent));
    await g.run().catch(() => {});
    expect(g.state.seerChecks[witch]).toBe('witch');
    expect(g.viewFor(seer).known[witch]).toBe('witch');
    expect(g.events.some((e) => e.text.includes('【女巫】'))).toBe(true);
  });

  it('wolf chat skips the human and goes to the vote once AI wolves have nothing to add', async () => {
    const g = new Game({ names, humanSeat: 0, humanRole: 'werewolf', seed: 5, wolfChatRounds: 3 });
    const humanRounds: number[] = [];
    const cues: string[] = [];
    const agent: Agent = {
      speak: async (r) => (r.kind === 'wolfChat' && r.round === 1 ? '刀 12 号' : 'pass'),
      choose: async (r) => {
        if (r.day > 1) throw new Error('stop');
        return r.allowSkip ? null : r.candidates[r.candidates.length - 1];
      },
    };
    const human: Agent = {
      speak: async (r) => {
        if (r.kind === 'wolfChat') humanRounds.push(r.round);
        return '好';
      },
      choose: agent.choose,
    };
    const g2 = new Game({ names, humanSeat: 0, humanRole: 'werewolf', seed: 5, wolfChatRounds: 3 }, { cue: async (c) => void cues.push(c) });
    for (const game of [g, g2]) game.setAgents(names.map((_, i) => (i === 0 ? human : agent)));
    await g2.run().catch(() => {});
    // round 1: everyone talks; round 2: AI wolves all pass -> human not asked, no round 3
    expect(humanRounds).toEqual([1]);
    expect(cues.slice(0, 4)).toEqual(['nightfall', 'wolvesOut', 'wolvesIn', 'dawn']);
  });

  it('guard blocks the wolf kill but not poison', async () => {
    const g = new Game({ names, humanSeat: -1, seed: 7, wolfChatRounds: 1 });
    const villager = g.players.find((p) => p.role === 'villager')!.id;
    const agent: Agent = {
      speak: async () => 'pass',
      choose: async (r) => {
        if (r.day > 1) throw new Error('stop');
        if (r.action === 'guard' || r.action === 'wolfKill') return villager;
        return null;
      },
    };
    g.setAgents(names.map(() => agent));
    await g.run().catch(() => {});
    expect(g.players[villager].alive).toBe(true);
    expect(g.events.some((e) => e.text.includes('平安夜'))).toBe(true);
  });

  it('orders speakers circularly', () => {
    expect(circularOrder([0, 2, 5, 9], 5, true)).toEqual([5, 9, 0, 2]);
    expect(circularOrder([0, 2, 5, 9], 5, false)).toEqual([5, 2, 0, 9]);
  });
});
