import type { Persona } from '../personas';
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

export const RULES_TEXT = `【规则】12 人局：4 狼人、4 村民、预言家、女巫、猎人、守卫。
- 狼人阵营：存活狼人数多于存活好人（村民 + 神职）时立即获胜（此时投票已无法翻盘）。好人阵营：所有狼人出局（被放逐、毒杀、枪杀或自爆均可）才获胜，只要还剩一只狼游戏就继续。
- 夜晚顺序：预言家查验 → 守卫守护 → 狼人商量并投票杀人 → 猎人可开枪 → 女巫用药。
- 预言家每晚查验一人，得知其具体身份（如狼人、女巫、村民）；若当晚在查验后被杀，查验信息作废。
- 守卫每晚守护一人，不能守自己，不能连续两晚守同一人；只挡狼刀，不挡毒和枪。
- 女巫有金水（救人）、银水（毒药）各一瓶，同一晚可以都用；只知道谁死了、不知道死因；不能毒自己。
- 猎人整局可以开一枪带走一名玩家（不能射自己），夜里轮到他时或出局时都可以开。
- 夜里死亡的玩家没有遗言。白天由随机玩家开始顺/逆时针发言，首位发言人最后再做一次归纳总结，然后投票，票数最多者被放逐并留遗言。
- 平票时平票者各做一次正名发言，全体在平票者中再投；再次平票由 GM 随机淘汰一人。
- 狼人可以在白天轮到自己发言时自爆：公开狼人身份并立即出局（没有遗言），当天剩余发言和投票全部取消，直接进入黑夜。`;

const ROLE_GUIDE: Record<Role, string> = {
  werewolf:
    '你是狼人。白天必须伪装成好人，绝不能承认自己是狼，也不要暴露狼队友。可以考虑悍跳预言家、给真预言家泼脏水、把票引向好人。夜里与队友商量刀谁，优先刀神职（尤其是跳出来的预言家、女巫）。',
  villager:
    '你是村民，没有技能。认真分析每个人的发言逻辑、投票行为和前后矛盾之处，找出狼人。可以保护可信的神职，不要轻易暴露谁是神。',
  seer:
    '你是预言家。每晚查验一人，能看到对方的具体身份。白天可以选择起跳公开身份并报出查验结果（包括查到的狼），带领好人投票；也要提防狼人悍跳冒充你。',
  witch:
    '你是女巫。你只知道夜里谁死了，不知道死因。救人和毒人都要根据发言与局势判断。白天一般不急于暴露身份，但必要时可以公开用药信息来证明自己或指认狼人。',
  hunter:
    '你是猎人。你有一发子弹，可在夜里或出局时带走一人。白天可以视情况表明身份来威慑狼人。开枪要尽量打中狼人，不要误伤神职。',
  guard:
    '你是守卫。每晚守护一人免受狼刀（不能连续两晚守同一人）。尽量守护关键好人（如跳出的真预言家），白天隐藏身份以免被刀。',
};

export type { Persona } from '../personas';

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

/** Tonight's wolf-chat lines from teammates after this wolf last spoke, passes left out. */
export function teammatesSinceMe(view: PlayerView, day: number) {
  const tonight = view.events.filter((e) => e.type === 'wolfChat' && e.day === day && e.speaker !== undefined);
  let mine = -1;
  tonight.forEach((e, i) => e.speaker === view.self.id && (mine = i));
  return tonight.slice(mine + 1).filter((e) => e.text !== '（没有补充）');
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
    lines.push(`（已知查验：${checks.map(([id, t]) => `${seat(Number(id))}=${ROLE_NAME[t as Role] ?? t}`).join('，') || '无'}）`);
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
    const fresh = teammatesSinceMe(view, req.day);
    const heard = fresh.length
      ? `\n${req.round === 1 ? '在你之前' : '自你上次发言后'}，队友说了：\n${fresh.map((e) => `- ${seat(e.speaker!)}：${e.text}`).join('\n')}`
      : '';
    const answer = '如果有人反对当前刀口或打法、或提出了新方案，你不能 pass：点名回应，正面回答对方的理由（要么被说服并说出改成什么，要么讲清为什么坚持）。';
    const task =
      req.round === 1
        ? fresh.length
          ? `先回应在你之前发言的队友，点名说同意还是反对、为什么。${answer}然后说出你的刀口和明天白天的打法。60 字以内。`
          : '和队友商量今晚刀谁、明天白天怎么打配合（谁悍跳、怎么站边）。60 字以内，直接说内容。'
        : fresh.length
          ? `${answer}如果他们只是附和、没有新分歧，只回复：pass。40 字以内。`
          : '如果刀口和打法已经一致，只回复：pass。';
    return `现在是第 ${req.day} 夜，狼队秘密频道第 ${req.round}/${req.rounds} 轮沟通（只有狼人能看到）。
${aliveList(view)}${heard}
${task}`;
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
    : '你是今天第一个发言的人，其他人都还没轮到，不能拿「没发言」怀疑任何人。结合昨夜结果和之前几天的记录（如果有）开个头，给出你的初步判断，不要编造别人说过的话。';
  const progress = speechProgress(req, view);
  const explode = req.canExplode
    ? `\n【自爆选项】你是狼人，可以选择自爆：在发言最开头写「${EXPLODE_TAG}」，后面接你的最后一句话。自爆后你立刻出局，今天剩下的发言和投票全部取消，直接天黑。代价很大（白送一狼），只在局势对狼队明显不利时用：例如你被可信的预言家查杀、今天必然被放逐，自爆能打断好人归票、保住队友或让真预言家来不及报查验。局势正常就不要自爆。`
    : '';
  return `现在是第 ${req.day} 天（第 ${req.day} 轮白天）。${aliveList(view)}
${progress ? `${progress}\n` : ''}${what}
${respond}${explode}
200 字以内，直接输出发言内容。`;
}

/**
 * 本轮发言进度: the full speaking order with who has spoken, the speaker's own
 * position, and how many are still to come — so the AI can pace its speech
 * (open with a view early, wrap up and push a vote late).
 */
export function speechProgress(req: SpeechRequest, view: PlayerView): string {
  const order = req.order;
  if (!order?.length) return '';
  const me = view.self.id;
  const spoken = new Set(req.spoken ?? []);
  const alive = new Set(view.players.filter((p) => p.alive).map((p) => p.id));
  const tag = (id: number) => {
    if (id === me) return `${seat(id)}（你）`;
    if (spoken.has(id)) return `${seat(id)}（已发言）`;
    if (!alive.has(id)) return `${seat(id)}（已出局）`;
    return `${seat(id)}（未发言）`;
  };
  const line = order.map(tag).join(' → ');
  const total = order.filter((id) => alive.has(id) || spoken.has(id)).length;
  const done = order.filter((id) => spoken.has(id)).length;

  if (req.purpose === 'discussion') {
    // Split instead of one arrow chain tagged 「未发言」: models read that as
    // "stayed silent" and blamed seats whose turn had not come yet.
    const before = order.filter((id) => spoken.has(id));
    const after = order.slice(order.indexOf(me) + 1).filter((id) => alive.has(id) && !spoken.has(id));
    const pos = done + 1;
    const left = after.length;
    const n = view.players.length;
    const dir =
      req.clockwise === undefined ? '' : req.clockwise ? `顺时针（号码从小到大，${n}号之后接1号）` : `逆时针（号码从大到小，1号之后接${n}号）`;
    const opener = req.first !== undefined ? `由 ${seat(req.first)} 开始${dir}发言。` : '';
    const tip =
      left === 0
        ? '你是本轮最后一个发言的人：回应前面所有人的关键观点，给出明确的放逐建议。'
        : pos <= 2
          ? '你发言较早：先亮出你的判断和怀疑对象，同时说明你想听后面哪些人怎么接。'
          : '';
    const summary = req.first !== undefined && req.first !== me ? `全部发言结束后，由 ${seat(req.first)} 做归纳总结，然后投票。` : '全部发言结束后，由你（首位发言人）做归纳总结，然后投票。';
    const waiting = left
      ? `还没轮到（按发言顺序）：${after.map(seat).join(' → ')}，共 ${left} 人。他们只是还没轮到，不是沉默：不要说他们「没声音」「一直不说话」「在躲」，也不要评价他们的发言。`
      : '在你之后没有人了。';
    return `【本轮发言进度】${opener}
已发言（按顺序）：${before.length ? before.map(seat).join(' → ') : '无，你是第一个'}
轮到你：${seat(me)}，第 ${pos} 位（共 ${total} 人）
${waiting}
${summary}${tip ? `\n${tip}` : ''}`;
  }
  if (req.purpose === 'summary') {
    return `【本轮发言进度】${line}\n本轮 ${total} 人已全部发言完毕，你作为首位发言人做归纳总结，之后立即投票。`;
  }
  if (req.purpose === 'defense') {
    const left = total - done - 1;
    return `【平票正名进度】平票玩家：${order.map(seat).join('、')}。${line}\n${left > 0 ? `你说完后还有 ${left} 位平票玩家正名，然后全体在平票玩家中再投一次。` : '你是最后一位正名的，说完后全体在平票玩家中再投一次。'}`;
  }
  return '';
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

export const EXPLODE_TAG = '【自爆】';

/** Split a leading 【自爆】 marker off a day speech. */
export function parseExplode(text: string): { text: string; explode: boolean } {
  const m = text.match(/^\s*[【\[]\s*自爆\s*[】\]]\s*/);
  return m ? { text: text.slice(m[0].length), explode: true } : { text, explode: false };
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
