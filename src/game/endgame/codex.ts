// The Chamber of the Codex (1000:31F4) and the ending (1000:3025), reached by using the Black stone on the
// altar of the 8th Abyss level. Failures eject the party to the overworld (1000:2F9D, positions DS:0BF0/0BFE).
import { CODEX_EJECT_POSITIONS, CODEX_FINAL_ANSWER, CODEX_QUESTIONS, CODEX_WORD_OF_PASSAGE } from "../../data/tables";
import type { Game } from "../game";
import { addDrawHook, blankView, loadPicture, PixelLayer, shake } from "./ui";
import { flushKeys, pauseUnits as pause, sameText, ticks } from "../prompts";
import { MSG_MAGIC as M } from "../texts/magic";
import { withScene } from "../../audio/music";

/** Thrown to unwind the codex after an ejection (the original longjmps back to the main loop). */
class Ejected extends Error {}

class Codex {
  private readonly layer = new PixelLayer();
  private restoreDraw: (() => void) | null = null;
  private restoreView: (() => void) | null = null;
  private partySize: number;

  constructor(private readonly g: Game) { this.partySize = g.save.members; }

  private say(s: string) { this.g.con.print(s); }

  /** FUN_1000_227B: picture OR-ed over the screen. */
  private async picture(name: string) { this.layer.or(await loadPicture(name)); }

  /** 1000:2F9D: back to the overworld at position i, party size restored. */
  private async eject(i: number): Promise<never> {
    const g = this.g, s = g.save, pos = CODEX_EJECT_POSITIONS[i];
    await ticks(5);
    s.members = this.partySize;
    s.dngX = pos.x; s.dngY = pos.y;
    s.balloonState = 0;
    g.spellEffect = null;
    this.cleanup();
    if (g.dungeon.exit) g.dungeon.exit();
    else { s.location = 0; g.setPos(pos.x, pos.y); }
    flushKeys(g);
    throw new Ejected();
  }

  private cleanup() {
    this.restoreDraw?.(); this.restoreDraw = null;
    this.restoreView?.(); this.restoreView = null;
  }

  /** 1000:310F: three tries. */
  private async ask(answer: string, question: string): Promise<boolean> {
    for (let k = 0; k < 3; k++) {
      if (k > 0) { await ticks(1); this.say(M.notPure); await ticks(2); }
      this.say(question + "\n");
      const typed = await this.g.getLine(15);
      if (sameText(typed, answer, 16)) return true;
    }
    return false;
  }

  private async passageNotGranted(): Promise<never> { // 1000:3010
    this.say(M.passageNotGranted);
    return this.eject(12);
  }

  async run() {
    const g = this.g, s = g.save;
    s.members = 1;
    this.restoreView = blankView(g);
    this.restoreDraw = addDrawHook(g, (r) => this.layer.draw(r), { wide: true });
    this.say(M.suddenDarkness);
    await ticks(4);
    await this.picture("KEY7.EGA");
    if ((s.items & 0xe0) !== 0xe0) {
      this.say(M.noKey);
      await this.eject(12);
    }
    this.say(M.useKey);
    await ticks(3);
    this.say(M.voiceRingsOut);
    if (!(await this.ask(CODEX_WORD_OF_PASSAGE, M.wordOfPassage))) await this.passageNotGranted();
    if (this.partySize !== 8) {
      this.say(M.notLeader);
      await ticks(8);
      await this.passageNotGranted();
    }
    if (s.karma.some((k) => k !== 0)) { this.say(M.notReady); await this.passageNotGranted(); }
    this.say(M.passageGranted);
    await ticks(5);
    this.layer.clear();
    const pics = ["HONESTY", "COMPASSN", "VALOR", "JUSTICE", "SACRIFIC", "HONOR", "SPIRIT", "HUMILITY", "TRUTH", "LOVE", "COURAGE"]; // DS:1620/161A
    for (let i = 0; i < 11; i++) {
      await ticks(2);
      this.say(M.voiceAsks);
      await ticks(2);
      const q = CODEX_QUESTIONS[i];
      if (!(await this.ask(q.answer, q.question))) {
        await ticks(1);
        this.say(M.questIncomplete);
        await this.eject(i);
      }
      await this.picture(pics[i] + ".EGA");
      if (i === 7) {
        await ticks(3);
        this.say(M.wellVersed);
        await ticks(5);
      }
    }
    this.say(M.floorRumbles);
    await shake(g); await shake(g);
    await ticks(5);
    this.say(M.aboveTheDin);
    await pause(g);
    this.say(M.finalQuestion);
    let ok = false;
    for (let k = 0; k < 3 && !ok; k++) {
      // the retries print their own copies (DS:1484/14AE, DS:1534/155E)
      if (k > 0) { this.say(k === 1 ? M.notPure2 : M.notPure3); await ticks(3); this.say(k === 1 ? M.finalQuestion2 : M.finalQuestion3); }
      ok = sameText(await g.getLine(15), CODEX_FINAL_ANSWER, 16);
    }
    if (!ok) {
      await ticks(1);
      this.say(M.trueNature);
      await this.eject(11);
    }
    await this.ending();
  }

  /** 1000:3025: the game ends here (the original loops forever). */
  private async ending(): Promise<never> {
    const g = this.g;
    await ticks(2);
    for (let k = 0; k < 4; k++) await shake(g);
    await ticks(3);
    // the codex picture gives way to the rune of infinity (EGA.DRV entry 0x22 with RUNE_5, DS:08B8/08C3)
    this.layer.clear();
    await this.picture("RUNE_5.EGA");
    await ticks(3);
    const texts = [M.ending, M.proven, M.endlessQuest, M.livingGift, M.stray, M.returnNow];
    for (const t of texts) { this.say(t); await pause(g); }
    this.layer.clear();
    this.say(M.trailsOff);
    await pause(g);
    await this.picture("STONCRCL.EGA");
    for (const t of [M.circle, M.distant, M.walkAway]) { this.say(t); await pause(g); }
    this.say(M.congratulations + g.save.moves + M.turnsReport);
    g.con.cursor = false;
    return new Promise<never>(() => { /* the end */ });
  }
}

/** Use of the Black stone at the last Abyss altar (1000:0311 -> 1000:31F4). Returns after an ejection. */
export async function runCodex(g: Game) {
  const codex = new Codex(g);
  try {
    await withScene("ending", () => codex.run());
  } catch (e) {
    if (!(e instanceof Ejected)) throw e;
  }
}
