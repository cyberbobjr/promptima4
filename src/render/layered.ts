// Map viewport of a layered tile pack (format 2, docs/TILEPACK-LAYERED.md), composited on a 2D canvas of
// 11 x tileSize pixels square, shown by the renderer as a texture over the viewport:
//   1. the base texture (deep water), scrolled by the pack's clock;
//   2. the terrain layers, bottom to top, on the dual grid: one Wang corner tile centred on every corner
//      shared by 4 cells (index NW*8 + NE*4 + SW*2 + SE, 1 = that cell belongs to the layer). `fill` layers
//      use their tiles as a mask over a scrolled texture; `clip: "land"` layers are multiplied by the
//      coverage of the "land" layer;
//   3. the cells the pack does not cover, opaque from the fallback classic atlas; black cells (line of sight);
//   4. sprites, top rows first so that lower creatures overlap upper ones (frames may overflow their cell).
// It is redrawn when the view changes and when the pack's animation frame (`fps`) advances.
import type { LayeredPack } from "../assets/store";
import { T } from "../game/tiles";

const N = 11, G = N + 2;

export class LayeredView {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** Scratch canvas for the masked layers (fill, clip). */
  private readonly tmp: CanvasRenderingContext2D;
  /** Coverage of the "land" layer (clip), drawn once per composite. */
  private readonly land: CanvasRenderingContext2D | null;
  private readonly landIndex: number;
  private readonly S: number;
  private readonly terrain = new Set<number>();
  /** SHAPES id -> sprite index. */
  private readonly sprite = new Map<number, number>();
  /** Layer membership per SHAPES id: bit k = member of layer k. */
  private readonly member = new Uint32Array(256);
  /** Ground terrain per cell of the 13x13 grid (-1 = not terrain: grass for the layers + fallback tile). */
  private readonly cells = new Int16Array(G * G);

  constructor(readonly pack: LayeredPack, private readonly atlas: CanvasImageSource, private readonly atlasTile: number) {
    const def = pack.def;
    this.S = def.tileSize;
    const mk = (w: number) => {
      const c = document.createElement("canvas");
      c.width = c.height = w;
      const ctx = c.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;
      return ctx;
    };
    this.ctx = mk(N * this.S);
    this.canvas = this.ctx.canvas;
    this.tmp = mk(N * this.S);
    this.landIndex = def.layers.findIndex((l) => l.name === "land");
    this.land = def.layers.some((l) => l.clip === "land") && this.landIndex >= 0 ? mk(N * this.S) : null;
    for (const t of def.terrainIds) this.terrain.add(t);
    def.sprites.forEach((s, i) => { for (const id of s.ids) this.sprite.set(id, i); });
    def.layers.forEach((l, k) => { for (const id of l.members) this.member[id & 255] |= 1 << k; });
  }

  /** Terrain under a ground id: terrain ids, `groundOnly`/`underlay` ids mapped, other sprites on grass, else -1. */
  private groundOf(id: number): number {
    const def = this.pack.def;
    if (this.terrain.has(id)) return id;
    const m = def.groundOnly?.[id] ?? def.underlay?.[id];
    if (m !== undefined) return m;
    return this.sprite.has(id) ? T.GRASS : -1;
  }

  /** Ground derived from the tiles when the caller gives none: the ring repeats the edge cells. */
  static derive(tiles: ArrayLike<number>, pack: LayeredPack): number[] {
    const def = pack.def, out: number[] = new Array(G * G);
    const terrain = new Set(def.terrainIds);
    const c = (v: number) => Math.min(N - 1, Math.max(0, v - 1));
    for (let y = 0; y < G; y++)
      for (let x = 0; x < G; x++) {
        const t = tiles[c(y) * N + c(x)];
        out[y * G + x] = terrain.has(t) ? t : def.groundOnly?.[t] ?? def.underlay?.[t] ?? T.GRASS;
      }
    return out;
  }

  /**
   * Composites the viewport. `frame` is the pack's animation frame (floor(time * fps)); `x0` is the map x
   * of the viewport's first column (per-creature animation phase). Returns true if it drew fallback tiles.
   */
  draw(tiles: ArrayLike<number>, ground: ArrayLike<number>, frame: number, x0: number): boolean {
    const { ctx, S, pack } = this, def = pack.def, W = N * S;
    for (let i = 0; i < G * G; i++) this.cells[i] = this.groundOf(ground[i]);

    // 1. base
    this.tiled(ctx, pack.base, def.base.scroll, frame);

    // 2. terrain layers
    if (this.land) { this.land.clearRect(0, 0, W, W); this.corners(this.land, this.landIndex); }
    def.layers.forEach((l, k) => {
      if (!l.fill && !l.clip) { this.corners(ctx, k); return; }
      const t = this.tmp;
      t.globalCompositeOperation = "source-over";
      t.clearRect(0, 0, W, W);
      if (!this.corners(t, k)) return;
      if (l.fill) { t.globalCompositeOperation = "source-in"; this.tiled(t, pack.layers[k].fill!, l.scroll, frame); }
      if (l.clip === "land" && this.land) { t.globalCompositeOperation = "destination-in"; t.drawImage(this.land.canvas, 0, 0); }
      t.globalCompositeOperation = "source-over";
      ctx.drawImage(t.canvas, 0, 0);
    });

    // 3. uncovered cells (fallback atlas, opaque) and black cells
    let fallback = false;
    const A = this.atlasTile;
    ctx.imageSmoothingEnabled = A > S; // a bigger fallback tile is scaled down
    for (let vy = 0; vy < N; vy++)
      for (let vx = 0; vx < N; vx++) {
        const t = tiles[vy * N + vx], x = vx * S, y = vy * S;
        if (t < 0) { ctx.fillStyle = "#000"; ctx.fillRect(x, y, S, S); continue; }
        let f = -1;
        if (!this.terrain.has(t) && !this.sprite.has(t) && def.groundOnly?.[t] === undefined) f = t;
        else if (this.cells[(vy + 1) * G + vx + 1] < 0) f = ground[(vy + 1) * G + vx + 1];
        if (f < 0) continue;
        ctx.drawImage(this.atlas, (f & 15) * A, ((f >> 4) & 15) * A, A, A, x, y, S, S);
        fallback = true;
      }
    ctx.imageSmoothingEnabled = false;

    // 4. sprites, row by row (lower ones over upper ones)
    for (let vy = 0; vy < N; vy++)
      for (let vx = 0; vx < N; vx++) {
        const k = this.sprite.get(tiles[vy * N + vx]);
        if (k === undefined) continue;
        const s = def.sprites[k];
        const f = s.frames > 1 ? (((frame + x0 + vx) % s.frames) + s.frames) % s.frames : 0;
        ctx.drawImage(pack.sprites[k], f * s.w, 0, s.w, s.h,
          vx * S + ((S - s.w) >> 1), (vy + 1) * S + (s.dy ?? 0) - s.h, s.w, s.h);
      }
    return fallback;
  }

  /** Dual grid of layer k: tile (i, j), i, j in 0..11, reads cells (i-1, j-1) NW .. (i, j) SE. */
  private corners(c: CanvasRenderingContext2D, k: number): boolean {
    const { S, cells, member } = this, img = this.pack.layers[k].image, bit = 1 << k;
    const inLayer = (gi: number) => (member[cells[gi] < 0 ? T.GRASS : cells[gi]] & bit) !== 0;
    let any = false;
    for (let j = 0; j <= N; j++)
      for (let i = 0; i <= N; i++) {
        const nw = j * G + i; // ground index of cell (i-1, j-1)
        const idx = (inLayer(nw) ? 8 : 0) | (inLayer(nw + 1) ? 4 : 0) | (inLayer(nw + G) ? 2 : 0) | (inLayer(nw + G + 1) ? 1 : 0);
        if (!idx) continue;
        c.drawImage(img, idx * S, 0, S, S, i * S - S / 2, j * S - S / 2, S, S);
        any = true;
      }
    return any;
  }

  /** Covers the canvas with a tileable texture shifted by `scroll` pixels per frame (wrapping). */
  private tiled(c: CanvasRenderingContext2D, img: ImageBitmap, scroll: [number, number] | undefined, frame: number) {
    const w = img.width, h = img.height, W = N * this.S;
    const ox = (((scroll?.[0] ?? 0) * frame) % w + w) % w, oy = (((scroll?.[1] ?? 0) * frame) % h + h) % h;
    for (let y = oy - h; y < W; y += h)
      for (let x = ox - w; x < W; x += w) c.drawImage(img, x, y);
  }
}
