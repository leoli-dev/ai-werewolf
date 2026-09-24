import type { Agent, PlayerView, SpeechRequest, TargetRequest, WolfChatRequest } from '../game/types';
import { seat } from '../game/types';
import { MockAgent } from './mockAgent';
import { cleanSpeech, parseTarget, privateNotebook, sharedNotebook, speechTask, systemPrompt, targetTask, type Persona } from './prompts';
import type { ChatMessage, OpenAICompatibleProvider, SerialQueue } from './provider';

export interface AgentTelemetry {
  onCall?(info: { player: number; kind: string; ms: number; ok: boolean; error?: string }): void;
}

/**
 * An AI NPC driven by an OpenAI-compatible model. Memory =
 * role/system prompt + 共享发言记录本 (public events) + 角色私本 (private
 * events + its own notes). All calls go through one SerialQueue.
 */
export class LLMAgent implements Agent {
  /** Private notes: the reasons behind its own night actions / votes. */
  readonly notes: string[] = [];
  private fallback: MockAgent;

  constructor(
    private id: number,
    readonly persona: Persona,
    private provider: OpenAICompatibleProvider,
    private queue: SerialQueue,
    private telemetry: AgentTelemetry = {},
  ) {
    this.fallback = new MockAgent(id * 7919);
  }

  private messages(view: PlayerView, task: string): ChatMessage[] {
    return [
      { role: 'system', content: systemPrompt(view, this.persona) },
      {
        role: 'user',
        content: `【共享发言记录本】\n${sharedNotebook(view)}\n\n【你的私人记录本】\n${privateNotebook(view, this.notes)}\n\n【当前任务】\n${task}`,
      },
    ];
  }

  private async call(kind: string, msgs: ChatMessage[], maxTokens: number): Promise<string> {
    let lastErr = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await this.queue.run(() => this.provider.chat(msgs, { maxTokens }));
        this.telemetry.onCall?.({ player: this.id, kind, ms: r.ms, ok: true });
        if (r.content) return r.content;
        lastErr = '空回复';
      } catch (e) {
        lastErr = (e as Error).message;
        this.telemetry.onCall?.({ player: this.id, kind, ms: 0, ok: false, error: lastErr });
      }
    }
    throw new Error(lastErr);
  }

  async speak(req: SpeechRequest | WolfChatRequest, view: PlayerView): Promise<string> {
    try {
      const raw = await this.call(req.kind === 'wolfChat' ? 'wolfChat' : req.purpose, this.messages(view, speechTask(req, view)), 2000);
      return cleanSpeech(raw, view, this.persona.name);
    } catch {
      return this.fallback.speak(req, view);
    }
  }

  async choose(req: TargetRequest, view: PlayerView): Promise<number | null> {
    let raw = '';
    try {
      raw = await this.call(req.action, this.messages(view, targetTask(req, view)), 1500);
    } catch {
      return this.fallback.choose(req, view);
    }
    const { target, reason } = parseTarget(raw, req);
    if (target === undefined) return this.fallback.choose(req, view);
    const tag = { vote: '投票', revote: '再投', seer: '查验', guard: '守护', wolfKill: '刀', hunterShot: '开枪', witchSave: '救', witchPoison: '毒' }[req.action];
    this.notes.push(`第${req.day}${['vote', 'revote'].includes(req.action) ? '天' : '夜'}${tag}${target === null ? '：放弃' : ` ${seat(target)}`}${reason ? `（${reason}）` : ''}`);
    if (this.notes.length > 40) this.notes.splice(0, this.notes.length - 40);
    return target;
  }
}
