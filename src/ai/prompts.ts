import {
  ROLE_NAME,
  seat,
  type GameEvent,
  type PlayerView,
  type Role,
  type SpeechRequest,
  type TargetRequest,
  type WolfChatRequest,
} from '../game/types';

export const RULES_TEXT = `【规则】12 人屠边局：4 狼人、4 村民、预言家、女巫、猎人、守卫。
- 狼人阵营：杀光所有神职或杀光所有村民（屠边）即获胜。好人阵营：投票放逐所有狼人即获胜。
- 夜晚顺序：预言家查验 → 守卫守护 → 狼人商量并投票杀人 → 猎人可开枪 → 女巫用药。
- 预言家每晚查验一人是好人还是狼人；若当晚在查验后被杀，查验信息作废。
- 守卫每晚守护一人，不能守自己，不能连续两晚守同一人；只挡狼刀，不挡毒和枪。
- 女巫有金水（救人）、银水（毒药）各一瓶，同一晚可以都用；只知道谁死了、不知道死因；不能毒自己。
- 猎人整局可以开一枪带走一名玩家（不能射自己），夜里轮到他时或出局时都可以开。
- 夜里死亡的玩家没有遗言。白天由随机玩家开始顺/逆时针发言，首位发言人最后再做一次归纳总结，然后投票，票数最多者被放逐并留遗言。
- 平票时平票者各做一次正名发言，全体在平票者中再投；再次平票由 GM 随机淘汰一人。`;

const ROLE_GUIDE: Record<Role, string> = {
  werewolf:
    '你是狼人。白天必须伪装成好人，绝不能承认自己是狼，也不要暴露狼队友。可以考虑悍跳预言家、给真预言家泼脏水、把票引向好人。夜里与队友商量刀谁，优先刀神职（尤其是跳出来的预言家、女巫）。',
  villager:
    '你是村民，没有技能。认真分析每个人的发言逻辑、投票行为和前后矛盾之处，找出狼人。可以保护可信的神职，不要轻易暴露谁是神。',
  seer:
    '你是预言家。每晚查验一人。白天可以选择起跳公开身份并报出查验结果（包括查到的狼），带领好人投票；也要提防狼人悍跳冒充你。',
  witch:
    '你是女巫。你只知道夜里谁死了，不知道死因。救人和毒人都要根据发言与局势判断。白天一般不急于暴露身份，但必要时可以公开用药信息来证明自己或指认狼人。',
  hunter:
    '你是猎人。你有一发子弹，可在夜里或出局时带走一人。白天可以视情况表明身份来威慑狼人。开枪要尽量打中狼人，不要误伤神职。',
  guard:
    '你是守卫。每晚守护一人免受狼刀（不能连续两晚守同一人）。尽量守护关键好人（如跳出的真预言家），白天隐藏身份以免被刀。',
};

export interface Persona {
  name: string;
  trait: string;
}

export const PERSONAS: Persona[] = [
  { name: '铁匠艾德', trait: '说话直来直去，脾气急' },
  { name: '修女玛莎', trait: '温和谨慎，爱讲道理' },
  { name: '酒馆老板布兰', trait: '圆滑健谈，喜欢开玩笑' },
  { name: '猎户罗根', trait: '沉默寡言，一句话切中要害' },
  { name: '学徒莉娜', trait: '年轻紧张，有时会自我怀疑' },
  { name: '老农托马斯', trait: '慢条斯理，爱用农谚打比方' },
  { name: '吟游诗人菲恩', trait: '语言华丽，喜欢夸张' },
  { name: '药师伊索', trait: '冷静理性，注重逻辑链' },
  { name: '守墓人格里姆', trait: '阴沉多疑，怀疑一切' },
  { name: '裁缝薇拉', trait: '观察细致，关注别人措辞' },
  { name: '磨坊主汉斯', trait: '热心肠，容易被说服' },
  { name: '流浪骑士卡尔', trait: '自信强势，喜欢带节奏' },
];

export function systemPrompt(view: PlayerView, persona: Persona): string {
  const self = view.self;
  let teammates = '';
  if (self.role === 'werewolf') {
    const mates = Object.entries(view.known)
      .filter(([id, r]) => r === 'werewolf' && Number(id) !== self.id)
      .map(([id]) => seat(Number(id)));
    teammates = `\n你的狼队友：${mates.join('、')}。`;
  }
  return `你正在一个中世纪破败小镇里玩狼人杀。你是 ${seat(self.id)}「${persona.name}」，性格：${persona.trait}。
你的真实身份：${ROLE_NAME[self.role]}。${teammates}
${RULES_TEXT}

【身份策略】${ROLE_GUIDE[self.role]}

【表达要求】
- 用简体中文口语，性格只影响语气，内容必须是基于场上信息的推理。
- 提到玩家时用「N号」。
- 只输出你说出口的台词：不要写动作、神态、旁白（禁止 *…*、（…）这类描写），不要输出思考过程或标签。`;
}

function fmtEvent(e: GameEvent, view: PlayerView): string | null {
  const name = (id: number) => `${seat(id)}${view.players[id]?.name ?? ''}`;
  const d = `第${e.day}天`;
  switch (e.type) {
    case 'speech': {
      const tag = { discussion: '发言', summary: '归纳总结', lastWords: '遗言', defense: '平票正名' }[e.speechKind ?? 'discussion'];
      return `[${d} ${tag}] ${name(e.speaker!)}：${e.text}`;
    }
    case 'gm':
    case 'vote':
      return `[${d} GM] ${e.text}`;
    default:
      return null;
  }
}

/** 共享发言记录本：所有人都能看到的公开内容。`day` 给定时只取该天之前 / 当天。 */
export function sharedNotebook(view: PlayerView, opts: { before?: number; onlyDay?: number; maxChars?: number } = {}): string {
  const maxChars = opts.maxChars ?? 20000;
  const lines = view.events
    .filter((e) => e.visibility.kind === 'public')
    .filter((e) => (opts.before === undefined || e.day < opts.before) && (opts.onlyDay === undefined || e.day === opts.onlyDay))
    .map((e) => fmtEvent(e, view))
    .filter((x): x is string => !!x);
  let text = lines.join('\n');
  if (text.length > maxChars) text = '…（更早的记录已省略）\n' + text.slice(-maxChars);
  return text || '（暂无）';
}

/** Speeches already made today, for the "respond to others" instruction. */
export function todaysSpeakers(view: PlayerView): number[] {
  const ids = view.events
    .filter((e) => e.type === 'speech' && e.day === view.day && e.speaker !== undefined && e.speaker !== view.self.id)
    .map((e) => e.speaker!);
  return [...new Set(ids)];
}

/** 角色私本：只属于自己的信息 + 自己记下的心得。 */
export function privateNotebook(view: PlayerView, notes: string[]): string {
  const lines: string[] = [];
  for (const e of view.events) {
    if (e.visibility.kind !== 'private') continue;
    if (e.type === 'wolfChat') {
      lines.push(e.speaker !== undefined ? `[第${e.day}夜 狼队] ${seat(e.speaker)}：${e.text}` : `[第${e.day}夜 狼队] ${e.text}`);
    } else if (e.type === 'private') {
      lines.push(`[第${e.day}夜] ${e.text}`);
    }
  }
  if (view.witch) lines.push(`（药品状态：金水${view.witch.hasAntidote ? '未用' : '已用'}，银水${view.witch.hasPoison ? '未用' : '已用'}）`);
  if (view.hunter) lines.push(`（猎枪：${view.hunter.hasShot ? '已开过' : '未开'}）`);
  if (view.guard) lines.push(`（上一晚守护：${view.guard.lastGuarded === null ? '无' : seat(view.guard.lastGuarded)}，今晚不能再守同一人）`);
  if (view.self.role === 'seer') {
    const checks = Object.entries(view.known).filter(([id]) => Number(id) !== view.self.id);
    lines.push(`（已知查验：${checks.map(([id, t]) => `${seat(Number(id))}=${t === 'wolf' ? '狼' : '好人'}`).join('，') || '无'}）`);
  }
  for (const n of notes) lines.push(`[心得] ${n}`);
  return lines.join('\n') || '（暂无）';
}

function aliveList(view: PlayerView) {
  const alive = view.players.filter((p) => p.alive).map((p) => seat(p.id));
  const dead = view.players.filter((p) => !p.alive).map((p) => seat(p.id));
  return `存活：${alive.join('、')}${dead.length ? `；已出局：${dead.join('、')}` : ''}`;
}

export function speechTask(req: SpeechRequest | WolfChatRequest, view: PlayerView): string {
  if (req.kind === 'wolfChat') {
    return `现在是第 ${req.day} 夜，狼队秘密频道第 ${req.round}/${req.rounds} 轮沟通（只有狼人能看到）。
${aliveList(view)}
和队友商量今晚刀谁、明天白天怎么打配合（谁悍跳、怎么站边）。60 字以内，直接说内容。如果已经商量好、没有补充，只回复：pass`;
  }
  const what = {
    discussion: '现在轮到你白天发言。分析局势，给出你的怀疑对象和理由，也可以根据策略表明（或伪装）身份。',
    summary: '所有人都已发言，你是本轮首位发言人，现在做归纳总结：梳理大家的站边与矛盾，给出你建议的放逐对象，影响大家投票。',
    lastWords: '你被投票放逐了，这是你的遗言。可以公开身份、留下信息或指认你认为的狼人。',
    defense: '你在投票中平票了，现在为自己正名，说服大家不要投你。',
  }[req.purpose];
  const prior = todaysSpeakers(view);
  const respond = prior.length
    ? `今天在你之前已有 ${prior.map(seat).join('、')} 发言（见上方【今天的发言】）。你必须具体回应其中至少两人：点名并引用或概括他们说过的内容，说明你同意/反对的理由；同时结合昨夜的死亡情况、身份声明（例如谁跳了预言家、报了什么查验）和之前的投票。不要说泛泛的「XX发言奇怪」而不给出依据。`
    : '你是今天第一个发言的人，还没有人说话。结合昨夜结果和之前几天的记录（如果有）开个头，给出你的初步判断，不要编造别人说过的话。';
  return `现在是第 ${req.day} 天。${aliveList(view)}
${what}
${respond}
200 字以内，直接输出发言内容。`;
}

const ACTION_TEXT: Record<TargetRequest['action'], string> = {
  vote: '白天投票：选择要放逐的玩家。',
  revote: '平票再投：只能在平票玩家中选择。',
  seer: '夜晚查验：选择一名玩家查验身份。',
  guard: '夜晚守护：选择一名玩家守护，使其免于狼刀。',
  wolfKill: '狼队投票：选择今晚要杀的玩家。',
  hunterShot: '猎人开枪：选择要带走的玩家，或不开枪。',
  witchSave: '女巫救人：选择是否用金水救下一名今晚死亡的玩家。',
  witchPoison: '女巫用毒：选择是否用银水毒杀一名存活玩家。',
};

export function targetTask(req: TargetRequest, view: PlayerView): string {
  const cands = req.candidates.map((c) => `${c + 1}`).join('、');
  return `现在是第 ${req.day} ${['vote', 'revote'].includes(req.action) ? '天' : '夜'}。${aliveList(view)}
${ACTION_TEXT[req.action]}
GM：${req.prompt}
可选号码：${cands}${req.allowSkip ? '；不选择请填 0' : ''}。
只输出一行 JSON：{"target": 号码, "reason": "20字以内的理由"}`;
}

/** Extract a seat choice from the model output; returns id (0-based), null for skip, or undefined if unparseable. */
export function parseTarget(text: string, req: TargetRequest): { target: number | null | undefined; reason: string } {
  const valid = new Set(req.candidates.map((c) => c + 1));
  let reason = '';
  const m = text.match(/\{[\s\S]*?\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      reason = String(obj.reason ?? '');
      const n = Number(obj.target);
      if (n === 0 && req.allowSkip) return { target: null, reason };
      if (valid.has(n)) return { target: n - 1, reason };
    } catch {
      /* fall through */
    }
  }
  const t = text.match(/"?target"?\s*[:：]\s*"?(\d{1,2})/);
  if (t) {
    const n = Number(t[1]);
    if (n === 0 && req.allowSkip) return { target: null, reason };
    if (valid.has(n)) return { target: n - 1, reason };
  }
  if (req.allowSkip && /不(开枪|救|毒|选)|放弃|弃票|空守/.test(text)) return { target: null, reason };
  for (const n of text.match(/\d{1,2}/g) ?? []) {
    if (valid.has(Number(n))) return { target: Number(n) - 1, reason };
  }
  return { target: undefined, reason };
}

/** Trim quotes / "3号艾德：" prefixes a model sometimes adds to speeches. */
export function cleanSpeech(text: string, view: PlayerView, personaName: string): string {
  let s = text.trim();
  const head = s.slice(0, 20);
  const colon = head.search(/[：:]/);
  if (colon > 0 && (head.slice(0, colon).includes(seat(view.self.id)) || head.slice(0, colon).includes(personaName))) {
    s = s.slice(colon + 1).trim();
  }
  // stage directions the model sometimes adds: *打了个嗝*, （眯着眼）
  s = s.replace(/\*[^*\n]{0,80}\*/g, '').replace(/^[（(][^）)\n]{0,40}[）)]\s*/, '').trim();
  s = s.replace(/^["“「]+|["”」]+$/g, '');
  return s.slice(0, 400);
}
