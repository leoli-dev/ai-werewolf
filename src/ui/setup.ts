import { DEFAULT_PROVIDER, OpenAICompatibleProvider, type ProviderConfig, type ReasoningLevel } from '../ai/provider';
import { ROLE_NAME, type Role } from '../game/types';
import { h } from './dom';

export interface Settings {
  provider: ProviderConfig;
  mode: 'llm' | 'offline';
  playerName: string;
  role: Role | 'random';
  paceMs: number;
  wolfChatRounds: number;
  godView: boolean;
}

const KEY = 'ai-werewolf:settings:v1';

export const DEFAULT_SETTINGS: Settings = {
  provider: DEFAULT_PROVIDER,
  mode: 'llm',
  playerName: '旅人',
  role: 'random',
  paceMs: 900,
  wolfChatRounds: 5,
  godView: false,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      return { ...DEFAULT_SETTINGS, ...s, provider: { ...DEFAULT_PROVIDER, ...s.provider } };
    }
  } catch {
    /* ignore */
  }
  return structuredClone(DEFAULT_SETTINGS);
}

function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** Pre-game configuration screen. Resolves with the chosen settings. */
export function showSetup(root: HTMLElement, onRules: () => void): Promise<Settings> {
  const s = loadSettings();
  return new Promise((resolve) => {
    const input = (value: string, type = 'text') => h('input', { type, value }) as HTMLInputElement;
    const url = input(s.provider.baseUrl);
    const key = input(s.provider.apiKey, 'password');
    key.placeholder = '本地服务可留空';
    const model = input(s.provider.model);
    model.setAttribute('list', 'model-list');
    const modelList = h('datalist', { id: 'model-list' });
    const reasoning = h('select', {}, ...(['none', 'low', 'medium', 'high'] as ReasoningLevel[]).map((r) => h('option', { value: r, selected: r === s.provider.reasoning }, r))) as HTMLSelectElement;
    const proxy = h('input', { type: 'checkbox', checked: s.provider.useProxy }) as HTMLInputElement;
    const mode = h('select', {}, h('option', { value: 'llm', selected: s.mode === 'llm' }, 'LLM 驱动（OpenAI 兼容接口）'), h('option', { value: 'offline', selected: s.mode === 'offline' }, '离线规则 AI（无需模型，调试用）')) as HTMLSelectElement;
    const name = input(s.playerName);
    const role = h('select', {}, h('option', { value: 'random' }, '随机（标准玩法）'), ...(Object.keys(ROLE_NAME) as Role[]).map((r) => h('option', { value: r, selected: s.role === r }, `${ROLE_NAME[r]}（调试）`))) as HTMLSelectElement;
    const pace = h('select', {}, ...[
      [300, '快'], [900, '标准'], [1800, '慢'],
    ].map(([v, l]) => h('option', { value: String(v), selected: s.paceMs === v }, String(l)))) as HTMLSelectElement;
    const wolfRounds = input(String(s.wolfChatRounds), 'number');
    wolfRounds.min = '1';
    wolfRounds.max = '5';
    const god = h('input', { type: 'checkbox', checked: s.godView }) as HTMLInputElement;
    const result = h('div', { class: 'test-result' });

    const read = (): Settings => ({
      provider: {
        ...s.provider,
        baseUrl: url.value.trim(),
        apiKey: key.value.trim(),
        model: model.value.trim(),
        reasoning: reasoning.value as ReasoningLevel,
        useProxy: proxy.checked,
      },
      mode: mode.value as Settings['mode'],
      playerName: name.value.trim() || '旅人',
      role: role.value as Settings['role'],
      paceMs: Number(pace.value),
      wolfChatRounds: Math.max(1, Math.min(5, Number(wolfRounds.value) || 5)),
      godView: god.checked,
    });

    const testBtn = h('button', { class: 'btn', type: 'button' }, '测试连接') as HTMLButtonElement;
    testBtn.onclick = async () => {
      testBtn.disabled = true;
      result.className = 'test-result';
      result.textContent = '连接中…（本地推理首个请求可能较慢）';
      const cfg = read().provider;
      const r = await new OpenAICompatibleProvider(cfg).test();
      if (r.models?.length) {
        modelList.replaceChildren(...r.models.map((m) => h('option', { value: m })));
      }
      result.className = `test-result ${r.ok ? 'ok' : 'err'}`;
      result.textContent = (r.ok ? '✓ ' : '✗ ') + r.message + (r.models?.length ? `（可用模型：${r.models.join('、')}）` : '');
      testBtn.disabled = false;
    };

    const start = h('button', { class: 'btn primary', type: 'submit' }, '开始游戏');
    const rulesBtn = h('button', { class: 'btn', type: 'button', onclick: onRules }, '规则说明');

    const form = h(
      'form',
      { class: 'modal panel' },
      h('h1', {}, '雾镇狼人夜'),
      h('div', { class: 'sub' }, '12 人屠边局 · 你与 11 位 AI 镇民 · 天黑请闭眼'),
      h('h2', {}, 'AI 引擎'),
      h(
        'div',
        { class: 'form' },
        h('label', {}, '驱动方式'), mode,
        h('label', {}, 'Base URL'), url,
        h('label', {}, 'API Key'), key,
        h('label', {}, '模型'), h('div', {}, model, modelList),
        h('label', {}, '推理强度'), reasoning,
        h('label', {}, '跨域代理'), h('label', { class: 'check' }, proxy, '经开发服务器转发（本地服务拒绝浏览器跨域时需要）'),
      ),
      h('div', { class: 'inline', style: 'margin-top:10px;display:flex;gap:8px' }, testBtn),
      result,
      h('h2', {}, '对局'),
      h(
        'div',
        { class: 'form' },
        h('label', {}, '你的名字'), name,
        h('label', {}, '身份'), role,
        h('label', {}, '节奏'), pace,
        h('label', {}, '狼队沟通轮数'), wolfRounds,
        h('label', {}, '上帝视角'), h('label', { class: 'check' }, god, '显示所有身份与夜间信息（调试用，会剧透）'),
      ),
      h('div', { class: 'actions' }, rulesBtn, start),
    ) as HTMLFormElement;
    form.onsubmit = (e) => {
      e.preventDefault();
      const out = read();
      saveSettings(out);
      back.remove();
      resolve(out);
    };
    const back = h('div', { class: 'modal-back' }, form);
    root.appendChild(back);
  });
}
