// Sound packs (assets/sounds/<name>/sounds.json, format 1): recorded effects played instead of the PC-speaker
// waveforms of speaker.ts. The game keeps calling playEffect(SFX...): with a pack, this module plays the
// matching recorded sound (EFFECT_EVENTS), the game still waits as long as the original effect lasted, so the
// pacing does not change. Calls can name a more precise sound (`event`: the step on a given ground), and
// cue() plays the pack's own events that the original had no sound for (doors, chests, sailing).
// Interpretation of the port: the original only has the speaker effects.
import { assets } from "../assets/store";
import { config, onConfigChange } from "../config/config";
import { soundRand8 } from "../game/rng";
import { T } from "../game/tiles";
import { audioOutput, setEffectHandler, SFX, speakerReady } from "./speaker";

/** "classic": the PC-speaker effects, no pack. */
export const CLASSIC = "classic";

interface SoundPackDef { format: 1; name: string; events: Record<string, { file: string }> }

/** Effect -> event of the pack; null: silent with a pack (the call that matters names its own event). */
const EFFECT_EVENTS: Record<number, string | null | ((param: number) => string)> = {
  // two clicks per move in the original (the command, then the step taken): only the step, with its ground
  [SFX.STEP]: null,
  [SFX.ERROR]: "blocked",
  [SFX.BAD_COMMAND]: "bad-command",
  [SFX.CANNON]: "cannon",
  [SFX.ATTACK]: "sword-swing",
  [SFX.MONSTER_ATTACK]: "monster-attack",
  [SFX.HIT]: "sword-hit",
  [SFX.HURT]: "hurt",
  [SFX.FLEE]: "flee",
  // pulse width: 0xA0 moongates, 0xC0 healing and level up (Lord British, healers), else spells and shrines
  [SFX.MAGIC]: (p) => ((p & 0xff) === 0xa0 ? "moongate" : (p & 0xff) === 0xc0 ? "level-up" : "spell-cast"),
  // the casting noise always comes before a magic effect, which carries the sound
  [SFX.CAST]: null,
  [SFX.WHIRLPOOL]: "whirlpool",
  [SFX.TWISTER]: "twister",
};

/** Events whose pitch varies a little on each play, so that repeated sounds do not sound mechanical. */
const VARIED = /^(step-|sword-|hurt|monster-attack|blocked|sail)/;

let pack: { def: SoundPackDef; name: string; data: Map<string, Promise<ArrayBuffer>>; decoded: Map<string, Promise<AudioBuffer | null>> } | null = null;
let loading = "";

/** Loads a sound pack by name (CLASSIC or a missing pack: the speaker effects). */
export async function loadSoundPack(name: string): Promise<void> {
  loading = name;
  if (name === CLASSIC || !name) { pack = null; return; }
  try {
    const def = await assets.jsonAt<SoundPackDef>(`sounds/${name}/sounds.json`);
    if (loading !== name) return;
    // the files are fetched now, decoded on first use (decoding needs the AudioContext of the first gesture)
    const data = new Map(Object.entries(def.events).map(([ev, e]) => [ev, assets.binary(`sounds/${name}/${e.file}`)]));
    for (const p of data.values()) p.catch(() => undefined);
    pack = { def, name, data, decoded: new Map() };
  } catch (e) {
    console.warn(`sound pack "${name}" unavailable, using the PC-speaker effects`, e);
    pack = null;
  }
}

/** Loads the configured pack and follows the settings. */
export function initSoundPacks(): Promise<void> {
  setEffectHandler(handle);
  onConfigChange((c) => { const n = c.sound.pack ?? CLASSIC; if (n !== loading) void loadSoundPack(n); });
  return loadSoundPack(config().sound.pack ?? CLASSIC);
}

/** True when a pack replaces the speaker effects. */
export const soundPackActive = (): boolean => pack !== null;

function decoded(event: string): Promise<AudioBuffer | null> | null {
  const out = audioOutput();
  if (!pack || !out) return null;
  let d = pack.decoded.get(event);
  if (!d) {
    const raw = pack.data.get(event);
    if (!raw) return null;
    // decodeAudioData detaches its input: decode a copy, the fetched data stays for another context
    d = raw.then((b) => out.ctx.decodeAudioData(b.slice(0)), () => null).catch(() => null);
    pack.decoded.set(event, d);
  }
  return d;
}

/** Plays an event of the active pack now (no queue: sounds overlap). False when nothing was played. */
export function cue(event: string): boolean {
  if (!pack || !speakerReady()) return false;
  const d = decoded(event);
  if (!d) return false;
  void d.then((buf) => {
    const out = audioOutput();
    if (!buf || !out) return;
    const src = out.ctx.createBufferSource();
    src.buffer = buf;
    // +-4% pitch from the sound stream (never the game's generator: rolls stay the same with or without sound)
    if (VARIED.test(event)) src.playbackRate.value = 0.96 + (soundRand8() / 255) * 0.08;
    src.connect(out.master);
    src.start();
  });
  return true;
}

/** speaker.ts handler: true when the pack takes the effect (played, or silent on purpose). */
function handle(n: number, param: number, event?: string): boolean {
  if (!pack) return false;
  const e = event ?? EFFECT_EVENTS[n];
  const name = typeof e === "function" ? e(param) : e;
  if (name) cue(name);
  return true;
}

/** Step sound of a ground tile (on foot, or on horseback anywhere). */
export function stepEvent(tile: number, horse = false): string {
  if (horse) return "step-horse";
  if (tile === T.WOOD_FLOOR || tile === T.BRIDGE || tile === T.BRIDGE_N || tile === T.BRIDGE_S) return "step-wood";
  if (tile === T.BRICK_FLOOR || tile === T.DUNGEON_FLOOR || tile === T.HILLS || tile === T.CASTLE || tile === T.TOWN ||
      (tile >= T.LCB_WEST && tile <= T.LCB_EAST) || tile === T.RUINS || tile === T.SHRINE) return "step-stone";
  return "step-grass";
}
