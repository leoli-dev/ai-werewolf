import { describe, expect, it } from 'vitest';
import { Game, GameAborted } from '../game/game';
import type { Agent } from '../game/types';
import { RequestQueue } from './provider';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('RequestQueue', () => {
  const load = async (q: RequestQueue, n: number) => {
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        q.run(async () => {
          peak = Math.max(peak, ++active);
          await tick();
          order.push(i);
          active--;
        }),
      ),
    );
    return { peak, order };
  };

  it('runs one call at a time by default, in order', async () => {
    const { peak, order } = await load(new RequestQueue(), 5);
    expect(peak).toBe(1);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });
  it('runs up to the cap side by side', async () => {
    expect((await load(new RequestQueue(() => 3), 8)).peak).toBe(3);
    expect((await load(new RequestQueue(() => 12), 11)).peak).toBe(11);
  });
  it('keeps going after a failed call', async () => {
    const q = new RequestQueue();
    await expect(q.run(async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(await q.run(async () => 7)).toBe(7);
    expect(q.pending).toBe(0);
  });
});

describe('simultaneous picks', () => {
  it('asks every voter before any answer comes back', async () => {
    let waiting = 0;
    let peak = 0;
    const g: Game = new Game(
      { names: Array.from({ length: 12 }, (_, i) => `P${i}`), humanSeat: -1, seed: 2, wolfChatRounds: 1 },
      { onEvent: (e) => void (e.type === 'vote' && g.abort()) },
    );
    g.setAgents(
      g.players.map((): Agent => ({
        speak: async () => '过',
        choose: async (r) => {
          if (r.action !== 'runForSheriff') return r.allowSkip ? null : r.candidates[0];
          peak = Math.max(peak, ++waiting);
          await tick();
          waiting--;
          return null;
        },
      })),
    );
    await g.run().catch((e) => {
      if (!(e instanceof GameAborted)) throw e;
    });
    expect(peak).toBe(12); // all twelve 上警 questions were out at once
  });
});
