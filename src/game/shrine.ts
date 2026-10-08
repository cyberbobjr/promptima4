// Shrines and meditation: 1000:E72C (meditation), 1000:E6DF (vision picture).
import { assets } from "../assets/store";
import { MANTRAS, MEDITATION, SHRINE_VISIONS, SHRINES } from "../data/tables";
import type { Game } from "./game";
import { VIRTUES } from "./locations";
import { addDrawHook, blankView, loadPicture, PixelLayer, showTiles } from "./endgame/ui";
import { askKey, flushKeys, sameText, ticks } from "./prompts";
import { MSG_MAGIC as M } from "./texts/magic";
import { playEffect, SFX } from "../audio/speaker";
import { inverted, VIEWPORT_RECT } from "../ui/invert";

const SPIRITUALITY = 6;

async function meditate(g: Game, virtue: number) {
  const s = g.save, say = (t: string) => g.con.print(t);
  if (!(s.runes & (1 << virtue))) {
    say(M.noRune);
    return;
  }
  // SHRINE.CON: the first 121 bytes are the 11x11 view shown while in the shrine (mode 7)
  const restoreView = showTiles(g, await assets.shrineMap());
  try {
    say(M.enterShrine);
    const subject = await g.getLine(15);
    say(M.howMany);
    const k = await askKey(g, M.cycles, "0", "3");
    if (k < 0) return;
    const cycles = k - 0x30;
    if (cycles === 0 || !sameText(subject, VIRTUES[virtue], 16)) {
      say(M.unableFocus);
      return;
    }
    // one meditation (or Hawkwind visit) per 100 moves, DS:932E
    const period = Math.floor(s.moves / MEDITATION.cooldownMoves) & 0xffff;
    if (period === s.lastMeditation) { say(M.mindWeary); return; }
    s.lastMeditation = period;
    say(M.beginMeditation);
    for (let c = 0; c < cycles; c++) {
      for (let d = 0; d < 16; d++) { await ticks(1); say("."); }
      flushKeys(g);
      say(M.mantra);
      const mantra = await g.getLine(15);
      if (!sameText(mantra, MANTRAS[virtue], 16)) {
        say(M.badMantra);
        g.karmaDec(SPIRITUALITY, 3);
        return;
      }
    }
    if (cycles === MEDITATION.maxCycles && s.karma[virtue] === MEDITATION.elevationKarma) {
      say(M.partialAvatarhood + VIRTUES[virtue]);
      await inverted(g, [VIEWPORT_RECT], () => playEffect(SFX.MAGIC, 0xff)); // between two viewport inverts (1000:E907, 1000:2241)
      g.con.println("");
      s.karma[virtue] = 0;
      flushKeys(g);
      await g.getKey();
      say(M.grantedVision);
      // 1000:E6DF: blank viewport, rune picture OR-ed over it, until a key is pressed
      const layer = new PixelLayer();
      layer.or(await loadPicture(SHRINES[virtue].visionPic.toUpperCase() + ".EGA"));
      const restoreBlank = blankView(g);
      const restoreDraw = addDrawHook(g, (r) => layer.draw(r));
      try {
        flushKeys(g);
        await g.getKey();
      } finally {
        restoreDraw();
        restoreBlank();
      }
    } else {
      say(M.thoughtsPure);
      g.karmaInc(SPIRITUALITY, MEDITATION.spiritualityPerCycle * cycles);
      flushKeys(g);
      await g.getKey();
      g.con.println("");
      say(SHRINE_VISIONS[virtue][cycles - 1]);
      await g.getKey();
      g.con.println("");
    }
  } finally {
    restoreView();
  }
}

/** Entering a shrine (E)nter on its tile, or the moongate to Spirituality). */
export async function meditateAt(g: Game, virtue: number) {
  g.save.location = 25 + virtue; // DS:9338 while inside
  try {
    await meditate(g, virtue);
  } finally {
    g.save.location = 0;
  }
  g.endTurn();
}
