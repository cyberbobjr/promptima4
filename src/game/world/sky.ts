// Moons, moongates and wind (1000:3A80, 1000:35C7, 1000:2A91).
import type { SaveGame } from "../../formats/save";
import { MOON_RULES, MOONGATES, WIND_RULES } from "../../data/tables";
import { rand8 } from "../rng";
import { T } from "../tiles";
import type { Game } from "../game";
import { playEffect, SFX } from "../../audio/speaker";

export class Sky {
  private moonSub = 0;
  private trammelByte = -1;
  private feluccaByte = 0;
  private moonDelay = 0;
  /** 0 West, 1 North, 2 East, 3 South (DS:96F2) */
  wind = 1;

  /** One 250 ms tick of the moon phases and the wind. */
  tick(s: SaveGame | undefined) {
    if (!s) return;
    if (this.trammelByte < 0) { this.trammelByte = s.trammelPhase << 5; this.feluccaByte = s.feluccaPhase << 5; }
    if (++this.moonDelay < 2) return; // the original's rate depends on CPU calibration; ~2 ticks of 250 ms
    this.moonDelay = 0;
    this.moonSub = (this.moonSub + MOON_RULES.subStepAdd) & 0xff;
    if (this.moonSub === 0) {
      this.trammelByte = (this.trammelByte + MOON_RULES.trammelAdd) & 0xff;
      this.feluccaByte = (this.feluccaByte + MOON_RULES.feluccaAdd) & 0xff;
      s.trammelPhase = this.trammelByte >> MOON_RULES.phaseShift;
      s.feluccaPhase = this.feluccaByte >> MOON_RULES.phaseShift;
    }
    if ((rand8() & WIND_RULES.changeChanceMask) === 0) this.wind = (this.wind + (rand8() & 2) - 1) & 3;
  }

  /** Tile of the open moongate at (x,y), or -1. Gate = MOONGATES[trammel phase]. */
  moongateTile(s: SaveGame, x: number, y: number): number {
    const g = MOONGATES[s.trammelPhase];
    if (!g || g.x !== (x & 255) || g.y !== (y & 255)) return -1;
    const low = this.trammelByte & 0x1f, step = this.moonSub >> 6;
    if (low === 0) return T.MOONGATE0 + step;             // opening
    if (low === 0x1e) return T.MOONGATE0 + (step ^ 3);    // closing
    return T.MOONGATE3;
  }
}

/** Stepping into the open gate sends the party to the gate of Felucca's phase (1000:2A91). */
export async function checkMoongate(g: Game) {
  if (g.map.kind !== "world" || g.sky.moongateTile(g.save, g.px, g.py) !== T.MOONGATE3) return;
  // the screen flashes with the magic sound (pulse width 0xA0) as the party steps in, and again at arrival
  await playEffect(SFX.MAGIC, 0xa0);
  if (g.save.trammelPhase === 4 && g.save.feluccaPhase === 4) {
    // both moons full: the gate leads to the Shrine of Spirituality (1000:2A91)
    g.pendingShrine = 6;
    return;
  }
  const dest = MOONGATES[g.save.feluccaPhase];
  g.setPos(dest.x, dest.y);
  await playEffect(SFX.MAGIC, 0xa0);
}
