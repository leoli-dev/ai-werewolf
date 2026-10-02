import { playScores, scoredVote, type AwardVote, type ReviewContext, type ReviewResult, type Reviewer } from '../game/ceremony';
import { Rng } from '../game/rng';
import type { MockStyle, Playstyle } from './playstyles';
import { EXPLODE_CHOICE, ROLE_NAME, isWolf, seat, type Agent, type PlayerView, type SpeechRequest, type SpeechResult, type TargetRequest, type WolfChatRequest } from '../game/types';

export interface MockSnapshot {
  rng: number;
  suspicion: [number, number][];
  /** A 悍跳狼's made-up 查杀 (older saves lack it). */
  fakeCheck?: number | null;
}

/**
 * Offline rule-based agent: no LLM needed. Used for tests and the
 * "离线规则 AI" mode. Plays plausibly but simply.
 */
export class MockAgent implements Agent, Reviewer {
  private rng: Rng;
  private suspicion = new Map<number, number>();
  private fakeCheck: number | null = null;
  private readonly style: MockStyle;

  constructor(seed?: number, private delayMs = 0, style: Playstyle | null = null) {
    this.rng = new Rng(seed);
    this.style = style?.mock ?? {};
  }

  /** Save-game state (the replay never calls agents, so their memory is saved as is). */
  snapshot(): MockSnapshot {
    return { rng: this.rng.state, suspicion: [...this.suspicion], fakeCheck: this.fakeCheck };
  }

  restore(s: MockSnapshot) {
    this.rng = new Rng(s.rng);
    this.suspicion = new Map(s.suspicion);
    this.fakeCheck = s.fakeCheck ?? null;
  }

  /** A seer who is not hiding comes out on day 1; a hiding one only with a 查杀, or to counter a fake seer. */
  private seerOut(v: PlayerView): boolean {
    if (!this.style.hide) return true;
    const wolfFound = Object.entries(v.known).some(([id, t]) => Number(id) !== v.self.id && t === 'wolf');
    return wolfFound || v.events.some((e) => e.type === 'speech' && e.speaker !== v.self.id && /我是预言家/.test(e.text));
  }

  /** Has anyone pointed at me today (查杀 / 是狼 / 出N号)? */
  private underFire(v: PlayerView): boolean {
    const me = seat(v.self.id);
    return v.events.some((e) => e.type === 'speech' && e.day === v.day && e.speaker !== v.self.id && new RegExp(`(查杀|出|投)\\s*${me}|(?<!\\d)${me}\\s*是狼`).test(e.text));
  }

  /** The style's public claim for this speech, if any. */
  private claimLine(req: SpeechRequest, v: PlayerView, others: number[]): string | null {
    const { claim } = this.style;
    if (req.purpose === 'lastWords' || req.purpose === 'summary') return null;
    if (claim === 'seer' && this.isWolf(v)) {
      // 悍跳: a made-up 查杀 on a good player, kept from day to day
      if (this.fakeCheck === null || !v.players[this.fakeCheck]?.alive) {
        const good = others.filter((o) => !isWolf(v.known[o]));
        if (!good.length || this.fakeCheck !== null) return null;
        this.fakeCheck = this.rng.pick(good);
      }
      const x = seat(this.fakeCheck);
      if (req.purpose === 'campaign') {
        const flow = others.filter((o) => o !== this.fakeCheck && !isWolf(v.known[o])).slice(0, 2);
        return `我是预言家，昨晚验了 ${x}，查杀！警徽给我，警徽流：${flow.map(seat).join('、')}。`;
      }
      return `我是预言家，${x} 是我验出来的查杀，今天必须出 ${x}，别被他骗了。`;
    }
    if ((claim === 'hunter' || claim === 'guard') && v.day <= 2 && (req.purpose === 'campaign' || req.purpose === 'discussion' || req.purpose === 'defense')) {
      return claim === 'hunter' ? '我是猎人，狼人别来动我，谁敢出我我就开枪带走狼。' : '我是守卫，昨晚我守了人，大家别乱投神职。';
    }
    if (this.style.showGun && v.self.role === 'hunter' && (req.purpose === 'defense' || this.underFire(v))) {
      return '我是猎人！出我我就开枪，你们自己掂量。';
    }
    return null;
  }

  private async wait() {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs * (0.5 + this.rng.next())));
  }

  private isWolf(v: PlayerView) {
    return isWolf(v.self.role);
  }

  /** Pick the most suspicious candidate, with some noise. */
  private suspect(v: PlayerView, cands: number[]): number {
    const known = v.known;
    const knownWolf = cands.filter((c) => known[c] === 'wolf' || (isWolf(known[c]) && !this.isWolf(v)));
    if (knownWolf.length) return this.rng.pick(knownWolf);
    // for a wolf, teammates are safe; for good players, any known non-wolf role is safe
    const safe = cands.filter((c) => !(known[c] && known[c] !== 'wolf' && (this.isWolf(v) ? isWolf(known[c]) : !isWolf(known[c]))));
    const pool = safe.length ? safe : cands;
    let best = pool[0];
    let bestScore = -Infinity;
    for (const c of pool) {
      const s = (this.suspicion.get(c) ?? 0) + this.rng.next() * 2;
      if (s > bestScore) [best, bestScore] = [c, s];
    }
    return best;
  }

  /**
   * Blow up today? A wolf called out as 查杀 (or by 3+ speakers) cuts the day short;
   * so does one whose teammate was called 查杀 today (no exile vote, so the teammate
   * lives and the pack kills again tonight). Never a 狼王 whose gun is still loaded.
   */
  private cornered(v: PlayerView): boolean {
    if (v.self.role === 'wolfKing' && !v.wolfKing?.hasShot) return false;
    const me = seat(v.self.id);
    const hits = v.events.filter(
      (e) => e.type === 'speech' && e.day === v.day && e.speaker !== v.self.id && e.text.includes(me) && /查杀|是狼/.test(e.text),
    );
    const checked = hits.some((e) => new RegExp(`查杀\\s*${me}|(?<!\\d)${me}\\s*是狼`).test(e.text));
    if ((checked || hits.length >= 3) && this.rng.next() < 0.25) return true;
    const pack = v.players.filter((p) => p.alive && isWolf(v.known[p.id]));
    const mateChecked = pack.some((p) => p.id !== v.self.id && checkedWolf(v, p.id, v.day));
    return mateChecked && pack.length >= 3 && this.rng.next() < 0.2;
  }

  /** Night talk: back the first kill a teammate put forward, else propose one (自刀 included). */
  private wolfChat(req: WolfChatRequest, v: PlayerView, others: number[]): string {
    if (req.round > 1) return 'pass';
    const proposed = proposedKill(v, req.day);
    if (proposed !== null && v.players[proposed]?.alive) return `同意刀 ${seat(proposed)}。`;
    const pack = v.players.filter((p) => p.alive && isWolf(v.known[p.id])).map((p) => p.id);
    // 自刀骗药 on night 1 (the 自刀狼 always offers itself); later, knife a teammate already called 查杀
    if (req.day === 1 && (this.style.selfKnife || this.rng.next() < 0.1)) return `今晚自刀 ${seat(v.self.id)}（我），骗女巫的解药，被救了我就是银水。`;
    const doomed = pack.filter((w) => w !== v.self.id && checkedWolf(v, w));
    if (req.day > 1 && doomed.length && this.rng.next() < 0.35) {
      return `今晚刀 ${seat(doomed[0])}，他被查杀明天也活不了，刀了他好人会怀疑那个预言家。`;
    }
    const seers = others.filter((o) => !isWolf(v.known[o]) && claimsSeer(v, o));
    const nonWolf = others.filter((o) => !isWolf(v.known[o]));
    const pick = seers.length ? this.rng.pick(seers) : this.rng.pick(nonWolf.length ? nonWolf : others);
    return `我建议今晚刀 ${seat(pick)}，${seers.includes(pick) ? '他跳了预言家' : '看起来像神'}。`;
  }

  async speak(req: SpeechRequest | WolfChatRequest, v: PlayerView): Promise<SpeechResult> {
    await this.wait();
    if (req.kind === 'speech' && req.canExplode && this.cornered(v)) {
      return { text: '算了，不装了，我就是狼。今天这票你们投不成了，好人慢慢猜吧。', explode: true };
    }
    const others = v.players.filter((p) => p.alive && p.id !== v.self.id).map((p) => p.id);
    if (req.kind === 'wolfChat') return this.wolfChat(req, v, others);
    const target = this.suspect(v, others);
    this.suspicion.set(target, (this.suspicion.get(target) ?? 0) + 1);
    const claim = this.claimLine(req, v, others);
    if (claim) return claim;
    if (req.purpose === 'lastWords') return `我是好人，大家多注意 ${seat(target)}。`;
    if (req.purpose === 'defense') return '我真的是好人，请大家相信我，别投错了。';
    if (req.purpose === 'campaignPk') return '警徽给我，我能带好人把狼找出来。';
    if (req.purpose === 'summary') return `我是警长，听完一轮，我觉得 ${seat(target)} 最可疑，归票 ${seat(target)}。`;
    if (v.self.role === 'seer' && this.seerOut(v)) {
      const checks = Object.entries(v.known).filter(([id]) => Number(id) !== v.self.id);
      if (checks.length) {
        const said = `我是预言家，${checks.map(([id, t]) => `${t === 'wolf' ? '查杀' : '金水'} ${seat(Number(id))}`).join('，')}。`;
        if (req.purpose !== 'campaign') return said;
        const flow = others.filter((o) => !(o in v.known)).slice(0, 2);
        return `${said}警徽流：${flow.map(seat).join('、')}。`;
      }
    }
    if (req.purpose === 'campaign') return `我上警是想拿警徽带队，目前我比较怀疑 ${seat(target)}。`;
    if (this.style.quiet) {
      return this.rng.pick(['我是好人，信息还不够，先听后面的人怎么说。', '过，跟着票型走，暂时不站边。', `没什么特别的，${seat(target)} 我稍微留意一下。`]);
    }
    const lines = [
      `我是好人，${seat(target)} 发言有点奇怪。`,
      `目前信息不多，先听听大家，我暂时怀疑 ${seat(target)}。`,
      `过，我觉得 ${seat(target)} 需要解释一下。`,
    ];
    return this.rng.pick(lines);
  }

  async review(ctx: ReviewContext): Promise<ReviewResult> {
    await this.wait();
    return mockReview(ctx, this.rng);
  }

  async awardVote(ctx: ReviewContext): Promise<AwardVote> {
    await this.wait();
    return scoredVote(ctx, () => this.rng.next());
  }

  async choose(req: TargetRequest, v: PlayerView): Promise<number | null> {
    await this.wait();
    const c = req.candidates;
    switch (req.action) {
      case 'runForSheriff':
        if (v.self.role === 'seer' && this.seerOut(v)) return v.self.id;
        return this.rng.next() < (this.style.run ?? 0.3) ? v.self.id : null;
      case 'withdraw':
        if (req.canExplode && this.cornered(v)) return EXPLODE_CHOICE;
        return v.self.role !== 'seer' && this.style.claim !== 'seer' && this.rng.next() < 0.25 ? v.self.id : null;
      case 'sheriffVote':
      case 'sheriffRevote': {
        // back a claimed seer / a checked-good candidate, else whoever looks least suspicious
        const trusted = c.filter((x) => v.known[x] === 'good' || (!this.isWolf(v) && claimsSeer(v, x)));
        if (trusted.length) return this.rng.pick(trusted);
        if (this.isWolf(v)) {
          const mates = c.filter((x) => isWolf(v.known[x]));
          if (mates.length) return this.rng.pick(mates);
        }
        return c.reduce((best, x) => ((this.suspicion.get(x) ?? 0) < (this.suspicion.get(best) ?? 0) ? x : best), c[0]);
      }
      case 'badge': {
        // 警徽流: the seer hands it to the latest player checked good; a wolf passes it to a teammate
        const checks = v.events.filter((e) => e.data?.result === 'good' && c.includes(e.data.check as number));
        if (checks.length) return checks[checks.length - 1].data!.check as number;
        if (this.isWolf(v)) {
          const mates = c.filter((x) => isWolf(v.known[x]));
          return mates.length ? this.rng.pick(mates) : null;
        }
        const calm = c.filter((x) => (this.suspicion.get(x) ?? 0) === 0);
        return calm.length ? this.rng.pick(calm) : null;
      }
      case 'speakOrder':
        return this.rng.pick(c);
      case 'wolfKill': {
        // the kill the pack agreed on in the channel (自刀 included)
        const proposed = proposedKill(v, v.day);
        if (proposed !== null && c.includes(proposed)) return proposed;
        const nonWolf = c.filter((x) => !isWolf(v.known[x]));
        return this.rng.pick(nonWolf.length ? nonWolf : c);
      }
      case 'seer':
        return this.rng.pick(c);
      case 'guard':
        // a hiding guard stays out of 同守同救 on night 1
        return this.style.hide && v.day === 1 && req.allowSkip ? null : this.rng.pick(c);
      case 'witchSave':
        return v.day === 1 ? (this.rng.next() < (this.style.save1 ?? 1) ? c[0] : null) : this.rng.next() < 0.3 ? this.rng.pick(c) : null;
      case 'witchPoison': {
        const wolf = c.filter((x) => (this.suspicion.get(x) ?? 0) >= 2);
        return v.day > 1 && wolf.length && this.rng.next() < (this.style.poison ?? 0.5) ? this.rng.pick(wolf) : null;
      }
      case 'hunterShot': {
        // a 查杀 from a claimed seer first (not one the hunter knows is good), else the top suspect if there is any reason
        const checked = c.filter((x) => checkedWolf(v, x) && v.known[x] !== 'good');
        if (checked.length) return this.rng.pick(checked);
        const target = this.suspect(v, c);
        return (this.suspicion.get(target) ?? 0) > 0 || this.rng.next() < 0.5 ? target : null;
      }
      case 'wolfKingShot': {
        // the biggest threat to the pack: a claimed seer, the sheriff, a claimed witch, else any good player
        const nonWolf = c.filter((x) => !isWolf(v.known[x]));
        const seer = nonWolf.filter((x) => claimsSeer(v, x));
        if (seer.length) return this.rng.pick(seer);
        if (v.sheriff != null && nonWolf.includes(v.sheriff)) return v.sheriff;
        const gods = nonWolf.filter((x) => claimsRole(v, x, /我是(女巫|守卫|猎人)/));
        return gods.length ? this.rng.pick(gods) : nonWolf.length ? this.rng.pick(nonWolf) : null;
      }
      case 'vote':
      case 'revote': {
        if (this.isWolf(v)) {
          if (this.fakeCheck !== null && c.includes(this.fakeCheck)) return this.fakeCheck;
          // 倒钩: throw a teammate who has been called 查杀 under the bus
          const doomed = c.filter((x) => x !== v.self.id && isWolf(v.known[x]) && checkedWolf(v, x));
          if (this.style.bus && doomed.length) return this.rng.pick(doomed);
          const nonWolf = c.filter((x) => !isWolf(v.known[x]));
          if (nonWolf.length) return this.suspect(v, nonWolf);
        }
        return this.suspect(v, c);
      }
    }
    return null;
  }
}

/** The post-game remarks of the rule AI: praise the best-scoring seat, rib the worst. */
function mockReview(ctx: ReviewContext, rng: Rng): string {
  const vote = scoredVote(ctx, () => rng.next());
  const me = ctx.players[ctx.self];
  const role = (id: number) => ROLE_NAME[ctx.players[id].role];
  const won = ctx.winner !== null && isWolf(me.role) === (ctx.winner === 'wolf');
  const self = playScores(ctx)[ctx.self] > 0 ? '我自己这局还算对得起这个身份' : '我自己这局打得不太行，回去再练练';
  return rng.pick([
    `${won ? '赢了真开心！' : '输了有点可惜。'}这局我最佩服${seat(vote.best)}，${role(vote.best)}打得很到位；${seat(vote.worst)}这个${role(vote.worst)}就有点拉胯了。${self}。`,
    `复盘一下：${seat(vote.best)}（${role(vote.best)}）是全场 MVP，关键操作都做对了。${seat(vote.worst)}（${role(vote.worst)}）失误太多，下局加油。${self}。`,
    `我是${role(ctx.self)}。要我说，${seat(vote.best)}打得最好，${seat(vote.worst)}打得最差，没什么好争的。`,
  ]);
}

/** The first kill put forward in the pack's channel tonight (「刀 N号」, 自刀 included), if any. */
function proposedKill(v: PlayerView, day: number): number | null {
  for (const e of v.events) {
    if (e.type !== 'wolfChat' || e.day !== day || e.speaker === undefined) continue;
    const m = e.text.match(/刀\s*(\d{1,2})\s*号/);
    if (m) return Number(m[1]) - 1;
  }
  return null;
}

/** Has `id` publicly claimed a role matching `re`? */
function claimsRole(v: PlayerView, id: number, re: RegExp): boolean {
  return v.events.some((e) => e.type === 'speech' && e.speaker === id && re.test(e.text));
}

/** Has someone who claims seer called `id` a 查杀 (on `day`, if given)? */
function checkedWolf(v: PlayerView, id: number, day?: number): boolean {
  const s = seat(id);
  return v.events.some((e) => e.type === 'speech' && (day === undefined || e.day === day) && /我是预言家/.test(e.text) && new RegExp(`查杀\\s*${s}|验了\\s*${s}，查杀|(?<!\\d)${s}\\s*是我验出来的查杀`).test(e.text));
}

/** Has `id` claimed seer in a public speech? */
function claimsSeer(v: PlayerView, id: number): boolean {
  return v.events.some((e) => e.type === 'speech' && e.speaker === id && /我是预言家/.test(e.text));
}
