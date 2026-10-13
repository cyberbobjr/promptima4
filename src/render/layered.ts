// Map viewport of a layered tile pack (format 2, docs/TILEPACK-LAYERED.md), composited on a 2D canvas of
// 11 x tileSize pixels square, shown by the renderer as a texture over the viewport:
//   1. the base texture (deep water), scrolled by the pack's clock;
//   2. the terrain layers, bottom to top, on the dual grid: one Wang corner tile centred on every corner
//      shared by 4 cells (index NW*8 + NE*4 + SW*2 + SE, 1 = that cell belongs to the layer). `fill` layers
//      use their tiles as a mask over a scrolled texture; `clip: "land"` layers are multiplied by the
//      coverage of the "land" layer;
//   3. the other cells, opaque: the pack's `tiles` (frames, scroll), else the fallback classic atlas
//      (nearest-neighbour scaled); black cells (line of sight). A sprite whose ground cell is itself a sprite
//      id (an object of a town map) stands on the most common non-sprite ground of its 4 neighbours;
//   4. sprites, top rows first so that lower creatures overlap upper ones (frames may overflow their cell).
// It is redrawn when the view changes and when the pack's animation frame (`fps`) advances.
import type { LayeredPack } from "../assets/store";
import { isOpaque, T } from "../game/tiles";

const N = 11, G = N + 2;
/** Orthogonal neighbours, in tie-break order. */
const NEIGHBOURS = [[0, -1], [-1, 0], [1, 0], [0, 1]] as const;

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
  /** SHAPES id -> index in def.tiles (opaque pack cells). */
  private readonly tile = new Map<number, number>();
  /** Ground terrain per cell of the 13x13 grid (-1 = not terrain: grass for the layers + opaque cell). */
  private readonly cells = new Int16Array(G * G);
  /** Resolved ground id per cell of the 13x13 grid: a terrain id, a `tiles` id or a fallback id. */
  private readonly under = new Int16Array(G * G);

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
    def.tiles?.forEach((t, i) => { for (const id of t.ids) this.tile.set(id, i); });
  }

  /** Plain ground of an id, without neighbours: terrain and `tiles` ids, `groundOnly` mapped, else -1. */
  private plain(id: number): number {
    if (this.terrain.has(id) || this.tile.has(id)) return id;
    return this.pack.def.groundOnly?.[id] ?? -1;
  }

  /**
   * Ground of cell gi of the 13x13 grid: its plain ground; for a sprite id (an object of the map) the most
   * common plain ground of its 4 orthogonal neighbours (`tiles` ids that block sight, i.e. walls, doors and
   * solid tiles, do not count), else `underlay`, else grass; any other id stays
   * itself (or its `underlay` entry) and is drawn opaque from the fallback.
   */
  private groundAt(ground: ArrayLike<number>, gi: number): number {
    const id = ground[gi], p = this.plain(id);
    if (p >= 0) return p;
    const u = this.pack.def.underlay?.[id];
    if (!this.sprite.has(id)) return u ?? id;
    const x = gi % G, y = (gi / G) | 0;
    const seen: number[] = [], count: number[] = [];
    let best = -1, bestN = 0;
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= G || ny >= G) continue;
      const n = this.plain(ground[ny * G + nx]);
      if (n < 0 || (!this.terrain.has(n) && isOpaque(n))) continue; // not on a wall, door or solid tile
      let k = seen.indexOf(n);
      if (k < 0) { k = seen.length; seen.push(n); count.push(0); }
      if (++count[k] > bestN) { bestN = count[k]; best = n; }
    }
    return best >= 0 ? best : u ?? T.GRASS;
  }

  /**
   * Ground derived from the tiles when the caller gives none: the tiles themselves (sprites are resolved
   * through their neighbours like map objects), the ring repeats the edge cells, black cells are grass.
   */
  static derive(tiles: ArrayLike<number>): number[] {
    const out: number[] = new Array(G * G);
    const c = (v: number) => Math.min(N - 1, Math.max(0, v - 1));
    for (let y = 0; y < G; y++)
      for (let x = 0; x < G; x++) {
        const t = tiles[c(y) * N + c(x)];
        out[y * G + x] = t < 0 ? T.GRASS : t;
      }
    return out;
  }

  /**
   * Composites the viewport. `frame` is the pack's animation frame (floor(time * fps)); `x0` is the map x
   * of the viewport's first column (per-creature animation phase). Returns true if it drew fallback tiles.
   */
  draw(tiles: ArrayLike<number>, ground: ArrayLike<number>, frame: number, x0: number): boolean {
    const { ctx, S, pack } = this, def = pack.def, W = N * S;
    for (let i = 0; i < G * G; i++) {
      const u = this.under[i] = this.groundAt(ground, i);
      this.cells[i] = this.terrain.has(u) ? u : -1;
    }

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

    // 3. opaque cells (pack tiles, else the fallback atlas, nearest-neighbour scaled) and black cells
    let fallback = false;
    const A = this.atlasTile;
    for (let vy = 0; vy < N; vy++)
      for (let vx = 0; vx < N; vx++) {
        const t = tiles[vy * N + vx], x = vx * S, y = vy * S;
        if (t < 0) { ctx.fillStyle = "#000"; ctx.fillRect(x, y, S, S); continue; }
        const gi = (vy + 1) * G + vx + 1;
        let f = -1;
        if (!this.terrain.has(t) && !this.sprite.has(t) && def.groundOnly?.[t] === undefined) f = t;
        else if (this.cells[gi] < 0) f = this.under[gi];
        if (f < 0) continue;
        const k = this.tile.get(f);
        if (k !== undefined) { this.cell(k, x, y, frame, frame + x0 + vx); continue; }
        ctx.drawImage(this.atlas, (f & 15) * A, ((f >> 4) & 15) * A, A, A, x, y, S, S);
        fallback = true;
      }

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

  /**
   * Opaque pack tile k at (x, y): frame `phase` mod frames; the texture shifted by `scroll` pixels per
   * animation frame (`frame`, the same for every cell so that neighbours stay continuous), wrapping.
   */
  private cell(k: number, x: number, y: number, frame: number, phase: number) {
    const { ctx, S } = this, t = this.pack.def.tiles![k], img = this.pack.tiles[k];
    const sx = (t.frames > 1 ? ((phase % t.frames) + t.frames) % t.frames : 0) * S;
    const ox = (((t.scroll?.[0] ?? 0) * frame) % S + S) % S, oy = (((t.scroll?.[1] ?? 0) * frame) % S + S) % S;
    // destination [0, o) shows source [S - o, S), destination [o, S) shows source [0, S - o)
    for (const [dx, srcX, w] of [[0, S - ox, ox], [ox, 0, S - ox]])
      for (const [dy, srcY, h] of [[0, S - oy, oy], [oy, 0, S - oy]])
        if (w > 0 && h > 0) ctx.drawImage(img, sx + srcX, srcY, w, h, x + dx, y + dy, w, h);
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
