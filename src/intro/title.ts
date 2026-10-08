// Title screen of TITLE.EXE: opening animation (FUN_1000_068c), static redraw (FUN_1000_0bca),
// the animated map vignette in the box (FUN_1000_034d/041a/05a4), the two creatures in the top
// corners (FUN_1000_019a) and the menu (FUN_1000_0b45 / main loop in FUN_1000_0eaa).
import { random } from "../game/rng";
import { assets } from "../assets/store";
import { MENU_POS, type TitleData } from "./data";
import { TITLE } from "./texts";
import { Keys, Screen } from "./screen";
import { playDissolve, titleBuzz } from "../audio/titleSounds";

const MAP_W = 19, MAP_H = 5, MAP_Y = 0x68;
/** Real-time pacing of the original's CPU-bound loops (not in the binary: tuned by eye). */
const CREATURE_MS = 130, MAP_STEP_MS = 110;
/** One pass of the dissolve (the original runs them back to back at CPU speed). */
const DISSOLVE_MS = 25;

export class Title {
  private title!: Uint8Array;
  private animate!: Uint8Array;
  // creatures (DS:0036 / DS:0038 frame counters)
  private creatures = false;
  private seqL = 0; private seqR = 0; private lastCreature = 0;
  // map vignette: objects DS:6D76 tile, 6D96 x, 6DB6 y, 6DD6 animation base; DS:00C4 script pc, 00C6 delay
  private mapOn = false;
  private lastStep = 0;
  private readonly objTile = new Uint8Array(32);
  private readonly objX = new Uint8Array(32);
  private readonly objY = new Uint8Array(32);
  private readonly objAnim = new Uint8Array(32);
  private pc = -1; private wait = 0;
  private readonly baseMap: Uint8Array;
  private readonly script: Uint8Array;
  private readonly objBase: Uint8Array;
  private readonly frame: Uint8Array;

  constructor(private readonly scr: Screen, private readonly keys: Keys, private readonly d: TitleData) {
    this.baseMap = Uint8Array.from(d.baseMap.slice(0, MAP_W * MAP_H));
    this.script = Uint8Array.from(d.script);
    this.objBase = Uint8Array.from(d.objBase);
    this.frame = this.baseMap.slice();
    scr.animators.push((now) => this.animateCreatures(now), (now) => this.animateMap(now));
  }

  async load() {
    this.title = (await assets.screen("TITLE.EGA")).pixels;
    this.animate = (await assets.screen("ANIMATE.EGA")).pixels;
  }

  // ------------------------------------------------------------------ creatures

  private drawCreatures(rise = 32) {
    const d = this.d, srcY = d.animSrcY;
    const l = d.seqL[this.seqL], r = d.seqR[this.seqR];
    this.scr.blit(this.animate, 6, rise, d.animSrcXL[l], srcY[l] + 32 - rise, 0, 0);
    this.scr.blit(this.animate, 6, rise, d.animSrcXR[r], srcY[r] + 32 - rise, 0, 0x22);
  }

  private stepCreatures() {
    this.seqL = (this.seqL + 1) & 0x7f;
    this.seqR = (this.seqR + 1) & 0x3f;
  }

  private animateCreatures(now: number) {
    if (!this.creatures || now - this.lastCreature < CREATURE_MS) return;
    this.lastCreature = now;
    this.drawCreatures();
    this.stepCreatures();
  }

  // ------------------------------------------------------------------ map vignette

  /** FUN_1000_034d: object tile animation (2 frames for people/sea, 4 for monsters). */
  private animObjects() {
    for (let o = 0; o < 32; o++) {
      const t = this.objAnim[o];
      const r = random() * 256;
      if ((t >= 0x84 && t <= 0x8e) || (t >= 0x20 && t <= 0x2e) || (t >= 0x50 && t <= 0x5e)) {
        if (r < 0xc0) this.objTile[o] = ((this.objTile[o] & 1) | t) ^ 1;
      } else if (t < 0x90) {
        if (t !== 0x80) this.objTile[o] = t;
      } else if (r < 0xc0) this.objTile[o] = ((this.objTile[o] + 1) & 3) | t;
    }
  }

  /** FUN_1000_041a: one step of the vignette script. */
  private runScript() {
    if (this.wait > 0) { this.wait--; return; }
    const s = this.script;
    for (let guard = 0; guard < 4096; guard++) {
      const b = s[++this.pc] ?? 0xff;
      const op = b & 0xf0, o = b & 0xf;
      if (op === 0x70) { this.objAnim[o] = 0; this.objTile[o] = 0; continue; }
      if (op <= 0x60) {
        const n = s[this.pc + 1];
        this.objY[o] = op >> 4;
        this.objX[o] = n & 0x1f;
        this.objTile[o] = ((n >> 5) + this.objBase[o]) & 0xff;
        this.objAnim[o] = o === 1 ? this.objBase[1] : this.objTile[o];
        this.pc++;
        continue;
      }
      if (op !== 0x80) { this.pc = -1; continue; }
      this.frame.set(this.baseMap);
      for (let k = 0; k < 32; k++) {
        const i = this.objX[k] + this.objY[k] * MAP_W;
        if (this.objTile[k] && i < this.frame.length) this.frame[i] = this.objTile[k];
      }
      this.wait = o;
      return;
    }
  }

  /** FUN_1000_1186 (EGA): 19x5 tiles drawn at (8,104). */
  private drawMap(map: Uint8Array) {
    for (let y = 0; y < MAP_H; y++)
      for (let x = 0; x < MAP_W; x++) this.scr.tile(map[y * MAP_W + x], 8 + x * 16, MAP_Y + y * 16);
  }

  private animateMap(now: number) {
    if (!this.mapOn) return;
    if (now - this.lastStep >= MAP_STEP_MS) {
      this.lastStep = now;
      this.animObjects();
      this.runScript();
    }
    this.drawMap(this.frame); // redrawn every frame so water/fields scroll
  }

  // ------------------------------------------------------------------ screens

  /** FUN_1000_02d1: the Lord British signature. */
  private signature(slow: boolean): Promise<void> | void {
    const pts = this.d.signature;
    const plot = (i: number) => {
      this.scr.plot(0xbf - pts[i + 1], pts[i] + 0x14, 3);
      this.scr.plot(0xbf - pts[i + 1], pts[i] + 0x15, 3);
    };
    if (!slow) { for (let i = 0; pts[i]; i += 2) plot(i); return; }
    return (async () => {
      for (let i = 0; pts[i]; i += 2) {
        plot(i);
        if (!this.keys.hit && i % 4 === 2) await this.keys.delay(15);
      }
      await this.keys.delay(1000);
    })();
  }

  /** FUN_1000_068c: the opening animation; any key skips to the final layout. */
  private async intro() {
    const s = this.scr, t = this.title, k = this.keys;
    s.clear();
    await k.delay(1000);
    await this.signature(true);
    s.blit(t, 4, 4, 0x13, 0x11, 0x11, 0x13);
    await k.delay(1000);
    for (let x = 0x56; x < 0xee; x++) { s.plot(0x1f, x, 2); if (!k.hit && x % 4 === 0) await k.delay(25); }
    for (let h = 1; h < 10; h++) { s.blit(t, 0x15, h, 9, 0x15, 0x1e - h, 9); if (!k.hit) await k.delay(60); }
    await k.delay(1000);
    if (!k.hit) {
      for (let h = 1; h < 6; h++) { s.blit(t, 0xf, h, 0xe, 5 - h, 0x21, 0xe); if (!k.hit) await k.delay(60); }
      await k.delay(1000);
      const masks = Uint8Array.from(this.d.dissolve);
      for (let u = 0; u < 0x39; u++) {
        const step = k.hit ? 0x38 : u;
        s.blitDissolve(t, 0x1e, 0x2d, 5, 0x22, 0x22, 5, step, masks);
        playDissolve(t, 0x1e, 0x2d, 5, 0x22, step, DISSOLVE_MS); // 1000:173F flips the speaker as it draws
        if (!k.hit) await k.delay(DISSOLVE_MS); else u = 0x38;
      }
      await k.delay(1000);
    } else {
      s.blit(t, 0x1e, 0x2d, 5, 0x22, 0x22, 5);
      s.blit(t, 0xf, 5, 0xe, 0, 0x21, 0xe);
    }
    for (let u = 1; u < 7; u++) {
      s.blit(t, 0x21, u, 3, 0x51, 0x56 - u, 3);
      s.blit(t, 0x21, u, 3, 0x5d - u, 0x56, 3);
      if (!k.hit) await k.delay(50);
    }
    // FUN_1000_160d draws the base vignette into the picture, then the box opens from the middle.
    const boxed = t.slice();
    const save = s.px.slice();
    this.drawMap(this.baseMap);
    for (let y = MAP_Y; y < MAP_Y + MAP_H * 16; y++) boxed.set(s.px.subarray(y * 320 + 8, y * 320 + 312), y * 320 + 8);
    s.px.set(save);
    for (let u = 1; u < 0x15; u++) {
      s.blit(boxed, u * 2, 0x60, 0x14 - u, 0x60, 0x60, 0x14 - u);
      if (!k.hit) await k.delay(30);
    }
    // the creatures slide in from the top while the vignette starts
    this.mapOn = true;
    for (let u = 1; u < 0x21; u++) {
      if (k.hit) u = 0x20;
      this.stepCreatures();
      this.drawCreatures(u);
      if (!k.hit) await k.delay(60);
    }
    this.creatures = true;
  }

  /** FUN_1000_0bca: final title layout (used after an aborted new game). */
  private drawStatic() {
    const s = this.scr, t = this.title;
    s.clear();
    this.signature(false);
    s.blit(t, 4, 4, 0x13, 0x11, 0x11, 0x13);
    for (let x = 0x56; x < 0xee; x++) s.plot(0x1f, x, 2);
    s.blit(t, 0x15, 9, 9, 0x15, 0x15, 9);
    s.blit(t, 0x1e, 0x2d, 5, 0x22, 0x22, 5);
    s.blit(t, 0xf, 5, 0xe, 0, 0x21, 0xe);
    s.blit(t, 0x21, 6, 3, 0x51, 0x50, 3);
    s.blit(t, 0x21, 6, 3, 0x57, 0x56, 3);
    s.blit(t, 0x28, 0x60, 0, 0x60, 0x60, 0);
    this.drawCreatures();
    this.creatures = true;
  }

  /** FUN_1000_0b45 */
  drawMenu() {
    const s = this.scr;
    s.clearBox();
    const lines = [TITLE.menu0, TITLE.menu1, TITLE.menu2, TITLE.menu3, TITLE.menu4, TITLE.menu5, TITLE.menu6];
    lines.forEach((line, i) => s.printAt(line, MENU_POS[i][0], MENU_POS[i][1]));
    s.col = 0x18; s.row = 0x10;
  }

  /**
   * Shows the title until Journey Onward or Initiate New Game is chosen.
   * "start": opening animation then the view; "redraw": full redraw then the menu (after an
   * aborted new game, as FUN_1000_0eaa calls FUN_1000_0bca); "menu": just the menu.
   */
  async run(mode: "start" | "redraw" | "menu"): Promise<"journey" | "new"> {
    if (mode === "start") await this.intro();
    else if (mode === "redraw") this.drawStatic();
    let view = mode === "start";
    for (;;) {
      if (view) {
        // FUN_1000_05a4: "Return to the view" — the vignette runs until a key is pressed
        this.mapOn = true;
        await this.keys.get(false);
        this.mapOn = false;
      }
      this.drawMenu();
      view = false;
      for (;;) {
        const k = await this.keys.get();
        const ch = k.key.length === 1 ? k.key.toLowerCase() : "";
        if (ch > " " && ch <= "~") this.scr.glyph(ch.charCodeAt(0));
        if (ch === "r") { view = true; break; }
        if (ch === "i") return "new";
        if (ch === "j") return "journey";
        await titleBuzz(); // FUN_1000_0eaa: any other key (1000:21BF)
      }
    }
  }

  stop() { this.mapOn = false; this.creatures = false; }

  /** Message in the menu box, then back to the menu. */
  async notice(lines: string[]) {
    const s = this.scr;
    s.clearBox();
    lines.forEach((l, i) => s.printAt(l, Math.max(1, (40 - l.length) >> 1), 16 + i));
    await this.keys.get();
  }
}
