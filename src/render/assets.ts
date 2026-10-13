import { assets, type LayeredPack, type LoadedPack } from "../assets/store";
import { EGA_PALETTE, type IndexedImage } from "../formats/ega";
import { LayeredView } from "./layered";

export interface Assets {
  tiles: IndexedImage[];
  glyphs: IndexedImage[];
  frame: IndexedImage; // START.EGA: the in-game screen border
  /** Tile pack of the map views (the original one, or HD...). */
  pack: LoadedPack;
}

/** The edition's layered pack, used when the original graphics have not been extracted. */
export const EDITION_PACK = "pixellab";

export async function loadAssets(packName = "original"): Promise<Assets> {
  if (!assets.originals) return loadEditionAssets(packName);
  const [tiles, glyphs, frame] = await Promise.all([assets.tiles(), assets.glyphs(), assets.screen("START.EGA")]);
  let pack: LoadedPack;
  try { pack = await assets.loadPack(packName); } catch (e) {
    console.warn(`tile pack "${packName}" unavailable, using the original tiles`, e);
    pack = await assets.loadPack("original");
  }
  return { tiles, glyphs, frame, pack };
}

/**
 * Without the original graphics (a fresh clone, the public site): a layered pack (the edition's by default)
 * stands in for everything. Its classic atlas, used where the engine still draws 16-pixel tiles (the world
 * map overview, the 3D dungeon's uncovered ids, projectiles), is the pack's own picture of every id; the
 * indexed tiles are that atlas brought to the EGA palette. No original font (the modern one is forced by
 * main()) and no 1987 frame (the responsive layout is forced). Interpretation of the port.
 */
async function loadEditionAssets(packName: string): Promise<Assets> {
  let pack: LoadedPack;
  try { pack = await assets.loadPack(packName, standInAtlas); } catch (e) {
    if (packName === EDITION_PACK) throw e;
    console.warn(`tile pack "${packName}" unavailable without the original graphics, using "${EDITION_PACK}"`, e);
    pack = await assets.loadPack(EDITION_PACK, standInAtlas);
  }
  if (!pack.layered) throw new Error(`tile pack "${packName}" needs the original graphics (npm run extract)`);
  return {
    tiles: indexedTiles(pack.rgba),
    glyphs: Array.from({ length: 128 }, () => ({ width: 8, height: 8, pixels: new Uint8Array(64) })),
    frame: { width: 320, height: 200, pixels: new Uint8Array(320 * 200) },
    pack,
  };
}

/** A 16x16-tile classic atlas drawn by the layered pack (one thumbnail per id). */
function standInAtlas(layered: LayeredPack): LoadedPack {
  const T = 16, size = 16 * T;
  const blank = document.createElement("canvas");
  blank.width = blank.height = size;
  const view = new LayeredView(layered, blank, T);
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  for (let id = 0; id < 256; id++) g.drawImage(view.thumbnail(id, T), (id & 15) * T, (id >> 4) * T);
  const rgba = new Uint8Array(g.getImageData(0, 0, size, size).data.buffer);
  return { pack: { name: `${layered.def.name} (stand-in)`, tileSize: T, columns: 16, count: 256, image: "" }, size, rgba };
}

/** The atlas's tiles as indexed images, each pixel the nearest EGA colour. */
function indexedTiles(rgba: Uint8Array): IndexedImage[] {
  const nearest = new Map<number, number>();
  const index = (r: number, g: number, b: number) => {
    const key = (r << 16) | (g << 8) | b;
    let best = nearest.get(key);
    if (best === undefined) {
      let d = Infinity;
      EGA_PALETTE.forEach(([pr, pg, pb], i) => {
        const e = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
        if (e < d) { d = e; best = i; }
      });
      nearest.set(key, best!);
    }
    return best!;
  };
  const stride = 256 * 4;
  return Array.from({ length: 256 }, (_, t) => {
    const pixels = new Uint8Array(256), ox = (t & 15) * 16, oy = (t >> 4) * 16;
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const o = (oy + y) * stride + (ox + x) * 4;
        pixels[y * 16 + x] = rgba[o + 3] < 128 ? 0 : index(rgba[o], rgba[o + 1], rgba[o + 2]);
      }
    return { width: 16, height: 16, pixels };
  });
}
