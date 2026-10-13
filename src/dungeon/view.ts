// First-person dungeon view built with three.js, drawn by Renderer.view3d inside the map viewport.
// The original (AVATAR.EXE FUN_1000_b4df and friends) draws flat EGA polygons: walls filled blue or
// green depending on their axis, cyan doors and ladders, and scaled tiles for objects/monsters
// (FUN_1000_ab08/ad6a). This keeps that palette on real 3D geometry, with nearest filtering.
import * as THREE from "three";
import { EGA_PALETTE } from "../formats/ega";
import type { Assets } from "../render/assets";
import type { PackArt } from "../render/renderer";
import { SCROLL_TILES, T } from "../game/tiles";

/** Orientation as stored in the save (0x9334): 0 West, 1 North, 2 East, 3 South. */
export const DIR_DX = [-1, 0, 1, 0];
export const DIR_DY = [0, -1, 0, 1];

/** Cells drawn around the party; the original draws 4 cells ahead (FUN_1000_b4df). */
const RADIUS = 4;
const TWEEN_MS = 140;
/** Camera stands this far behind the cell centre, looking forward. */
const CAM_BACK = 0.3;
const FOV = 80;
/** Objects are drawn at a fixed screen size and height per distance like FUN_1000_ac23 (48/32/16/8 px of 176,
 *  centred 48/32/16/12 px below the middle), interpolated for the camera tween. */
const SPRITE_PX = [48, 32, 16, 8, 4];
const SPRITE_DROP = [48, 32, 16, 12, 8];

export interface DungeonViewState {
  /** Cell byte at wrapped coordinates (0..7). */
  cellAt(x: number, y: number): number;
  /** Unwrapped party position (only the low 3 bits address the map). */
  ux: number; uy: number;
  dir: number;
  /** Torch/light burning; without light nothing is drawn (FUN_1000_b61c). */
  lit: boolean;
}

/** Monster sprite base tile for a cell, or 0 (FUN_1000_abe5: the low nibble holds a wandering monster). */
export function monsterInCell(cell: number): number {
  const t = cell & 0xf0;
  if (t === 0x80 || t === 0x90 || t === 0xa0 || t >= 0xd0 || (cell & 0xf) === 0) return 0;
  return ((cell & 0xf) * 4 + 0x8c) & 0xff;
}

type Pixels = (x: number, y: number) => number;

export class DungeonView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.02, 40);
  private readonly world = new THREE.Group();
  private readonly plane = new THREE.PlaneGeometry(1, 1);
  private readonly mats = new Map<string, THREE.Material>();
  private readonly tileTex = new Map<string, THREE.DataTexture>();
  /** Textures made from the layered pack's pictures (static: they do not scroll). */
  private readonly packTex = new Map<string, THREE.Texture>();
  /** Whether the pack has an opaque tile for an id (wall and door faces). */
  private readonly packHas = new Map<number, boolean>();
  private monsters: { sprite: THREE.Sprite; base: number; phase: number }[] = [];
  private sprites: THREE.Sprite[] = [];
  private lastScroll = 0;
  // camera tween
  private from = { x: 0, z: 0, yaw: 0 };
  private to = { x: 0, z: 0, yaw: 0 };
  private t0 = 0;
  private yawTarget = 0;

  /** `art`: a layered pack's pictures, used instead of the original 16-pixel tiles for the ids it covers. */
  constructor(private readonly assets: Assets, private readonly art: PackArt | null = null) {
    this.scene.background = new THREE.Color(0x000000);
    this.scene.add(this.world);
    this.camera.rotation.order = "YXZ";
  }

  // ------------------------------------------------------------ textures & materials

  private makeTexture(w: number, h: number, px: Pixels, transparentBlack: boolean): THREE.DataTexture {
    const data = new Uint8Array(w * h * 4);
    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
    this.fillTexture(tex, px, transparentBlack);
    tex.magFilter = tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;
    return tex;
  }

  private fillTexture(tex: THREE.DataTexture, px: Pixels, transparentBlack: boolean) {
    const { width: w, height: h, data } = tex.image as { width: number; height: number; data: Uint8Array };
    // DataTexture row 0 is the bottom of a plane's UV space: store the picture upside down.
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const c = px(x, y);
        const [r, g, b] = EGA_PALETTE[c];
        data.set([r, g, b, transparentBlack && c === 0 ? 0 : 255], ((h - 1 - y) * w + x) * 4);
      }
    tex.needsUpdate = true;
  }

  private tile(t: number, transparentBlack: boolean): THREE.Texture {
    const key = `${t}:${transparentBlack}`;
    const packed = this.packTex.get(key);
    if (packed) return packed;
    // the pack's sprite (creatures, chests...) or opaque tile (fields), when it has one
    const pic = this.art && (transparentBlack ? this.art.sprite(t) : this.art.tile(t) ?? this.art.sprite(t));
    if (pic) {
      const ct = new THREE.CanvasTexture(pic);
      ct.magFilter = THREE.NearestFilter;
      ct.minFilter = THREE.LinearFilter;
      ct.generateMipmaps = false;
      ct.colorSpace = THREE.SRGBColorSpace;
      this.packTex.set(key, ct);
      return ct;
    }
    let tex = this.tileTex.get(key);
    if (!tex) {
      const p = this.assets.tiles[t].pixels;
      tex = this.makeTexture(16, 16, (x, y) => p[y * 16 + x], transparentBlack);
      this.tileTex.set(key, tex);
    }
    return tex;
  }

  private mat(key: string, make: () => THREE.Material): THREE.Material {
    let m = this.mats.get(key);
    if (!m) { m = make(); this.mats.set(key, m); }
    return m;
  }

  /**
   * A face textured with a layered pack's opaque tile (0x7F wall, 0x3A door), the x-facing ones darker so that
   * corners still read; null without such a tile. Interpretation of the port: the original's faces are flat.
   */
  private packFaceMat(key: string, t: number, axisX: boolean): THREE.Material | null {
    let has = this.packHas.get(t);
    if (has === undefined) this.packHas.set(t, has = !!this.art?.tile(t));
    if (!has) return null;
    return this.mat(`${key}${axisX}`, () => new THREE.MeshBasicMaterial({
      map: this.tile(t, false), color: axisX ? new THREE.Color(0.72, 0.72, 0.78) : new THREE.Color(1, 1, 1),
    }));
  }

  /** Wall face: EGA blue (y-facing) or green (x-facing) fill with a black outline, like FUN_1000_2297. */
  private wallMat(axisX: boolean) {
    const packed = this.packFaceMat("packwall", T.WALL, axisX);
    if (packed) return packed;
    return this.mat(`wall${axisX}`, () => {
      const fill = axisX ? 2 : 1;
      const tex = this.makeTexture(16, 16, (x, y) => (x === 0 || y === 0 || x === 15 || y === 15 ? 0 : fill), false);
      return new THREE.MeshBasicMaterial({ map: tex });
    });
  }

  /** Door (and room entrance): wall with a cyan door panel (FUN_1000_b35c). */
  private doorMat(axisX: boolean) {
    const packed = this.packFaceMat("packdoor", T.DOOR, axisX);
    if (packed) return packed;
    return this.mat(`door${axisX}`, () => {
      const fill = axisX ? 2 : 1;
      const tex = this.makeTexture(16, 16, (x, y) => {
        if (x === 0 || y === 0 || x === 15 || y === 15) return 0;
        if (x >= 4 && x <= 11 && y >= 3) return x === 4 || x === 11 || y === 3 ? 0 : 3;
        return fill;
      }, false);
      return new THREE.MeshBasicMaterial({ map: tex });
    });
  }

  /** Ceiling/floor hole: black opening with a cyan rim (FUN_1000_a94a / aa29). */
  private holeMat() {
    return this.mat("hole", () => {
      const tex = this.makeTexture(16, 16, (x, y) => (x === 0 || y === 0 || x === 15 || y === 15 ? 3 : 0), false);
      return new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
    });
  }

  private cyanMat() {
    return this.mat("cyan", () => {
      const [r, g, b] = EGA_PALETTE[3];
      return new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace) });
    });
  }

  private fieldMat(t: number) {
    return this.mat(`field${t}`, () => new THREE.MeshBasicMaterial({
      map: this.tile(t, false), transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false,
    }));
  }

  private spriteMat(t: number) {
    return this.mat(`sprite${t}`, () => new THREE.SpriteMaterial({ map: this.tile(t, true), alphaTest: 0.5 })) as THREE.SpriteMaterial;
  }

  // ------------------------------------------------------------ scene

  /** Rebuilds the cells around the party; `tween` animates the camera from its current pose. */
  update(st: DungeonViewState, tween: boolean) {
    this.build(st);
    const yaw = this.yawFor(st.dir);
    const fx = DIR_DX[st.dir], fz = DIR_DY[st.dir];
    const x = st.ux + 0.5 - fx * CAM_BACK, z = st.uy + 0.5 - fz * CAM_BACK;
    const now = performance.now();
    if (tween && this.t0 && this.to.x === x && this.to.z === z && this.to.yaw === yaw) {
      // same target: keep the running tween
    } else if (tween) {
      const cur = this.pose(now);
      this.from = cur;
      this.to = { x, z, yaw };
      this.t0 = now;
    } else {
      this.from = this.to = { x, z, yaw };
      this.t0 = 0;
    }
    this.frame(now);
  }

  /** Continuous yaw so that turning always takes the short way round. */
  private yawFor(dir: number): number {
    const target = (1 - dir) * (Math.PI / 2);
    let d = target - this.yawTarget;
    d = ((d % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    this.yawTarget += d;
    return this.yawTarget;
  }

  private pose(now: number) {
    const k = this.t0 ? Math.min(1, (now - this.t0) / TWEEN_MS) : 1;
    const e = k * (2 - k);
    return {
      x: this.from.x + (this.to.x - this.from.x) * e,
      z: this.from.z + (this.to.z - this.from.z) * e,
      yaw: this.from.yaw + (this.to.yaw - this.from.yaw) * e,
    };
  }

  /** Per-frame update: camera tween, monster animation, scrolling field tiles. */
  frame(now: number) {
    const p = this.pose(now);
    this.camera.position.set(p.x, 0.5, p.z);
    this.camera.rotation.set(0, p.yaw, 0);
    this.placeSprites(p.x, p.z, p.yaw);
    const f = Math.floor(now / 250);
    for (const m of this.monsters) m.sprite.material = this.spriteMat(m.base + ((f + m.phase) & 3));
    if (now - this.lastScroll > 120) {
      this.lastScroll = now;
      // Renderer.animateTiles scrolls the indexed pixels of these tiles; mirror them.
      for (const t of SCROLL_TILES)
        for (const tb of [false, true]) {
          const tex = this.tileTex.get(`${t}:${tb}`);
          if (tex) { const px = this.assets.tiles[t].pixels; this.fillTexture(tex, (x, y) => px[y * 16 + x], tb); }
        }
    }
  }

  private placeSprites(camX: number, camZ: number, yaw: number) {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const k = Math.tan((FOV / 2) * Math.PI / 180); // half view height per unit of depth
    const lerp = (t: number[], d: number) => {
      const i = Math.max(0, Math.min(t.length - 2, Math.floor(d)));
      const u = Math.max(0, Math.min(1, d - i));
      return t[i] + (t[i + 1] - t[i]) * u;
    };
    for (const s of this.sprites) {
      const z = (s.position.x - camX) * fx + (s.position.z - camZ) * fz;
      if (z <= 0.05) { s.visible = false; continue; }
      s.visible = true;
      const d = Math.max(0, z - CAM_BACK);
      const size = (lerp(SPRITE_PX, d) / 88) * z * k;
      s.scale.set(size, size, 1);
      s.position.y = 0.5 - (lerp(SPRITE_DROP, d) / 88) * z * k;
    }
  }

  private build(st: DungeonViewState) {
    this.world.clear();
    this.monsters = [];
    this.sprites = [];
    this.world.visible = st.lit;
    if (!st.lit) return;
    const solid = (c: number) => c >= 0xe0; // secret doors look like walls (FUN_1000_b4df)
    for (let wy = st.uy - RADIUS; wy <= st.uy + RADIUS; wy++)
      for (let wx = st.ux - RADIUS; wx <= st.ux + RADIUS; wx++) {
        const c = st.cellAt(wx & 7, wy & 7);
        const type = c & 0xf0;
        if (solid(c)) {
          for (let d = 0; d < 4; d++) {
            const n = st.cellAt((wx + DIR_DX[d]) & 7, (wy + DIR_DY[d]) & 7);
            if (!solid(n)) this.face(wx, wy, d, this.wallMat(d === 0 || d === 2));
          }
          continue;
        }
        if (type === 0xc0 || type === 0xd0) {
          for (let d = 0; d < 4; d++) {
            const n = st.cellAt((wx + DIR_DX[d]) & 7, (wy + DIR_DY[d]) & 7);
            if (!solid(n)) this.face(wx, wy, d, this.doorMat(d === 0 || d === 2));
          }
          continue;
        }
        const cx = wx + 0.5, cz = wy + 0.5;
        if (type === 0xa0) {
          const box = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.98, 0.98), this.fieldMat(0x44 + (c & 3)));
          box.position.set(cx, 0.5, cz);
          this.world.add(box);
          continue;
        }
        if (type === 0x10 || type === 0x30) this.ladder(cx, cz, 0.5, 1, true);
        if (type === 0x20 || type === 0x30) this.ladder(cx, cz, 0, 0.5, false);
        if (type === 0x50) this.hole(cx, cz, true);
        if (type === 0x60) this.hole(cx, cz, false);
        // Objects and monsters (FUN_1000_ab08): chest, orb, fountain (shallow water), altar.
        const mon = monsterInCell(c);
        if (mon) {
          const s = this.sprite(cx, cz, mon);
          this.monsters.push({ sprite: s, base: mon, phase: (wx * 3 + wy) & 3 });
        } else if (type === 0x40) this.sprite(cx, cz, 0x3c);
        else if (type === 0x70) this.sprite(cx, cz, 0x4e);
        else if (type === 0x90) this.sprite(cx, cz, 0x02);
        else if (type === 0xb0) this.sprite(cx, cz, 0x4a);
      }
  }

  /** A face on side `d` of cell (wx, wy), facing out of the cell. */
  private face(wx: number, wy: number, d: number, m: THREE.Material) {
    const mesh = new THREE.Mesh(this.plane, m);
    const cx = wx + 0.5, cz = wy + 0.5;
    mesh.position.set(cx + DIR_DX[d] * 0.5, 0.5, cz + DIR_DY[d] * 0.5);
    // PlaneGeometry faces +z; rotate its normal to point along (dx, dy).
    mesh.rotation.y = Math.atan2(DIR_DX[d], DIR_DY[d]);
    this.world.add(mesh);
  }

  private ladder(cx: number, cz: number, y0: number, y1: number, ceilingHole: boolean) {
    const h = y1 - y0;
    const m = this.cyanMat();
    for (const sx of [-0.09, 0.09]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.015, h, 0.015), m);
      rail.position.set(cx + sx, y0 + h / 2, cz);
      this.world.add(rail);
    }
    for (let y = y0 + 0.06; y < y1; y += 0.12) {
      const rung = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.012, 0.012), m);
      rung.position.set(cx, y, cz);
      this.world.add(rung);
    }
    this.hole(cx, cz, ceilingHole);
  }

  private hole(cx: number, cz: number, ceiling: boolean) {
    const mesh = new THREE.Mesh(this.plane, this.holeMat());
    mesh.scale.set(0.4, 0.4, 1);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(cx, ceiling ? 0.999 : 0.001, cz);
    this.world.add(mesh);
  }

  private sprite(cx: number, cz: number, t: number): THREE.Sprite {
    const s = new THREE.Sprite(this.spriteMat(t));
    s.position.set(cx, 0.25, cz);
    this.sprites.push(s);
    this.world.add(s);
    return s;
  }

  dispose() {
    this.world.traverse((o) => { if (o instanceof THREE.Mesh && o.geometry !== this.plane) o.geometry.dispose(); });
    this.world.clear();
    this.plane.dispose();
    for (const m of this.mats.values()) m.dispose();
    for (const t of this.tileTex.values()) t.dispose();
    for (const m of this.mats.values()) (m as THREE.MeshBasicMaterial).map?.dispose();
  }
}
