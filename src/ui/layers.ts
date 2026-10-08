// Screen composition by layers. The game screen is the original layout (frame, 11x11 viewport,
// party panel, console); modes (combat, dungeon, shops, visions, intro, endgame) push layers that
// replace or decorate parts of it, and remove them when they end:
//
//   const layer = g.layers.push({ view: () => tiles, draw: (r) => hud(r) });
//   try { ... } finally { layer.remove(); }
//
// The topmost layer that provides a part wins for that part; `draw` callbacks run bottom to top
// after the base screen. A `fullscreen` layer hides everything below it.
import type { Scene, Camera } from "three";
import type { Renderer, ScreenRect } from "../render/renderer";

/** Contents of the party panel when a mode replaces it (shops, inventories): title + 8 rows. */
export interface StatusPanel { title: string; rows: string[] }

export interface Layer {
  /** Debug name. */
  name?: string;
  /** Hides the whole game screen below (title, pictures, endgame). */
  fullscreen?: boolean;
  /** Viewport contents: 121 tile ids (-1 = black), or null to hide the tile grid. */
  view?: () => number[] | null;
  /** Three.js scene drawn in the viewport (first-person dungeon). */
  scene3d?: () => { scene: Scene; camera: Camera } | null;
  /** Replaces the party list. */
  status?: () => StatusPanel | null;
  /** Drawn after the base screen and the layers below. */
  draw?: (r: Renderer) => void;
  /**
   * Screen areas whose colours are inverted over everything (src/ui/invert.ts: the viewport and status
   * line inverts of EGA.DRV). They add up like XORs: an area inverted by two layers looks normal.
   */
  invert?: readonly ScreenRect[];
}

export interface LayerHandle { remove(): void }

export class LayerStack {
  private layers: Layer[] = [];

  push(layer: Layer): LayerHandle {
    this.layers.push(layer);
    return { remove: () => { this.layers = this.layers.filter((l) => l !== layer); } };
  }

  /** Runs `fn` with the layer pushed, removing it afterwards even on error. */
  async with<T>(layer: Layer, fn: () => Promise<T>): Promise<T> {
    const h = this.push(layer);
    try { return await fn(); } finally { h.remove(); }
  }

  /** Layers from the topmost fullscreen one (included) upwards, or all of them. */
  visible(): { base: boolean; layers: readonly Layer[] } {
    for (let i = this.layers.length - 1; i >= 0; i--)
      if (this.layers[i].fullscreen) return { base: false, layers: this.layers.slice(i) };
    return { base: true, layers: this.layers };
  }

  /** Topmost value of a part among the visible layers (undefined = no layer provides it). */
  top<K extends "view" | "scene3d" | "status">(part: K): Layer[K] | undefined {
    const { layers } = this.visible();
    for (let i = layers.length - 1; i >= 0; i--) if (layers[i][part]) return layers[i][part];
    return undefined;
  }

  /** Inverted areas of the visible layers, bottom to top. */
  inverts(): ScreenRect[] {
    return this.visible().layers.flatMap((l) => l.invert ?? []);
  }

  get size(): number { return this.layers.length; }
}
