import { describe, expect, it } from 'vitest';
import { MockAgent } from '../ai/mockAgent';
import { Game, GameAborted } from './game';
import { RECORD_FORMAT, RECORD_VERSION, buildRecord, mergeTimeline, recordFileName, type RecordContext } from './record';
import type { Agent } from './types';

const names = Array.from({ length: 12 }, (_, i) => `P${i + 1}`);
const ctx = (over: Partial<RecordContext> = {}): RecordContext => ({
  setupSeed: 7,
  humanSeat: -1,
  autoPlay: false,
  engine: 'offline',
  llm: null,
  wolfChatRounds: 2,
  elapsedMs: 1234,
  playstyles: names.map(() => null),
  notes: names.map(() => null),
  ceremony: null,
  now: new Date(2026, 9, 9, 21, 30),
  ...over,
});

async function play(seed: number, agents?: (m: MockAgent, i: number, g: Game) => Agent, replay?: Game['journal']) {
  const g = new Game({ names, humanSeat: -1, seed, wolfChatRounds: 2, replay });
  g.setAgents(names.map((_, i) => {
    const m = new MockAgent(seed * 31 + i);
    return agents ? agents(m, i, g) : m;
  }));
  await g.run().catch((e) => {
    if (!(e instanceof GameAborted)) throw e;
  });
  return g;
}

describe('game record', () => {
  it('records every event and every decision of a finished game', async () => {
    for (let seed = 1; seed <= 10; seed++) {
      const g = await play(seed);
      const r = buildRecord(g, ctx());
      expect(r.format).toBe(RECORD_FORMAT);
      expect(r.version).toBe(RECORD_VERSION);
      expect(r.status).toBe('ended');
      expect(r.result?.winner).toBe(g.state.winner);
      // one decision per journaled answer, every event once, in order
      const decisions = r.timeline.filter((t) => t.kind === 'decision');
      const events = r.timeline.filter((t) => t.kind === 'event');
      expect(decisions).toHaveLength(g.journal.length);
      expect(events.map((e) => e.seq)).toEqual(g.events.map((e) => e.seq));
      // a decision comes right before the events it led to
      let last = 0;
      for (const t of r.timeline) {
        if (t.kind === 'event') last = t.seq + 1;
        else expect(t.atEvent).toBe(last);
      }
      for (const d of decisions) {
        if (d.request.kind === 'target') {
          expect(d.text).toBeUndefined();
          expect('resolved' in d).toBe(!d.discarded);
        } else expect(typeof d.text).toBe('string');
      }
      // everyone who is out has a cause and the moment it happened
      for (const p of r.players) {
        expect(p.seat).toBe(p.id + 1);
        if (p.alive) expect(p.death).toBeNull();
        else expect(p.death?.cause).toBeTruthy();
      }
      // plain JSON: survives a round trip unchanged
      expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    }
  });

  it('can be exported mid-game', async () => {
    let answers = 0;
    const g = await play(3, (m, _, g) => ({
      speak: (r, v) => m.speak(r, v),
      choose: (r, v) => {
        // every answer given so far is on the record, also inside a round of votes
        expect(g.decisions).toHaveLength(g.journal.length);
        if (++answers === 30) g.abort();
        return m.choose(r, v);
      },
    }));
    const r = buildRecord(g, ctx());
    expect(r.status).toBe('inProgress');
    expect(r.result).toBeNull();
    expect(r.timeline.length).toBeGreaterThan(0);
    expect(recordFileName(r)).toBe(`ai-werewolf-2026-10-09-2130-day${g.state.day}.json`);
  });

  it('keeps the reason and fallback the agent gave with a pick, also across a save', async () => {
    const reasoned = (m: MockAgent, i: number): Agent => ({
      speak: (r, v) => m.speak(r, v),
      choose: async (r, v) => ({ target: await m.choose(r, v), reason: `理由${i}`, ...(i === 0 ? { fallback: true } : {}) }),
    });
    const g = await play(5, reasoned);
    const picks = buildRecord(g, ctx()).timeline.filter((t) => t.kind === 'decision' && t.request.kind === 'target');
    expect(picks.length).toBeGreaterThan(0);
    for (const p of picks) {
      if (p.kind !== 'decision') continue;
      expect(p.reason).toBe(`理由${p.actor}`);
      expect(!!p.fallback).toBe(p.actor === 0);
    }
    // a resumed game rebuilds the same decisions from the journal
    const resumed = await play(5, undefined, g.journal.slice());
    expect(mergeTimeline(resumed.events, resumed.decisions)).toEqual(mergeTimeline(g.events, g.decisions));
  });
});
