// Background music (assets/music/<pack>/music.json, format 1): one looping track per scene, cross-faded when
// the scene changes. Interpretation of the port: the DOS original has no music. Tracks are streamed by audio
// elements (a decoded 4-minute track would take ~85 MB); they start after the first user gesture.
import { assets } from "../assets/store";
import { config } from "../config/config";
import type { Game } from "../game/game";
import { LOCATIONS, LocKind } from "../game/locations";

export type Scene = "title" | "overworld" | "town" | "castle" | "dungeon" | "combat" | "sailing" | "shrine" | "ending";
interface MusicDef { format: 1; name: string; tracks: Partial<Record<Scene, { file: string }>> }

/** Fade duration of a scene change, in seconds. */
const FADE_S = 2;
const TICK_MS = 100;

let def: MusicDef | null = null;
let loaded = "";
let current: { url: string; el: HTMLAudioElement } | null = null;
const fading = new Set<HTMLAudioElement>();
let forced: Scene | null = null;
let unlocked = false;

/** Runs `fn` with the music of `scene` (meditation, the ending), whatever the map. */
export async function withScene<T>(scene: Scene, fn: () => Promise<T>): Promise<T> {
  const before = forced;
  forced = scene;
  try { return await fn(); } finally { forced = before; }
}

/** The scene of the game now. */
function sceneOf(g: Game): Scene {
  if (forced) return forced;
  if (!g.save || !g.map) return "title";
  if (g.layers.visible().layers.some((l) => l.name === "combat")) return "combat";
  // shrines set the location to 25 + virtue while the party meditates (shrine.ts)
  if (g.save.location >= 25) return "shrine";
  if (g.save.location >= 17) return "dungeon";
  if (g.map.kind === "town") return LOCATIONS[g.save.location]?.kind === LocKind.Castle ? "castle" : "town";
  return g.onShip ? "sailing" : "overworld";
}

async function load(name: string) {
  loaded = name;
  try {
    const d = await assets.jsonAt<MusicDef>(`music/${name}/music.json`);
    if (loaded === name) def = d;
  } catch (e) {
    console.warn(`music "${name}" unavailable`, e);
    if (loaded === name) def = null;
  }
}

/** Target volume of the music now (0: silent, the track fades out). */
function level(): number {
  const c = config();
  if (c.sound.enabled === false || !c.music.enabled) return 0;
  return Math.max(0, Math.min(1, c.music.volume));
}

function tick(g: Game) {
  const c = config();
  if (c.music.pack !== loaded) void load(c.music.pack);
  const file = def?.tracks[sceneOf(g)]?.file;
  const url = file ? assets.url(`music/${loaded}/${file}`) : "";
  if (url !== (current?.url ?? "")) {
    if (current) fading.add(current.el);
    current = null;
    if (url) {
      const el = new Audio(url);
      el.loop = true;
      el.volume = 0;
      current = { url, el };
    }
  }
  const step = TICK_MS / 1000 / FADE_S;
  const target = level();
  if (current && unlocked) {
    const el = current.el;
    if (el.paused && target > 0) void el.play().catch(() => undefined);
    el.volume = el.volume < target ? Math.min(target, el.volume + step * Math.max(target, 0.05)) : Math.max(target, el.volume - step);
    // muted: the track pauses once faded out (it resumes from there when the music is back on)
    if (target === 0 && el.volume === 0 && !el.paused) el.pause();
  }
  for (const el of fading) {
    el.volume = Math.max(0, el.volume - step);
    if (el.volume === 0) { el.pause(); el.removeAttribute("src"); el.load(); fading.delete(el); }
  }
}

/** Starts the music of the game's scenes (the browser lets it play after the first gesture). */
export function installMusic(g: Game): void {
  if (typeof window === "undefined" || typeof Audio === "undefined") return;
  const events = ["pointerdown", "keydown", "touchend"] as const;
  const unlock = () => { unlocked = true; for (const ev of events) window.removeEventListener(ev, unlock, true); };
  for (const ev of events) window.addEventListener(ev, unlock, true);
  setInterval(() => tick(g), TICK_MS);
}
