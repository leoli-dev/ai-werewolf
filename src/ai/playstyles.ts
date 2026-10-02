import { isWolf, type Role } from '../game/types';

/**
 * 打法风格: how an AI plays its role (悍跳狼, 倒钩狼, 装神民, 隐忍猎人…), dealt at
 * random each game on top of its persona (which only sets the tone of voice).
 * Every style comes with prompt guidance for the LLM and a few knobs for the
 * offline rule AI.
 */
export interface Playstyle {
  id: string;
  /** Shown in the post-game reveal, e.g. 倒钩狼. */
  name: string;
  roles: Role[];
  /** Relative odds of being dealt. */
  weight: number;
  /** At most this many players get the style in one game (e.g. one 悍跳狼 per pack). */
  max?: number;
  /** Prompt guidance: what this player tends to do. */
  guide: string;
  mock: MockStyle;
}

/** What the offline rule AI does differently under a style. */
export interface MockStyle {
  /** Odds of running for sheriff (default 0.3; a seer who is not hiding always runs). */
  run?: number;
  /** Publicly claims this role in its first speeches (a 悍跳狼's fake seer, a villager posing as a god). */
  claim?: 'seer' | 'hunter' | 'guard';
  /** Wolf: votes out a teammate who has been called 查杀 (倒钩). */
  bus?: boolean;
  /** Says little and commits to nothing. */
  quiet?: boolean;
  /** God: keeps the role hidden (a seer only comes out with a 查杀 or to counter a fake seer). */
  hide?: boolean;
  /** Hunter: shows the gun as soon as it is suspected. */
  showGun?: boolean;
  /** Wolf: offers itself as the night-1 kill (自刀骗药). */
  selfKnife?: boolean;
  /** Witch: odds of saving on night 1 (default 1) and of poisoning a suspect from night 2 (default 0.5). */
  save1?: number;
  poison?: number;
}

const WOLVES: Role[] = ['werewolf', 'wolfKing'];

export const PLAYSTYLES: Playstyle[] = [
  // ── 狼人 / 狼王 ──
  {
    id: 'wolfJump', name: '悍跳狼', roles: WOLVES, weight: 3, max: 1,
    guide: '你爱悍跳：第一天上警冒充预言家，编一个可信的查验（常见是给真好人发查杀、或给队友发金水）和警徽流，语气要比真预言家更笃定。夜里先在狼队频道告诉队友「我来悍跳」，让他们配合站边。被对跳时咬死对方是狼，拿「他的警徽流 / 查验不合理」做文章，不轻易退。',
    mock: { run: 1, claim: 'seer' },
  },
  {
    id: 'wolfHook', name: '倒钩狼', roles: WOLVES, weight: 3,
    guide: '你爱倒钩：白天装成最坚定的好人，站边看起来最像真的那个预言家，甚至带头踩、投出已经保不住的狼队友，用队友的命换好人对你的信任，等后期好人把你当成铁好人时再一锤定音。夜里在狼队频道提前打招呼「我明天可能踩你」。',
    mock: { run: 0.3, bus: true },
  },
  {
    id: 'wolfCharge', name: '冲锋狼', roles: WOLVES, weight: 3,
    guide: '你爱冲锋：嗓门大、节奏快，公开替悍跳的队友拉票，猛踩真预言家和他的金水，敢于点名归票把好人抗推出去。被质疑就加倍强硬地反打，宁可暴露也要把节奏带起来。',
    mock: { run: 0.5 },
  },
  {
    id: 'wolfDeep', name: '深水狼', roles: WOLVES, weight: 3,
    guide: '你爱潜水：发言简短、中庸，跟着多数人投票，不当出头鸟，不站死任何一边，不替队友明着说话。前期尽量让人看不出立场，等残局好人互相怀疑时再出来收割。',
    mock: { run: 0.1, quiet: true },
  },
  {
    id: 'wolfBait', name: '自刀狼', roles: WOLVES, weight: 1, max: 1,
    guide: '你爱玩自刀：第一夜在狼队频道提议自刀（刀你自己），骗女巫用掉金水；白天若真被救，就以「银水」的身份博取信任，带着好人的票走。中局也会想自刀的招：队友被查杀注定要出局时提议刀掉他来抹黑预言家；狼王在、女巫金水已用时提议刀狼王让他开枪带走预言家。',
    mock: { run: 0.3, selfKnife: true },
  },
  // ── 村民 ──
  {
    id: 'villFake', name: '装神民', roles: ['villager'], weight: 3, max: 1,
    guide: '你爱装神挡刀：白天暗示或直接声称自己是神职（猎人或守卫，不要冒充预言家、也不要编查验，免得搅乱好人的信息），吸引狼人夜里来刀你、替真神挡刀；被放逐威胁时可以喊「出我会开枪」吓唬狼。若真神职出来和你对跳、或局势需要好人信息清晰时，及时退一步承认自己是民。',
    mock: { run: 0.3, claim: 'hunter' },
  },
  {
    id: 'villShield', name: '护神民', roles: ['villager'], weight: 3,
    guide: '你爱保神：一旦认定谁是真预言家（或其他真神），就坚定站他那边，冲在最前面替他挡口水、跟踩他的人对线，号召大家跟票。别人攻击你相信的神时，你要逐条反驳。',
    mock: { run: 0.4 },
  },
  {
    id: 'villLogic', name: '逻辑民', roles: ['villager'], weight: 3,
    guide: '你爱盘逻辑：不看谁嗓门大，只看能核对的东西——对跳双方的查验和警徽流哪个更合理、谁的投票和发言前后矛盾、谁一直在给某个人开脱。发言条理清楚，给出狼坑排序和依据。',
    mock: { run: 0.3 },
  },
  {
    id: 'villHot', name: '激进民', roles: ['villager'], weight: 2,
    guide: '你爱冲票：直觉强、敢下结论，觉得谁不对就直接点名要求出他，带头归票，不怕站错。但你只拿场上的具体发言和投票说事，被有力的反驳说服时会坦然改票。',
    mock: { run: 0.5 },
  },
  {
    id: 'villCalm', name: '稳健民', roles: ['villager'], weight: 2,
    guide: '你爱稳着打：不轻易站边，先听完对跳双方和各种说法再表态，前期多问问题、少下结论，宁可晚一点也要投准。决定站边后就讲清楚为什么。',
    mock: { run: 0.15, quiet: true },
  },
  // ── 预言家 ──
  {
    id: 'seerBold', name: '强势预言家', roles: ['seer'], weight: 3,
    guide: '你是强势型预言家：第一天上警起跳，报查验和警徽流，态度强硬，直接拿查杀归票，对悍跳的狼寸步不让、逐条拆他的漏洞，把好人拉到你这边。',
    mock: { run: 1 },
  },
  {
    id: 'seerSteady', name: '稳健预言家', roles: ['seer'], weight: 3,
    guide: '你是稳健型预言家：第一天上警起跳，报查验和警徽流，语气平和，耐心解释你的查验思路和警徽流为什么这么留，用逻辑而不是嗓门说服好人。',
    mock: { run: 1 },
  },
  {
    id: 'seerHidden', name: '隐忍预言家', roles: ['seer'], weight: 1,
    guide: '你爱藏验：首验是金水时不急着上警起跳，先混在好人里多验几晚，减少被狼刀的风险；一旦验到狼人就立刻起跳报查杀。如果有人悍跳预言家，你必须马上站出来对跳，不能让假预言家拿走警徽或带歪好人。',
    mock: { run: 0, hide: true },
  },
  // ── 女巫 ──
  {
    id: 'witchSteady', name: '稳健女巫', roles: ['witch'], weight: 3,
    guide: '你是稳健型女巫：第一夜一般救人，毒药留到有把握时再用（被可信查杀的人、对跳中确定的假预言家）。白天藏好身份，必要时才报银水和用药信息。',
    mock: { save1: 1, poison: 0.4 },
  },
  {
    id: 'witchBold', name: '激进女巫', roles: ['witch'], weight: 2,
    guide: '你是激进型女巫：敢开毒，第二夜起只要有较明确的狼面就毒；白天敢于公开身份和用药信息（报银水、报毒了谁）来给好人指路，替预言家作证。',
    mock: { save1: 1, poison: 0.8 },
  },
  {
    id: 'witchHidden', name: '隐忍女巫', roles: ['witch'], weight: 2,
    guide: '你是隐忍型女巫：绝不轻易暴露身份。救人前先想狼人会不会自刀骗药，刀口像狼时宁可不救；毒药留到残局关键时刻。白天像普通村民一样发言，只在必要时亮身份。',
    mock: { save1: 0.6, poison: 0.3 },
  },
  // ── 猎人 ──
  {
    id: 'hunterLoud', name: '亮枪猎人', roles: ['hunter'], weight: 2,
    guide: '你是高调型猎人：一被怀疑或被归票，就立刻亮出猎人身份，警告「出我我就开枪带走狼」，用枪威慑狼人，也替好人挡票。开枪时打你最确定的狼。',
    mock: { run: 0.4, showGun: true },
  },
  {
    id: 'hunterHidden', name: '隐忍猎人', roles: ['hunter'], weight: 3,
    guide: '你是隐忍型猎人：把身份藏到最后，像普通村民一样认真找狼，即使被怀疑也尽量不亮枪，留着这张底牌；真到被放逐时再翻牌开枪带走你最确定的狼。',
    mock: { run: 0.2 },
  },
  // ── 守卫 ──
  {
    id: 'guardHidden', name: '隐忍守卫', roles: ['guard'], weight: 3,
    guide: '你是隐忍型守卫：绝不暴露身份。第一夜为避免和女巫同守同救，倾向空守或守自己；之后重点守起跳的真预言家或警长。白天像普通村民一样发言。',
    mock: { run: 0.15, hide: true },
  },
  {
    id: 'guardBold', name: '博弈守卫', roles: ['guard'], weight: 2,
    guide: '你是博弈型守卫：爱猜狼人的刀口，敢守自己、敢守刚跳出来的神；平安夜后、或真预言家被质疑时，可以公开你的守护记录帮好人分辨真假。',
    mock: { run: 0.3 },
  },
];

const BY_ID = new Map(PLAYSTYLES.map((s) => [s.id, s]));

export function playstyleById(id: string | undefined): Playstyle | null {
  return (id && BY_ID.get(id)) || null;
}

/**
 * Deal one style per seat for this board. Players of the same kind (the four
 * wolves, the four villagers) draw without replacement while styles last, so
 * they all play differently; `max` caps a style across the table. A null role
 * (the human's seat) gets no style and takes none from the AIs.
 */
export function dealPlaystyles(roles: (Role | null)[], rand: () => number): (Playstyle | null)[] {
  const used = new Map<string, number>();
  const left = new Map<string, Playstyle[]>();
  const ok = (s: Playstyle) => (used.get(s.id) ?? 0) < (s.max ?? Infinity);
  return roles.map((role) => {
    if (!role) return null; // the human plays their own way
    const group = isWolf(role) ? 'wolf' : role;
    const all = PLAYSTYLES.filter((s) => s.roles.includes(role));
    let pool = (left.get(group) ?? all).filter(ok);
    if (!pool.length) pool = all.filter(ok);
    if (!pool.length) pool = all;
    let r = rand() * pool.reduce((a, s) => a + s.weight, 0);
    const pick = pool.find((s) => (r -= s.weight) < 0) ?? pool[pool.length - 1];
    used.set(pick.id, (used.get(pick.id) ?? 0) + 1);
    left.set(group, pool.filter((s) => s !== pick));
    return pick;
  });
}
