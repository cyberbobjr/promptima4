// Shared helpers for spells, items, shrines and the endgame: original prompt routines, game mode,
// timed waits and extra drawing layers (pictures OR-ed over the screen, small tiles in the viewport).
import { assets } from "../../assets/store";
import { EGA_PALETTE } from "../../formats/ega";
import type { PlayerRecord } from "../../formats/save";
import type { Renderer } from "../../render/renderer";
import { TILE, VIEW_TILES, VIEW_X, VIEW_Y } from "../../render/renderer";
import type { Game } from "../game";
import { sleep } from "../prompts";
import { playEffect, SFX } from "../../audio/speaker";
import { inverted, partyRowsRects } from "../../ui/invert";

/** Game mode DS:946A: 1 overworld, 2 town, 3 dungeon, 4 combat (6 = dungeon room, reported as 4 here). */
export function gameMode(g: Game): number {
  if (g.activeMember >= 0) return 4;
  const loc = g.save.location;
  if (loc >= 17 && loc <= 24) return 3;
  return g.map.kind === "town" ? 2 : 1;
}


// ------------------------------------------------------------------ drawing layers

/** Adds a drawing pass over the game screen (a layer). Returns the function removing it. */
export function addDrawHook(g: Game, fn: (r: Renderer) => void): () => void {
  const layer = g.layers.push({ name: "draw", draw: fn });
  return () => layer.remove();
}

const BLACK_VIEW: number[] = new Array(VIEW_TILES * VIEW_TILES).fill(-1);

/** FUN_1000_2246: blank map viewport (also hides the dungeon 3D view). Returns the restore function. */
export function blankView(g: Game): () => void {
  const layer = g.layers.push({ name: "blank", view: () => BLACK_VIEW });
  return () => layer.remove();
}

/** Shows an arbitrary 11x11 tile view (e.g. SHRINE.CON) in the viewport. Returns the restore function. */
export function showTiles(g: Game, tiles: ArrayLike<number>): () => void {
  const view = Array.from(tiles);
  const layer = g.layers.push({ name: "tiles", view: () => view });
  return () => layer.remove();
}

/** A 320x200 indexed layer drawn over the screen; colour 0 is transparent (pictures are OR-ed by EGA.DRV). */
export class PixelLayer {
  readonly px = new Uint8Array(320 * 200);
  private readonly canvas = document.createElement("canvas");
  private dirty = true;
  constructor() { this.canvas.width = 320; this.canvas.height = 200; }
  /** EGA.DRV picture blit (driver entry 0x10): sets the colour planes of every non-black pixel. */
  or(pixels: Uint8Array) { for (let i = 0; i < pixels.length; i++) if (pixels[i]) this.px[i] |= pixels[i]; this.dirty = true; }
  set(x: number, y: number, c: number) { this.px[y * 320 + x] = c; this.dirty = true; }
  xor(x: number, y: number, c: number) { this.px[y * 320 + x] ^= c; this.dirty = true; }
  clear() { this.px.fill(0); this.dirty = true; }
  draw(r: Renderer) {
    if (this.dirty) {
      const ctx = this.canvas.getContext("2d")!;
      const img = ctx.createImageData(320, 200);
      for (let i = 0; i < this.px.length; i++) {
        const c = this.px[i];
        if (!c) continue;
        const [R, G, B] = EGA_PALETTE[c];
        img.data[i * 4] = R; img.data[i * 4 + 1] = G; img.data[i * 4 + 2] = B; img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      this.dirty = false;
    }
    r.ui.drawImage(this.canvas, 0, 0);
  }
}

/** Loads a full-screen .EGA picture (RLE) as 64000 colour indices. */
export async function loadPicture(name: string): Promise<Uint8Array> {
  return (await assets.screen(name)).pixels;
}

/** Draws a tile over viewport cell (vx, vy) (projectiles, flashes). */
export function drawViewTile(r: Renderer, t: number, vx: number, vy: number) {
  if (vx < 0 || vy < 0 || vx >= VIEW_TILES || vy >= VIEW_TILES) return;
  r.drawTileUI(t, VIEW_X + vx * TILE, VIEW_Y + vy * TILE);
}

/** FUN_1000_095E: screen shake. */
export async function shake(g: Game) {
  const el = g.r.gl.domElement;
  for (const dx of [-3, 3, -2, 2, -1, 1, 0]) { el.style.transform = dx ? `translate(${dx}px, ${-dx}px)` : ""; await sleep(40); }
}

/**
 * Opening of 1000:1584 (party hazard: bombs, falling rocks, cannonballs, whirlpools, twisters): every
 * member's status line is inverted (1000:224B, last member first), the hit noise plays, the screen
 * shakes (1000:095E), and the lines are inverted back.
 */
export async function hazardFlash(g: Game) {
  await inverted(g, partyRowsRects(g.save.members), async () => { await playEffect(SFX.HIT); await shake(g); });
}

/** Title drawn in the top frame row over the status area (FUN_1000_45D6 with row 0). */
export function drawStatusTitle(r: Renderer, title: string) {
  const len = Math.min(12, title.length), even = len - (len & 1);
  const col = (even > 7 ? 1 : 0) + Math.floor((12 - even) / 2) + 0x19;
  r.drawGlyph(0x10, col - 1, 0);
  r.drawText(title, col, 0);
  r.drawGlyph(0x11, col + title.length, 0);
}

/** Clears the 8 member rows of the status area (cols 24..39). */
export function clearStatusRows(r: Renderer) { r.fillRect(24 * 8, 8, 16 * 8, 8 * 8, 0); }
