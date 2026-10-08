// Screen inverts of AVATAR.EXE that go with its sound effects (docs/RE_NOTES.md "PC speaker").
//
// Two EGA.DRV entries XOR the screen with the graphics controller in XOR mode, colour planes 0-2 only
// (colour c -> c ^ 7), so calling them twice restores the screen:
// - 1000:2241 -> driver entry 0x12: the map viewport (lines 8..183, bytes 1..22: 176x176 at 8,8);
// - 1000:224B(i) -> driver entry 0x16: party member i's status line (8 lines from (i+1)*8, 15 bytes
//   from byte 24: columns 24..38 of text row i+1).
// The game calls them around a sound: invert, 1000:1D47, invert. Here an inverted area is a layer
// (src/ui/layers.ts `invert`) pushed for the duration; the renderer applies the XOR (renderer.ts).
import type { ScreenRect } from "../render/renderer";
import { TILE, VIEW_TILES, VIEW_X, VIEW_Y } from "../render/renderer";
import type { LayerStack } from "./layers";

/** EGA.DRV entry 0x12 (1000:2241): the map viewport. */
export const VIEWPORT_RECT: ScreenRect = { x: VIEW_X, y: VIEW_Y, w: VIEW_TILES * TILE, h: VIEW_TILES * TILE };

/** EGA.DRV entry 0x16 (1000:224B(i)): member i's status line. */
export const statusRowRect = (i: number): ScreenRect => ({ x: 24 * 8, y: (i + 1) * 8, w: 15 * 8, h: 8 });

/** The status lines of members 0..n-1 (the loops `for i = size-1 downto 0: 1000:224B(i)`). */
export const partyRowsRects = (n: number): ScreenRect[] => Array.from({ length: n }, (_, i) => statusRowRect(i));

/** Inverts `rects` until the returned function is called (one XOR toggle of the original, then the other). */
export function invertAreas(host: { layers: LayerStack }, rects: readonly ScreenRect[]): () => void {
  const layer = host.layers.push({ name: "invert", invert: rects });
  return () => layer.remove();
}

/**
 * Runs `fn` (usually a sound, 1000:1D47) with `rects` inverted: the "invert, sound, invert" pattern.
 * The inversion lasts as long as the sound, so it is not seen when the sound is off, as in the original.
 */
export async function inverted<T>(host: { layers: LayerStack }, rects: readonly ScreenRect[], fn: () => Promise<T>): Promise<T> {
  const restore = invertAreas(host, rects);
  try { return await fn(); } finally { restore(); }
}
