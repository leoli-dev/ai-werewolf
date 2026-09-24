export type Role = 'werewolf' | 'villager' | 'seer' | 'witch' | 'hunter' | 'guard';
export type Team = 'wolf' | 'good';

export const ROLE_NAME: Record<Role, string> = {
  werewolf: '狼人',
  villager: '村民',
  seer: '预言家',
  witch: '女巫',
  hunter: '猎人',
  guard: '守卫',
};

export const GOD_ROLES: Role[] = ['seer', 'witch', 'hunter', 'guard'];

/** 12 人屠边局：4 狼 / 4 民 / 预言家 女巫 猎人 守卫 */
export const STANDARD_BOARD: Role[] = [
  'werewolf', 'werewolf', 'werewolf', 'werewolf',
  'villager', 'villager', 'villager', 'villager',
  'seer', 'witch', 'hunter', 'guard',
];

export function teamOf(role: Role): Team {
  return role === 'werewolf' ? 'wolf' : 'good';
}

export interface Player {
  /** 0-based index; seat number shown to users is id + 1 */
  id: number;
  name: string;
  role: Role;
  alive: boolean;
  isHuman: boolean;
}

export type DeathCause = 'wolf' | 'poison' | 'hunter' | 'vote' | 'explode' | 'gm';

export type Phase =
  | 'setup'
  | 'night'
  | 'dawn'
  | 'discussion'
  | 'vote'
  | 'lastWords'
  | 'ended';

/** Who can see an event. `private` is a list of player ids. */
export type Visibility = { kind: 'public' } | { kind: 'private'; to: number[] };

export type EventType =
  | 'gm'          // GM narration / announcements
  | 'speech'      // day speech (public)
  | 'wolfChat'    // wolf-channel chat (wolves only)
  | 'vote'        // a public vote tally
  | 'death'       // someone was eliminated
  | 'private'     // private info for one player (seer result, witch info, ...)
  | 'system';     // engine/ai diagnostics

export type SpeechKind = 'discussion' | 'summary' | 'lastWords' | 'defense';

export interface GameEvent {
  seq: number;
  day: number;
  phase: Phase;
  type: EventType;
  text: string;
  speaker?: number;
  speechKind?: SpeechKind;
  visibility: Visibility;
  data?: Record<string, unknown>;
}

export type TargetAction =
  | 'vote'
  | 'revote'
  | 'seer'
  | 'guard'
  | 'wolfKill'
  | 'hunterShot'
  | 'witchSave'
  | 'witchPoison';

export interface SpeechRequest {
  kind: 'speech';
  purpose: SpeechKind;
  day: number;
  /** Speaking order of this sequence (discussion: the day's round; defense: the tied players). */
  order?: number[];
  /** Who in `order` has already spoken in this sequence. */
  spoken?: number[];
  /** Discussion only: who opened the round and in which direction it goes. */
  first?: number;
  clockwise?: boolean;
  /** The speaker is a wolf on a day turn: they may self-destruct (自爆) instead of just speaking. */
  canExplode?: boolean;
}

/** Where a speaker stands in the current speaking sequence. */
export type SpeechOrder = Pick<SpeechRequest, 'order' | 'spoken' | 'first' | 'clockwise'>;

export interface WolfChatRequest {
  kind: 'wolfChat';
  round: number;
  rounds: number;
  day: number;
  /** Round ≥ 2 and every teammate before you had nothing to add. */
  othersPassed?: boolean;
}

export interface TargetRequest {
  kind: 'target';
  action: TargetAction;
  day: number;
  candidates: number[];
  allowSkip: boolean;
  /** Extra context the GM tells this player (e.g. witch's death list) */
  prompt: string;
}

export type DecisionRequest = SpeechRequest | WolfChatRequest | TargetRequest;

/** Read-only projection of the game that an agent is allowed to see. */
export interface PlayerView {
  self: Player;
  day: number;
  phase: Phase;
  players: { id: number; name: string; alive: boolean }[];
  /** Roles this player legitimately knows (self, wolf teammates, seer checks). */
  known: Record<number, Role | 'good' | 'wolf'>;
  events: GameEvent[];
  witch?: { hasAntidote: boolean; hasPoison: boolean };
  hunter?: { hasShot: boolean };
  guard?: { lastGuarded: number | null };
}

/**
 * `fallback` marks text produced by the rule AI instead of the model; `explode`
 * means the wolf self-destructs after these words (only honoured with `canExplode`).
 */
export type SpeechResult = string | { text: string; fallback?: boolean; explode?: boolean };

/**
 * One answer an agent gave, in the order the GM asked. A save game is the deal
 * seed plus this journal: replaying it reproduces the game exactly.
 */
export type Decision = { t: number | null } | { s: string; fb?: true; x?: true };

export interface Agent {
  speak(req: SpeechRequest | WolfChatRequest, view: PlayerView): Promise<SpeechResult>;
  choose(req: TargetRequest, view: PlayerView): Promise<number | null>;
}

export type Winner = Team | null;

export const seat = (id: number) => `${id + 1}号`;
