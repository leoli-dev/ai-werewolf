import type { Game, GameState } from '../game/game';
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
  type TargetRequest,
  type WolfChatRequest,
} from '../game/types';
import { characterCanvas, paletteFor } from '../render/pixel';
import type { ScreenPos, Stage } from '../render/stage';
import { h } from './dom';
import { showRules } from './rules';

const ROLE_DESC: Record<Role, string> = {
  werewolf: '每晚与狼队商量并投票杀人；白天伪装成好人。',
  villager: '没有技能，靠发言与投票找出狼人。',
  seer: '每晚查验一人是好人还是狼人。',
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
  private bubbles = new Map<number, { text: string; until: number }>();
  private tab: Tab = 'round';
  private playerFilter: number | null = null;
  private pendingTarget: { req: TargetRequest; select: (id: number) => void } | null = null;
  private lastPhase = '';
  private actorKey = '';
  private actorSince = 0;
  private actorTimer = 0;
  readonly agent: Agent;

  constructor(
    private root: HTMLElement,
    private labelsRoot: HTMLElement,
    private stage: Stage,
    private game: Game,
    private me: number,
    private godView: boolean,
    private onRestart: () => void,
  ) {
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
    if (k === 'werewolf') return { text: '狼队友', cls: 'wolf' };
    if (ring) return { text: ring === 'wolf' ? '查验：狼人' : '查验：好人', cls: ring, ring };
    return null;
  }

  private ringOf(id: number): 'good' | 'wolf' | undefined {
    const me = this.game.players[this.me];
    if (me.role !== 'seer' && !this.godView) return undefined;
    return this.game.state.seerChecks[id];
  }

  // ───────────────────────── build ─────────────────────────

  private build() {
    const me = this.game.players[this.me];
    const portrait = characterCanvas(paletteFor(this.me));
    portrait.style.width = '64px';
    portrait.style.height = '96px';
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

    this.banner = h('div', { id: 'banner', class: 'panel' }, h('div', { class: 'phase' }, '准备中'), h('div', { class: 'actor' }));

    const topright = h(
      'div',
      { id: 'topright' },
      h('button', { class: 'btn', onclick: () => showRules(this.root) }, '规则说明'),
      h('button', { class: 'btn danger', onclick: () => confirm('放弃本局并返回设置？') && this.onRestart() }, '重新开局'),
    );

    this.chatTabs = h('div', { class: 'tabs', role: 'tablist' });
    this.chatFilter = h('div', { class: 'filter' });
    this.chatLog = h('div', { class: 'log', 'aria-live': 'polite' });
    const chat = h('div', { id: 'chat', class: 'panel' }, this.chatTabs, this.chatFilter, this.chatLog);

    this.action = h('div', { id: 'action', class: 'panel' });

    this.root.append(this.hud, this.banner, topright, chat, this.action);

    for (let i = 0; i < 12; i++) {
      const el = h('div', { class: 'label' });
      this.labelsRoot.appendChild(el);
      this.labelEls.push(el);
    }
    this.renderTabs();
    this.renderRoster();
  }

  destroy() {
    clearInterval(this.actorTimer);
    for (const el of [...this.root.children]) el.remove();
    this.labelsRoot.replaceChildren();
    this.stage.onFrame = undefined;
    this.stage.onPick = undefined;
  }

  // ───────────────────────── game hooks ─────────────────────────

  onEvent(e: GameEvent) {
    if (e.type === 'death') this.stage.setAlive(e.data!.id as number, false);
    if (!this.canSee(e)) return;
    if ((e.type === 'speech' || e.type === 'wolfChat') && e.speaker !== undefined) {
      this.bubbles.set(e.speaker, { text: e.text, until: performance.now() + 9000 });
    }
    if (this.matches(e)) this.appendMsg(e);
    if (e.type === 'private' || e.type === 'gm' || e.type === 'death') this.renderRoster();
  }

  onState(s: GameState) {
    const night = s.phase === 'night';
    this.stage.setNight(night);
    this.stage.focus(s.actor);
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
    if (s.actor !== null) {
      // at night only reveal who acts if it is you (or god view)
      const hidden = night && s.actor !== this.me && !this.godView;
      const actorKey = `${s.actor}:${s.actorLabel}`;
      if (actorKey !== this.actorKey) {
        this.actorKey = actorKey;
        this.actorSince = performance.now();
        const timer = h('span', { class: 'timer' });
        actorEl.replaceChildren(
          hidden ? '夜幕下有人在行动' : `${seat(s.actor)} ${this.game.players[s.actor].name} · ${s.actorLabel}`,
          h('span', { class: 'dots' }),
          s.actor === this.me ? '' : timer,
        );
        clearInterval(this.actorTimer);
        this.actorTimer = window.setInterval(() => {
          const sec = Math.floor((performance.now() - this.actorSince) / 1000);
          timer.textContent = sec >= 3 ? ` ${sec}s` : '';
        }, 500);
      }
      if (hidden) this.stage.focus(null);
    } else {
      this.actorKey = '';
      clearInterval(this.actorTimer);
      actorEl.textContent = '';
    }
    const phaseKey = `${s.day}:${s.phase}`;
    if (phaseKey !== this.lastPhase) {
      this.lastPhase = phaseKey;
      if (s.phase === 'night' || s.phase === 'dawn') this.renderTabs();
    }
    this.renderRoster();
    this.renderItems();
    if (s.phase === 'ended') this.showEnd(s);
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
    const who = (id: number) => h('span', { class: 'who' }, h('span', { class: 'n' }, String(id + 1)), P[id].name);
    switch (e.type) {
      case 'speech': {
        const kind = { discussion: '', summary: '总结', lastWords: '遗言', defense: '正名' }[e.speechKind ?? 'discussion'];
        el = h('div', { class: `msg ${e.speaker === this.me ? 'me' : ''}` }, who(e.speaker!), kind ? h('span', { class: 'kind' }, kind) : null, h('div', {}, e.text));
        break;
      }
      case 'wolfChat':
        el = h('div', { class: 'msg wolf' }, e.speaker !== undefined ? who(e.speaker) : null, e.text);
        break;
      default:
        el = h('div', { class: `msg ${e.type}` }, e.text);
    }
    this.chatLog.append(el);
    if (scroll) this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  // ───────────────────────── labels ─────────────────────────

  private placeLabels(pos: ScreenPos[]) {
    const now = performance.now();
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
      const key = `${pl.alive}|${k?.text}|${k?.ring}|${b && b.until > now ? b.text : ''}|${thinking}`;
      if (el.dataset.key === key) return;
      el.dataset.key = key;
      el.className = `label ${pl.alive ? '' : 'dead'} ${i === this.me ? 'me' : ''}`;
      const parts = [
        b && b.until > now ? h('div', { class: 'bubble' }, b.text) : thinking ? h('div', { class: 'thinking' }, '...') : null,
        k && i !== this.me && !k.ring ? h('div', { class: `role-tag ${k.cls}` }, k.text) : null,
        k?.ring ? h('div', { class: `role-tag ${k.ring}` }, k.ring === 'wolf' ? '狼人' : '好人') : null,
        h('div', { class: 'plate' }, h('span', { class: `n ${k?.ring ? `ring-${k.ring}` : ''}` }, String(i + 1)), pl.name, pl.alive ? '' : ' ✝'),
      ];
      el.replaceChildren(...parts.filter((x): x is HTMLDivElement => x !== null));
    });
  }

  // ───────────────────────── human decisions ─────────────────────────

  private open(...children: (Node | string | null)[]) {
    this.action.replaceChildren(...children.filter((c): c is Node | string => c !== null));
    this.action.classList.add('show');
  }

  private close() {
    this.action.classList.remove('show');
    this.action.replaceChildren();
    this.pendingTarget = null;
  }

  private askSpeech(req: SpeechRequest | WolfChatRequest, _view: PlayerView): Promise<string> {
    return new Promise((resolve) => {
      const title =
        req.kind === 'wolfChat'
          ? `狼队频道 · 第 ${req.round}/${req.rounds} 轮`
          : { discussion: '轮到你发言', summary: '归纳总结（首位发言人）', lastWords: '你的遗言', defense: '平票正名' }[req.purpose];
      const hint =
        req.kind === 'wolfChat'
          ? '只有狼队友能看到。和队友商量刀谁、白天怎么配合；没有补充可直接点「过」。'
          : req.purpose === 'summary'
            ? '所有人都已发言。梳理大家的站边与矛盾，给出建议的放逐对象。'
            : '在这里输入你想对全镇说的话。可以提到「N号」。';
      const ta = h('textarea', { placeholder: req.kind === 'wolfChat' ? '例：今晚刀 5 号，他像预言家…' : '例：我是好人，3 号发言前后矛盾…', maxlength: '400' }) as HTMLTextAreaElement;
      const count = h('span', { class: 'count' }, '0 / 400');
      ta.oninput = () => (count.textContent = `${ta.value.length} / 400`);
      const done = (text: string) => {
        this.close();
        resolve(text);
      };
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
          h('button', { class: 'btn', onclick: () => done(req.kind === 'wolfChat' ? 'pass' : '过。') }, '过'),
          h('button', { class: 'btn primary', onclick: () => ta.value.trim() && done(ta.value.trim()) }, '发言 (⌘↵)'),
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
        h('div', { class: 'hint' }, req.prompt, ' 也可以点击左侧列表或场景中的角色来选择。'),
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
          h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => back.remove() }, '回看记录'), h('button', { class: 'btn primary', onclick: () => this.onRestart() }, '再来一局')),
        ),
      );
      this.root.appendChild(back);
      this.renderRoster();
      this.renderChat();
    }, 1500);
  }
}
