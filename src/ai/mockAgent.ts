import { Rng } from '../game/rng';
import { ROLE_NAME, seat, type Agent, type Role, type PlayerView, type SpeechRequest, type TargetRequest, type WolfChatRequest } from '../game/types';

export interface MockSnapshot {
  rng: number;
  suspicion: [number, number][];
}

/**
 * Offline rule-based agent: no LLM needed. Used for tests and the
 * "离线规则 AI" mode. Plays plausibly but simply.
 */
export class MockAgent implements Agent {
  private rng: Rng;
  private suspicion = new Map<number, number>();

  constructor(seed?: number, private delayMs = 0) {
    this.rng = new Rng(seed);
  }

  /** Save-game state (the replay never calls agents, so their memory is saved as is). */
  snapshot(): MockSnapshot {
    return { rng: this.rng.state, suspicion: [...this.suspicion] };
  }

  restore(s: MockSnapshot) {
    this.rng = new Rng(s.rng);
    this.suspicion = new Map(s.suspicion);
  }

  private async wait() {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs * (0.5 + this.rng.next())));
  }

  private isWolf(v: PlayerView) {
    return v.self.role === 'werewolf';
  }

  /** Pick the most suspicious candidate, with some noise. */
  private suspect(v: PlayerView, cands: number[]): number {
    const known = v.known;
    const knownWolf = cands.filter((c) => known[c] === 'wolf' || (known[c] === 'werewolf' && !this.isWolf(v)));
    if (knownWolf.length) return this.rng.pick(knownWolf);
    // for a wolf, teammates are safe; for good players, any known non-wolf role is safe
    const safe = cands.filter((c) => !(known[c] && known[c] !== 'wolf' && (this.isWolf(v) ? known[c] === 'werewolf' : known[c] !== 'werewolf')));
    const pool = safe.length ? safe : cands;
    let best = pool[0];
    let bestScore = -Infinity;
    for (const c of pool) {
      const s = (this.suspicion.get(c) ?? 0) + this.rng.next() * 2;
      if (s > bestScore) [best, bestScore] = [c, s];
    }
    return best;
  }

  async speak(req: SpeechRequest | WolfChatRequest, v: PlayerView): Promise<string> {
    await this.wait();
    const others = v.players.filter((p) => p.alive && p.id !== v.self.id).map((p) => p.id);
    if (req.kind === 'wolfChat') {
      if (req.round > 1) return 'pass';
      const nonWolf = others.filter((o) => v.known[o] !== 'werewolf');
      return `我建议今晚刀 ${seat(this.rng.pick(nonWolf.length ? nonWolf : others))}，看起来像神。`;
    }
    const target = this.suspect(v, others);
    this.suspicion.set(target, (this.suspicion.get(target) ?? 0) + 1);
    if (req.purpose === 'lastWords') return `我是好人，大家多注意 ${seat(target)}。`;
    if (req.purpose === 'defense') return '我真的是好人，请大家相信我，别投错了。';
    if (req.purpose === 'summary') return `听完一轮，我觉得 ${seat(target)} 最可疑，建议集中投他。`;
    if (v.self.role === 'seer') {
      const checks = Object.entries(v.known).filter(([id]) => Number(id) !== v.self.id);
      if (checks.length) {
        return `我是预言家，${checks.map(([id, t]) => `${seat(Number(id))}是${ROLE_NAME[t as Role] ?? t}`).join('，')}。`;
      }
    }
    const lines = [
      `我是好人，${seat(target)} 发言有点奇怪。`,
      `目前信息不多，先听听大家，我暂时怀疑 ${seat(target)}。`,
      `过，我觉得 ${seat(target)} 需要解释一下。`,
    ];
    return this.rng.pick(lines);
  }

  async choose(req: TargetRequest, v: PlayerView): Promise<number | null> {
    await this.wait();
    const c = req.candidates;
    switch (req.action) {
      case 'wolfKill': {
        const nonWolf = c.filter((x) => v.known[x] !== 'werewolf');
        return this.rng.pick(nonWolf.length ? nonWolf : c);
      }
      case 'seer':
      case 'guard':
        return this.rng.pick(c);
      case 'witchSave':
        return v.day === 1 ? c[0] : this.rng.next() < 0.3 ? this.rng.pick(c) : null;
      case 'witchPoison': {
        const wolf = c.filter((x) => (this.suspicion.get(x) ?? 0) >= 2);
        return v.day > 1 && wolf.length && this.rng.next() < 0.5 ? this.rng.pick(wolf) : null;
      }
      case 'hunterShot':
        return v.self.alive && this.rng.next() < 0.8 ? null : this.suspect(v, c);
      case 'vote':
      case 'revote': {
        if (this.isWolf(v)) {
          const nonWolf = c.filter((x) => v.known[x] !== 'werewolf');
          if (nonWolf.length) return this.suspect(v, nonWolf);
        }
        return this.suspect(v, c);
      }
    }
    return null;
  }
}
