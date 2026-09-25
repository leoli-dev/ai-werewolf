import { Rng } from './rng';
import {
  ROLE_NAME,
  STANDARD_BOARD,
  seat,
  type Agent,
  type DeathCause,
  type Decision,
  type DecisionRequest,
  type EventType,
  type GameEvent,
  type Phase,
  type Player,
  type PlayerView,
  type Role,
  type SpeechKind,
  type SpeechOrder,
  type TargetAction,
  type TargetRequest,
  type Visibility,
  type Winner,
} from './types';

export interface GameOptions {
  names: string[];
  /** Index of the human seat, or -1 for all-AI (tests / spectating). */
  humanSeat: number;
  /** Force the human's role (dev); otherwise random. */
  humanRole?: Role;
  seed?: number;
  /** Max wolf-channel chat rounds per night (brief: 5). */
  wolfChatRounds?: number;
  /** Pause between GM steps, ms (0 in tests). */
  paceMs?: number;
  /**
   * Resume a saved game: these recorded answers are fed back instantly (no agent
   * calls, no pacing, no scene cues) before live play continues. Needs the same `seed`.
   */
  replay?: Decision[];
}

export interface GameState {
  day: number;
  phase: Phase;
  players: Player[];
  /** Player currently being asked to act/speak, for highlighting. */
  actor: number | null;
  actorLabel: string;
  winner: Winner;
  witch: { hasAntidote: boolean; hasPoison: boolean };
  hunterShot: boolean;
  lastGuarded: number | null;
  /** Seer knowledge: target -> exact role (told at once, during the seer's turn). */
  seerChecks: Record<number, Role>;
  /** Which night role is currently awake (public knowledge, drives scene/audio). */
  nightStep: NightStep | null;
}

export type NightStep = 'seer' | 'guard' | 'wolves' | 'hunter' | 'witch';

/**
 * A night role's action (or the hunter's day shot), staged for whoever may see it:
 * night ones only for the acting player (or god view), the day shot for everyone.
 */
export interface RoleCue {
  kind: 'seer' | 'guard' | 'witchSave' | 'witchPoison' | 'nightShot' | 'dayShot';
  actor: number;
  target: number;
}

/** Moments where the GM waits for the scene to finish animating. */
export type SceneCue = 'nightfall' | 'wolvesOut' | 'wolvesIn' | 'dawn' | 'explode' | RoleCue;

export interface GameHooks {
  onEvent?(e: GameEvent): void;
  onState?(s: GameState): void;
  /** Resolve when the scene has played the cue (e.g. every wolf is back indoors). */
  cue?(c: SceneCue): Promise<void>;
  /** Resumed game only: the replay has caught up, live play starts now. */
  restored?(): void;
  /** A day speech is ready: resolve to let it be heard (the host may hold it until the human has read the last one). */
  beforeSpeech?(speaker: number): Promise<void>;
  /** The exile has had their last words (and the hunter's shot): resolve to send them off and start the night. */
  confirmExile?(id: number): Promise<void>;
}

export class GameAborted extends Error {}
/** A save's journal no longer fits the engine (e.g. saved by an older version). */
export class ReplayMismatch extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Game {
  readonly rng: Rng;
  /** Deal/flow seed; with `journal` it is everything needed to rebuild the game. */
  readonly seed: number;
  readonly state: GameState;
  readonly events: GameEvent[] = [];
  /** Every answer given so far (replayed ones included). */
  readonly journal: Decision[] = [];
  private agents: Agent[] = [];
  private aborted = false;
  private paused = false;
  private pauseWaiters: (() => void)[] = [];
  private readonly replay: Decision[];
  private cursor = 0;
  private restoring: boolean;
  private readonly wolfChatRounds: number;
  private paceMs: number;

  constructor(private opts: GameOptions, private hooks: GameHooks = {}) {
    this.seed = opts.seed ?? (Math.random() * 2 ** 32) >>> 0;
    this.rng = new Rng(this.seed);
    this.replay = opts.replay ?? [];
    this.restoring = opts.replay !== undefined;
    this.wolfChatRounds = opts.wolfChatRounds ?? 3;
    this.paceMs = opts.paceMs ?? 0;
    const roles = this.dealRoles();
    this.state = {
      day: 0,
      phase: 'setup',
      players: roles.map((role, id) => ({
        id,
        name: opts.names[id] ?? `玩家${id + 1}`,
        role,
        alive: true,
        isHuman: id === opts.humanSeat,
      })),
      actor: null,
      actorLabel: '',
      winner: null,
      witch: { hasAntidote: true, hasPoison: true },
      hunterShot: false,
      lastGuarded: null,
      seerChecks: {},
      nightStep: null,
    };
  }

  private dealRoles(): Role[] {
    const { humanSeat, humanRole } = this.opts;
    if (humanSeat >= 0 && humanRole) {
      const rest = STANDARD_BOARD.slice();
      rest.splice(rest.indexOf(humanRole), 1);
      const shuffled = this.rng.shuffle(rest);
      shuffled.splice(humanSeat, 0, humanRole);
      return shuffled;
    }
    return this.rng.shuffle(STANDARD_BOARD);
  }

  setAgents(agents: Agent[]) {
    this.agents = agents;
  }

  abort() {
    this.aborted = true;
    this.release();
  }

  /** 配置 changed the pace mid-game. */
  setPace(ms: number) {
    this.paceMs = ms;
  }

  /** Freeze the GM: it stops at its next step (an answer arriving meanwhile waits too). */
  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.release();
  }

  get isPaused() {
    return this.paused;
  }

  /** Still fast-forwarding through a save's journal. */
  get replaying() {
    return this.cursor < this.replay.length;
  }

  private release() {
    const waiters = this.pauseWaiters;
    this.pauseWaiters = [];
    for (const r of waiters) r();
  }

  private async gate() {
    this.guard();
    while (this.paused) {
      await new Promise<void>((r) => this.pauseWaiters.push(r));
      this.guard();
    }
  }

  /** Tell the host once the replay has caught up (at the first live step: pace, cue or question). */
  private checkRestored() {
    if (!this.restoring || this.replaying) return;
    this.restoring = false;
    this.hooks.restored?.();
  }

  // ───────────────────────── queries ─────────────────────────

  get players() {
    return this.state.players;
  }
  alive(): Player[] {
    return this.players.filter((p) => p.alive);
  }
  aliveIds(): number[] {
    return this.alive().map((p) => p.id);
  }
  byRole(role: Role): Player | undefined {
    return this.players.find((p) => p.role === role);
  }
  wolves(): Player[] {
    return this.players.filter((p) => p.role === 'werewolf');
  }

  /** Good wins once every wolf is gone; wolves win as soon as they outnumber the rest (they carry every vote). */
  checkWinner(): Winner {
    const alive = this.alive();
    const wolves = alive.filter((p) => p.role === 'werewolf').length;
    if (wolves === 0) return 'good';
    if (wolves > alive.length - wolves) return 'wolf';
    return null;
  }

  /** What `id` is allowed to know. Used by both AI prompts and the human UI. */
  viewFor(id: number): PlayerView {
    const self = this.players[id];
    const known: PlayerView['known'] = { [id]: self.role };
    if (self.role === 'werewolf') for (const w of this.wolves()) known[w.id] = 'werewolf';
    if (self.role === 'seer') Object.assign(known, this.state.seerChecks, { [id]: 'seer' });
    if (this.state.phase === 'ended') for (const p of this.players) known[p.id] = p.role;
    return {
      self: { ...self },
      day: this.state.day,
      phase: this.state.phase,
      players: this.players.map((p) => ({ id: p.id, name: p.name, alive: p.alive })),
      known,
      events: this.events.filter((e) => canSee(e.visibility, id)),
      witch: self.role === 'witch' ? { ...this.state.witch } : undefined,
      hunter: self.role === 'hunter' ? { hasShot: this.state.hunterShot } : undefined,
      guard: self.role === 'guard' ? { lastGuarded: this.state.lastGuarded } : undefined,
    };
  }

  // ───────────────────────── plumbing ─────────────────────────

  private emit(
    type: EventType,
    text: string,
    visibility: Visibility = { kind: 'public' },
    extra: Partial<GameEvent> = {},
  ): GameEvent {
    const e: GameEvent = {
      seq: this.events.length,
      day: this.state.day,
      phase: this.state.phase,
      type,
      text,
      visibility,
      ...extra,
    };
    this.events.push(e);
    this.hooks.onEvent?.(e);
    return e;
  }

  private gm(text: string, to?: number[]) {
    return this.emit(to ? 'private' : 'gm', text, to ? { kind: 'private', to } : { kind: 'public' });
  }

  private publish() {
    this.hooks.onState?.(this.state);
  }

  private setPhase(phase: Phase) {
    this.state.phase = phase;
    this.publish();
  }

  private announceStep(step: NightStep, text: string) {
    this.setNightStep(step);
    this.gm(text);
  }

  /** A turn whose role is dead / has nothing to do: wait a plausible while. */
  private async idleTurn() {
    await this.pace(2 + this.rng.next() * 3);
  }

  private setNightStep(step: NightStep | null) {
    this.state.nightStep = step;
    this.publish();
  }

  private setActor(id: number | null, label = '') {
    this.state.actor = id;
    this.state.actorLabel = label;
    this.publish();
  }

  private async pace(mult = 1) {
    await this.gate();
    if (this.replaying) return;
    this.checkRestored();
    if (this.paceMs > 0) await sleep(this.paceMs * mult);
    await this.gate();
  }

  private async cue(c: SceneCue) {
    await this.gate();
    if (this.replaying) return;
    this.checkRestored();
    if (this.hooks.cue) await this.hooks.cue(c);
    await this.gate();
  }

  private guard() {
    if (this.aborted) throw new GameAborted();
  }

  /** The agent's answer, or the recorded one while replaying a save. Journaled either way. */
  private async answer(id: number, req: DecisionRequest): Promise<Decision> {
    if (this.replaying) {
      const rec = this.replay[this.cursor++];
      if ((req.kind === 'target') !== 't' in rec) throw new ReplayMismatch(`存档第 ${this.cursor} 步与当前规则不符`);
      this.journal.push(rec);
      return rec;
    }
    this.checkRestored();
    await this.gate();
    const agent = this.agents[id];
    const view = this.viewFor(id);
    let rec: Decision;
    if (req.kind === 'target') rec = { t: await agent.choose(req, view) };
    else {
      const res = await agent.speak(req, view);
      if (typeof res === 'string') rec = { s: res };
      else {
        rec = { s: res.text };
        if (res.fallback) rec.fb = true;
        if (res.explode && req.kind === 'speech' && req.canExplode) rec.x = true;
      }
    }
    this.guard();
    // journal before waiting out a pause, so a save made meanwhile keeps this answer
    this.journal.push(rec);
    await this.gate();
    return rec;
  }

  private async ask(id: number, req: DecisionRequest, label: string): Promise<string | number | null> {
    this.guard();
    this.setActor(id, label);
    try {
      const rec = await this.answer(id, req);
      if ('t' in rec) {
        const choice = rec.t;
        const { candidates, allowSkip } = req as TargetRequest;
        if (choice === null) {
          if (allowSkip) return null;
          return this.rng.pick(candidates);
        }
        if (!candidates.includes(choice)) {
          this.emit('system', `${seat(id)}给出非法目标 ${choice + 1}，已随机替换`, { kind: 'private', to: [id] });
          return allowSkip ? null : this.rng.pick(candidates);
        }
        return choice;
      }
      this.lastSpeechFallback = !!rec.fb;
      this.lastSpeechExplode = !!rec.x;
      return rec.s.trim() || '（沉默）';
    } finally {
      this.setActor(null);
    }
  }

  private askTarget(id: number, action: TargetAction, candidates: number[], allowSkip: boolean, prompt: string, label: string) {
    const req: TargetRequest = { kind: 'target', action, day: this.state.day, candidates, allowSkip, prompt };
    return this.ask(id, req, label) as Promise<number | null>;
  }

  private kill(id: number, cause: DeathCause) {
    const p = this.players[id];
    if (!p.alive) return;
    p.alive = false;
    const shown = cause === 'vote' || cause === 'explode' ? cause : 'hidden';
    this.emit('death', `${seat(id)} ${p.name} 出局`, { kind: 'public' }, { data: { id, cause: shown } });
  }

  /** Returns true if the game ended. */
  private endIfWon(): boolean {
    const w = this.checkWinner();
    if (!w) return false;
    this.state.winner = w;
    this.setPhase('ended');
    const roster = this.players.map((p) => `${seat(p.id)}${p.name}：${ROLE_NAME[p.role]}`).join('，');
    const wolves = this.alive().filter((p) => p.role === 'werewolf').length;
    this.gm(
      w === 'good'
        ? '所有狼人均已出局，好人阵营获胜！'
        : `场上剩余 ${wolves} 名狼人、${this.alive().length - wolves} 名好人，狼人人数已超过好人，狼人阵营获胜！`,
    );
    this.gm(`身份公开：${roster}`);
    return true;
  }

  // ───────────────────────── main loop ─────────────────────────

  async run(): Promise<Winner> {
    if (this.agents.length !== this.players.length) throw new Error('agents not set');
    for (const p of this.players) {
      let text = `你是 ${seat(p.id)}，身份：${ROLE_NAME[p.role]}。`;
      if (p.role === 'werewolf') {
        text += `狼队友：${this.wolves().filter((w) => w.id !== p.id).map((w) => seat(w.id)).join('、')}。`;
      }
      this.gm(text, [p.id]);
    }
    this.gm('游戏开始。12 人局：4 狼人、4 村民、预言家、女巫、猎人、守卫。');
    while (true) {
      this.state.day += 1;
      await this.night();
      if (this.endIfWon()) break;
      await this.dayPhase();
      if (this.endIfWon()) break;
    }
    this.checkRestored();
    return this.state.winner;
  }

  // ───────────────────────── night ─────────────────────────

  private async night() {
    this.setPhase('night');
    const day = this.state.day;
    this.gm(`第 ${day} 夜，天黑请闭眼。`);
    await this.cue('nightfall');
    await this.pace(2);

    const pending = new Map<number, DeathCause>();
    const alive = this.aliveIds();

    // 1. 预言家
    const seer = this.byRole('seer');
    // every turn is announced every night, even if that role is gone (no information leak)
    this.announceStep('seer', '预言家请睁眼，请选择要查验的玩家。');
    if (!seer?.alive) await this.idleTurn();
    else {
      const cands = alive.filter((i) => i !== seer.id && !(i in this.state.seerChecks));
      const target = await this.askTarget(seer.id, 'seer', cands.length ? cands : alive.filter((i) => i !== seer.id), false, '选择今晚要查验的玩家。', '预言家查验中');
      if (target !== null) {
        // the GM tells the seer at once
        const role = this.players[target].role;
        this.state.seerChecks[target] = role;
        this.emit('private', `查验结果：${seat(target)} 的身份是【${ROLE_NAME[role]}】。`, { kind: 'private', to: [seer.id] }, { data: { check: target, role } });
        this.publish();
        await this.cue({ kind: 'seer', actor: seer.id, target });
      }
      await this.pace();
    }

    // 2. 守卫
    const guardP = this.byRole('guard');
    let guarded: number | null = null;
    this.announceStep('guard', '守卫请睁眼，请选择要守护的玩家。');
    if (!guardP?.alive) await this.idleTurn();
    else {
      const cands = alive.filter((i) => i !== guardP.id && i !== this.state.lastGuarded);
      guarded = await this.askTarget(guardP.id, 'guard', cands, true, `不能守护自己，不能连续守护同一人（上一晚守护：${this.state.lastGuarded === null ? '无' : seat(this.state.lastGuarded)}）。可以空守。`, '守卫守护中');
      if (guarded === null) this.gm('你今晚选择空守。', [guardP.id]);
      else {
        this.emit('private', `你今晚守护了 ${seat(guarded)}。`, { kind: 'private', to: [guardP.id] }, { data: { guard: guarded } });
        await this.cue({ kind: 'guard', actor: guardP.id, target: guarded });
      }
      await this.pace();
    }
    this.state.lastGuarded = guarded;

    // 3. 狼群
    const wolfKill = await this.wolfTurn();
    this.setNightStep(null);
    if (wolfKill !== null && wolfKill !== guarded) pending.set(wolfKill, 'wolf');

    // 4. 猎人（任意时机可开一枪；夜晚轮次询问）
    const hunter = this.byRole('hunter');
    this.announceStep('hunter', '猎人请睁眼，是否要开枪？');
    if (!(hunter?.alive && !this.state.hunterShot && !pending.has(hunter.id))) await this.idleTurn();
    else {
      const cands = this.aliveIds().filter((i) => i !== hunter.id);
      const shot = await this.askTarget(hunter.id, 'hunterShot', cands, true, '你可以现在开枪带走一名玩家（整局仅一发），也可以不开。', '猎人决定中');
      if (shot !== null) {
        this.state.hunterShot = true;
        pending.set(shot, 'hunter');
        this.emit('private', `你向 ${seat(shot)} 开了枪。`, { kind: 'private', to: [hunter.id] }, { data: { shot } });
        await this.cue({ kind: 'nightShot', actor: hunter.id, target: shot });
      }
      await this.pace();
    }

    // 5. 女巫（若已在今夜被杀则轮次作废）
    const witch = this.byRole('witch');
    this.announceStep('witch', '女巫请睁眼。');
    if (!(witch?.alive && !pending.has(witch.id))) await this.idleTurn();
    else {
      const w = this.state.witch;
      if (w.hasAntidote && pending.size > 0) {
        const dead = [...pending.keys()].sort((a, b) => a - b);
        const save = await this.askTarget(witch.id, 'witchSave', dead, true, `今晚死亡的玩家：${dead.map(seat).join('、')}。你有一瓶金水，是否救人？（只能救一人）`, '女巫决定救人');
        if (save !== null) {
          w.hasAntidote = false;
          pending.delete(save);
          this.emit('private', `你用金水救了 ${seat(save)}。`, { kind: 'private', to: [witch.id] }, { data: { saved: save } });
          await this.cue({ kind: 'witchSave', actor: witch.id, target: save });
        }
      } else if (w.hasAntidote) {
        this.gm('今晚无人死亡。', [witch.id]);
      }
      if (w.hasPoison) {
        const cands = this.aliveIds().filter((i) => i !== witch.id && !pending.has(i));
        const poison = await this.askTarget(witch.id, 'witchPoison', cands, true, '你有一瓶银水（毒药），是否要毒杀一名存活玩家？', '女巫决定用毒');
        if (poison !== null) {
          w.hasPoison = false;
          pending.set(poison, 'poison');
          this.emit('private', `你向 ${seat(poison)} 使用了银水。`, { kind: 'private', to: [witch.id] }, { data: { poison } });
          await this.cue({ kind: 'witchPoison', actor: witch.id, target: poison });
        }
      }
      await this.pace();
    }

    // 天亮结算
    this.setNightStep(null);
    this.setPhase('dawn');
    const deaths = [...pending.keys()].sort((a, b) => a - b);
    this.gm(`天亮了。${deaths.length ? `昨晚死亡的玩家：${deaths.map((i) => `${seat(i)} ${this.players[i].name}`).join('、')}。` : '昨晚是平安夜。'}`);
    for (const id of deaths) this.kill(id, pending.get(id)!);
    await this.cue('dawn');
    this.nightDeaths = deaths;
    await this.pace(2);
  }

  private nightDeaths: number[] = [];
  private lastSpeechFallback = false;
  private lastSpeechExplode = false;

  private async wolfTurn(): Promise<number | null> {
    const wolves = this.wolves().filter((w) => w.alive);
    if (!wolves.length) return null;
    // dead wolves (e.g. a voted-out human) keep watching their pack's channel
    const channel: Visibility = { kind: 'private', to: this.wolves().map((w) => w.id) };
    this.announceStep('wolves', '狼人请睁眼，请商量今晚的目标。');
    await this.cue('wolvesOut');
    const day = this.state.day;
    if (wolves.length > 1) {
      let rounds = this.wolfChatRounds;
      for (let round = 1; round <= rounds; round++) {
        // from round 2 the human (if a wolf) speaks last, after seeing what the AI wolves added;
        // if they all passed the human gets a one-click "no addition, vote now"
        const extra = round > this.wolfChatRounds;
        const order = round === 1 ? wolves : [...wolves.filter((w) => !w.isHuman), ...(extra ? [] : wolves.filter((w) => w.isHuman))];
        let passes = 0;
        let spoken = 0;
        let humanSpoke = false;
        for (const w of order) {
          const othersPassed = round > 1 && spoken > 0 && passes === spoken;
          const text = (await this.ask(w.id, { kind: 'wolfChat', round, rounds, day, othersPassed }, `狼队沟通 ${round}/${rounds}`)) as string;
          const bare = isPass(text);
          const passed = bare || isWolfPass(text);
          spoken++;
          if (passed) passes++;
          else if (w.isHuman) humanSpoke = true;
          this.emit('wolfChat', bare ? '（没有补充）' : text, channel, { speaker: w.id, data: this.lastSpeechFallback ? { fallback: true } : undefined });
        }
        if (passes === spoken) break; // nobody had anything to add: go straight to the vote
        // the human had the last word of the last round: give the AI wolves one more turn to answer it
        if (round === rounds && humanSpoke && !extra) rounds++;
      }
    }
    const cands = this.aliveIds();
    const votes = new Map<number, number>();
    // AI wolves vote first; a living human wolf sees their picks (like wolves pointing at night) and votes last
    const ai = wolves.filter((w) => !w.isHuman);
    const human = wolves.filter((w) => w.isHuman);
    for (const w of ai) {
      const t = (await this.askTarget(w.id, 'wolfKill', cands, false, '投票选择今晚要杀的玩家（可以选择狼队友）。', '狼队投票中'))!;
      votes.set(w.id, t);
    }
    const aiVotes = ai.map((w) => `${seat(w.id)}→${seat(votes.get(w.id)!)}`).join('，');
    if (human.length && ai.length) this.emit('wolfChat', `队友已投：${aiVotes}。`, channel);
    for (const w of human) {
      const prompt = ai.length ? `队友已投：${aiVotes}。投票选择今晚要杀的玩家（可以选择狼队友）。` : '投票选择今晚要杀的玩家（可以选择狼队友）。';
      const t = (await this.askTarget(w.id, 'wolfKill', cands, false, prompt, '狼队投票中'))!;
      votes.set(w.id, t);
    }
    const tally = new Map<number, number>();
    for (const t of votes.values()) tally.set(t, (tally.get(t) ?? 0) + 1);
    const [top, topCount] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    let target: number;
    const detail = [...votes.entries()].map(([w, t]) => `${seat(w)}→${seat(t)}`).join('，');
    if (topCount * 2 > wolves.length) {
      target = top;
      this.emit('wolfChat', `狼队投票：${detail}。今晚击杀 ${seat(target)}。`, channel, { data: { target } });
    } else {
      target = this.rng.pick([...tally.keys()]);
      this.emit('wolfChat', `狼队投票：${detail}。未过半数，系统随机选定 ${seat(target)}。`, channel, { data: { target } });
    }
    // the wolf turn only ends once the pack is fully back indoors
    await this.cue('wolvesIn');
    await this.pace();
    return target;
  }

  // ───────────────────────── day ─────────────────────────

  private async hunterOnDeath(): Promise<boolean> {
    const hunter = this.byRole('hunter');
    if (!hunter || hunter.alive || this.state.hunterShot) return false;
    this.gm(`${seat(hunter.id)} 出局，若有技能可以发动。`);
    const cands = this.aliveIds();
    const shot = await this.askTarget(hunter.id, 'hunterShot', cands, true, '你已出局，可以开枪带走一名存活玩家（整局仅一发）。', '出局技能');
    this.state.hunterShot = true; // chance is consumed either way
    if (shot !== null) {
      this.gm(`${seat(hunter.id)} 是猎人，开枪带走了 ${seat(shot)} ${this.players[shot].name}。`);
      await this.cue({ kind: 'dayShot', actor: hunter.id, target: shot });
      this.kill(shot, 'hunter');
      await this.pace(2);
      return this.endIfWon();
    }
    return false;
  }

  /** Returns true if the speaker (a wolf) self-destructed: the day ends at once. */
  private async speech(id: number, purpose: SpeechKind, label: string, seq: SpeechOrder = {}): Promise<boolean> {
    const canExplode = purpose !== 'lastWords' && this.players[id].role === 'werewolf';
    const text = (await this.ask(id, { kind: 'speech', purpose, day: this.state.day, ...seq, ...(canExplode ? { canExplode } : {}) }, label)) as string;
    const explode = canExplode && this.lastSpeechExplode;
    const data = { ...(this.lastSpeechFallback ? { fallback: true } : {}), ...(explode ? { explode: true } : {}) };
    await this.gate();
    if (!this.replaying && this.hooks.beforeSpeech) {
      this.checkRestored();
      await this.hooks.beforeSpeech(id);
      await this.gate();
    }
    if (!(explode && isPass(text))) this.emit('speech', text, { kind: 'public' }, { speaker: id, speechKind: purpose, data: Object.keys(data).length ? data : undefined });
    if (explode) {
      this.gm(`${seat(id)} ${this.players[id].name} 自爆，身份是狼人！本轮剩余发言与投票取消，直接进入黑夜。`);
      this.kill(id, 'explode');
      await this.cue('explode');
    }
    await this.pace();
    return explode;
  }

  private async dayPhase() {
    const day = this.state.day;
    // 夜里死去的猎人
    if (this.nightDeaths.includes(this.byRole('hunter')?.id ?? -1)) {
      if (await this.hunterOnDeath()) return;
    }

    this.setPhase('discussion');
    const alive = this.aliveIds();
    const first = this.rng.pick(alive);
    const clockwise = this.rng.next() < 0.5;
    const order = circularOrder(alive, first, clockwise);
    this.gm(`第 ${day} 天发言开始：由 ${seat(first)} 开始，${clockwise ? '顺时针' : '逆时针'}发言。`);
    await this.pace();
    const spoken: number[] = [];
    for (const id of order) {
      if (!this.players[id].alive) continue;
      if (await this.speech(id, 'discussion', '发言中', { order, spoken: [...spoken], first, clockwise })) return;
      spoken.push(id);
    }
    if (this.players[first].alive) {
      this.gm(`请首位发言的 ${seat(first)} 做归纳总结。`);
      if (await this.speech(first, 'summary', '归纳总结', { order, spoken, first, clockwise })) return;
    }

    // 投票
    this.setPhase('vote');
    this.gm('发言结束，开始投票。');
    let out = await this.voteRound(this.aliveIds(), 'vote');
    if (out.length > 1) {
      this.gm(`${out.map(seat).join('、')} 平票，请平票玩家依次发言为自己正名。`);
      const defended: number[] = [];
      for (const id of out) {
        if (await this.speech(id, 'defense', '平票正名', { order: out, spoken: [...defended] })) return;
        defended.push(id);
      }
      this.gm('请在平票玩家中再次投票。');
      out = await this.voteRound(out, 'revote');
      if (out.length > 1) {
        const pick = this.rng.pick(out);
        this.gm(`再次平票，GM 随机淘汰 ${seat(pick)}。`);
        out = [pick];
      }
    }
    if (out.length === 0) {
      this.gm('全员弃票，今天无人出局。');
      await this.pace();
      return;
    }
    const exiled = out[0];
    this.gm(`${seat(exiled)} ${this.players[exiled].name} 被放逐。`);
    this.kill(exiled, 'vote');
    if (this.endIfWon()) return;
    this.setPhase('lastWords');
    await this.speech(exiled, 'lastWords', '遗言');
    if (this.players[exiled].role === 'hunter' && (await this.hunterOnDeath())) return;
    // the exile stays on the plaza, last words overhead, until the human sends them off
    await this.gate();
    if (!this.replaying && this.hooks.confirmExile) {
      this.checkRestored();
      await this.hooks.confirmExile(exiled);
      await this.gate();
    }
  }

  /** Returns the ids with the top vote count (empty if everyone abstained). */
  private async voteRound(candidates: number[], action: 'vote' | 'revote'): Promise<number[]> {
    const votes: [number, number | null][] = [];
    for (const voter of this.aliveIds()) {
      const cands = candidates.filter((c) => c !== voter);
      if (!cands.length) {
        votes.push([voter, null]);
        continue;
      }
      const t = await this.askTarget(voter, action, cands, true, action === 'vote' ? '投票放逐一名玩家，也可以弃票。' : `只能在平票玩家 ${candidates.map(seat).join('、')} 中投票，也可以弃票。`, '投票中');
      votes.push([voter, t]);
    }
    const tally = new Map<number, number[]>();
    for (const [v, t] of votes) if (t !== null) tally.set(t, [...(tally.get(t) ?? []), v]);
    const lines = [...tally.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([t, vs]) => `${seat(t)}（${vs.length}票）← ${vs.map((v) => v + 1).join(',')}`);
    const abstain = votes.filter(([, t]) => t === null).map(([v]) => v + 1);
    this.emit('vote', `投票结果：${lines.join('；') || '无'}${abstain.length ? `；弃票：${abstain.join(',')}` : ''}`, { kind: 'public' }, { data: { votes: Object.fromEntries(votes) } });
    await this.pace();
    if (!tally.size) return [];
    const max = Math.max(...[...tally.values()].map((v) => v.length));
    return [...tally.entries()].filter(([, v]) => v.length === max).map(([t]) => t);
  }
}

export function isPass(text: string): boolean {
  return /^\s*(pass|过|结束)\s*[。.!！]?\s*$/i.test(text);
}

/** A wolf-chat line that adds nothing: "pass", "过…", or a short "没有补充 / 没意见". */
export function isWolfPass(text: string): boolean {
  return /^\s*(pass|过)/i.test(text) || (text.length <= 30 && /没有?补充|没意见|pass/i.test(text));
}

export function canSee(v: Visibility, id: number): boolean {
  return v.kind === 'public' || v.to.includes(id);
}

/** Alive ids starting from `first`, going clockwise (ascending seats) or counter-clockwise. */
export function circularOrder(alive: number[], first: number, clockwise: boolean): number[] {
  const sorted = alive.slice().sort((a, b) => a - b);
  if (!clockwise) sorted.reverse();
  const i = sorted.indexOf(first);
  return [...sorted.slice(i), ...sorted.slice(0, i)];
}
