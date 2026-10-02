import { describe, expect, it } from 'vitest';
import { MockAgent, type MockSnapshot } from '../ai/mockAgent';
import { Game, GameAborted, ReplayMismatch } from './game';
import type { Agent, Decision } from './types';

const names = Array.from({ length: 12 }, (_, i) => `P${i + 1}`);
const transcript = (g: Game) => g.events.map((e) => `${e.day}|${e.phase}|${e.type}|${e.speaker ?? ''}|${e.text}`);

/**
 * Play `seed` with mock agents, stopping (like a save) at the first agent call once
 * `stopAt` answers were given. `points`: the journal lengths seen at agent calls
 * (a round of votes is asked all at once, so lengths inside one never show up here).
 */
async function playUntil(seed: number, stopAt: number) {
  const mocks = names.map((_, i) => new MockAgent(seed * 31 + i));
  let saved: { journal: Decision[]; agents: MockSnapshot[] } | null = null;
  const g = new Game({ names, humanSeat: -1, seed, wolfChatRounds: 2 });
  const points = new Set<number>();
  const stop = () => {
    points.add(g.journal.length);
    if (g.journal.length < stopAt || saved) return;
    saved = { journal: g.journal.slice(), agents: mocks.map((m) => m.snapshot()) };
    g.abort();
  };
  g.setAgents(
    mocks.map((m): Agent => ({
      speak: (r, v) => (stop(), m.speak(r, v)),
      choose: (r, v) => (stop(), m.choose(r, v)),
    })),
  );
  const winner = await g.run().catch((e) => {
    if (!(e instanceof GameAborted)) throw e;
    return undefined;
  });
  return { g, winner, points: [...points], saved: saved as { journal: Decision[]; agents: MockSnapshot[] } | null };
}

describe('save games (seed + journal replay)', () => {
  it('a resumed game continues exactly like the uninterrupted one', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const full = await playUntil(seed, Infinity);
      const pts = full.points;
      for (const stopAt of [0, 1, pts[Math.floor(pts.length / 3)], pts[Math.floor(pts.length / 2)], pts[pts.length - 1]]) {
        const { saved } = await playUntil(seed, stopAt);
        expect(saved).not.toBeNull();
        const mocks = names.map((_, i) => new MockAgent(seed * 31 + i));
        saved!.agents.forEach((s, i) => mocks[i].restore(s));
        let restoredAt = -1;
        const g = new Game(
          { names, humanSeat: -1, seed, wolfChatRounds: 2, replay: saved!.journal },
          { restored: () => (restoredAt = g.journal.length) },
        );
        g.setAgents(mocks);
        expect(await g.run()).toBe(full.winner);
        // the host hears about it at the first live step, before any new answer
        expect(restoredAt).toBe(stopAt);
        expect(transcript(g)).toEqual(transcript(full.g));
        expect(g.journal).toEqual(full.g.journal);
      }
    }
  });

  it('a save made mid-vote keeps the answers already in and asks only the rest', async () => {
    // everyone answers 上警 at once, at different speeds; the save lands with seats 1–5 in
    const ask = (log: number[]) =>
      names.map((_, id): Agent => ({
        speak: async () => '过',
        choose: async (r) => {
          if (r.action !== 'runForSheriff') return r.allowSkip ? null : r.candidates[0];
          log.push(id);
          await new Promise((res) => setTimeout(res, id * 6));
          return id % 3 ? null : id;
        },
      }));
    const play = async (replay?: Decision[], abortMs?: number) => {
      const log: number[] = [];
      // these agents never exile anyone: stop once the election is over
      const g: Game = new Game(
        { names, humanSeat: -1, seed: 9, wolfChatRounds: 1, replay },
        { onEvent: (e) => void (/当选警长|没有警长/.test(e.text) && g.abort()) },
      );
      g.setAgents(ask(log));
      const timer = abortMs === undefined ? null : setTimeout(() => g.abort(), abortMs);
      await g.run().catch((e) => {
        if (!(e instanceof GameAborted)) throw e;
      });
      if (timer) clearTimeout(timer);
      return { g, log };
    };
    const full = await play();
    const cut = await play(undefined, 27);
    // the journal ends with the five 上警 answers that came in, tagged with their seats' places
    expect(cut.g.journal.slice(-5).map((d) => (d as { i?: number }).i)).toEqual([0, 1, 2, 3, 4]);
    const resumed = await play(cut.g.journal);
    expect(resumed.log).toEqual([5, 6, 7, 8, 9, 10, 11]);
    expect(full.g.events.some((e) => /当选警长|没有警长/.test(e.text))).toBe(true);
    expect(transcript(resumed.g)).toEqual(transcript(full.g));
    expect(resumed.g.journal).toEqual(full.g.journal);
  });

  it('replays a vote journaled one by one, as saves from before parallel votes have it', async () => {
    const full = await playUntil(11, Infinity);
    const legacy = full.g.journal.map((d) => ('t' in d ? { t: d.t } : d));
    const g = new Game({ names, humanSeat: -1, seed: 11, wolfChatRounds: 2, replay: legacy });
    g.setAgents(names.map(() => ({ speak: async () => 'x', choose: async () => null })));
    expect(await g.run()).toBe(full.winner);
    expect(transcript(g)).toEqual(transcript(full.g));
  });

  it('replays without asking agents or waiting for the scene', async () => {
    const full = await playUntil(7, Infinity);
    let asked = 0;
    let cues = 0;
    let live = false;
    // live pacing only resumes after the last recorded answer (the few steps that end the game)
    const g = new Game(
      { names, humanSeat: -1, seed: 7, wolfChatRounds: 2, paceMs: 40, replay: full.g.journal },
      { cue: async () => void (live || cues++), beforeSpeech: async () => void (live || cues++), restored: () => (live = true) },
    );
    g.setAgents(names.map(() => ({ speak: async () => (asked++, 'x'), choose: async () => (asked++, null) })));
    const t0 = performance.now();
    await g.run();
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(asked).toBe(0);
    expect(cues).toBe(0); // no scene cue or held speech while still replaying
    expect(transcript(g)).toEqual(transcript(full.g));
  });

  it('rejects a journal that no longer fits the rules', async () => {
    const g = new Game({ names, humanSeat: -1, seed: 3, replay: [{ s: 'not a target' }] });
    g.setAgents(names.map(() => new MockAgent(1)));
    await expect(g.run()).rejects.toBeInstanceOf(ReplayMismatch);
  });

  it('pausing holds the GM, including an answer that arrives meanwhile', async () => {
    let answer!: (v: number | null) => void;
    const g = new Game({ names, humanSeat: -1, seed: 5 });
    const mocks = names.map((_, i) => new MockAgent(i));
    let calls = 0;
    g.setAgents(
      mocks.map((m): Agent => ({
        speak: (r, v) => m.speak(r, v),
        choose: (r, v) => (++calls === 1 ? new Promise((res) => (answer = res)) : m.choose(r, v)),
      })),
    );
    const run = g.run();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1);
    g.pause();
    answer(g.viewFor(g.state.actor!).players.find((p) => p.id !== g.state.actor)!.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1); // held
    expect(g.journal.length).toBe(1); // but the answer is already journaled for a save
    g.resume();
    expect(await run).toMatch(/good|wolf/);
    expect(calls).toBeGreaterThan(1);
  });
});
