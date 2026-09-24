import type { Agent, PlayerView, SpeechRequest, SpeechResult, TargetRequest, WolfChatRequest } from '../game/types';
import { seat } from '../game/types';
import { MockAgent, type MockSnapshot } from './mockAgent';
import { cleanSpeech, parseTarget, privateNotebook, sharedNotebook, speechTask, systemPrompt, targetTask, type Persona } from './prompts';
import { ProviderError, type ChatMessage, type OpenAICompatibleProvider, type SerialQueue } from './provider';

export interface AgentTelemetry {
  onCall?(info: { player: number; kind: string; ms: number; ok: boolean; error?: string }): void;
  /**
   * Called when the model could not produce a usable answer. Resolve 'retry'
   * to try again, 'fallback' to let the rule AI act this once. Without this
   * hook the agent falls back immediately (headless / tests).
   */
  onFailure?(info: { player: number; kind: string; error: string }): Promise<'retry' | 'fallback'>;
}

export interface LLMSnapshot {
  notes: string[];
  fallback: MockSnapshot;
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

  snapshot(): LLMSnapshot {
    return { notes: this.notes.slice(), fallback: this.fallback.snapshot() };
  }

  restore(s: LLMSnapshot) {
    this.notes.splice(0, this.notes.length, ...s.notes);
    this.fallback.restore(s.fallback);
  }

  private messages(view: PlayerView, task: string): ChatMessage[] {
    return [
      { role: 'system', content: systemPrompt(view, this.persona) },
      {
        role: 'user',
        content: [
          `【共享发言记录本 · 之前几天】\n${sharedNotebook(view, { before: view.day })}`,
          `【你的私人记录本】\n${privateNotebook(view, this.notes)}`,
          `【今天的发言（第 ${view.day} 天，按顺序）】\n${sharedNotebook(view, { onlyDay: view.day })}`,
          `【当前任务】\n${task}`,
        ].join('\n\n'),
      },
    ];
  }

  private async call(kind: string, msgs: ChatMessage[], maxTokens: number, reasoning?: string): Promise<string> {
    let lastErr = '';
    // back off on overload (e.g. local server 507 OOM under memory pressure)
    const delays = [0, 5000, 15000];
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt]) await new Promise((r) => setTimeout(r, delays[attempt]));
      try {
        const r = await this.queue.run(() => this.provider.chat(msgs, { maxTokens, reasoning }));
        this.telemetry.onCall?.({ player: this.id, kind, ms: r.ms, ok: true });
        if (r.content) return r.content;
        lastErr = '空回复';
      } catch (e) {
        lastErr = (e as Error).message;
        this.telemetry.onCall?.({ player: this.id, kind, ms: 0, ok: false, error: lastErr });
        if (e instanceof ProviderError && !e.retryable) break;
      }
    }
    throw new Error(lastErr);
  }

  /** Ask the host whether to retry after a failure; false = use the rule AI. */
  private async shouldRetry(kind: string, error: string): Promise<boolean> {
    if (!this.telemetry.onFailure) return false;
    return (await this.telemetry.onFailure({ player: this.id, kind, error })) === 'retry';
  }

  async speak(req: SpeechRequest | WolfChatRequest, view: PlayerView): Promise<SpeechResult> {
    const kind = req.kind === 'wolfChat' ? 'wolfChat' : req.purpose;
    while (true) {
      try {
        // wolf chat is frequent and short: use the (cheaper) decision reasoning level
        const reasoning = req.kind === 'wolfChat' ? this.provider.config.decisionReasoning : undefined;
        const raw = await this.call(kind, this.messages(view, speechTask(req, view)), req.kind === 'wolfChat' ? 800 : 2000, reasoning);
        return cleanSpeech(raw, view, this.persona.name);
      } catch (e) {
        if (await this.shouldRetry(kind, (e as Error).message)) continue;
        return { text: await this.fallback.speak(req, view) as string, fallback: true };
      }
    }
  }

  async choose(req: TargetRequest, view: PlayerView): Promise<number | null> {
    while (true) {
      let raw = '';
      try {
        raw = await this.call(req.action, this.messages(view, targetTask(req, view)), 1000, this.provider.config.decisionReasoning);
      } catch (e) {
        if (await this.shouldRetry(req.action, (e as Error).message)) continue;
        return this.fallback.choose(req, view);
      }
      const { target, reason } = parseTarget(raw, req);
      if (target === undefined) {
        if (await this.shouldRetry(req.action, `无法从模型输出中解析目标：${raw.slice(0, 80)}`)) continue;
        return this.fallback.choose(req, view);
      }
      const tag = { vote: '投票', revote: '再投', seer: '查验', guard: '守护', wolfKill: '刀', hunterShot: '开枪', witchSave: '救', witchPoison: '毒' }[req.action];
      this.notes.push(`第${req.day}${['vote', 'revote'].includes(req.action) ? '天' : '夜'}${tag}${target === null ? '：放弃' : ` ${seat(target)}`}${reason ? `（${reason}）` : ''}`);
      if (this.notes.length > 40) this.notes.splice(0, this.notes.length - 40);
      return target;
    }
  }
}
