// three.js presentation layer. Everything is laid out in the original 320x200 screen space:
// - a 2D UI canvas (frame, text, status) uploaded as a texture on top,
// - an instanced 11x11 tile grid for the map views (towns, overworld, combat),
// - an optional perspective scene drawn inside the map viewport (dungeons).
import * as THREE from "three";
import { EGA_PALETTE } from "../formats/ega";
import { SCROLL_TILES } from "../game/tiles";
import type { Assets } from "./assets";

export const SCREEN_W = 320, SCREEN_H = 200;
export const VIEW_X = 8, VIEW_Y = 8, VIEW_TILES = 11, TILE = 16;

/** A rectangle of the original 320x200 screen. */
export interface ScreenRect { x: number; y: number; w: number; h: number }

/**
 * Text rendering: the original 8x8 CHARSET glyphs, or a modern pixel font (Press Start 2P, OFL,
 * public/fonts) drawn on a higher-resolution UI layer, needed for accented languages. Control glyphs
 * (moons, cursor, runes, borders: codes < 0x20) always come from the original charset.
 */
export type FontMode = "original" | "modern";
export const MODERN_FONT = "Press Start 2P";
/** UI layer resolution multiplier for the modern font. */
const MODERN_SCALE = 4;

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly ui: CanvasRenderingContext2D;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(0, SCREEN_W, 0, SCREEN_H, -10, 10);
  private readonly uiTexture: THREE.CanvasTexture;
  private readonly atlasData: Uint8Array<ArrayBuffer>;
  /** Tile size of the pack in the atlas (16 for the original). */
  private readonly tileSize: number;
  private readonly scrollTiles: number[];
  readonly atlas: THREE.DataTexture;
  private readonly tileAttr: THREE.InstancedBufferAttribute;
  private readonly mapMesh: THREE.InstancedMesh;
  private readonly glyphAtlas: HTMLCanvasElement;
  private readonly uiCanvas: HTMLCanvasElement;
  /** 320x200 scratch canvas for indexed pictures and tiles (putImageData ignores the UI scale). */
  private readonly scratch: CanvasRenderingContext2D;
  private fontMode: FontMode = "original";
  private uiScale = 1;
  /** Optional 3D view rendered inside the map viewport (dungeons). */
  view3d: { scene: THREE.Scene; camera: THREE.Camera } | null = null;
  /** Screen areas whose colours are inverted after everything is drawn (setInverts). */
  private inverts: readonly ScreenRect[] = [];
  private invertTex: THREE.FramebufferTexture | null = null;
  private readonly invertScene = new THREE.Scene();
  private readonly invertQuad: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;

  constructor(canvas: HTMLCanvasElement, readonly assets: Assets) {
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.gl.setClearColor(0x000000);
    this.gl.autoClear = false;

    // Tile atlas: 16x16 grid of tiles of the pack's size.
    const pack = assets.pack;
    this.tileSize = pack.pack.tileSize;
    this.atlasData = pack.rgba;
    this.scrollTiles = pack.pack.animations?.filter((a) => a.kind === "scroll").flatMap((a) => a.tiles) ?? SCROLL_TILES;
    this.atlas = new THREE.DataTexture(this.atlasData, pack.size, pack.size, THREE.RGBAFormat);
    this.atlas.magFilter = this.atlas.minFilter = THREE.NearestFilter;
    this.atlas.needsUpdate = true;

    const geo = new THREE.PlaneGeometry(TILE, TILE);
    const count = VIEW_TILES * VIEW_TILES;
    this.tileAttr = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    this.tileAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aTile", this.tileAttr);
    const mat = new THREE.ShaderMaterial({
      uniforms: { atlas: { value: this.atlas }, tileSize: { value: this.tileSize } },
      vertexShader: /* glsl */ `
        attribute float aTile;
        varying vec2 vUv; varying float vTile;
        void main() {
          vUv = uv; vTile = aTile;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D atlas; uniform float tileSize; varying vec2 vUv; varying float vTile;
        void main() {
          if (vTile < 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
          float t = floor(vTile + 0.5);
          vec2 cell = vec2(mod(t, 16.0), floor(t / 16.0));
          vec2 px = clamp(floor(vUv * tileSize), 0.0, tileSize - 1.0);
          gl_FragColor = texture2D(atlas, (cell * tileSize + px + 0.5) / (16.0 * tileSize));
        }`,
      side: THREE.DoubleSide,
    });
    this.mapMesh = new THREE.InstancedMesh(geo, mat, count);
    this.mapMesh.frustumCulled = false;
    const m = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      const x = i % VIEW_TILES, y = Math.floor(i / VIEW_TILES);
      m.makeTranslation(VIEW_X + x * TILE + TILE / 2, VIEW_Y + y * TILE + TILE / 2, 0);
      this.mapMesh.setMatrixAt(i, m);
      this.tileAttr.setX(i, -1);
    }
    this.scene.add(this.mapMesh);

    // UI layer.
    const uiCanvas = document.createElement("canvas");
    this.uiCanvas = uiCanvas;
    uiCanvas.width = SCREEN_W; uiCanvas.height = SCREEN_H;
    this.ui = uiCanvas.getContext("2d")!;
    this.ui.imageSmoothingEnabled = false;
    const scratch = document.createElement("canvas");
    scratch.width = SCREEN_W; scratch.height = SCREEN_H;
    this.scratch = scratch.getContext("2d", { willReadFrequently: true })!;
    this.uiTexture = new THREE.CanvasTexture(uiCanvas);
    this.uiTexture.flipY = false;
    this.uiTexture.magFilter = this.uiTexture.minFilter = THREE.NearestFilter;
    this.uiTexture.colorSpace = THREE.NoColorSpace;
    const uiMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(SCREEN_W, SCREEN_H),
      new THREE.MeshBasicMaterial({ map: this.uiTexture, transparent: true, side: THREE.DoubleSide }),
    );
    uiMesh.position.set(SCREEN_W / 2, SCREEN_H / 2, 1);
    this.scene.add(uiMesh);

    // Glyph atlas for text (one row of 8x8 glyphs).
    this.glyphAtlas = document.createElement("canvas");
    this.glyphAtlas.width = assets.glyphs.length * 8;
    this.glyphAtlas.height = 8;
    const gctx = this.glyphAtlas.getContext("2d")!;
    const img = gctx.createImageData(this.glyphAtlas.width, 8);
    assets.glyphs.forEach((g, c) => {
      for (let i = 0; i < 64; i++) {
        const [r, gg, b] = EGA_PALETTE[g.pixels[i]];
        img.data.set([r, gg, b, 255], ((i >> 3) * this.glyphAtlas.width + c * 8 + (i & 7)) * 4);
      }
    });
    gctx.putImageData(img, 0, 0);

    this.invertQuad = createInvertQuad();
    this.invertScene.add(this.invertQuad);

    this.resize();
    window.addEventListener("resize", () => this.resize());
    new ResizeObserver(() => this.resize()).observe(document.body);
  }

  /**
   * Water, fields and lava scroll down one original pixel row per tick (tileSize/16 rows of the pack).
   * The original-size indexed tiles (used by the intro, the dungeon view and drawTileUI) scroll too.
   */
  animateTiles() {
    const n = this.tileSize, step = Math.max(1, n >> 4), stride = 16 * n * 4, row = n * 4;
    for (const t of this.scrollTiles) {
      const ox = (t % 16) * n, oy = (t >> 4) * n;
      const cell = new Uint8Array(n * row);
      for (let y = 0; y < n; y++) cell.set(this.atlasData.subarray((oy + y) * stride + ox * 4, (oy + y) * stride + ox * 4 + row), ((y + step) % n) * row);
      for (let y = 0; y < n; y++) this.atlasData.set(cell.subarray(y * row, (y + 1) * row), (oy + y) * stride + ox * 4);
    }
    for (const t of SCROLL_TILES) {
      const p = this.assets.tiles[t].pixels;
      const last = p.slice(240, 256);
      p.copyWithin(16, 0, 240);
      p.set(last, 0);
    }
    this.atlas.needsUpdate = true;
  }

  /** 121 tile ids in row-major order; -1 renders black. null hides the grid. */
  setView(tiles: ArrayLike<number> | null) {
    this.mapMesh.visible = tiles !== null;
    if (!tiles) return;
    for (let i = 0; i < VIEW_TILES * VIEW_TILES; i++) this.tileAttr.setX(i, tiles[i]);
    this.tileAttr.needsUpdate = true;
  }

  /** Selects the text font; the modern one renders the UI layer at a higher resolution. */
  setFont(mode: FontMode) {
    this.fontMode = mode;
    const scale = mode === "modern" ? MODERN_SCALE : 1;
    if (scale === this.uiScale) return;
    this.uiScale = scale;
    this.uiCanvas.width = SCREEN_W * scale;
    this.uiCanvas.height = SCREEN_H * scale;
    this.ui.setTransform(scale, 0, 0, scale, 0, 0);
    this.ui.imageSmoothingEnabled = false;
    this.uiTexture.dispose(); // the texture size changed
  }

  get font(): FontMode { return this.fontMode; }

  /** Copies a full 320x200 indexed picture into the UI layer (replacing what is there). */
  drawPicture(pixels: Uint8Array, transparentBlack = false) {
    const img = this.scratch.createImageData(SCREEN_W, SCREEN_H);
    for (let i = 0; i < pixels.length; i++) {
      const [r, g, b] = EGA_PALETTE[pixels[i]];
      img.data.set([r, g, b, transparentBlack && pixels[i] === 0 ? 0 : 255], i * 4);
    }
    this.scratch.putImageData(img, 0, 0);
    this.ui.clearRect(0, 0, SCREEN_W, SCREEN_H);
    this.ui.drawImage(this.scratch.canvas, 0, 0, SCREEN_W, SCREEN_H, 0, 0, SCREEN_W, SCREEN_H);
  }

  drawGlyph(code: number, col: number, row: number) {
    if (this.fontMode === "modern" && code >= 0x20 && code !== 0x7f) {
      this.ui.fillStyle = "#000";
      this.ui.fillRect(col * 8, row * 8, 8, 8);
      this.ui.fillStyle = "#fff";
      this.ui.font = `8px "${MODERN_FONT}"`;
      this.ui.textBaseline = "top";
      this.ui.fillText(String.fromCharCode(code), col * 8, row * 8 + 0.5);
      return;
    }
    this.ui.drawImage(this.glyphAtlas, (code & 0x7f) * 8, 0, 8, 8, col * 8, row * 8, 8, 8);
  }

  drawText(text: string, col: number, row: number) {
    for (let i = 0; i < text.length; i++) this.drawGlyph(text.charCodeAt(i), col + i, row);
  }

  /** Draws a tile into the UI layer at pixel coordinates (replacing what is there). */
  drawTileUI(t: number, x: number, y: number) {
    const img = this.scratch.createImageData(16, 16);
    const p = this.assets.tiles[t].pixels;
    for (let i = 0; i < 256; i++) {
      const [r, g, b] = EGA_PALETTE[p[i]];
      img.data.set([r, g, b, 255], i * 4);
    }
    this.scratch.putImageData(img, 0, 0);
    this.ui.clearRect(x, y, 16, 16);
    this.ui.drawImage(this.scratch.canvas, 0, 0, 16, 16, x, y, 16, 16);
  }

  clearRect(x: number, y: number, w: number, h: number) { this.ui.clearRect(x, y, w, h); }

  fillRect(x: number, y: number, w: number, h: number, color: number) {
    const [r, g, b] = EGA_PALETTE[color];
    this.ui.fillStyle = `rgb(${r},${g},${b})`;
    this.ui.fillRect(x, y, w, h);
  }

  resize() {
    // The original 320x200 mode was shown on a 4:3 monitor (non-square pixels).
    const aspect = 4 / 3;
    // fits the canvas's container (the stage next to the command bar), or the window
    const box = this.gl.domElement.parentElement;
    let w = box?.clientWidth || window.innerWidth, h = box?.clientHeight || window.innerHeight;
    if (w / h > aspect) w = Math.floor(h * aspect); else h = Math.floor(w / aspect);
    // whole horizontal scale (every original pixel column the same width) when there is room
    if (w >= 2 * SCREEN_W) { w = Math.floor(w / SCREEN_W) * SCREEN_W; h = Math.floor(w / aspect); }
    this.gl.setPixelRatio(window.devicePixelRatio);
    this.gl.setSize(w, h);
  }

  render() {
    this.uiTexture.needsUpdate = true;
    const size = this.gl.getSize(new THREE.Vector2());
    this.gl.setScissorTest(false);
    this.gl.setViewport(0, 0, size.x, size.y);
    this.gl.clear();
    this.gl.render(this.scene, this.camera);
    if (this.view3d) {
      // Map viewport in GL coordinates (origin bottom-left), drawn over the (hidden) tile grid.
      const sx = size.x / SCREEN_W, sy = size.y / SCREEN_H;
      const vw = VIEW_TILES * TILE * sx, vh = VIEW_TILES * TILE * sy;
      const vx = VIEW_X * sx, vy = size.y - (VIEW_Y * sy + vh);
      this.gl.setViewport(vx, vy, vw, vh);
      this.gl.setScissor(vx, vy, vw, vh);
      this.gl.setScissorTest(true);
      this.gl.clearDepth();
      this.gl.render(this.view3d.scene, this.view3d.camera);
      this.gl.setScissorTest(false);
      this.gl.setViewport(0, 0, size.x, size.y);
    }
    for (const r of this.inverts) this.invertRect(r);
  }

  /**
   * Screen areas to invert at the next frames (the layers' `invert` parts). Each one is applied in
   * turn, so an area listed twice is back to normal, like the two XORs of the original.
   */
  setInverts(rects: readonly ScreenRect[]) { this.inverts = rects; }

  /** Copies the drawn pixels of `r` to a texture and draws them back with their colours inverted. */
  private invertRect(r: ScreenRect) {
    const db = this.gl.getDrawingBufferSize(new THREE.Vector2());
    const sx = db.x / SCREEN_W, sy = db.y / SCREEN_H;
    const x0 = Math.round(r.x * sx), x1 = Math.round((r.x + r.w) * sx);
    const y0 = Math.round(db.y - (r.y + r.h) * sy), y1 = Math.round(db.y - r.y * sy); // GL rows start at the bottom
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return;
    let tex = this.invertTex;
    if (!tex || tex.image.width !== w || tex.image.height !== h) {
      tex?.dispose();
      tex = this.invertTex = new THREE.FramebufferTexture(w, h);
      tex.magFilter = tex.minFilter = THREE.NearestFilter;
      this.invertQuad.material.uniforms.src.value = tex;
    }
    this.gl.copyFramebufferToTexture(tex, new THREE.Vector2(x0, y0));
    // black and white are the same in both colour spaces: inside the map viewport they invert to the
    // tile shader colours, elsewhere to the UI layer ones
    const inView = r.x >= VIEW_X && r.y >= VIEW_Y && r.x + r.w <= VIEW_X + VIEW_TILES * TILE && r.y + r.h <= VIEW_Y + VIEW_TILES * TILE;
    this.invertQuad.material.uniforms.first.value = inView ? 0 : 16;
    this.invertQuad.position.set(r.x + r.w / 2, r.y + r.h / 2, 5);
    this.invertQuad.scale.set(r.w, r.h, 1);
    this.gl.render(this.invertScene, this.camera);
  }
}

/**
 * The inverting quad. EGA.DRV inverts with the graphics controller in XOR mode on the colour planes 0-2
 * only (driver entries 0x12 and 0x16): EGA colour c becomes c ^ 7 (black <-> light grey, white <->
 * dark grey, blue <-> brown...). Each pixel is matched against the 16 EGA colours, both as drawn by
 * the tile shader (raw) and by the UI layer (sRGB-encoded), and replaced by its partner; colours of
 * other tile packs, which are not EGA colours, are inverted as RGB.
 */
function createInvertQuad(): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
  const srgb = (v: number) => { const c = v / 255; return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; };
  const pal: THREE.Vector3[] = [], inv: THREE.Vector3[] = [];
  for (const enc of [(v: number) => v / 255, srgb])
    for (let c = 0; c < 16; c++) {
      const [r, g, b] = EGA_PALETTE[c], [ir, ig, ib] = EGA_PALETTE[c ^ 7];
      pal.push(new THREE.Vector3(enc(r), enc(g), enc(b)));
      inv.push(new THREE.Vector3(enc(ir), enc(ig), enc(ib)));
    }
  const mat = new THREE.ShaderMaterial({
    uniforms: { src: { value: null }, pal: { value: pal }, inv: { value: inv }, first: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D src; uniform vec3 pal[32]; uniform vec3 inv[32]; uniform int first; varying vec2 vUv;
      void main() {
        vec3 c = texture2D(src, vec2(vUv.x, 1.0 - vUv.y)).rgb;
        vec3 o = vec3(1.0) - c;
        float best = 0.002;
        for (int k = 0; k < 32; k++) { int i = (k + first) % 32; vec3 d = c - pal[i]; float e = dot(d, d); if (e < best) { best = e; o = inv[i]; } }
        gl_FragColor = vec4(o, 1.0);
      }`,
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  quad.frustumCulled = false;
  return quad;
}
