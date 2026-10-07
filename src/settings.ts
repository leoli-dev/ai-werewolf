import { CLOUD_CONCURRENCY, PROVIDERS, PROVIDER_IDS, clampEffort, effortsFor, servedLocally, type ProviderId } from './ai/catalog';
import type { ProviderConfig } from './ai/provider';
import { envProvider, hostOf, lanes, normalizeBaseUrl, parseModels, type LocalServer } from './config';
import type { Role } from './game/types';

/**
 * Global configuration (配置 panel): sound, pace and the AI engine. Changes
 * apply at once — also to a game in progress — and are announced to listeners.
 *
 * Everything persists in the browser except API keys, which live encrypted in
 * the key vault (see keyVault.ts). Local / LAN servers come from `.env` (one
 * or more, see config.ts) plus any added in the panel — the only way to reach
 * a LAN server from the static site (GitHub Pages), which has no `.env`. The
 * panel picks a server and one of its models.
 */
export interface AudioLevels {
  muted: boolean;
  /** 0..1 */
  music: number;
  sfx: number;
  ambience: number;
}

/** One provider's saved choices (the matrix keeps one per provider). */
export interface LlmProfile {
  /** Fixed: the official address; for 本地 LLM, the chosen server (see `localServers`). */
  baseUrl: string;
  model: string;
  reasoning: string;
  decisionReasoning: string;
  useProxy: boolean;
}

export interface Config {
  mode: 'llm' | 'offline';
  paceMs: number;
  /** Day: hold each AI speech until the human asks for the next one. */
  stepSpeech: boolean;
  audio: AudioLevels;
  llm: { active: ProviderId; profiles: Record<ProviderId, LlmProfile>; servers: CustomServer[] };
}

/** A local / LAN server added in the 配置 panel (kept in the browser, unlike `.env`). */
export interface CustomServer {
  name: string;
  baseUrl: string;
  models: string[];
  concurrency: number;
}

/** Per-game choices made on the new-game screen. */
export interface GamePrefs {
  playerName: string;
  role: Role | 'random';
  wolfChatRounds: number;
  godView: boolean;
  /** Let AI control the player seat for the entire game. */
  autoPlay: boolean;
}

/** Everything a game is started with (`provider` = the active profile, resolved). */
export type Settings = GamePrefs & Pick<Config, 'mode' | 'paceMs'> & { provider: ProviderConfig };

const CONFIG_KEY = 'ai-werewolf:config:v1';
const GAME_KEY = 'ai-werewolf:settings:v1';
const OLD_MUTE_KEY = 'ai-werewolf:muted';

const DEFAULT_AUDIO: AudioLevels = { muted: false, music: 0.8, sfx: 0.8, ambience: 0.8 };
const DEFAULT_GAME: GamePrefs = { playerName: '旅人', role: 'random', wolfChatRounds: 3, godView: false, autoPlay: false };

function read<T>(key: string): Partial<T> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Partial<T>) : {};
  } catch {
    return {};
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function defaultProfile(id: ProviderId): LlmProfile {
  const preset = PROVIDERS[id];
  if (id === 'local') {
    const env = envProvider().config;
    return { baseUrl: env.baseUrl || preset.baseUrl, model: env.model, reasoning: env.reasoning, decisionReasoning: env.decisionReasoning, useProxy: env.useProxy };
  }
  // official APIs go through the dev-server proxy too (no CORS surprises)
  return { baseUrl: preset.baseUrl, model: preset.defaultModel, ...preset.suggested, useProxy: true };
}

/** A saved / entered server, or null when it is unusable. */
export function cleanServer(s: Partial<CustomServer> | undefined): CustomServer | null {
  const baseUrl = normalizeBaseUrl(s?.baseUrl);
  if (!/^https?:\/\/[^/]/i.test(baseUrl)) return null;
  const models = parseModels(Array.isArray(s?.models) ? s.models.join(',') : '');
  if (!models.length) return null;
  return { name: String(s?.name ?? '').trim() || hostOf(baseUrl), baseUrl, models, concurrency: lanes(String(s?.concurrency)) ?? 1 };
}

/** Every local / LAN server: `.env`'s first, then the ones added in the panel (an address once). */
export function localServers(servers: CustomServer[] = current?.llm.servers ?? []): LocalServer[] {
  const out: LocalServer[] = envProvider().servers.filter((s) => s.baseUrl);
  for (const s of servers) if (!out.some((o) => o.baseUrl === s.baseUrl)) out.push({ ...s, source: { kind: 'browser' } });
  return out;
}

/** A profile that only holds values its provider accepts. */
function sane(id: ProviderId, p: Partial<LlmProfile>, servers?: CustomServer[]): LlmProfile {
  const d = defaultProfile(id);
  let baseUrl = d.baseUrl;
  let model: string;
  if (PROVIDERS[id].fromEnv) {
    // a server or model no longer listed (e.g. removed from .env) falls back to the default
    const usable = localServers(servers).filter((s) => s.models.length);
    const server = usable.find((s) => s.baseUrl === p.baseUrl) ?? usable.find((s) => s.baseUrl === d.baseUrl) ?? usable[0];
    if (server) baseUrl = server.baseUrl;
    model = server ? (p.model && server.models.includes(p.model) ? p.model : server.models[0]) : d.model;
  } else model = p.model && PROVIDERS[id].models.some((m) => m.id === p.model) ? p.model : d.model;
  const efforts = effortsFor(id, model);
  return {
    baseUrl,
    model,
    reasoning: clampEffort(p.reasoning ?? d.reasoning, efforts),
    decisionReasoning: clampEffort(p.decisionReasoning ?? d.decisionReasoning, efforts),
    useProxy: p.useProxy ?? d.useProxy,
  };
}

export function localDefaults(): LlmProfile {
  return defaultProfile('local');
}

function loadConfig(): Config {
  const saved = read<Config>(CONFIG_KEY);
  // older builds kept mode/pace with the game prefs and the mute flag on its own
  const legacy = read<{ mode: Config['mode']; paceMs: number }>(GAME_KEY);
  let legacyMuted = false;
  try {
    legacyMuted = localStorage.getItem(OLD_MUTE_KEY) === '1';
  } catch {
    /* ignore */
  }
  const servers = (Array.isArray(saved.llm?.servers) ? saved.llm.servers : []).map(cleanServer).filter((x): x is CustomServer => !!x);
  // a public copy (GitHub Pages) starts on OpenAI; local / LAN servers stay one click away
  const active = saved.llm?.active && PROVIDER_IDS.includes(saved.llm.active) ? saved.llm.active : servedLocally() ? 'local' : 'openai';
  return {
    mode: saved.mode ?? legacy.mode ?? 'llm',
    paceMs: saved.paceMs ?? legacy.paceMs ?? 900,
    stepSpeech: saved.stepSpeech ?? true,
    audio: { ...DEFAULT_AUDIO, muted: legacyMuted, ...saved.audio },
    llm: {
      active,
      profiles: Object.fromEntries(PROVIDER_IDS.map((id) => [id, sane(id, saved.llm?.profiles?.[id] ?? {}, servers)])) as Record<ProviderId, LlmProfile>,
      servers,
    },
  };
}

function persist() {
  write(CONFIG_KEY, current);
}

let current = loadConfig();
// pin the migrated values before the new-game screen rewrites the old key
if (!Object.keys(read<Config>(CONFIG_KEY)).length) persist();
const listeners = new Set<(c: Config) => void>();

export function getConfig(): Config {
  return current;
}

function changed() {
  persist();
  for (const fn of listeners) fn(current);
}

export function updateConfig(patch: Partial<Pick<Config, 'mode' | 'paceMs' | 'stepSpeech'>> & { audio?: Partial<AudioLevels> }) {
  current = { ...current, ...patch, audio: { ...current.audio, ...patch.audio } };
  changed();
}

/** Pick which provider drives the AI. */
export function setActiveProvider(id: ProviderId) {
  current = { ...current, llm: { ...current.llm, active: id } };
  changed();
}

/** Edit one provider's profile; invalid values (e.g. an effort the new model lacks) are corrected. */
export function updateProfile(id: ProviderId, patch: Partial<LlmProfile>) {
  const profiles = { ...current.llm.profiles, [id]: sane(id, { ...current.llm.profiles[id], ...patch }, current.llm.servers) };
  current = { ...current, llm: { ...current.llm, profiles } };
  changed();
}

/**
 * Add (or replace, same address) a local / LAN server and switch 本地 LLM to it.
 * Returns the stored server, or null when the address or model list is unusable.
 */
export function addServer(s: Partial<CustomServer>): CustomServer | null {
  const server = cleanServer(s);
  if (!server) return null;
  const servers = [...current.llm.servers.filter((o) => o.baseUrl !== server.baseUrl), server];
  const local = sane('local', { ...current.llm.profiles.local, baseUrl: server.baseUrl }, servers);
  current = { ...current, llm: { ...current.llm, servers, profiles: { ...current.llm.profiles, local } } };
  changed();
  return server;
}

/** Forget a server added in the panel (`.env` servers stay); 本地 LLM falls back to another one. */
export function removeServer(baseUrl: string) {
  const servers = current.llm.servers.filter((o) => o.baseUrl !== baseUrl);
  const local = sane('local', current.llm.profiles.local, servers);
  current = { ...current, llm: { ...current.llm, servers, profiles: { ...current.llm.profiles, local } } };
  changed();
}

/** The request settings of the active (or given) provider. */
export function resolveProvider(c: Config = current, id: ProviderId = c.llm.active): ProviderConfig {
  const env = envProvider().config;
  const profile = c.llm.profiles[id];
  const concurrency = PROVIDERS[id].fromEnv ? (localServers(c.llm.servers).find((s) => s.baseUrl === profile.baseUrl)?.concurrency ?? env.concurrency) : CLOUD_CONCURRENCY;
  return { provider: id, ...profile, timeoutMs: env.timeoutMs, concurrency };
}

/** Returns an unsubscribe function. */
export function onConfigChange(fn: (c: Config) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function loadGamePrefs(): GamePrefs {
  const { playerName, role, wolfChatRounds, godView, autoPlay } = { ...DEFAULT_GAME, ...read<GamePrefs>(GAME_KEY) };
  return { playerName, role, wolfChatRounds, godView, autoPlay };
}

export function saveGamePrefs(p: GamePrefs) {
  write(GAME_KEY, p);
}
