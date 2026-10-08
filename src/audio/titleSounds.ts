// PC-speaker sounds of the title program (TITLE.EXE). See docs/RE_NOTES.md "TITLE.EXE sounds".
//
// TITLE.EXE touches port 0x61 in four routines only and never programs the PIT:
//  - 1000:21BF, the "refused key" buzz: the same code as AVATAR.EXE's effect 1 (16 half-periods of
//    0xCA*K passes of DEC/PUSHF/PUSH/POP/POPF/JNZ, K = DS:692E calibrated like AVATAR's DS:8728), so it
//    is played as speaker.ts's SFX.ERROR;
//  - 1000:160D / 173F / 1826, the dissolve blits (driver slot 0x0B, one per video mode; 173F is the EGA
//    one): for every 8-pixel group that is not black, the routine draws a byte r from its own generator
//    (DS:03CC/03CD) and flips the speaker when r + step carries, so the crackle gets denser as the
//    picture fills in. The toggles are paced by the drawing itself (uncalibrated); here each pass is
//    spread over the port's step time with the 8088 cycle cost of each group.
import { SFX, playEffect, playSpans, speakerReady, type Spans } from "./speaker";

/** 1000:21BF: wrong key at the title menu, the name prompt (line input) and the sex prompt. */
export const titleBuzz = (): Promise<void> => playEffect(SFX.ERROR);

// ------------------------------------------------------------------ dissolve (1000:173F)

/** Initial bytes of the dissolve generator: DS:03CC (low) and DS:03CD (high). */
export const DISSOLVE_SEED = { lo: 0x35, hi: 0x9b } as const;

/**
 * The generator of the dissolve routines (1000:1796..17AF): dl = [3CC] + 1Dh, dh = dl,
 * dl = dl + [3CD] + carry, [3CC] = dl, [3CD] = dh; returns dl. Its low 3 bits also pick the mask.
 */
export class DissolveRng {
  lo: number; hi: number;
  constructor(lo: number = DISSOLVE_SEED.lo, hi: number = DISSOLVE_SEED.hi) { this.lo = lo; this.hi = hi; }
  next(): number {
    const a = this.lo + 0x1d;
    const a8 = a & 0xff;
    const b = (a8 + this.hi + (a > 0xff ? 1 : 0)) & 0xff;
    this.lo = b;
    this.hi = a8;
    return b;
  }
}

/** 8088 cycles of 1000:173F (estimated from the instruction timings; only their ratios are used). */
export const DISSOLVE_CYCLES = {
  /** a black group: 4 plane reads, TEST, JE, INC/INC/DEC, JE, JMP */
  empty: 112,
  /** a drawn group without toggle: the generator, the mask lookup and 4 plane writes */
  drawn: 503,
  /** a drawn group with the PUSH/IN/XOR/OUT/POP of the toggle */
  drawnToggle: 542,
  /** offset of the OUT 61h inside a drawn group */
  toggleAt: 230,
  /** per line: the two row-table lookups, the counters */
  row: 270,
} as const;

/**
 * Speaker toggles of one pass of the dissolve 1000:173F over a w x h rectangle (w in 8-pixel
 * columns) of `src` (320x200 indexed pixels) at (sx*8, sy), for `step` (0..0x38), lasting `stepUs`.
 * Lines are processed from the bottom one up, groups left to right, as the original does. The
 * speaker starts off (state read at entry) and is restored at the end. Returns the spans with
 * the speaker off first; their total is exactly `stepUs`.
 */
export function dissolveSpans(src: Uint8Array, w: number, h: number, sx: number, sy: number, step: number,
  rng: DissolveRng, stepUs: number): Spans {
  const C = DISSOLVE_CYCLES;
  const toggles: number[] = [];
  let t = 0;
  for (let j = h - 1; j >= 0; j--) {
    t += C.row;
    const row = (sy + j) * 320;
    for (let c = 0; c < w; c++) {
      const s = row + (sx + c) * 8;
      let any = 0;
      for (let b = 0; b < 8; b++) any |= src[s + b] ?? 0;
      if (!any) { t += C.empty; continue; }
      const r = rng.next();
      if (r + (step & 0xff) > 0xff) { toggles.push(t + C.toggleAt); t += C.drawnToggle; } else t += C.drawn;
    }
  }
  const scale = t > 0 ? stepUs / t : 0;
  const spans: Spans = [];
  let prev = 0;
  for (const x of toggles) { spans.push((x - prev) * scale); prev = x; }
  spans.push((t - prev) * scale);
  return spans;
}

/** The generator keeps running from one dissolve pass to the next, as DS:03CC/03CD do. */
const dissolveRng = new DissolveRng();

/**
 * One pass of the title dissolve (FUN_1000_068c calls slot 0x0B for steps 0..0x38): plays its
 * crackle without waiting (the original makes it while drawing), queued after the previous pass.
 * The generator only advances when the sound is heard, so it never touches the game's random stream.
 */
export function playDissolve(src: Uint8Array, w: number, h: number, sx: number, sy: number, step: number, stepMs: number): void {
  if (!speakerReady()) return;
  void playSpans(() => dissolveSpans(src, w, h, sx, sy, step, dissolveRng, stepMs * 1000));
}
