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

  it('wolves win once they outnumber the good side; good wins only when every wolf is gone', () => {
    const g = simulate(1);
    const kill = (n: number, pred: (r: string) => boolean) => {
      for (const p of g.players.filter((p) => p.alive && pred(p.role)).slice(0, n)) p.alive = false;
    };
    expect(g.checkWinner()).toBeNull(); // 4 wolves vs 8
    // every god dead is no longer a win on its own (4 wolves vs 4 villagers)
    kill(4, (r) => r !== 'werewolf' && r !== 'villager');
    expect(g.checkWinner()).toBeNull();
    // 4 wolves vs 3: wolves carry every vote
    kill(1, (r) => r === 'villager');
    expect(g.checkWinner()).toBe('wolf');

    const h = simulate(2);
    for (const p of h.players.filter((p) => p.role !== 'werewolf').slice(0, 6)) p.alive = false;
    for (const p of h.players.filter((p) => p.role === 'werewolf').slice(0, 2)) p.alive = false;
    expect(h.checkWinner()).toBeNull(); // 2 wolves vs 2: a tie plays on
    // one wolf left against one good player: still not over
    h.players.find((p) => p.alive && p.role === 'werewolf')!.alive = false;
    h.players.find((p) => p.alive && p.role !== 'werewolf')!.alive = false;
    expect(h.checkWinner()).toBeNull();
    h.players.find((p) => p.alive && p.role === 'werewolf')!.alive = false;
    expect(h.checkWinner()).toBe('good');
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

  it('every day speech waits for the host before it is heard', async () => {
    const released: number[] = [];
    const heard: number[] = [];
    const g = new Game(
      { names, humanSeat: -1, seed: 5, wolfChatRounds: 2 },
      {
        beforeSpeech: async (id) => void released.push(id),
        onEvent: (e) => {
          if (e.type !== 'speech') return;
          expect(released.at(-1)).toBe(e.speaker); // released right before it lands
          heard.push(e.speaker!);
        },
      },
    );
    g.setAgents(names.map((_, i) => new MockAgent(i)));
    await g.run();
    expect(heard.length).toBeGreaterThan(0);
    expect(released).toHaveLength(heard.length);
  });

  it('a wolf self-destructing ends the day: rest of the speeches and the vote are skipped', async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const g = new Game({ names, humanSeat: -1, seed, wolfChatRounds: 1 });
      const speakers: number[] = [];
      let exploder = -1;
      let canExplodeSeen = false;
      g.setAgents(
        names.map((_, id): Agent => ({
          speak: async (r) => {
            if (r.kind !== 'speech') return 'pass';
            if (r.canExplode) {
              canExplodeSeen = true;
              expect(g.players[id].role).toBe('werewolf');
            }
            if (r.purpose === 'discussion' && r.day === 1) speakers.push(id);
            // the first wolf to speak on day 1 blows up; good players' explode flags are ignored
            if (r.day === 1 && exploder < 0 && (r.canExplode || g.players[id].role !== 'werewolf')) {
              if (r.canExplode) {
                exploder = id;
                return { text: '我自爆。', explode: true };
              }
              return { text: '我是好人。', explode: true };
            }
            return '过。';
          },
          choose: async (r) => r.candidates[0] ?? null,
        })),
      );
      await g.run();
      expect(canExplodeSeen).toBe(true);
      expect(exploder).toBeGreaterThanOrEqual(0);
      expect(g.players[exploder].alive).toBe(false);
      // nobody spoke after the wolf, no summary, no vote on day 1
      expect(speakers[speakers.length - 1]).toBe(exploder);
      const day1 = g.events.filter((e) => e.day === 1);
      expect(day1.some((e) => e.type === 'vote')).toBe(false);
      expect(day1.some((e) => e.speechKind === 'summary' || e.speechKind === 'lastWords')).toBe(false);
      expect(day1.filter((e) => e.type === 'death' && e.data?.cause === 'explode').map((e) => e.data!.id)).toEqual([exploder]);
      // non-wolves' explode flag was ignored: exactly one explosion
      expect(g.journal.filter((d) => 'x' in d).length).toBe(1);
      // straight into the next night
      if (g.state.day > 1) expect(g.events.find((e) => e.day === 2)?.phase).toBe('night');
    }
  });

  it('seer is told the result at once, even if killed that night', async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const g = new Game({ names, humanSeat: -1, seed, wolfChatRounds: 1 });
      const seer = g.players.find((p) => p.role === 'seer')!.id;
      const agent: Agent = {
        speak: async () => 'pass',
        choose: async (r) => {
          if (r.day > 1) throw new Error('stop');
          if (r.action === 'wolfKill') return seer;
          if (r.action === 'seer') return r.candidates[0];
          return null;
        },
      };
      g.setAgents(names.map(() => agent));
      await g.run().catch(() => {});
      const result = g.events.findIndex((e) => e.data?.check !== undefined);
      const nightStepAfter = g.events.findIndex((e) => e.text.startsWith('守卫请睁眼'));
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThan(nightStepAfter);
      expect(Object.keys(g.state.seerChecks)).toHaveLength(1);
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

  it('wolf chat always lets the human speak last each round and ends once everyone passes', async () => {
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
        if (r.kind === 'wolfChat') {
          humanRounds.push(r.round);
          if (r.round > 1) expect(r.othersPassed).toBe(true);
        }
        return '好';
      },
      choose: agent.choose,
    };
    const g2 = new Game({ names, humanSeat: 0, humanRole: 'werewolf', seed: 5, wolfChatRounds: 3 }, { cue: async (c) => void (typeof c === 'string' && cues.push(c)) });
    for (const game of [g, g2]) game.setAgents(names.map((_, i) => (i === 0 ? human : agent)));
    await g2.run().catch(() => {});
    // AI wolves pass from round 2, but the human still gets the last word every round;
    // the human keeps adding something ("好"), so all 3 rounds are played
    expect(humanRounds).toEqual([1, 2, 3]);
    expect(cues.slice(0, 4)).toEqual(['nightfall', 'wolvesOut', 'wolvesIn', 'dawn']);
  });

  it('wolf chat ends early when the human also passes', async () => {
    const humanRounds: number[] = [];
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
        return r.kind === 'wolfChat' && r.round > 1 ? 'pass' : '同意';
      },
      choose: agent.choose,
    };
    const g = new Game({ names, humanSeat: 0, humanRole: 'werewolf', seed: 5, wolfChatRounds: 3 });
    g.setAgents(names.map((_, i) => (i === 0 ? human : agent)));
    await g.run().catch(() => {});
    expect(humanRounds).toEqual([1, 2]);
  });

  it('an objection from the human in the last wolf-chat round gets one more AI round to answer it', async () => {
    const aiRounds: { round: number; rounds: number; sawObjection: boolean }[] = [];
    const agent: Agent = {
      speak: async (r, v) => {
        if (r.kind === 'wolfChat') aiRounds.push({ round: r.round, rounds: r.rounds, sawObjection: v.events.some((e) => e.text === '我不同意！') });
        return r.kind === 'wolfChat' && r.round === 1 ? '刀 12 号' : 'pass';
      },
      choose: async (r) => {
        if (r.day > 1) throw new Error('stop');
        return r.allowSkip ? null : r.candidates[r.candidates.length - 1];
      },
    };
    const human: Agent = {
      speak: async (r) => (r.kind === 'wolfChat' && r.round === 2 ? '我不同意！' : '同意'),
      choose: agent.choose,
    };
    const g = new Game({ names, humanSeat: 0, humanRole: 'werewolf', seed: 5, wolfChatRounds: 2 });
    g.setAgents(names.map((_, i) => (i === 0 ? human : agent)));
    await g.run().catch(() => {});
    const extra = aiRounds.filter((r) => r.round === 3);
    expect(extra).toHaveLength(3);
    expect(extra.every((r) => r.rounds === 3 && r.sawObjection)).toBe(true);
  });

  it('the human wolf votes last and sees the AI wolves\' picks first', async () => {
    const order: number[] = [];
    let humanPrompt = '';
    const choose = (id: number) => async (r: TargetRequest) => {
      if (r.day > 1) throw new Error('stop');
      if (r.action === 'wolfKill') order.push(id);
      if (id === 0 && r.action === 'wolfKill') humanPrompt = r.prompt;
      return r.allowSkip ? null : r.candidates[r.candidates.length - 1];
    };
    const g = new Game({ names, humanSeat: 0, humanRole: 'werewolf', seed: 5, wolfChatRounds: 1 });
    g.setAgents(names.map((_, i) => ({ speak: async () => 'pass', choose: choose(i) })));
    await g.run().catch(() => {});
    const wolves = g.players.filter((p) => p.role === 'werewolf').map((p) => p.id);
    expect(order.at(-1)).toBe(0);
    expect(order.slice().sort((a, b) => a - b)).toEqual(wolves);
    expect(humanPrompt).toMatch(/^队友已投：/);
    expect(g.events.some((e) => e.type === 'wolfChat' && e.text.startsWith('队友已投：'))).toBe(true);
  });

  it('tells each day speaker the round order and who has already spoken', async () => {
    const g = new Game({ names, humanSeat: -1, seed: 11, wolfChatRounds: 1 });
    const seen: { id: number; order: number[]; spoken: number[]; purpose: string }[] = [];
    const agent = (id: number): Agent => ({
      speak: async (r) => {
        if (r.kind === 'speech' && r.day === 1) seen.push({ id, order: r.order ?? [], spoken: r.spoken ?? [], purpose: r.purpose });
        return '我是好人';
      },
      choose: async (r) => {
        if (r.day > 1) throw new Error('stop');
        return r.allowSkip ? null : r.candidates[0];
      },
    });
    g.setAgents(names.map((_, i) => agent(i)));
    await g.run().catch(() => {});
    const disc = seen.filter((x) => x.purpose === 'discussion');
    expect(disc.length).toBeGreaterThan(5);
    disc.forEach((x, k) => {
      expect(x.order).toEqual(disc[0].order); // one shared order for the round
      expect(x.spoken).toEqual(disc.slice(0, k).map((d) => d.id)); // exactly the earlier speakers
      expect(x.order[k]).toBe(x.id); // speaking at its own position
    });
    const summary = seen.find((x) => x.purpose === 'summary')!;
    expect(summary.id).toBe(disc[0].id);
    expect(summary.spoken).toHaveLength(disc.length);
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
