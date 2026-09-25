import './ui/styles.css';
import { LLMAgent } from './ai/llmAgent';
import { MockAgent } from './ai/mockAgent';
import { PERSONAS, TRAVELLER_LOOK } from './personas';
import { OpenAICompatibleProvider, SerialQueue } from './ai/provider';
import { Game, GameAborted, ReplayMismatch } from './game/game';
import { Rng } from './game/rng';
import type { Agent } from './game/types';
import { Stage } from './render/stage';
import { audio } from './audio/audio';
import { clearSave, readSave, writeSave, type SaveGame } from './save';
import { h } from './ui/dom';
import { GameUI, formatClock } from './ui/hud';
import { showPause } from './ui/pause';
import { showRules } from './ui/rules';
import { PROVIDERS } from './ai/catalog';
import { vault } from './keyVault';
import { getConfig, onConfigChange, resolveProvider, type Settings } from './settings';
import { promptSetKey, promptUnlock } from './ui/keyDialogs';
import { showConfig } from './ui/config';
import { showSetup } from './ui/setup';
import { PHASE_NAME, showTitle } from './ui/title';

const app = document.getElementById('app')!;
const labels = document.getElementById('labels')!;
const stage = new Stage(document.getElementById('stage')!);
if (import.meta.env.DEV) (window as unknown as { __stage: Stage }).__stage = stage; // debugging hook
stage.sounds = {
  doorOpen: (v) => audio.doorOpen(v),
  doorClose: (v) => audio.doorClose(v),
  doorBreak: (v) => audio.doorBreak(v),
  seal: (v) => audio.seal(v),
  squeak: (v) => audio.squeak(v),
  flap: (v) => audio.batFlap(v),
  caw: (v) => audio.caw(v),
  thunder: (d) => audio.thunder(d),
  explosion: (v, big) => audio.explosion(v, big),
  doorBang: (v) => audio.doorBang(v),
  growl: (v) => audio.growl(v),
  scream: (v) => audio.scream(v),
  bell: (v) => audio.bell(v),
  guardCast: (v) => audio.guardCast(v),
  sparkle: (v) => audio.sparkle(v),
  reveal: (wolf) => audio.reveal(wolf),
  poison: (v) => audio.poison(v),
  groan: (v) => audio.groan(v),
  hymn: () => audio.hymn(),
  lock: () => audio.lock(),
  gunshot: () => audio.gunshot(),
  hit: (v) => audio.hit(v),
  howl: (v, pitch) => audio.howl(v, 0, pitch),
};

// sound settings apply everywhere (title screen included)
const applyAudio = () => {
  const a = getConfig().audio;
  audio.setMuted(a.muted);
  audio.setLevels(a);
};
applyAudio();
onConfigChange(applyAudio);

function toast(text: string) {
  // on <body>, so it outlives the game UI (e.g. a save that fails to load)
  const el = h('div', { class: 'toast panel' }, text);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

/** Play one game (new, or resumed from `save`) until the player goes back to the title. */
async function play(settings: Settings, save?: SaveGame) {
  const { playerName, role, wolfChatRounds, godView, mode } = settings;
  const prefs = { playerName, role, wolfChatRounds, godView, mode };
  const setupSeed = save?.setupSeed ?? (Math.random() * 2 ** 32) >>> 0;
  const rng = new Rng(setupSeed);
  const humanSeat = rng.int(12);
  const personas = rng.shuffle(PERSONAS);
  const names = personas.map((p, i) => (i === humanSeat ? settings.playerName : p.name));

  let ui: GameUI | null = null;
  const game = new Game(
    {
      names,
      humanSeat,
      humanRole: settings.role === 'random' ? undefined : settings.role,
      paceMs: settings.paceMs,
      wolfChatRounds: settings.wolfChatRounds,
      seed: save?.gameSeed,
      replay: save?.journal,
    },
    {
      onEvent: (e) => ui?.onEvent(e),
      onState: (s) => ui?.onState(s),
      cue: (c) => ui?.cue(c) ?? Promise.resolve(),
      restored: () => ui?.restored(),
    },
  );

  if (import.meta.env.DEV) (window as unknown as { __game: Game }).__game = game; // debugging hook
  let leave!: () => void;
  const left = new Promise<void>((r) => (leave = r));
  stage.resetAll();
  // everyone looks like their trade; the human is the hooded traveller
  const looks = personas.map((p, i) => (i === humanSeat ? TRAVELLER_LOOK : p.look));
  stage.setLooks(looks);
  ui = new GameUI(app, labels, stage, game, humanSeat, settings.godView, leave, looks, {
    restoring: !!save,
    elapsedMs: save?.elapsedMs ?? 0,
    onPause: () => void pause(),
  });

  const provider = new OpenAICompatibleProvider(settings.provider, (id) => vault.getKey(id));
  const queue = new SerialQueue();
  ui.setEngineMode(settings.mode);
  const agents: (Agent & Partial<Snapshotting>)[] = names.map((_, i) => {
    if (i === humanSeat) return ui!.agent;
    if (settings.mode === 'offline') return new MockAgent(rng.int(1e9), 600);
    return new LLMAgent(i, personas[i], provider, queue, {
      onCall: (c) => ui?.recordCall(c.ok, c.ms),
      onFailure: (info) => ui!.askFailure(info),
    });
  });
  save?.agents.forEach((snap, i) => snap && agents[i].restore?.(snap as never));
  game.setAgents(agents);
  // 配置 changes made from the pause menu reach the running game
  const unsubConfig = onConfigChange((c) => {
    game.setPace(c.paceMs);
    provider.config = resolveProvider(c);
  });

  // ── save / pause ──
  let savedLen = save ? save.journal.length : -1;
  const snapshot = (): SaveGame => {
    const s = game.state;
    return {
      v: 1,
      savedAt: Date.now(),
      prefs,
      setupSeed,
      gameSeed: game.seed,
      journal: game.journal.slice(),
      agents: agents.map((a) => a.snapshot?.() ?? null),
      elapsedMs: ui!.elapsedMs,
      meta: { seat: humanSeat, role: game.players[humanSeat].role, day: s.day, phase: s.phase, alive: game.alive().length },
    };
  };
  let pausing = false;
  const pause = async () => {
    if (pausing || game.state.phase === 'ended') return;
    pausing = true;
    game.pause();
    stage.paused = true;
    audio.pause();
    ui!.setPaused(true);
    const s = game.state;
    const choice = await showPause(app, {
      status: `${PHASE_NAME[s.phase](s.day)} · 用时 ${formatClock(ui!.elapsedMs)}`,
      cannotSave: null,
      save: () => {
        const snap = snapshot();
        const err = writeSave(snap);
        if (!err) savedLen = snap.journal.length;
        return err;
      },
      dirty: () => game.journal.length !== savedLen,
      config: () => showConfig(app, { inGame: settings.mode }),
    });
    pausing = false;
    if (choice === 'title') {
      leave();
      return;
    }
    audio.resume();
    stage.paused = false;
    ui!.setPaused(false);
    game.resume();
  };
  // losing focus (switching window/tab) pauses the game
  const onBlur = () => void pause();
  const onVisibility = () => document.hidden && void pause();
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !document.querySelector('.modal-back')) void pause();
  };
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('keydown', onKey);

  const done = game.run().catch((e) => {
    if (e instanceof GameAborted) return;
    console.error(e);
    if (e instanceof ReplayMismatch) {
      toast(`存档无法载入：${e.message}（可能是旧版本的存档）`);
      leave();
    } else toast(`游戏出错：${(e as Error).message}`);
  });
  await Promise.race([left, done.then(() => left)]);
  unsubConfig();
  window.removeEventListener('blur', onBlur);
  document.removeEventListener('visibilitychange', onVisibility);
  document.removeEventListener('keydown', onKey);
  game.abort();
  stage.paused = false;
  audio.resume();
  ui.destroy();
  audio.setEnding(null);
  stage.resetAll();
}

interface Snapshotting {
  snapshot(): NonNullable<SaveGame['agents'][number]>;
  restore(s: never): void;
}

/** An official API needs its key available (set, and the vault unlocked) before the game starts. */
async function keyReady(s: Settings): Promise<boolean> {
  if (s.mode !== 'llm' || !PROVIDERS[s.provider.provider].needsKey) return true;
  const id = s.provider.provider;
  if (!vault.hints()[id] && !(await promptSetKey(app, id))) return false;
  return promptUnlock(app, `开始对局需要使用已保存的 ${PROVIDERS[id].label} API Key。`);
}

async function main() {
  while (true) {
    const choice = await showTitle(app, readSave(), {
      onRules: () => showRules(app),
      onConfig: () => {
        audio.start(); // so the volume sliders can be heard
        void showConfig(app, { inGame: null });
      },
      onDelete: clearSave,
    });
    audio.start(); // the title click is the user gesture that unlocks audio
    if (choice === 'load') {
      const save = readSave();
      if (!save) continue;
      // the game's own choices from the save; pace and connection from 配置
      const { playerName, role, wolfChatRounds, godView, mode } = save.prefs;
      const settings: Settings = { playerName, role, wolfChatRounds, godView, mode, paceMs: getConfig().paceMs, provider: resolveProvider() };
      if (await keyReady(settings)) await play(settings, save);
      continue;
    }
    const settings = await showSetup(app, () => showRules(app));
    if (settings && (await keyReady(settings))) await play(settings);
  }
}

main();
