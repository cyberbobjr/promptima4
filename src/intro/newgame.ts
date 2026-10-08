// "Initiate New Game" of TITLE.EXE: name and sex (FUN_1000_3030), the story (FUN_1000_2883),
// the gypsy's casting (FUN_1000_2c12) and the new PARTY.SAV (FUN_1000_2e04).
import { random } from "../game/rng";
import type { SaveGame } from "../formats/save";
import { assets } from "../assets/store";
import type { TitleData } from "./data";
import { TITLE } from "./texts";
import { Abort, Keys, Screen } from "./screen";
import { titleBuzz } from "../audio/titleSounds";

const pics = new Map<string, Uint8Array>();
async function picture(name: string): Promise<Uint8Array> {
  const key = name.toUpperCase();
  let p = pics.get(key);
  if (!p) { p = (await assets.screen(key)).pixels; pics.set(key, p); }
  return p;
}

const rnd8 = () => Math.floor(random() * 8);
const isEsc = (k: { key: string }) => k.key === "Escape";

export class NewGame {
  /** `leaveTitle` stops the title animations (FUN_1000_3030 clears DS:6E80 before the story). */
  constructor(private readonly scr: Screen, private readonly keys: Keys, private readonly d: TitleData,
    private readonly leaveTitle: () => void) {}

  /** Returns the new save, or null when the player backs out (empty name, Escape...). */
  async run(): Promise<SaveGame | null> {
    try {
      const who = await this.askName();
      if (!who) return null;
      this.leaveTitle();
      await this.story();
      const result = await this.casting();
      return await this.buildSave(who.name, who.sex, result);
    } catch (e) {
      if (e instanceof Abort) return null;
      throw e;
    }
  }

  private async key(): Promise<string> {
    const k = await this.keys.get();
    if (isEsc(k)) throw new Abort();
    return k.key;
  }

  /** FUN_1000_3030 + FUN_1000_2656 (line input: 11 characters, leading/trailing blanks removed). */
  private async askName(): Promise<{ name: string; sex: "M" | "F" } | null> {
    const s = this.scr;
    s.clearBox();
    s.printAt(TITLE.namePrompt1, 4, 0x10);
    s.printAt(TITLE.namePrompt2, 4, 0x11);
    s.col = 0xc; s.row = 0x13;
    let buf = "";
    for (;;) {
      const k = await this.keys.get();
      if (isEsc(k)) return null; // the original only beeps here
      if (k.key === "Enter") break;
      if (k.key === "Backspace" || k.key === "ArrowLeft") {
        if (buf) { s.putc("\b"); buf = buf.slice(0, -1); } else await titleBuzz(); // 1000:2696: nothing to erase
        continue;
      }
      if (k.key.length === 1 && k.key >= " " && k.key < "\x7f" && buf.length < 0xc - 1) { buf += k.key; s.putc(k.key); }
      else await titleBuzz(); // FUN_1000_2656: buffer full or not a character (1000:21BF)
    }
    const name = buf.trim();
    if (!name) return null;
    s.clearBox();
    s.printAt(TITLE.sexPrompt, 4, 0x11);
    for (;;) {
      const k = await this.keys.get();
      const c = k.key.toUpperCase();
      if (c === "M" || c === "F") { s.putc(c); return { name, sex: c }; }
      if (isEsc(k) || k.key === "Enter" || k.key === " ") return null;
      await titleBuzz(); // FUN_1000_3030: neither M nor F (1000:21BF)
    }
  }

  /** FUN_1000_2883: story pages 0x1D..0x34 of the text table with their pictures and animations. */
  private async story() {
    const s = this.scr;
    // picture file names (EGA variants) used by the jump table at 1000:2AED
    const pic = [TITLE.pic0, TITLE.pic1, TITLE.pic2, TITLE.pic3, TITLE.pic4, TITLE.pic5, TITLE.pic6, TITLE.pic7];
    let buf = await picture(pic[0]); // tree
    s.clear();
    s.blit(buf, 0x28, 0x98, 0, 0, 0, 0);
    const show = async (next: string) => { s.blit(buf, 0x28, 0x98, 0, 0, 0, 0); buf = await picture(next); };
    for (let p = 0x1d; p < 0x35; p++) {
      s.clearText();
      s.print(TITLE.pages[p]);
      switch (p) {
        case 0x20: await this.portalRise(buf); break;
        case 0x22: await this.portalSink(buf); buf = await picture(pic[1]); break; // portal
        case 0x23: await show(pic[2]); break; // shows portal, loads tree
        case 0x28: await show(pic[3]); break; // tree -> outside
        case 0x2c: await show(pic[4]); break; // outside -> inside
        case 0x2e: await show(pic[5]); break; // inside -> wagon
        case 0x31: await show(pic[6]); break; // wagon -> gypsy
        case 0x32: await show(pic[7]); break; // gypsy -> abacus
        case 0x34: s.blit(buf, 0x28, 0x98, 0, 0, 0, 0); break;
      }
      this.keys.flush();
      await this.key();
    }
    this.abacus = buf;
  }
  private abacus!: Uint8Array;

  /** FUN_1000_273e: the moongate rises (sprite below the scene in TREE.EGA). */
  private async portalRise(t: Uint8Array) {
    for (let u = 1; u < 0x18; u++) {
      this.scr.blit(t, 3, u, 0, 0x98, 0x5c - u, 9);
      this.scr.blit(t, 3, 0x18 - u, 9, 0x44, 0x44, 9);
      await this.keys.delay(40);
    }
    this.scr.blit(t, 3, 0x18, 0, 0x98, 0x44, 9);
  }

  /** FUN_1000_27e0: the moongate sinks into the ground. */
  private async portalSink(t: Uint8Array) {
    for (let u = 1; u < 0x18; u++) {
      this.scr.blit(t, 3, u, 3, 0x98, 0x44, 9);
      this.scr.blit(t, 3, 0x18 - u, 0, 0x98, u + 0x44, 9);
      await this.keys.delay(40);
    }
    this.scr.blit(t, 3, 0x18, 3, 0x98, 0x44, 9);
  }

  /** FUN_1000_2b6d: one card from the pair picture (HONCOM, VALJUS, SACHONOR, SPIRHUM). */
  private async card(side: 0 | 1, v: number) {
    const file = TITLE.cardPics[v >> 1];
    const pic = await picture(file);
    this.scr.blit(pic, 0xc, 0x7c, v & 1 ? 0x1b : 1, 0xc, 0xc, side ? 0x1b : 1);
  }

  /** FUN_1000_2b2a: bead on the abacus (column = virtue, row = round). */
  private bead(round: number, v: number, won: boolean) {
    this.scr.blit(this.abacus, 1, 0xc, won ? 1 : 3, 0xbb, this.d.beadY[round], v + 0x10);
  }

  /** FUN_1000_2c12: seven dilemmas between random pairs of cards, winners meet again (4, 2, 1). */
  private async casting() {
    const s = this.scr, d = this.d;
    const names = TITLE.virtueNames;
    const qBase = d.questionBase;
    const bonus = [d.strBonus, d.dexBonus, d.intBonus];
    const stats = [15, 15, 15]; // str, dex, int
    const karma = new Array(8).fill(50);
    const mark = new Uint8Array(8); // 0 free, 1 winner, 0xFF eliminated
    let last = 0;
    for (let round = 0; round < 7; round++) {
      if (round === 4 || round === 6) for (let v = 0; v < 8; v++) if (mark[v] < 0x80) mark[v] = 0;
      s.clearText();
      let a: number, b: number;
      do a = rnd8(); while (mark[a]);
      do b = rnd8(); while (mark[b] || b === a);
      if (b < a) [a, b] = [b, a];
      s.print((round === 0 ? TITLE.placeFirst : round === 6 ? TITLE.placeLast : TITLE.placeMore)[0]);
      s.print(TITLE.upon[0]);
      await this.card(0, a);
      s.print(names[a]);
      s.print(TITLE.and);
      await this.card(1, b);
      s.print(names[b]);
      s.print(TITLE.consider);
      this.keys.flush();
      await this.key();
      s.clearText();
      s.print(TITLE.pages[qBase[a] + b]);
      for (;;) {
        const c = (await this.key()).toLowerCase();
        if (c === "a") break;
        if (c === "b") { [a, b] = [b, a]; break; }
      }
      last = a;
      mark[a] = 1;
      karma[a] += 5;
      for (let i = 0; i < 3; i++) stats[i] += bonus[i][a];
      this.bead(round, a, true);
      mark[b] = 0xff;
      this.bead(round, b, false);
    }
    for (const text of TITLE.finalTexts) { // FUN_1000_271d
      s.clearText();
      s.print(text);
      await this.key();
    }
    return { virtue: last, karma, str: stats[0], dex: stats[1], int: stats[2] };
  }

  /** FUN_1000_2e04: PARTY.NEW with the avatar swapped into slot 0 (class = final virtue). */
  private async buildSave(name: string, sex: "M" | "F", r: { virtue: number; karma: number[]; str: number; dex: number; int: number }): Promise<SaveGame> {
    const d = this.d, cls = r.virtue;
    const save = await assets.newParty();
    save.x = d.startX[cls];
    save.y = d.startY[cls];
    save.members = 1;
    save.karma = r.karma;
    [save.players[0], save.players[cls]] = [save.players[cls], save.players[0]];
    const p = save.players[0];
    // strcpy into the 16-byte name field: bytes after the terminator keep the template's content
    for (let i = 0; i <= name.length; i++) p.nameBuf[i] = i < name.length ? name.charCodeAt(i) : 0;
    p.name = name;
    p.str = r.str; p.dex = r.dex; p.int = r.int;
    p.sex = sex === "M" ? 0x0b : 0x0c;
    return save;
  }
}
