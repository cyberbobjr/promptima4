import { describe, expect, it } from "vitest";
import {
  EFFECT_COUNT, REF_CPU_HZ, SFX, UNIT_US, effectSpans, playEffect, renderSpans, spanFrequencies, spansDuration,
} from "../src/audio/speaker";

/** A fixed byte sequence standing for 1000:1771. */
const seq = (...v: number[]) => { let i = 0; return () => v[i++ % v.length]; };
const ms = (us: number) => us / 1000;

describe("PC speaker timing model (1000:0012 calibration)", () => {
  it("one calibrated cycle is a timer tick over 232 cycles x 1000", () => {
    expect(UNIT_US).toBeCloseTo(54925.4 / 232000, 6);
  });
});

describe("effect table 1000:1D47 -> speaker toggles", () => {
  it("0: a single click of 50 uncalibrated 18-cycle passes", () => {
    const s = effectSpans(SFX.STEP);
    expect(s).toHaveLength(2);
    expect(s[0]).toBe(0);
    expect(s[1]).toBeCloseTo((50 * 18 * 1e6) / REF_CPU_HZ, 6);
  });

  it("1: 16 half-periods of 0xCA x 71 calibrated cycles (~147 Hz, ~54 ms)", () => {
    const s = effectSpans(SFX.ERROR);
    const half = 0xca * 71 * UNIT_US;
    expect(s).toHaveLength(16);
    for (const x of s) expect(x).toBeCloseTo(half, 6);
    expect(ms(spansDuration(s))).toBeCloseTo(16 * ms(half), 6);
    expect(spanFrequencies(s)[0]).toBeCloseTo(1e6 / (2 * half), 3);
    expect(Math.round(spanFrequencies(s)[0])).toBe(147);
  });

  it("2: 48 half-periods of 0xE0 x 18 cycles (~524 Hz), then effect 1", () => {
    const s = effectSpans(SFX.BAD_COMMAND);
    expect(spansDuration(s)).toBeCloseTo(48 * 0xe0 * 18 * UNIT_US + spansDuration(effectSpans(SFX.ERROR)), 6);
    expect(Math.round(spanFrequencies(s)[0])).toBe(524);
  });

  it("3, 5: falling sweeps; 8: rising sweep", () => {
    for (const [n, count] of [[SFX.CANNON, 251], [SFX.MONSTER_ATTACK, 128], [SFX.FLEE, 128]] as const) {
      const s = effectSpans(n);
      expect(s.length, `effect ${n}`).toBe(count);
      const f = spanFrequencies(s.slice(1));
      const falling = n !== SFX.FLEE;
      for (let i = 1; i < f.length; i++) expect(falling ? f[i] < f[i - 1] : f[i] > f[i - 1], `effect ${n} #${i}`).toBe(true);
    }
    // effect 3: half-period = bl * 12 calibrated cycles, bl = 5..255
    expect(spansDuration(effectSpans(SFX.CANNON))).toBeCloseTo(((5 + 255) * 251) / 2 * 12 * UNIT_US, 3);
  });

  it("4: the bl = 0 pass waits 65536 uncalibrated passes in silence, then a rising sweep 255..128", () => {
    const s = effectSpans(SFX.ATTACK);
    expect(s[0]).toBeCloseTo((65536 * 24 * 1e6) / REF_CPU_HZ, 3);
    expect(ms(s[0])).toBeCloseTo(329.5, 0);
    expect(s).toHaveLength(129);
    expect(s[1]).toBeCloseTo(255 * 12 * UNIT_US, 6);
    expect(s[128]).toBeCloseTo(128 * 12 * UNIT_US, 6);
  });

  it("6, 7: 255 random half-periods from the sound generator", () => {
    const six = effectSpans(SFX.HIT, 0, seq(0x00, 0x7f, 0x80));
    // r = (byte & 0x7F) | 1 -> 1, 127, 1, 1, 127...: wait 3r/4 x 17 cycles, then toggle (the first toggle leaves it off)
    expect(six[0]).toBeCloseTo((1 + 127) * 0.75 * 17 * UNIT_US, 6);
    expect(six[1]).toBeCloseTo(1 * 0.75 * 17 * UNIT_US, 6);
    expect(six[3]).toBeCloseTo(127 * 0.75 * 17 * UNIT_US, 6);
    const seven = effectSpans(SFX.HURT, 0, seq(0x00));
    // r = 0x40: 0x40/2 x 24 cycles each; first wait and first toggle both at "off": merged
    expect(seven[0]).toBeCloseTo(2 * 0x40 * 12 * UNIT_US, 6);
    expect(spansDuration(seven)).toBeCloseTo(255 * 0x40 * 12 * UNIT_US, 3);
    // reproducible for a given generator
    expect(effectSpans(SFX.HIT, 0, seq(1, 2, 3))).toEqual(effectSpans(SFX.HIT, 0, seq(1, 2, 3)));
  });

  it("9: pulse-width sweep at a fixed pitch set by the parameter", () => {
    for (const p of [0x80, 0xa0, 0xc0, 0xff]) {
      const s = effectSpans(SFX.MAGIC, p);
      const period = (p + 1) * 9 * UNIT_US;
      expect(spansDuration(s)).toBeCloseTo(53 * 48 * period, 2);
      // on = (p + 1 - c) and off = c units: every on+off pair after the first has the same period
      for (const f of spanFrequencies(s).slice(0, 200)) expect(f).toBeCloseTo(1e6 / period, 3);
    }
    expect(ms(spansDuration(effectSpans(SFX.MAGIC, 0xa0)))).toBeCloseTo(873, 0);
  });

  it("10: one burst of 40 half-periods per unit of the parameter (0 = 256)", () => {
    const s = effectSpans(SFX.CAST, 3, seq(0x00, 0x3f, 0xff));
    // r = (byte & 0x3F) + 0x40 = 0x40, 0x7F, 0x7F: half-period r x 2 x 18 cycles
    expect(spansDuration(s)).toBeCloseTo(40 * (0x40 + 0x7f + 0x7f) * 36 * UNIT_US, 3);
    expect(spansDuration(effectSpans(SFX.CAST, 0, seq(0)))).toBeCloseTo(256 * 40 * 0x40 * 36 * UNIT_US, 1);
  });

  it("11, 12: 128 steps of 20 half-periods, falling then rising", () => {
    const w = effectSpans(SFX.WHIRLPOOL), t = effectSpans(SFX.TWISTER);
    expect(spansDuration(w)).toBeCloseTo(20 * ((0x40 + 0xbf) * 128) / 2 * 21 * UNIT_US, 2);
    expect(spansDuration(t)).toBeCloseTo(20 * ((0x41 + 0xc0) * 128) / 2 * 21 * UNIT_US, 2);
    expect(spanFrequencies(w).at(-1)!).toBeLessThan(spanFrequencies(w)[0]);
    expect(spanFrequencies(t).at(-1)!).toBeGreaterThan(spanFrequencies(t)[0]);
  });

  it("ignores numbers outside the table, as 1000:1D47 does", () => {
    expect(EFFECT_COUNT).toBe(13);
    expect(spansDuration(effectSpans(13))).toBe(0);
    expect(spansDuration(effectSpans(-1))).toBe(0);
  });
});

describe("rendering", () => {
  it("area-samples the 1-bit level and blocks DC", () => {
    const rate = 48000;
    const s = effectSpans(SFX.ERROR);
    const pcm = renderSpans(s, rate, 20);
    expect(pcm.length).toBe(Math.ceil((spansDuration(s) / 1e6) * rate) + Math.ceil(0.02 * rate));
    let max = 0, sum = 0;
    for (const v of pcm) { max = Math.max(max, Math.abs(v)); sum += v; }
    expect(max).toBeGreaterThan(0.5);
    expect(max).toBeLessThanOrEqual(1);
    expect(Math.abs(sum / pcm.length)).toBeLessThan(0.05);
    // a click shorter than a sample still has its energy (area sampling)
    expect(Math.max(...renderSpans(effectSpans(SFX.STEP), rate, 0).map(Math.abs))).toBeGreaterThan(0.1);
  });
});

describe("playback without a user gesture (tests, node)", () => {
  it("resolves at once and silently", async () => {
    const t = Date.now();
    await playEffect(SFX.MAGIC, 0xff);
    expect(Date.now() - t).toBeLessThan(50);
  });
});
