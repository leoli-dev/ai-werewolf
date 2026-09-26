import type { Persona } from '../personas';
import {
  ROLE_NAME,
  EXPLODE_CHOICE,
  YES_NO_ACTIONS,
  seat,
  type GameEvent,
  type SpeechKind,
  type PlayerView,
  type Role,
  type SpeechRequest,
  type TargetRequest,
  type WolfChatRequest,
} from '../game/types';

export const RULES_TEXT = `【规则】12 人局（预女猎守）：4 狼人、4 村民、预言家、女巫、猎人、守卫。
- 胜负：狼人阵营屠边获胜——神职（预言家、女巫、猎人、守卫）全部出局，或村民全部出局，狼人立即获胜。好人阵营必须把所有狼人淘汰（放逐、毒杀、枪杀或自爆均可）才获胜。同一夜双方同时达成条件时算狼人获胜。
- 夜晚顺序：守卫守护 → 狼人商量并投票杀人（可以空刀、可以刀队友）→ 女巫用药 → 预言家查验 → 猎人确认开枪状态。
- 守卫每晚守护一人（可以守自己、可以空守），不能连续两晚守同一人；只挡狼刀，不挡毒。守卫守护和女巫金水作用在同一人身上（同守同救）时，此人仍然死亡。
- 女巫有金水、银水各一瓶，同一晚只能用一瓶。有金水时 GM 会告诉她当晚狼人刀了谁（金水用掉后不再告知）；除第一夜外不能自救；不能毒自己。
- 预言家每晚查验一人，结果只有「好人」或「狼人」（查验为好人叫金水，为狼人叫查杀）。
- 猎人出局时可以开枪带走一人（整局一次），被女巫毒死则不能开枪；夜里不能主动开枪。
- 警长竞选：第一天天亮后、公布昨晚死讯之前进行（昨晚死的人此时还不知道自己死了，照常参加）。想竞选的玩家上警（警上），其余为警下。警上玩家依次发言，然后可以退水（放弃竞选，退水的人不能投警长票）；警下玩家投票选出警长，平票则平票者 PK 发言后再投，再平票则警徽流失。只剩一人时自动当选；无人上警或警下无人投票时没有警长。狼人在警上自爆会让竞选推迟到第二天从退水环节继续，第二次自爆则警徽流失。
- 警长：放逐投票时一票算 1.5 票；每天决定发言顺序（昨晚单死从死者左右两侧选一边开始，平安夜或多人死亡从警长左右两侧选一边开始），自己最后发言并归票（点出建议放逐的号码）。警长出局时可以把警徽移交给一名存活玩家，或撕掉警徽（之后没有警长）；自爆的警长警徽直接流失。
- 警徽流：预言家当上警长后通常会报警徽流，如「今晚验 X 号，明晚验 Y 号」：若夜里死亡，就把警徽交给当晚查验的人（查验是好人则交给他；是狼人则撕警徽或交给已知好人，并用遗言/其他方式说明），让查验信息在死后也能传出来。
- 遗言：白天死亡（放逐、被猎人带走）都有遗言；夜里死亡只有第一夜的死者有遗言，之后夜里死亡没有遗言；自爆没有遗言。
- 放逐投票：可以弃票，得票最多者出局；平票时平票者 PK 发言，台下玩家（不含 PK 玩家）在他们之中再投一次，再平票则当天无人出局。
- 自爆：狼人在白天轮到自己发言时（含警上发言、PK 发言）可以自爆：公开狼人身份并立即出局（无遗言），当天剩余环节全部取消，直接进入黑夜。`;

const ROLE_GUIDE: Record<Role, string> = {
  werewolf:
    '你是狼人。白天必须伪装成好人，绝不能承认自己是狼，也不要暴露狼队友。可以考虑上警悍跳预言家（编造查验和警徽流）、给真预言家泼脏水、抢警徽、把票引向好人。夜里与队友商量刀谁，优先刀神职（尤其是跳出来的预言家、女巫）；屠边只需要神职全灭或村民全灭。',
  villager:
    '你是村民，没有技能。认真分析每个人的发言逻辑、投票行为和前后矛盾之处，找出狼人。可以上警争夺警徽帮好人归票，也可以在警下投票给你认为是真预言家的人。不要轻易暴露谁是神。',
  seer:
    '你是预言家。每晚查验一人，得知他是好人还是狼人。第一天一般要上警起跳：报出昨晚的查验（金水或查杀），并留警徽流（今晚验谁、明晚验谁）；当上警长后如果夜里死亡，把警徽交给按警徽流查验出的好人（查到狼则撕警徽或交给金水），让信息传下去。也要提防狼人悍跳冒充你。',
  witch:
    '你是女巫。有金水时你会知道当晚狼人刀了谁。救人和毒人都要根据发言与局势判断；第一夜可以自救，之后不能；同一晚只能用一瓶药。白天一般不急于暴露身份，但必要时可以公开用药信息（如报出银水/金水对象）来证明自己或指认狼人。',
  hunter:
    '你是猎人。出局时可以开枪带走一人（被毒死不能开枪），夜里不能主动开枪。白天可以视情况表明身份来威慑狼人。开枪要尽量打中狼人，不要误伤神职。',
  guard:
    '你是守卫。每晚守护一人免受狼刀（可以守自己，不能连续两晚守同一人）。注意同守同救：你和女巫同时守/救同一人，他仍会死亡。尽量守护关键好人（如跳出的真预言家、警长），白天隐藏身份以免被刀。',
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
- 提到玩家时用「N号」。玩家名字里的行当（铁匠、药师、猎户、骑士、裁缝……）只是小镇里的称呼，和狼人杀身份毫无关系：药师不是女巫，猎户不是猎人。谁是什么身份，只能看 GM 公布的信息和他们自己的声明。
- 只输出你说出口的台词：不要写动作、神态、旁白（禁止 *…*、（…）这类描写），不要输出思考过程或标签。`;
}

const SPEECH_TAG: Record<SpeechKind, string> = {
  discussion: '发言', summary: '警长归票', lastWords: '遗言', defense: '放逐PK发言', campaign: '警上发言', campaignPk: '警长PK发言',
};

/** 警长竞选 has its own shared record (it may run over two days). */
export const isElection = (e: GameEvent) => e.phase === 'election';

function fmtEvent(e: GameEvent, view: PlayerView): string | null {
  const d = `第${e.day}天`;
  switch (e.type) {
    case 'speech': {
      // speaker on its own header line and the words fenced in 「」: with a one-line
      // "7号卡尔：…6号你承认刀了4号" small models credit the seats inside the text as the speaker
      const tag = SPEECH_TAG[e.speechKind ?? 'discussion'];
      const name = view.players[e.speaker!]?.name;
      return `[${d} ${tag}] 发言人：${seat(e.speaker!)}${name ? `（${name}）` : ''}\n「${e.text}」`;
    }
    case 'gm':
    case 'vote':
      return `[${d} GM] ${e.text}`;
    default:
      return null;
  }
}

/**
 * 共享发言记录本：所有人都能看到的公开内容。`before` / `onlyDay` 按天筛选；
 * 警长竞选的内容默认不在里面（单独一本，`election: true` 只取竞选）。
 */
export function sharedNotebook(view: PlayerView, opts: { before?: number; onlyDay?: number; maxChars?: number; election?: boolean } = {}): string {
  const maxChars = opts.maxChars ?? 20000;
  const lines = view.events
    .filter((e) => e.visibility.kind === 'public')
    .filter((e) => isElection(e) === !!opts.election)
    .filter((e) => (opts.before === undefined || e.day < opts.before) && (opts.onlyDay === undefined || e.day === opts.onlyDay))
    .map((e) => fmtEvent(e, view))
    .filter((x): x is string => !!x);
  let text = lines.join('\n');
  if (text.length > maxChars) text = '…（更早的记录已省略）\n' + text.slice(-maxChars);
  return text || '（暂无）';
}

/** Speeches already made today (the election's on the election stage, the rest otherwise), for the "respond to others" instruction. */
export function todaysSpeakers(view: PlayerView, election = false): number[] {
  const ids = view.events
    .filter((e) => e.type === 'speech' && e.day === view.day && e.speaker !== undefined && e.speaker !== view.self.id && isElection(e) === election)
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
  if (view.hunter) lines.push(`（猎枪：${view.hunter.hasShot ? '已用掉' : '还在'}）`);
  if (view.guard) lines.push(`（上一晚守护：${view.guard.lastGuarded === null ? '无' : seat(view.guard.lastGuarded)}，今晚不能再守同一人）`);
  if (view.self.role === 'seer') {
    const checks = Object.entries(view.known).filter(([id]) => Number(id) !== view.self.id);
    lines.push(`（已知查验：${checks.map(([id, t]) => `${seat(Number(id))}=${t === 'wolf' ? '狼人（查杀）' : '好人（金水）'}`).join('，') || '无'}）`);
  }
  for (const n of notes) lines.push(`[心得] ${n}`);
  return lines.join('\n') || '（暂无）';
}

function aliveList(view: PlayerView) {
  const alive = view.players.filter((p) => p.alive).map((p) => seat(p.id));
  const dead = view.players.filter((p) => !p.alive).map((p) => seat(p.id));
  const sheriff = view.sheriff != null ? `；警长：${seat(view.sheriff)}${view.sheriff === view.self.id ? '（你）' : ''}` : '';
  return `存活：${alive.join('、')}${dead.length ? `；已出局：${dead.join('、')}（已出局的人不再参与投票，不能再当作怀疑或放逐对象）` : ''}${sheriff}`;
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
    summary: '你是警长，所有人都已发言，你最后一个发言：梳理大家的站边与矛盾，明确归票——点出你建议大家放逐的号码（你的票算 1.5 票）。',
    lastWords: '你出局了，这是你的遗言。可以公开身份、留下信息（如查验、用药、警徽流）或指认你认为的狼人。',
    defense: '你在放逐投票中平票了，现在是 PK 发言：为自己辩护，说服台下玩家不要投你。',
    campaign: `你上警竞选警长，现在是警上发言：说明你为什么要当警长、你的身份信息和对局势的判断，争取警下玩家的票。昨晚的死讯还没有公布，不要编造谁死了。${view.self.role === 'seer' ? '你是预言家：一般在这里起跳，报出昨晚的查验结果，并留下警徽流（今晚验几号、明晚验几号）。' : ''}`,
    campaignPk: '你在警长投票中平票，现在是警长 PK 发言：说服警下玩家把警徽投给你。',
  }[req.purpose];
  const onStage = req.purpose === 'campaign' || req.purpose === 'campaignPk';
  const book = onStage ? '【警长竞选记录】' : '【今天的发言】';
  const prior = todaysSpeakers(view, onStage);
  const respond = prior.length
    ? `今天在你之前已有 ${prior.map(seat).join('、')} 发言（见上方${book}${onStage ? '' : '，警上的发言见【警长竞选记录】'}）。你必须具体回应其中至少两人：点名并引用或概括他们说过的内容，说明你同意/反对的理由；同时结合${onStage ? '' : '昨夜的死亡情况、'}身份声明（例如谁跳了预言家、报了什么查验和警徽流）和之前的投票。不要说泛泛的「XX发言奇怪」而不给出依据。
【引用自检】说「N号说了/承认了/跳了……」之前，先确认这句话确实在「发言人：N号」那一段的「」里。发言内容里提到的号码是被谈论或被质问的人，不是说话人：例如 7号说「6号你承认刀了4号？」，承认的是 6号，不是 7号。记不清是谁说的就不要点名引用。`
    : onStage
      ? '你是第一个警上发言的人，不能拿「没发言」怀疑任何人，也不要编造别人说过的话。'
      : '你是今天第一个发言的人，其他人都还没轮到，不能拿「没发言」怀疑任何人。结合昨夜结果、警长竞选和之前几天的记录（如果有）开个头，给出你的初步判断，不要编造别人说过的话。';
  const secret =
    view.self.role === 'werewolf'
      ? '\n【保密】狼队频道的内容（刀了谁、狼队讨论过什么、谁是你的队友）只有狼人知道，白天绝不能说出口，也不能说漏嘴。昨夜的公开结果只有 GM 宣布的死亡名单。'
      : '\n【保密】私人记录本里的信息别人不知道；除非你有意公开身份（如报查验、报用药），不要把它当成大家都知道的事来说。';
  const progress = speechProgress(req, view);
  const explode = req.canExplode
    ? `\n【自爆选项】你是狼人，可以选择自爆：在发言最开头写「${EXPLODE_TAG}」，后面接你的最后一句话。自爆后你立刻出局，今天剩下的环节全部取消，直接天黑（在警上自爆会让警长竞选推迟到明天）。代价很大（白送一狼），只在局势对狼队明显不利时用：例如你被可信的预言家查杀、今天必然被放逐，自爆能打断好人归票、保住队友或让真预言家来不及报查验。局势正常就不要自爆。`
    : '';
  return `现在是第 ${req.day} 天（第 ${req.day} 轮白天）。${aliveList(view)}
${progress ? `${progress}\n` : ''}${what}
${respond}${req.purpose === 'lastWords' ? '' : secret}${explode}
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
    const sheriff = view.sheriff != null && alive.has(view.sheriff) ? view.sheriff : null;
    const summary = sheriff !== null ? `全部发言结束后，由警长 ${seat(sheriff)} 最后发言并归票，然后放逐投票。` : '全部发言结束后直接放逐投票。';
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
    return `【本轮发言进度】${line}\n其他人都已发言完毕，你作为警长最后发言并归票，之后立即投票。`;
  }
  if (req.purpose === 'campaign') {
    const left = order.slice(order.indexOf(me) + 1).length;
    return `【警上发言进度】上警玩家：${order.map(seat).join('、')}。${line}\n${left ? `你之后还有 ${left} 位警上玩家发言。` : '你是最后一位警上发言的人。'}全部说完后警上玩家可以退水，然后由警下玩家投票选警长。`;
  }
  if (req.purpose === 'defense' || req.purpose === 'campaignPk') {
    const left = total - done - 1;
    const next = req.purpose === 'defense' ? '台下玩家在 PK 玩家中再投一次，再平票则今天无人出局' : '警下玩家在 PK 玩家中再投一次，再平票则警徽流失';
    return `【PK 发言进度】PK 玩家：${order.map(seat).join('、')}。${line}\n${left > 0 ? `你说完后还有 ${left} 位 PK 玩家发言，然后${next}。` : `你是最后一位 PK 发言的，说完后${next}。`}`;
  }
  return '';
}

const ACTION_TEXT: Record<TargetRequest['action'], string> = {
  vote: '放逐投票：选择要放逐的玩家。',
  revote: 'PK 再投：只能在 PK 玩家中选择。',
  seer: '夜晚查验：选择一名玩家查验（结果为好人或狼人）。',
  guard: '夜晚守护：选择一名玩家守护，使其免于狼刀（可以守自己）。',
  wolfKill: '狼队投票：选择今晚要杀的玩家。',
  hunterShot: '猎人开枪：选择要带走的玩家，或不开枪。',
  witchSave: '女巫救人：选择是否用金水救下今晚被狼人杀害的玩家。',
  witchPoison: '女巫用毒：选择是否用银水毒杀一名玩家。',
  runForSheriff: '警长竞选：决定是否上警。',
  withdraw: '警长竞选：决定是否退水。',
  sheriffVote: '警长投票：在警上玩家中选出警长。',
  sheriffRevote: '警长 PK 再投：只能在 PK 玩家中选择。',
  badge: '移交警徽：你是警长，现在出局了。选择继承警徽的玩家（按你的警徽流 / 最信任的好人），或撕掉警徽。',
  speakOrder: '警长决定发言顺序：选择从哪一位开始发言。',
};

const NIGHT_ACTIONS: TargetRequest['action'][] = ['seer', 'guard', 'wolfKill', 'witchSave', 'witchPoison'];

export function targetTask(req: TargetRequest, view: PlayerView): string {
  const head = `现在是第 ${req.day} ${NIGHT_ACTIONS.includes(req.action) ? '夜' : '天'}。${aliveList(view)}
${ACTION_TEXT[req.action]}
GM：${req.prompt}`;
  if (YES_NO_ACTIONS.includes(req.action)) {
    const yes = req.action === 'runForSheriff' ? '上警' : '退水';
    const no = req.action === 'runForSheriff' ? '不上警' : '继续竞选';
    const explode = req.canExplode ? `；你是狼人，也可以选择现在自爆（立刻出局，竞选推迟到明天，今天直接天黑），自爆填 ${EXPLODE_CHOICE}` : '';
    return `${head}
${yes}填你的号码 ${view.self.id + 1}，${no}填 0${explode}。
只输出一行 JSON：{"target": 号码, "reason": "20字以内的理由"}`;
  }
  const cands = req.candidates.map((c) => `${c + 1}`).join('、');
  const skip = req.allowSkip ? `；${req.action === 'badge' ? '撕掉警徽' : req.action === 'wolfKill' ? '空刀' : '不选择'}请填 0` : '';
  return `${head}
可选号码：${cands}${skip}。
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
      if (n === EXPLODE_CHOICE && req.canExplode) return { target: EXPLODE_CHOICE, reason };
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
  if (req.allowSkip && /不(开枪|救|毒|选|上警|退水)|放弃|弃票|空守|空刀|撕(掉|毁)?警徽|继续竞选/.test(text)) return { target: null, reason };
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
  // a self-reported length echoing the prompt's word cap: （约190字）
  s = s.replace(/\s*[（(【\[]\s*(?:约|共|全文|字数[:：]?)?\s*\d+\s*字\s*(?:左右)?\s*[）)】\]]$/, '').trim();
  s = s.replace(/^["“「]+|["”」]+$/g, '');
  return s.slice(0, 400);
}
