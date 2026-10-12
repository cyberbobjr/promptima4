// Single access point to the game resources. Everything comes from the asset folder; the engine
// never reads the original files:
//   assets/original/   produced by `npm run extract` from the original install
//   assets/i18n/<lang>/ translations of the original texts and dialogues (game.json, talk/*.json)
//   assets/packs/<name>/ other tile packs (HD...)
// assets/original, the translations and the derived packs come from the original game: they are
// git-ignored on the public branches.
// Callers still name resources by their original file names ("LCB_1.ULT", "GRASS.CON"...), which the
// store maps to the extracted JSON/PNG files.
import type { IndexedImage } from "../formats/ega";
import type { CombatMap, Dungeon, NpcDef } from "../formats/maps";
import type { Dialogue } from "../formats/tlk";
import type { SaveGame } from "../formats/save";
import { decodeIndexedPng } from "./png";

export interface TownMap { tiles: Uint8Array; npcs: NpcDef[] }
/**
 * A tile pack (tiles/<name>/pack.json in assets/original for the extracted one, packs/<name>/ for the
 * others): one atlas image of `columns` x rows tiles of `tileSize` pixels, with the same tile
 * indices as the original SHAPES.EGA. Animations: "scroll" tiles roll down by tileSize/16 pixels per
 * tick (water, fields, lava), as the original does by one pixel.
 */
export interface TilePack { name: string; tileSize: number; columns: number; count: number; image: string; indexed?: boolean; animations?: { kind: "scroll"; tiles: number[] }[] }

/**
 * A layered tile pack (format 2, docs/TILEPACK-LAYERED.md): scrolling base texture, terrain layers on a
 * dual grid (Wang corner tiles), sprites with frames; the ids it does not cover come from `fallback`.
 */
export interface LayeredPackDef {
  name: string; format: 2; tileSize: number; fallback?: string; fps: number;
  base: { image: string; scroll?: [number, number] };
  terrainIds: number[];
  layers: { name: string; members: number[]; image: string; fill?: string; scroll?: [number, number]; clip?: "land" }[];
  underlay?: Record<string, number>;
  groundOnly?: Record<string, number>;
  sprites: { name: string; ids: number[]; image: string; w: number; h: number; frames: number; dy?: number }[];
}

/** A layered pack with its images decoded. */
export interface LayeredPack {
  def: LayeredPackDef;
  base: ImageBitmap;
  /** Same order as def.layers; `fill` decoded when the layer has one. */
  layers: { image: ImageBitmap; fill: ImageBitmap | null }[];
  /** Same order as def.sprites. */
  sprites: ImageBitmap[];
}

/**
 * A pack ready for the renderer: RGBA atlas of 16x16 tiles. For a layered pack, `pack`/`rgba` are its
 * fallback classic pack (used for the uncovered ids and everything outside the map views).
 */
export interface LoadedPack { pack: TilePack; size: number; rgba: Uint8Array<ArrayBuffer>; layered?: LayeredPack }
export type TitleTables = Record<string, number[]>;
export type TextCatalog = Record<string, string | string[]>;

export interface AssetManifest { version: number; files: string[] }

const base = (file: string) => file.replace(/\.[^.]+$/, "").toLowerCase();
const bytes = (a: ArrayLike<number>) => Uint8Array.from(a);

export class AssetStore {
  private cache = new Map<string, Promise<unknown>>();

  /** `root` is the URL of the asset folder, ending with "/". */
  constructor(readonly root: string) {}

  /** Language of the dialogues (talk/*.json overlays from assets/i18n/<lang>/). */
  lang = "en";

  private memo<T>(key: string, load: () => Promise<T>): Promise<T> {
    let p = this.cache.get(key) as Promise<T> | undefined;
    if (!p) { p = load(); this.cache.set(key, p); p.catch(() => this.cache.delete(key)); }
    return p;
  }

  private async fetch(path: string): Promise<Response> {
    const res = await fetch(this.root + path);
    if (!res.ok) throw new Error(`asset ${path}: HTTP ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("text/html")) throw new Error(`asset ${path}: not found`); // dev server fallback page
    return res;
  }

  /** JSON file, relative to assets/ (`at`) or to assets/original/ (`json`). */
  jsonAt<T>(path: string): Promise<T> {
    return this.memo(path, async () => (await this.fetch(path)).json() as Promise<T>);
  }

  json<T>(rel: string): Promise<T> { return this.jsonAt<T>(`original/${rel}`); }

  /** JSON file that may be missing (null). */
  async optionalJson<T>(path: string): Promise<T | null> {
    try { return await this.jsonAt<T>(path); } catch { return null; }
  }

  image(rel: string): Promise<IndexedImage> {
    const path = `original/${rel}`;
    return this.memo(path, async () => decodeIndexedPng(await (await this.fetch(path)).blob()));
  }

  /** Null when the folder has not been extracted yet. */
  async manifest(): Promise<AssetManifest | null> {
    try { return await this.json<AssetManifest>("manifest.json"); } catch { return null; }
  }

  // --- graphics

  tilePack(name = "original"): Promise<TilePack> {
    return name === "original" ? this.json("tiles/original/pack.json") : this.jsonAt(`packs/${name}/pack.json`);
  }

  /**
   * Loads a pack's atlas as RGBA (any pack, including HD ones). A layered pack (format 2) loads its
   * images and its fallback classic pack ("original" if that one is missing).
   */
  async loadPack(name = "original"): Promise<LoadedPack> {
    const pack = await this.tilePack(name);
    if ((pack as unknown as { format?: number }).format !== 2) return this.loadClassic(name, pack);
    const def = pack as unknown as LayeredPackDef;
    let fallback: LoadedPack;
    try { fallback = await this.loadClassic(def.fallback ?? "original"); } catch (e) {
      console.warn(`fallback pack "${def.fallback}" of "${name}" unavailable, using the original tiles`, e);
      fallback = await this.loadClassic("original");
    }
    const img = async (rel: string) =>
      createImageBitmap(await (await this.fetch(`packs/${name}/${rel}`)).blob(), { colorSpaceConversion: "none" });
    const [base, layers, sprites] = await Promise.all([
      img(def.base.image),
      Promise.all(def.layers.map(async (l) => ({ image: await img(l.image), fill: l.fill ? await img(l.fill) : null }))),
      Promise.all(def.sprites.map((s) => img(s.image))),
    ]);
    return { ...fallback, layered: { def, base, layers, sprites } };
  }

  private async loadClassic(name: string, known?: TilePack): Promise<LoadedPack> {
    const pack = known ?? await this.tilePack(name);
    if ((pack as unknown as { format?: number }).format === 2) throw new Error(`pack ${name}: a layered pack cannot be a fallback`);
    const path = name === "original" ? `original/tiles/original/${pack.image}` : `packs/${name}/${pack.image}`;
    const res = await this.fetch(path);
    const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    const size = pack.tileSize * 16;
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    // the atlas is always laid out 16x16 for the renderer, whatever the pack's column count
    for (let t = 0; t < pack.count; t++) {
      const sx = (t % pack.columns) * pack.tileSize, sy = Math.floor(t / pack.columns) * pack.tileSize;
      ctx.drawImage(bmp, sx, sy, pack.tileSize, pack.tileSize, (t % 16) * pack.tileSize, (t >> 4) * pack.tileSize, pack.tileSize, pack.tileSize);
    }
    bmp.close();
    const rgba = new Uint8Array(ctx.getImageData(0, 0, size, size).data.buffer);
    return { pack, size, rgba };
  }

  /** The 16x16 EGA tiles of the original pack, one indexed image per tile. */
  async tiles(): Promise<IndexedImage[]> {
    const pack = await this.tilePack();
    const atlas = await this.image(`tiles/original/${pack.image}`);
    return slice(atlas, pack.tileSize, pack.tileSize, pack.columns, pack.count);
  }

  async glyphs(): Promise<IndexedImage[]> {
    const f = await this.json<{ glyphWidth: number; glyphHeight: number; columns: number; count: number; image: string }>("font/charset.json");
    return slice(await this.image(`font/${f.image}`), f.glyphWidth, f.glyphHeight, f.columns, f.count);
  }

  /** A full-screen 320x200 picture, by original name ("START.EGA"). */
  screen(name: string): Promise<IndexedImage> { return this.image(`screens/${base(name)}.png`); }

  // --- maps and dialogues

  async world(): Promise<Uint8Array> {
    return bytes((await this.json<{ tiles: number[] }>("maps/world.json")).tiles);
  }

  async town(file: string): Promise<TownMap> {
    const t = await this.json<{ tiles: number[]; npcs: NpcDef[] }>(`maps/towns/${base(file)}.json`);
    return { tiles: bytes(t.tiles), npcs: t.npcs.map((n) => ({ ...n })) };
  }

  /** Dialogues of a town; in another language, translated fields replace the original ones. */
  async talk(file: string): Promise<(Dialogue | null)[]> {
    const orig = await this.json<(Dialogue | null)[]>(`talk/${base(file)}.json`);
    if (this.lang === "en") return orig;
    const tr = await this.optionalJson<(Partial<Dialogue> | null)[]>(`i18n/${this.lang}/talk/${base(file)}.json`);
    return orig.map((d, i) => (d && tr?.[i] ? { ...d, ...tr[i] } : d));
  }

  /** An arena by file name ("GRASS.CON"; "CAMP.DNG" is the camp arena underground). */
  async combat(file: string): Promise<CombatMap> {
    const name = file.toUpperCase().endsWith(".DNG") ? `${base(file)}-dng` : base(file);
    const c = await this.json<{ tiles: number[]; monsterPos: [number, number][]; partyPos: [number, number][] }>(`maps/combat/${name}.json`);
    return { tiles: bytes(c.tiles), monsterPos: c.monsterPos, partyPos: c.partyPos };
  }

  async shrineMap(): Promise<Uint8Array> {
    return bytes((await this.json<{ tiles: number[] }>("maps/combat/shrine.json")).tiles);
  }

  async dungeon(file: string): Promise<Dungeon> {
    type Room = Omit<Dungeon["rooms"][number], "tiles"> & { tiles: number[] };
    const d = await this.json<{ levels: number[][]; rooms: Room[] }>(`maps/dungeons/${base(file)}.json`);
    return { levels: d.levels.map(bytes), rooms: d.rooms.map((r) => ({ ...r, tiles: bytes(r.tiles) })) };
  }

  // --- tables, texts, saves

  titleTables(): Promise<TitleTables> { return this.json("data/title.json"); }

  /** Original texts: English from the extraction, other languages from assets/i18n. */
  gameText(lang: string): Promise<TextCatalog> {
    return lang === "en" ? this.json("i18n/en/game.json") : this.jsonAt(`i18n/${lang}/game.json`);
  }

  /** PARTY.NEW: the party template used by character creation. */
  async newParty(): Promise<SaveGame> { return structuredClone(await this.json<SaveGame>("saves/party.new.json")); }

  /** PARTY.SAV of the original install, if it held a game (imported by the extractor). */
  async originalSave(): Promise<SaveGame | null> {
    try { return structuredClone(await this.json<SaveGame>("saves/party.sav.json")); } catch { return null; }
  }
}

function slice(img: IndexedImage, w: number, h: number, columns: number, count: number): IndexedImage[] {
  const out: IndexedImage[] = [];
  for (let i = 0; i < count; i++) {
    const ox = (i % columns) * w, oy = Math.floor(i / columns) * h;
    const pixels = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) pixels.set(img.pixels.subarray((oy + y) * img.width + ox, (oy + y) * img.width + ox + w), y * w);
    out.push({ width: w, height: h, pixels });
  }
  return out;
}

/** Where the extracted assets are served from (Vite dev server / bundled app). */
export const assets = new AssetStore(`${import.meta.env.BASE_URL}assets/`);
