import './ui/styles.css';
import { LLMAgent } from './ai/llmAgent';
import { MockAgent } from './ai/mockAgent';
import { PERSONAS } from './ai/prompts';
import { OpenAICompatibleProvider, SerialQueue } from './ai/provider';
import { Game, GameAborted } from './game/game';
import { Rng } from './game/rng';
import type { Agent } from './game/types';
import { Stage } from './render/stage';
import { audio } from './audio/audio';
import { h } from './ui/dom';
import { GameUI } from './ui/hud';
import { showRules } from './ui/rules';
import { showSetup, type Settings } from './ui/setup';

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
};

function toast(text: string) {
  const el = h('div', { class: 'toast panel' }, text);
  app.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function play(settings: Settings) {
  const rng = new Rng();
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
    },
    {
      onEvent: (e) => ui?.onEvent(e),
      onState: (s) => ui?.onState(s),
      cue: (c) => ui?.cue(c) ?? Promise.resolve(),
    },
  );

  let restart!: () => void;
  const restarted = new Promise<void>((r) => (restart = r));
  stage.resetAll();
  ui = new GameUI(app, labels, stage, game, humanSeat, settings.godView, () => {
    game.abort();
    restart();
  });

  const provider = new OpenAICompatibleProvider(settings.provider);
  const queue = new SerialQueue();
  ui.setEngineMode(settings.mode);
  const agents: Agent[] = names.map((_, i) => {
    if (i === humanSeat) return ui!.agent;
    if (settings.mode === 'offline') return new MockAgent(rng.int(1e9), 600);
    return new LLMAgent(i, personas[i], provider, queue, {
      onCall: (c) => ui?.recordCall(c.ok, c.ms),
      onFailure: (info) => ui!.askFailure(info),
    });
  });
  game.setAgents(agents);

  const done = game.run().catch((e) => {
    if (!(e instanceof GameAborted)) {
      console.error(e);
      toast(`游戏出错：${(e as Error).message}`);
    }
  });
  await Promise.race([restarted, done.then(() => restarted)]);
  game.abort();
  ui.destroy();
}

async function main() {
  while (true) {
    const settings = await showSetup(app, () => showRules(app));
    audio.start(); // "开始游戏" click is the user gesture that unlocks audio
    await play(settings);
  }
}

main();
