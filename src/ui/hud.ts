import type { Game, GameState, NightStep, RoleCue, SceneCue } from '../game/game';
import { canSee } from '../game/game';
import {
  ROLE_NAME,
  seat,
  teamOf,
  type Agent,
  type GameEvent,
  type PlayerView,
  type Role,
  type SpeechRequest,
  type SpeechResult,
  type TargetRequest,
  type WolfChatRequest,
} from '../game/types';
import { characterCanvas, type Look } from '../render/pixel';
import type { ScreenPos, Stage } from '../render/stage';
import { audio } from '../audio/audio';
import { getConfig, onConfigChange, updateConfig } from '../settings';
import { h } from './dom';
import { showRules } from './rules';

const ROLE_DESC: Record<Role, string> = {
  werewolf: '每晚与狼队商量并投票杀人；白天伪装成好人。',
  villager: '没有技能，靠发言与投票找出狼人。',
  seer: '每晚查验一人的具体身份。',
  witch: '金水救人、银水毒人，各一瓶。',
  hunter: '整局一枪：夜里或出局时可带走一人。',
  guard: '每晚守护一人免受狼刀，不可连守。',
};

const ACTION_TITLE: Record<TargetRequest['action'], string> = {
  vote: '放逐投票',
  revote: '平票再投',
  seer: '预言家 · 查验',
  guard: '守卫 · 守护',
  wolfKill: '狼队 · 投票刀人',
  hunterShot: '猎人 · 开枪',
  witchSave: '女巫 · 金水',
  witchPoison: '女巫 · 银水',
};

type Tab = 'round' | 'all' | 'wolf' | 'private';

/** Phone-sized screens (portrait, or a landscape phone): the HUD folds into a bottom dock + sheets. */
const MOBILE = window.matchMedia('(max-width: 760px), (max-height: 520px)');

/** Mobile: which sheet is pulled up over the scene. */
type Sheet = 'none' | 'players' | 'chat';

/**
 * One clearly different bubble colour per seat (12 distinct colour families,
 * ordered so neighbouring seats never look alike), reused in the chat log.
 */
const BUBBLE_COLORS: { bg: string; edge: string }[] = [
  { bg: '#ffd95e', edge: '#8a6a00' }, // 1 yellow
  { bg: '#7ab8ff', edge: '#1f4f8a' }, // 2 blue
  { bg: '#ff8f85', edge: '#9a2a22' }, // 3 red
  { bg: '#7fdc98', edge: '#1f6b36' }, // 4 green
  { bg: '#d4a4ff', edge: '#5e2a8f' }, // 5 purple
  { bg: '#ffb066', edge: '#8f4c0a' }, // 6 orange
  { bg: '#74e0e0', edge: '#0f6666' }, // 7 cyan
  { bg: '#ff9fd0', edge: '#8f2a5f' }, // 8 pink
  { bg: '#c8e67a', edge: '#4f6a10' }, // 9 lime
  { bg: '#aeb4ff', edge: '#2e3490' }, // 10 periwinkle
  { bg: '#e2c49c', edge: '#6a4a24' }, // 11 tan
  { bg: '#eeeeea', edge: '#55554f' }, // 12 light grey
];

export function bubbleColor(id: number) {
  return BUBBLE_COLORS[id % BUBBLE_COLORS.length];
}

function bubbleStyle(id: number) {
  const c = bubbleColor(id);
  return `background:${c.bg};border-color:${c.edge};box-shadow:2px 2px 0 ${c.edge}`;
}

/** Public night-step names (GM announces the turn, never what the role does). */
const NIGHT_STEP_NAME: Record<NightStep, string> = {
  seer: '预言家轮',
  guard: '守卫轮',
  wolves: '狼人轮',
  hunter: '猎人轮',
  witch: '女巫轮',
};

export interface GameUIOptions {
  /** Resuming a save: the replay rebuilds the log silently, then `restored()` sets the scene. */
  restoring: boolean;
  /** Game time already played (resumed games). */
  elapsedMs: number;
  onPause: () => void;
}

export class GameUI {
  private hud!: HTMLElement;
  private roleCard!: HTMLElement;
  private roster!: HTMLElement;
  private banner!: HTMLElement;
  private chatLog!: HTMLElement;
  private chatTabs!: HTMLElement;
  private chatFilter!: HTMLElement;
  private action!: HTMLElement;
  private labelEls: HTMLElement[] = [];
  private bubbles = new Map<number, { text: string; seq: number }>();
  private bubbleSeq = 0;
  private tab: Tab = 'round';
  private playerFilter: number | null = null;
  private pendingTarget: { req: TargetRequest; select: (id: number) => void } | null = null;
  private lastPhase = '';
  private clock!: HTMLElement;
  private stepEl!: HTMLElement;
  private lastStep: NightStep | null = null;
  private clockTimer = 0;
  /** Played time before `runningSince` (the clock stops while paused). */
  private playedMs = 0;
  private runningSince: number | null = null;
  private restoring: boolean;
  private actorKey = '';
  private actorSince = 0;
  private actorTimer = 0;
  readonly agent: Agent;
  private engineChip = h('div', { class: 'engine panel', title: 'AI 引擎状态' });
  private engineStats = { ok: 0, fail: 0, fallback: 0, lastMs: 0 };
  private dock!: HTMLElement;
  private sheet: Sheet = 'none';
  private unread = 0;
  /** Label tapped last (touch has no hover to bring a buried bubble to the front). */
  private raised: number | null = null;
  private cleanups: (() => void)[] = [];

  constructor(
    private root: HTMLElement,
    private labelsRoot: HTMLElement,
    private stage: Stage,
    private game: Game,
    private me: number,
    private godView: boolean,
    private onRestart: () => void,
    private looks: Look[],
    private opts: GameUIOptions,
  ) {
    this.restoring = opts.restoring;
    this.playedMs = opts.elapsedMs;
    this.build();
    this.agent = {
      speak: (req, view) => this.askSpeech(req, view),
      choose: (req, view) => this.askTarget(req, view),
    };
    stage.onFrame = (p) => this.placeLabels(p);
    stage.onPick = (id) => this.pick(id);
    stage.highlightSelf(me);
  }

  private view(): PlayerView {
    return this.game.viewFor(this.me);
  }

  private canSee(e: GameEvent) {
    return this.godView || canSee(e.visibility, this.me);
  }

  /** What the human knows about player `id`'s role/alignment. */
  private knownOf(id: number): { text: string; cls: string; ring?: 'good' | 'wolf' } | null {
    const p = this.game.players[id];
    if (this.godView || this.game.state.phase === 'ended') {
      return { text: ROLE_NAME[p.role], cls: teamOf(p.role) === 'wolf' ? 'wolf' : 'good', ring: this.ringOf(id) };
    }
    const k = this.view().known[id];
    const ring = this.ringOf(id);
    if (id === this.me) return { text: ROLE_NAME[p.role], cls: 'me', ring };
    // a wolf you checked as the seer is a check result, not a teammate
    if (k === 'werewolf' && this.game.players[this.me].role === 'werewolf') return { text: '狼队友', cls: 'wolf' };
    if (ring) return { text: `查验：${ROLE_NAME[this.game.state.seerChecks[id]]}`, cls: ring, ring };
    return null;
  }

  private ringOf(id: number): 'good' | 'wolf' | undefined {
    const me = this.game.players[this.me];
    if (me.role !== 'seer' && !this.godView) return undefined;
    const r = this.game.state.seerChecks[id];
    return r ? (teamOf(r) === 'wolf' ? 'wolf' : 'good') : undefined;
  }

  // ───────────────────────── build ─────────────────────────

  private build() {
    const me = this.game.players[this.me];
    const portrait = characterCanvas(this.looks[this.me]);
    this.roleCard = h('div', { class: 'role-card panel' });
    this.roleCard.append(
      portrait,
      h(
        'div',
        {},
        h('div', { class: 'seat' }, `SEAT ${this.me + 1} · ${me.name}`),
        h('div', { class: `role ${me.role === 'werewolf' ? 'wolf' : 'good'}` }, ROLE_NAME[me.role]),
        h('div', { class: 'desc' }, ROLE_DESC[me.role]),
        h('div', { class: 'items' }),
      ),
    );
    this.roster = h('div', { class: 'roster panel' });
    this.hud = h('div', { id: 'hud' }, this.roleCard, this.roster);

    this.clock = h('div', { class: 'clock', title: '本局已进行时间' }, '00:00');
    this.banner = h('div', { id: 'banner', class: 'panel' }, this.clock, h('div', { class: 'phase' }, '准备中'), h('div', { class: 'actor' }));
    this.runningSince = performance.now();
    this.clockTimer = window.setInterval(() => this.renderClock(), 1000);
    this.renderClock();

    const topright = h(
      'div',
      { id: 'topright' },
      this.engineChip,
      this.muteBtn(),
      h('button', { class: 'btn', title: '规则说明', 'aria-label': '规则说明', onclick: () => showRules(this.root) }, h('span', { class: 'long' }, '规则说明'), h('span', { class: 'short' }, '?')),
      h('button', { class: 'btn', title: '暂停（Esc）', 'aria-label': '暂停', onclick: () => this.opts.onPause() }, h('span', { class: 'long' }, '暂停'), h('span', { class: 'short' }, 'Ⅱ')),
    );

    this.chatTabs = h('div', { class: 'tabs', role: 'tablist' });
    this.chatFilter = h('div', { class: 'filter' });
    this.chatLog = h('div', { class: 'log', 'aria-live': 'polite' });
    const chat = h('div', { id: 'chat', class: 'panel' }, this.chatTabs, this.chatFilter, this.chatLog);

    this.action = h('div', { id: 'action', class: 'panel' });

    this.stepEl = h('div', { id: 'nightstep', 'aria-live': 'polite' });
    this.dock = h('nav', { id: 'dock', class: 'panel', 'aria-label': '面板' });
    this.root.append(this.hud, this.banner, topright, chat, this.action, this.stepEl, this.dock);
    this.bindMobile();

    for (let i = 0; i < 12; i++) {
      const el = h('div', { class: 'label' });
      this.labelsRoot.appendChild(el);
      this.labelEls.push(el);
    }
    this.renderTabs();
    this.renderRoster();
  }

  /**
   * Mobile plumbing: the sheets sit above the dock and the action panel, and the
   * action panel above the on-screen keyboard (CSS reads these as variables).
   */
  private bindMobile() {
    const root = this.root;
    const actionH = new ResizeObserver(() => root.style.setProperty('--action-h', `${this.action.offsetHeight}px`));
    actionH.observe(this.action);
    this.cleanups.push(() => actionH.disconnect());
    const vv = window.visualViewport;
    if (vv) {
      const onViewport = () => root.style.setProperty('--kb', `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`);
      vv.addEventListener('resize', onViewport);
      vv.addEventListener('scroll', onViewport);
      this.cleanups.push(() => {
        vv.removeEventListener('resize', onViewport);
        vv.removeEventListener('scroll', onViewport);
      });
    }
    const onMedia = () => {
      if (!MOBILE.matches) this.setSheet('none');
    };
    MOBILE.addEventListener('change', onMedia);
    this.cleanups.push(() => MOBILE.removeEventListener('change', onMedia));
    // a tapped bubble comes to the front (the desktop gets this from :hover)
    const onLabelTap = (e: PointerEvent) => {
      const i = this.labelEls.indexOf((e.target as HTMLElement).closest('.label') as HTMLElement);
      if (i >= 0) this.raised = i;
    };
    this.labelsRoot.addEventListener('pointerdown', onLabelTap);
    this.cleanups.push(() => this.labelsRoot.removeEventListener('pointerdown', onLabelTap));
    this.renderDock();
  }

  private setSheet(sheet: Sheet) {
    this.sheet = sheet;
    if (sheet === 'none') delete this.root.dataset.sheet;
    else this.root.dataset.sheet = sheet;
    if (sheet === 'chat') {
      this.unread = 0;
      this.chatLog.scrollTop = this.chatLog.scrollHeight;
    }
    this.renderDock();
  }

  private renderDock() {
    const me = this.game.players[this.me];
    const tab = (sheet: Sheet, ...label: (Node | string | null)[]) =>
      h(
        'button',
        {
          class: `dock-tab ${this.sheet === sheet ? 'on' : ''}`,
          'aria-pressed': String(this.sheet === sheet),
          onclick: () => this.setSheet(this.sheet === sheet ? 'none' : sheet),
        },
        ...label,
      );
    this.dock.replaceChildren(
      tab('players', h('span', { class: `dock-role ${me.role === 'werewolf' ? 'wolf' : 'good'}` }, `${this.me + 1}号 ${ROLE_NAME[me.role]}`), '玩家'),
      tab('chat', '记录', this.unread ? h('span', { class: 'badge' }, this.unread > 99 ? '99+' : String(this.unread)) : null),
    );
  }

  /** Game time played so far, excluding pauses. */
  get elapsedMs() {
    return this.playedMs + (this.runningSince === null ? 0 : performance.now() - this.runningSince);
  }

  setPaused(paused: boolean) {
    if (paused && this.runningSince !== null) {
      this.playedMs = this.elapsedMs;
      this.runningSince = null;
    } else if (!paused && this.runningSince === null && this.game.state.phase !== 'ended') {
      this.runningSince = performance.now();
    }
  }

  private renderClock() {
    this.clock.textContent = formatClock(this.elapsedMs);
  }

  /** Quick mute; the same switch as 配置 → 声音. */
  private muteBtn() {
    const label = () => (getConfig().audio.muted ? '♪ 关' : '♪ 开');
    const b = h('button', { class: 'btn', title: '声音开关' }, label());
    b.onclick = () => updateConfig({ audio: { muted: !getConfig().audio.muted } });
    this.unsubConfig = onConfigChange(() => (b.textContent = label()));
    return b;
  }
  private unsubConfig = () => {};

  setEngineMode(mode: 'llm' | 'offline') {
    this.engineMode = mode;
    this.renderEngine();
  }
  private engineMode: 'llm' | 'offline' = 'llm';

  /** Telemetry from LLM agents. */
  recordCall(ok: boolean, ms: number) {
    if (ok) {
      this.engineStats.ok++;
      this.engineStats.lastMs = ms;
    } else this.engineStats.fail++;
    this.renderEngine();
  }

  private renderEngine() {
    const st = this.engineStats;
    if (this.engineMode === 'offline') {
      this.engineChip.className = 'engine panel warn';
      this.engineChip.textContent = '离线规则 AI（非 LLM）';
      return;
    }
    const bad = st.fallback > 0;
    this.engineChip.className = `engine panel ${bad ? 'warn' : ''}`;
    this.engineChip.textContent = `LLM ● ${st.ok} 次${st.lastMs ? ` · 上次 ${(st.lastMs / 1000).toFixed(1)}s` : ''}${st.fail ? ` · 失败 ${st.fail}` : ''}${bad ? ` · 代打 ${st.fallback}` : ''}`;
  }

  /** The model failed for an AI player: pause and let the human decide. */
  askFailure(info: { player: number; kind: string; error: string }): Promise<'retry' | 'fallback'> {
    return new Promise((resolve) => {
      const p = this.game.players[info.player];
      const KIND: Record<string, string> = {
        discussion: '发言', summary: '总结', lastWords: '遗言', defense: '正名', vote: '投票', revote: '再投',
        wolfChat: '狼队沟通', wolfKill: '狼队投票', seer: '查验', guard: '守护', hunterShot: '开枪', witchSave: '救人', witchPoison: '用毒',
      };
      // never reveal who acts at night (would leak roles)
      const secret = this.game.state.phase === 'night' && !this.godView;
      const who = secret ? '夜间某位 AI 玩家行动' : `${seat(p.id)} ${p.name} 的「${KIND[info.kind] ?? info.kind}」`;
      const done = (v: 'retry' | 'fallback') => {
        back.remove();
        if (v === 'fallback') {
          this.engineStats.fallback++;
          this.renderEngine();
        }
        resolve(v);
      };
      const back = h(
        'div',
        { class: 'modal-back' },
        h(
          'div',
          { class: 'modal panel', role: 'alertdialog' },
          h('h2', {}, 'AI 调用失败，游戏已暂停'),
          h('p', {}, `${who}的请求没有拿到可用结果（已自动重试）。`),
          h('p', { class: 'sub' }, info.error),
          h('p', { class: 'sub' }, '可能原因：模型服务不可达、显存不足（HTTP 507）、另一个程序正在占用本地模型导致排队超时。'),
          h(
            'div',
            { class: 'actions' },
            h('button', { class: 'btn', onclick: () => done('fallback') }, '本次由规则 AI 代打'),
            h('button', { class: 'btn primary', onclick: () => done('retry') }, '重试'),
          ),
        ),
      );
      this.root.appendChild(back);
    });
  }

  destroy() {
    this.unsubConfig();
    for (const off of this.cleanups) off();
    delete this.root.dataset.sheet;
    for (const v of ['--action-h', '--kb']) this.root.style.removeProperty(v);
    clearInterval(this.actorTimer);
    clearInterval(this.clockTimer);
    for (const el of [...this.root.children]) el.remove();
    this.labelsRoot.replaceChildren();
    this.stage.onFrame = undefined;
    this.stage.onPick = undefined;
  }

  // ───────────────────────── game hooks ─────────────────────────

  onEvent(e: GameEvent) {
    if (e.type === 'wolfChat' && typeof e.data?.target === 'number' && this.canSee(e)) this.wolfTarget = e.data.target;
    if (this.restoring) {
      // replaying a save: only keep the bubbles current; restored() rebuilds the rest at once
      if (this.canSee(e)) this.trackBubble(e);
      return;
    }
    if (e.type === 'death') {
      const id = e.data!.id as number;
      // exiles walk home after their last words; everyone else leaves a grave now
      if (e.data!.cause === 'vote') this.pendingExile.add(id);
      else if (e.data!.cause === 'explode') this.blast = this.stage.exploded(id);
      else this.stage.killed(id);
    }
    if (e.type === 'gm' && e.text.startsWith('天亮了')) {
      // the rooster crows first, then the GM's verdict sting
      audio.rooster();
      const peaceful = e.text.includes('平安夜');
      setTimeout(() => (peaceful ? audio.peaceful() : audio.death()), 2600);
    }
    if (!this.canSee(e)) return;
    this.trackBubble(e);
    if (this.matches(e)) this.appendMsg(e);
    if (e.type === 'private' || e.type === 'gm' || e.type === 'death') this.renderRoster();
  }

  private trackBubble(e: GameEvent) {
    if ((e.type === 'speech' || e.type === 'wolfChat') && e.speaker !== undefined) {
      // every speaker keeps their latest words over their head (day: until everyone
      // goes home at nightfall; wolf chat: until the pack is back indoors)
      this.bubbles.set(e.speaker, { text: e.text, seq: ++this.bubbleSeq });
    }
  }

  /**
   * The replay of a save has caught up: put the scene where the game stands
   * (graves, sealed houses, who is indoors, wolves out) without animation or sound.
   */
  restored() {
    this.restoring = false;
    const s = this.game.state;
    const night = s.phase === 'night';
    const dead: number[] = [];
    const exiled: number[] = [];
    const exploded: number[] = [];
    for (const e of this.game.events) {
      if (e.type !== 'death') continue;
      const id = e.data!.id as number;
      // today's exile still stands on the plaza for the vote result / last words
      if (e.data!.cause === 'explode') exploded.push(id);
      else if (e.data!.cause !== 'vote') dead.push(id);
      else if (e.day === s.day && (s.phase === 'vote' || s.phase === 'lastWords')) this.pendingExile.add(id);
      else exiled.push(id);
    }
    const iSeeWolves = this.game.players[this.me].role === 'werewolf' || this.godView;
    this.wolvesShown = night && s.nightStep === 'wolves' && iSeeWolves ? this.game.wolves().filter((w) => w.alive).map((w) => w.id) : [];
    this.lastHowlStep = `${s.day}:${s.nightStep}`;
    // tonight's own actions that leave a mark until dawn: the guard's bell, houses gone dark
    let guarded: number | null = null;
    const darkened: number[] = [];
    if (night) {
      for (const e of this.game.events) {
        if (e.day !== s.day || e.phase !== 'night' || !this.canSee(e) || !e.data) continue;
        if (typeof e.data.guard === 'number') guarded = e.data.guard;
        for (const k of ['poison', 'shot'] as const) if (typeof e.data[k] === 'number') darkened.push(e.data[k] as number);
      }
    }
    this.stage.restore({ dead, exiled, exploded, indoors: night, wolves: this.wolvesShown, night, guarded, darkened });
    this.onState(s);
    this.renderTabs();
  }

  onState(s: GameState) {
    if (this.restoring) {
      this.scopeBubbles(s);
      return;
    }
    const night = s.phase === 'night';
    this.stage.setNight(night);
    audio.setNight(night);
    // never point the camera at a hidden night actor (it would reveal their role)
    this.stage.focus(this.visibleActor());
    this.choreograph(s);
    const phaseName: Record<string, string> = {
      setup: '准备中',
      night: `第 ${s.day} 夜`,
      dawn: `第 ${s.day} 天 · 天亮`,
      discussion: `第 ${s.day} 天 · 发言`,
      vote: `第 ${s.day} 天 · 投票`,
      lastWords: `第 ${s.day} 天 · 遗言`,
      ended: '游戏结束',
    };
    const phaseEl = this.banner.querySelector('.phase')!;
    phaseEl.textContent = phaseName[s.phase];
    phaseEl.className = `phase ${night ? 'night' : ''}`;
    const actorEl = this.banner.querySelector('.actor')!;
    const secret = night && !this.godView;
    const mine = s.actor === this.me;
    // At night the banner only shows the public turn and how long it has lasted —
    // the timer restarts per turn, never per actor (per-actor restarts would leak
    // e.g. whether the witch was asked to save someone). Your own action is shown.
    const actorKey = secret && !mine
      ? (s.nightStep ? `step:${s.day}:${s.nightStep}` : '')
      : s.actor !== null ? `${s.actor}:${s.actorLabel}` : '';
    if (actorKey !== this.actorKey) {
      this.actorKey = actorKey;
      clearInterval(this.actorTimer);
      if (!actorKey) actorEl.textContent = '';
      else {
        this.actorSince = this.elapsedMs;
        const timer = h('span', { class: 'timer' });
        actorEl.replaceChildren(
          secret && !mine ? '夜幕下' : `${seat(s.actor!)} ${this.game.players[s.actor!].name} · ${s.actorLabel}`,
          h('span', { class: 'dots' }),
          mine ? '' : timer,
        );
        this.actorTimer = window.setInterval(() => {
          const sec = Math.floor((this.elapsedMs - this.actorSince) / 1000);
          timer.textContent = sec >= 3 ? ` ${sec}s` : '';
        }, 500);
      }
    }
    if (s.nightStep !== this.lastStep) {
      this.lastStep = s.nightStep;
      if (s.nightStep) {
        this.stepEl.textContent = NIGHT_STEP_NAME[s.nightStep];
        this.stepEl.className = 'show';
        const step = s.nightStep;
        setTimeout(() => {
          if (this.lastStep === step) this.stepEl.className = 'show dim';
        }, 3000);
      } else this.stepEl.className = '';
    }
    const phaseKey = `${s.day}:${s.phase}`;
    if (phaseKey !== this.lastPhase) {
      this.lastPhase = phaseKey;
      if (s.phase === 'night' || s.phase === 'dawn') this.renderTabs();
    }
    this.renderRoster();
    this.renderItems();
    if (s.phase === 'ended') {
      this.setPaused(true);
      clearInterval(this.clockTimer);
      this.renderClock();
      this.showEnd(s);
    }
  }

  // ───────────────────────── scene choreography ─────────────────────────

  private pendingExile = new Set<number>();
  /** Tonight's kill, from the wolves' vote (only reaches wolf / god-view players). */
  private wolfTarget: number | null = null;
  /** A wolf's house going up; the GM waits for it before nightfall. */
  private blast: Promise<void> | null = null;
  private bubbleScope = '';
  private wolvesShown: number[] = [];
  private lastHowlStep: string | null = null;

  /** Map engine state changes onto scene animation (howls, exiles). */
  private choreograph(s: GameState) {
    this.scopeBubbles(s);
    const stepKey = `${s.day}:${s.nightStep}`;
    if (s.nightStep === 'wolves' && this.lastHowlStep !== stepKey) {
      this.lastHowlStep = stepKey;
      audio.howl(0.9, 0.4);
      audio.howl(0.6, 1.6, 1.12);
    }
    if (this.pendingExile.size && s.phase !== 'vote' && s.phase !== 'lastWords') {
      for (const id of this.pendingExile) this.stage.exiled(id);
      this.pendingExile.clear();
    }
  }

  /** night ↔ day: wipe leftover bubbles from the previous part of the round
   * (the wolf-chat bubbles are their own scope, gone once the wolf turn ends). */
  private scopeBubbles(s: GameState) {
    const bubbleScope = `${s.day}:${s.phase === 'night' ? `night:${s.nightStep === 'wolves' ? 'wolves' : ''}` : 'day'}`;
    if (bubbleScope !== this.bubbleScope) {
      this.bubbleScope = bubbleScope;
      this.bubbles.clear();
    }
  }

  /**
   * The GM waits on these before moving on (e.g. the wolf turn ends only once
   * the pack is back indoors). Capped so a hidden tab (paused rAF) never stalls the game.
   */
  cue(c: SceneCue): Promise<void> {
    if (typeof c === 'object') return this.roleCue(c);
    const iSeeWolves = this.game.players[this.me].role === 'werewolf' || this.godView;
    let job: Promise<void> = Promise.resolve();
    switch (c) {
      case 'nightfall':
        job = this.stage.nightFall();
        break;
      case 'dawn':
        job = this.stage.dayBreak();
        break;
      case 'wolvesOut':
        if (iSeeWolves) {
          this.wolvesShown = this.game.wolves().filter((w) => w.alive).map((w) => w.id);
          job = this.stage.wolvesOut(this.wolvesShown);
        }
        break;
      case 'explode':
        job = this.blast ?? job;
        this.blast = null;
        break;
      case 'wolvesIn':
        if (this.wolvesShown.length) {
          const shown = this.wolvesShown;
          const target = this.wolfTarget;
          this.wolvesShown = [];
          this.wolfTarget = null;
          // the kill plays out first (the guard's 金钟罩 turns it away), then the pack goes home
          const attack = target === null ? Promise.resolve() : this.stage.wolfAttack(shown, target, this.game.state.lastGuarded === target);
          job = attack.then(() => this.stage.wolvesIn(shown));
        }
        break;
    }
    // capped so a hidden tab (paused rAF) never stalls the game; the attack takes a while
    return Promise.race([job, new Promise<void>((r) => setTimeout(r, c === 'wolvesIn' ? 40000 : 12000))]);
  }

  /**
   * A night role's action plays out only for the player who took it (or god view);
   * for anyone else it resolves at once, so its length gives nothing away. The
   * hunter's day shot is public.
   */
  private roleCue(c: RoleCue): Promise<void> {
    if (c.kind !== 'dayShot' && c.actor !== this.me && !this.godView) return Promise.resolve();
    const home = this.me;
    let job: Promise<void>;
    switch (c.kind) {
      case 'guard':
        job = this.stage.guardCover(c.target, home);
        break;
      case 'seer':
        job = this.stage.seerReveal(c.target, this.game.players[c.target].role === 'werewolf', home);
        break;
      case 'witchPoison':
        job = this.stage.witchPoison(c.target, home);
        break;
      case 'witchSave':
        job = this.stage.witchSave(c.target, home);
        break;
      case 'nightShot':
        job = this.stage.nightShot(c.target, home);
        break;
      case 'dayShot':
        job = this.stage.dayShot(c.target);
        break;
    }
    return Promise.race([job, new Promise<void>((r) => setTimeout(r, 20000))]);
  }

  // ───────────────────────── roster / role card ─────────────────────────

  private renderItems() {
    const items = this.roleCard.querySelector('.items')!;
    const s = this.game.state;
    const me = this.game.players[this.me];
    const chips: HTMLElement[] = [];
    if (me.role === 'witch') {
      chips.push(h('span', { class: `chip ${s.witch.hasAntidote ? '' : 'used'}` }, '金水'));
      chips.push(h('span', { class: `chip ${s.witch.hasPoison ? '' : 'used'}` }, '银水'));
    }
    if (me.role === 'hunter') chips.push(h('span', { class: `chip ${s.hunterShot ? 'used' : ''}` }, '猎枪 ×1'));
    if (me.role === 'guard' && s.lastGuarded !== null) chips.push(h('span', { class: 'chip' }, `昨夜守护 ${seat(s.lastGuarded)}`));
    if (!me.alive) chips.push(h('span', { class: 'chip used' }, '已出局'));
    items.replaceChildren(...chips);
  }

  /** Night actors stay secret unless it is you (or god view). */
  private visibleActor(): number | null {
    const s = this.game.state;
    if (s.actor === null) return null;
    if (s.phase === 'night' && s.actor !== this.me && !this.godView) return null;
    return s.actor;
  }

  private renderRoster() {
    const actor = this.visibleActor();
    const rows = this.game.players.map((p) => {
      const k = this.knownOf(p.id);
      const num = h('span', { class: `num ${k?.ring ? `ring-${k.ring}` : ''}` }, String(p.id + 1));
      const row = h(
        'div',
        {
          class: `roster-row ${p.alive ? '' : 'dead'} ${actor === p.id ? 'acting' : ''} ${this.playerFilter === p.id ? 'selected' : ''}`,
          role: 'button',
          tabindex: '0',
          title: '点击只看 TA 的发言；选择目标时点击即可选中',
          onclick: () => this.pick(p.id),
        },
        num,
        h('span', { class: 'name' }, p.name, p.id === this.me ? '（你）' : ''),
        h('span', { class: `tag ${k?.cls ?? ''}` }, k?.text ?? (p.alive ? '' : '出局')),
      );
      return row;
    });
    this.roster.replaceChildren(...rows);
  }

  private pick(id: number) {
    if (this.pendingTarget && this.pendingTarget.req.candidates.includes(id)) {
      this.pendingTarget.select(id);
      return;
    }
    this.playerFilter = this.playerFilter === id ? null : id;
    this.renderRoster();
    this.renderChat();
    // on a phone the log is folded away: show what the filter picked
    if (MOBILE.matches && this.playerFilter !== null) this.setSheet('chat');
  }

  // ───────────────────────── chat ─────────────────────────

  private renderTabs() {
    const me = this.game.players[this.me];
    const tabs: [Tab, string][] = [['round', '本轮'], ['all', '全部']];
    if (me.role === 'werewolf' || this.godView) tabs.push(['wolf', '狼队频道']);
    tabs.push(['private', '私密信息']);
    this.chatTabs.replaceChildren(
      ...tabs.map(([t, label]) =>
        h('button', { class: `tab ${t === 'wolf' ? 'wolf' : ''} ${this.tab === t ? 'active' : ''}`, role: 'tab', onclick: () => { this.tab = t; this.renderTabs(); this.renderChat(); } }, label),
      ),
    );
    this.renderChat();
  }

  private matches(e: GameEvent): boolean {
    if (!this.canSee(e)) return false;
    if (this.playerFilter !== null && e.speaker !== this.playerFilter) return false;
    switch (this.tab) {
      case 'round':
        return e.day === this.game.state.day && e.type !== 'system';
      case 'all':
        return e.type !== 'system';
      case 'wolf':
        return e.type === 'wolfChat';
      case 'private':
        return e.visibility.kind === 'private' && e.type !== 'wolfChat';
    }
  }

  private renderChat() {
    this.chatFilter.replaceChildren();
    if (this.playerFilter !== null) {
      this.chatFilter.append(`只看 ${seat(this.playerFilter)} ${this.game.players[this.playerFilter].name} 的发言 `, h('button', { onclick: () => { this.playerFilter = null; this.renderRoster(); this.renderChat(); } }, '清除'));
    }
    this.chatLog.replaceChildren();
    let lastDay = -1;
    for (const e of this.game.events) {
      if (!this.matches(e)) continue;
      if (e.day !== lastDay && this.tab !== 'round') {
        this.chatLog.append(h('div', { class: 'daydiv' }, e.day === 0 ? '— 开局 —' : `— 第 ${e.day} 天 —`));
        lastDay = e.day;
      }
      this.appendMsg(e, false);
    }
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  private appendMsg(e: GameEvent, scroll = true) {
    const P = this.game.players;
    let el: HTMLElement;
    // spoken lines are blocks in the speaker's bubble colour, name included (same as over their head)
    const said = (id: number, cls: string, ...rest: (Node | string | null)[]) =>
      h(
        'div',
        { class: `msg said ${cls}`, style: bubbleStyle(id) },
        h('div', { class: 'who' }, h('span', { class: 'n' }, String(id + 1)), P[id].name, id === this.me ? h('span', { class: 'you' }, '（你）') : null, ...rest),
      );
    switch (e.type) {
      case 'speech': {
        const kind = e.data?.explode ? '自爆' : { discussion: '', summary: '总结', lastWords: '遗言', defense: '正名' }[e.speechKind ?? 'discussion'];
        const fb = e.data?.fallback ? h('span', { class: 'kind fallback', title: '模型调用失败，由规则 AI 代发' }, '规则AI代打') : null;
        el = said(e.speaker!, '', kind ? h('span', { class: 'kind' }, kind) : null, fb);
        el.append(h('div', { class: 'text' }, e.text));
        break;
      }
      case 'wolfChat':
        if (e.speaker !== undefined) {
          el = said(e.speaker, 'wolf', h('span', { class: 'kind' }, '狼队'));
          el.append(h('div', { class: 'text' }, e.text));
        } else el = h('div', { class: 'msg wolf' }, e.text);
        break;
      default:
        el = h('div', { class: `msg ${e.type}` }, e.text);
    }
    this.chatLog.append(el);
    if (scroll) {
      this.chatLog.scrollTop = this.chatLog.scrollHeight;
      if (MOBILE.matches && this.sheet !== 'chat') {
        this.unread++;
        this.renderDock();
      }
    }
  }

  // ───────────────────────── labels ─────────────────────────

  private placeLabels(pos: ScreenPos[]) {
    const actor = this.visibleActor();
    pos.forEach((p, i) => {
      const el = this.labelEls[i];
      el.style.display = p.visible ? '' : 'none';
      if (!p.visible) return;
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
      const pl = this.game.players[i];
      const k = this.knownOf(i);
      const b = this.bubbles.get(i);
      const thinking = actor === i;
      // newest words on top; hovering a bubble brings it to the front (CSS)
      el.style.zIndex = this.raised === i ? '9999' : String(b ? 10 + b.seq : 1);
      const key = `${pl.alive}|${k?.text}|${k?.ring}|${b ? b.text : ''}|${thinking}`;
      if (el.dataset.key === key) return;
      el.dataset.key = key;
      el.className = `label ${pl.alive ? '' : 'dead'} ${i === this.me ? 'me' : ''}`;
      const parts = [
        b ? h('div', { class: 'bubble', style: bubbleStyle(i) }, b.text) : null,
        thinking ? h('div', { class: 'thinking' }, '...') : null,
        k && i !== this.me && !k.ring ? h('div', { class: `role-tag ${k.cls}` }, k.text) : null,
        k?.ring ? h('div', { class: `role-tag ${k.ring}` }, ROLE_NAME[this.game.state.seerChecks[i] ?? pl.role]) : null,
        h('div', { class: 'plate' }, h('span', { class: `n ${k?.ring ? `ring-${k.ring}` : ''}` }, String(i + 1)), pl.name, pl.alive ? '' : ' ✝'),
      ];
      el.replaceChildren(...parts.filter((x): x is HTMLDivElement => x !== null));
    });
  }

  // ───────────────────────── human decisions ─────────────────────────

  private open(...children: (Node | string | null)[]) {
    audio.chime();
    this.action.replaceChildren(...children.filter((c): c is Node | string => c !== null));
    this.action.classList.add('show');
  }

  private close() {
    this.action.classList.remove('show');
    this.action.replaceChildren();
    this.pendingTarget = null;
  }

  private askSpeech(req: SpeechRequest | WolfChatRequest, _view: PlayerView): Promise<SpeechResult> {
    return new Promise((resolve) => {
      const title =
        req.kind === 'wolfChat'
          ? `狼队频道 · 第 ${req.round}/${req.rounds} 轮`
          : { discussion: '轮到你发言', summary: '归纳总结（首位发言人）', lastWords: '你的遗言', defense: '平票正名' }[req.purpose];
      const hint =
        req.kind === 'wolfChat'
          ? req.othersPassed
            ? '队友们都表示没有补充。你还想说什么就写下来，队友会在下一轮回应；否则直接开始投票。'
            : '只有狼队友能看到。和队友商量刀谁、白天怎么配合；没有补充可直接点「过」。'
          : req.purpose === 'summary'
            ? '所有人都已发言。梳理大家的站边与矛盾，给出建议的放逐对象。'
            : '在这里输入你想对全镇说的话。可以提到「N号」。';
      const ta = h('textarea', { placeholder: req.kind === 'wolfChat' ? '例：今晚刀 5 号，他像预言家…' : '例：我是好人，3 号发言前后矛盾…', maxlength: '400' }) as HTMLTextAreaElement;
      const count = h('span', { class: 'count' }, '0 / 400');
      ta.oninput = () => (count.textContent = `${ta.value.length} / 400`);
      const done = (text: string, explode = false) => {
        this.close();
        resolve(explode ? { text, explode } : text);
      };
      // two clicks: the first arms it, so a stray click can't throw the game away
      let armed = false;
      const explodeBtn =
        req.kind === 'speech' && req.canExplode
          ? (h('button', {
              class: 'btn danger',
              title: '公开狼人身份并立即出局（无遗言）；今天剩余发言和投票取消，直接天黑。输入框里的话会作为你的最后发言。',
              onclick: () => {
                if (armed) return done(ta.value.trim() || '过', true);
                armed = true;
                explodeBtn!.textContent = '确认自爆？';
              },
            }, '自爆') as HTMLButtonElement)
          : null;
      ta.onkeydown = (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ta.value.trim()) done(ta.value.trim());
      };
      this.open(
        h('div', { class: 'title' }, title),
        h('div', { class: 'hint' }, hint),
        ta,
        h(
          'div',
          { class: 'row' },
          count,
          ...(req.kind === 'wolfChat' && req.othersPassed
            ? [
                h('button', { class: 'btn', onclick: () => ta.value.trim() && done(ta.value.trim()) }, '补充 (⌘↵)'),
                h('button', { class: 'btn primary', onclick: () => done('pass') }, '没有补充，开始投票'),
              ]
            : [
                explodeBtn,
                h('button', { class: 'btn', onclick: () => done(req.kind === 'wolfChat' ? 'pass' : '过。') }, '过'),
                h('button', { class: 'btn primary', onclick: () => ta.value.trim() && done(ta.value.trim()) }, '发言 (⌘↵)'),
              ]),
        ),
      );
      setTimeout(() => ta.focus(), 50);
    });
  }

  private askTarget(req: TargetRequest, _view: PlayerView): Promise<number | null> {
    return new Promise((resolve) => {
      let selected: number | null = null;
      const buttons = new Map<number, HTMLButtonElement>();
      const confirmBtn = h('button', { class: 'btn primary', disabled: true }, '确认') as HTMLButtonElement;
      const select = (id: number) => {
        selected = id;
        for (const [k, b] of buttons) b.classList.toggle('sel', k === id);
        confirmBtn.disabled = false;
        confirmBtn.textContent = `确认：${seat(id)} ${this.game.players[id].name}`;
      };
      const finish = (v: number | null) => {
        this.close();
        resolve(v);
      };
      confirmBtn.onclick = () => selected !== null && finish(selected);
      const targets = h(
        'div',
        { class: 'targets' },
        ...req.candidates.map((id) => {
          const b = h('button', { class: 'btn', title: this.game.players[id].name, onclick: () => select(id) }, String(id + 1)) as HTMLButtonElement;
          buttons.set(id, b);
          return b;
        }),
      );
      const skipLabel: Partial<Record<TargetRequest['action'], string>> = {
        vote: '弃票', revote: '弃票', guard: '空守', hunterShot: '不开枪', witchSave: '不救', witchPoison: '不用毒',
      };
      this.open(
        h('div', { class: 'title' }, ACTION_TITLE[req.action]),
        h('div', { class: 'hint' }, req.prompt, MOBILE.matches ? ' 也可以在「玩家」列表或场景中点选角色。' : ' 也可以点击左侧列表或场景中的角色来选择。'),
        targets,
        h('div', { class: 'row' }, req.allowSkip ? h('button', { class: 'btn', onclick: () => finish(null) }, skipLabel[req.action] ?? '跳过') : null, confirmBtn),
      );
      this.pendingTarget = { req, select };
    });
  }

  // ───────────────────────── end ─────────────────────────

  private endShown = false;
  private showEnd(s: GameState) {
    if (this.endShown) return;
    this.endShown = true;
    this.close();
    this.stage.setNight(false);
    const meTeam = teamOf(this.game.players[this.me].role);
    const won = s.winner === meTeam;
    setTimeout(() => {
      const back = h(
        'div',
        { class: 'modal-back' },
        h(
          'div',
          { class: 'modal panel' },
          h('div', { class: `winner ${s.winner}` }, s.winner === 'good' ? '好人胜利' : '狼人胜利'),
          h('p', { style: 'text-align:center' }, won ? '你所在的阵营赢得了这座小镇。' : '你所在的阵营输掉了这一局。'),
          h('div', { class: 'reveal' }, ...this.game.players.map((p) => h('div', { class: teamOf(p.role) === 'wolf' ? 'wolf' : '' }, `${seat(p.id)} ${p.name}`, h('br'), `${ROLE_NAME[p.role]}${p.alive ? '' : ' ✝'}`))),
          h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => { back.remove(); if (MOBILE.matches) this.setSheet('chat'); } }, '回看记录'), h('button', { class: 'btn primary', onclick: () => this.onRestart() }, '回到标题画面')),
        ),
      );
      this.root.appendChild(back);
      this.renderRoster();
      this.renderChat();
    }, 1500);
  }
}

export function formatClock(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const hh = Math.floor(sec / 3600);
  const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}
