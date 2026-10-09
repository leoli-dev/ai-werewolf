import type { Game } from './game';
import {
  ROLE_NAME,
  STANDARD_BOARD,
  teamOf,
  type DeathCause,
  type Decision,
  type DecisionLog,
  type GameEvent,
  type Phase,
  type Role,
  type Team,
  type Winner,
} from './types';

/**
 * 对局记录: everything that happened in one game, from the god's view, in a fixed
 * JSON shape that can be exported at any moment (mid-game or after it):
 * who sat where as what, every line of narration / speech / wolf chat / private
 * info (with who could see it), every decision taken (the question, the answer,
 * the AI's reason, what the rules made of it), every death and the result.
 *
 * The shape is versioned by `format` + `version`; a change that breaks readers
 * bumps `version`.
 */
export const RECORD_FORMAT = 'ai-werewolf/game-record';
export const RECORD_VERSION = 1;

export interface GameRecord {
  format: typeof RECORD_FORMAT;
  version: typeof RECORD_VERSION;
  /** ISO 8601 */
  exportedAt: string;
  /** 'inProgress' when exported mid-game. */
  status: 'inProgress' | 'ended';
  game: RecordGameInfo;
  players: RecordPlayer[];
  /** Events and decisions merged in the order they happened (see `TimelineEntry`). */
  timeline: TimelineEntry[];
  /** Where the game stands at export time. */
  state: RecordState;
  /** Null until the game is over. */
  result: RecordResult | null;
  /** 颁奖典礼 (post-game remarks and award votes), once it has started. */
  ceremony: RecordCeremonyLine[] | null;
  /** Seeds + every answer: enough for the engine to rebuild the game exactly. */
  replay: { setupSeed: number; gameSeed: number; journal: Decision[] };
}

export interface RecordGameInfo {
  /** 12 人局（狼王守卫）: the roles dealt. */
  board: Role[];
  /** The human's seat id (0-based), or -1 when nobody plays one. */
  humanSeat: number;
  /** The human's seat was played by the AI throughout. */
  autoPlay: boolean;
  /** 'llm' = AI players driven by a model, 'offline' = the rule AI only. */
  engine: 'llm' | 'offline';
  /** The model in use at export time (llm engine only); no addresses, no keys. */
  llm: { provider: string; model: string } | null;
  wolfChatRounds: number;
  /** Time played (pauses excluded), ms. */
  elapsedMs: number;
}

export interface RecordPlayer {
  /** 0-based, as used everywhere in the record (events, decisions, votes). */
  id: number;
  /** Shown to players: id + 1. */
  seat: number;
  name: string;
  role: Role;
  roleName: string;
  team: Team;
  /** Played by the human (false for every seat in an AI-autoplay game). */
  isHuman: boolean;
  /** The AI's 打法风格 (null for the human / when none). */
  playstyle: string | null;
  alive: boolean;
  /** How they went out (god view), null while alive. */
  death: { cause: DeathCause; day: number; phase: Phase; atEvent: number } | null;
  /** The AI's own notes on why it did what it did (llm engine; null otherwise). */
  notes: string[] | null;
}

/**
 * `event`: something the GM / a player put on the record (GameEvent as emitted;
 * `visibility` says who saw it). `decision`: an answer the GM asked for.
 * A decision comes right before the events it led to.
 */
export type TimelineEntry = ({ kind: 'event' } & GameEvent) | ({ kind: 'decision' } & DecisionLog);

export interface RecordState {
  day: number;
  phase: Phase;
  sheriff: number | null;
  witch: { hasAntidote: boolean; hasPoison: boolean };
  hunterShot: boolean;
  wolfKingShot: boolean;
  lastGuarded: number | null;
  /** The seer's checks so far: seat id → result. */
  seerChecks: Record<number, 'good' | 'wolf'>;
  alive: number[];
}

export interface RecordResult {
  winner: Exclude<Winner, null>;
  days: number;
  survivors: number[];
}

export interface RecordCeremonyLine {
  /** null for a GM note (tallies, awards). */
  speaker: number | null;
  /** e.g. "赛后感言", "投票" */
  tag: string | null;
  text: string;
  fallback?: boolean;
}

/** What the record needs beyond the engine itself (the host knows these). */
export interface RecordContext {
  setupSeed: number;
  humanSeat: number;
  autoPlay: boolean;
  engine: 'llm' | 'offline';
  llm: { provider: string; model: string } | null;
  wolfChatRounds: number;
  elapsedMs: number;
  playstyles: (string | null)[];
  notes: (string[] | null)[];
  ceremony: RecordCeremonyLine[] | null;
  now?: Date;
}

export function buildRecord(game: Game, ctx: RecordContext): GameRecord {
  const s = game.state;
  const causes = game.deathCauses();
  const deathEvents = new Map<number, GameEvent>();
  for (const e of game.events) if (e.type === 'death' && typeof e.data?.id === 'number') deathEvents.set(e.data.id, e);

  const players: RecordPlayer[] = game.players.map((p) => {
    const e = deathEvents.get(p.id);
    const cause = causes[p.id];
    return {
      id: p.id,
      seat: p.id + 1,
      name: p.name,
      role: p.role,
      roleName: ROLE_NAME[p.role],
      team: teamOf(p.role),
      isHuman: p.isHuman,
      playstyle: ctx.playstyles[p.id] ?? null,
      alive: p.alive,
      death: !p.alive && cause && e ? { cause, day: e.day, phase: e.phase, atEvent: e.seq } : null,
      notes: ctx.notes[p.id]?.slice() ?? null,
    };
  });

  return {
    format: RECORD_FORMAT,
    version: RECORD_VERSION,
    exportedAt: (ctx.now ?? new Date()).toISOString(),
    status: s.phase === 'ended' ? 'ended' : 'inProgress',
    game: {
      board: STANDARD_BOARD.slice(),
      humanSeat: ctx.humanSeat,
      autoPlay: ctx.autoPlay,
      engine: ctx.engine,
      llm: ctx.engine === 'llm' ? ctx.llm : null,
      wolfChatRounds: ctx.wolfChatRounds,
      elapsedMs: Math.round(ctx.elapsedMs),
    },
    players,
    timeline: mergeTimeline(game.events, game.decisions),
    state: {
      day: s.day,
      phase: s.phase,
      sheriff: s.sheriff,
      witch: { ...s.witch },
      hunterShot: s.hunterShot,
      wolfKingShot: s.wolfKingShot,
      lastGuarded: s.lastGuarded,
      seerChecks: { ...s.seerChecks },
      alive: game.aliveIds(),
    },
    result: s.winner ? { winner: s.winner, days: s.day, survivors: game.aliveIds() } : null,
    ceremony: ctx.ceremony?.map((l) => ({ ...l })) ?? null,
    replay: { setupSeed: ctx.setupSeed, gameSeed: game.seed, journal: game.journal.map((d) => ({ ...d })) },
  };
}

/** Each decision goes right before the first event emitted after it. */
export function mergeTimeline(events: GameEvent[], decisions: DecisionLog[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  let d = 0;
  for (const e of events) {
    while (d < decisions.length && decisions[d].atEvent <= e.seq) out.push({ kind: 'decision', ...structuredClone(decisions[d++]) });
    out.push({ kind: 'event', ...structuredClone(e) });
  }
  while (d < decisions.length) out.push({ kind: 'decision', ...structuredClone(decisions[d++]) });
  return out;
}

/** e.g. "ai-werewolf-2026-10-09-2130-day3.json" */
export function recordFileName(r: GameRecord): string {
  const d = new Date(r.exportedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const where = r.status === 'ended' ? `${r.result!.winner}-wins` : `day${r.state.day}`;
  return `ai-werewolf-${stamp}-${where}.json`;
}

/** One-line description for UI, e.g. "第 3 天 · 12 条决策 · 87 条事件". */
export function recordSummary(r: GameRecord): string {
  const events = r.timeline.filter((t) => t.kind === 'event').length;
  const decisions = r.timeline.length - events;
  return `${r.status === 'ended' ? '已结束' : `进行中（第 ${r.state.day} 天）`} · ${events} 条事件 · ${decisions} 次决策`;
}
