// User configuration: config.json in the app data dir (Tauri) or localStorage (browser), merged
// over the versioned defaults (./defaults.json). Unknown keys are kept, missing ones get defaults.
import defaults from "./defaults.json";

export type Lang = "en" | "fr";

export interface Config {
  version: number;
  lang: { game: Lang; ui: Lang };
  /** Extracted assets folder (Tauri only; empty = the one bundled with the app). */
  assets: { dir: string };
  /** Tile pack folder name under assets (tiles/<pack>/pack.json). */
  tiles: { pack: string };
  /** font: "auto" = original 8x8 font for English with the original tiles, the modern font otherwise. */
  display: { font: "auto" | "original" | "modern"; smoothing: boolean; keepAspect: boolean };
  controls: { tapToMove: boolean; commandBar: "auto" | "always" | "never"; inputTimeoutSeconds: number };
  /** PC-speaker effects (src/audio/speaker.ts); volume 0..1. V)olume toggles `enabled` in the game. */
  sound: { enabled: boolean; volume: number };
  debug: { enabled: boolean; godMode: boolean };
  /** Conversation provider for NPCs (not implemented yet: see src/game/talk/provider.ts). */
  llm: { enabled: boolean; provider: string; model: string; apiKey: string };
}

export const DEFAULT_CONFIG: Config = defaults as Config;

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const STORAGE_KEY = "u4config";

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep merge: values of `over` win, objects are merged key by key. */
export function mergeConfig<T>(base: T, over: unknown): T {
  if (!isPlain(base) || !isPlain(over)) return (over === undefined ? base : over) as T;
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? mergeConfig((base as Plain)[k], v) : v;
  return out as T;
}

let current: Config = structuredClone(DEFAULT_CONFIG);
/** What is saved: the stored values and the user's changes, without the session overrides (?lang, ?debug). */
let stored: Config = structuredClone(DEFAULT_CONFIG);
const listeners = new Set<(c: Config) => void>();

export const config = (): Config => current;

export function onConfigChange(fn: (c: Config) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function readStored(): Promise<unknown> {
  try {
    if (isTauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      const text = await invoke<string | null>("read_config");
      return text ? JSON.parse(text) : undefined;
    }
    const s = localStorage.getItem(STORAGE_KEY);
    return s ? JSON.parse(s) : undefined;
  } catch (e) {
    console.warn("config: unreadable, using defaults", e);
    return undefined;
  }
}

export async function loadConfig(): Promise<Config> {
  stored = mergeConfig(structuredClone(DEFAULT_CONFIG), await readStored());
  current = structuredClone(stored);
  // Dev/tests: ?lang=fr, ?debug override the stored values for this session only.
  if (typeof location !== "undefined") {
    const q = new URLSearchParams(location.search);
    const lang = q.get("lang");
    if (lang === "en" || lang === "fr") current.lang = { game: lang, ui: lang };
    if (q.has("debug")) current.debug.enabled = true;
  }
  return current;
}

/** Applies a partial change, notifies listeners and persists it. */
export async function updateConfig(change: Partial<{ [K in keyof Config]: Partial<Config[K]> }>): Promise<void> {
  current = mergeConfig(current, change);
  stored = mergeConfig(stored, change);
  for (const fn of listeners) fn(current);
  const text = JSON.stringify(stored, null, 2);
  try {
    if (isTauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("write_config", { text });
    } else localStorage.setItem(STORAGE_KEY, text);
  } catch (e) {
    console.warn("config: not saved", e);
  }
}
