import { describe, expect, it } from "vitest";
import { DISSOLVE_CYCLES, DissolveRng, dissolveSpans, titleBuzz } from "../src/audio/titleSounds";
import { spansDuration } from "../src/audio/speaker";

/** A 320x200 picture whose 8-pixel groups are set where `on(col, line)` is true. */
function picture(on: (c: number, y: number) => boolean): Uint8Array {
  const p = new Uint8Array(320 * 200);
  for (let y = 0; y < 200; y++) for (let c = 0; c < 40; c++) if (on(c, y)) p[y * 320 + c * 8 + 3] = 5;
  return p;
}

/** The generator of 1000:1796 written as the x86 code does it (add / adc with the carry). */
function reference(lo: number, hi: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let dl = lo + 0x1d;
    const cf = dl > 0xff ? 1 : 0;
    dl &= 0xff;
    const dh = dl;
    dl = (dl + hi + cf) & 0xff;
    lo = dl; hi = dh;
    out.push(dl);
  }
  return out;
}

describe("TITLE.EXE dissolve generator (DS:03CC/03CD)", () => {
  it("matches the add/adc sequence from the initial bytes 0x35, 0x9B", () => {
    const g = new DissolveRng();
    const got = Array.from({ length: 300 }, () => g.next());
    expect(got).toEqual(reference(0x35, 0x9b, 300));
    expect(got[0]).toBe((0x35 + 0x1d + 0x9b) & 0xff);
  });
});

describe("dissolve 1000:173F -> speaker toggles", () => {
  const full = picture(() => true);

  it("a black rectangle makes no toggle but still lasts the whole pass", () => {
    const s = dissolveSpans(new Uint8Array(320 * 200), 30, 45, 5, 34, 0x38, new DissolveRng(), 25000);
    expect(s).toHaveLength(1);
    expect(s[0]).toBeCloseTo(25000, 6);
  });

  it("step 0: r + 0 never carries, so the speaker stays silent", () => {
    const s = dissolveSpans(full, 30, 45, 5, 34, 0, new DissolveRng(), 25000);
    expect(s).toHaveLength(1);
  });

  it("toggles exactly when the generator byte + step carries, and lasts the step", () => {
    const step = 0x20, w = 30, h = 45;
    const bytes = reference(0x35, 0x9b, w * h);
    const expected = bytes.filter((r) => r + step > 0xff).length;
    const s = dissolveSpans(full, w, h, 5, 34, step, new DissolveRng(), 25000);
    expect(s.length - 1).toBe(expected);
    expect(spansDuration(s)).toBeCloseTo(25000, 6);
    for (const x of s) expect(x).toBeGreaterThanOrEqual(0);
  });

  it("places the toggles with the cycle cost of each group (lines bottom-up)", () => {
    // one drawn group per line, in column 0; the other columns black
    const pic = picture((c) => c === 0);
    const step = 0xff; // r + 0xFF carries for every r > 0: (almost) every drawn group toggles
    const g = new DissolveRng();
    const w = 4, h = 3, C = DISSOLVE_CYCLES;
    const bytes = reference(0x35, 0x9b, h);
    const s = dissolveSpans(pic, w, h, 0, 0, step, g, 1);
    // rebuild the toggle times in cycles
    const perLine = (tog: boolean) => C.row + (tog ? C.drawnToggle : C.drawn) + (w - 1) * C.empty;
    const total = bytes.reduce((a, r) => a + perLine(r + step > 0xff), 0);
    const times: number[] = [];
    let t = 0;
    for (const r of bytes) {
      if (r + step > 0xff) times.push(t + C.row + C.toggleAt);
      t += perLine(r + step > 0xff);
    }
    let acc = 0;
    const got = s.slice(0, -1).map((x) => (acc += x));
    expect(got.length).toBe(times.length);
    got.forEach((x, i) => expect(x).toBeCloseTo(times[i] / total, 9));
    expect(g.lo).toBe(bytes[bytes.length - 1]); // the generator advanced once per drawn group
  });

  it("denser as the step grows", () => {
    const n = (step: number) => dissolveSpans(full, 30, 45, 5, 34, step, new DissolveRng(), 25000).length;
    expect(n(0x10)).toBeLessThan(n(0x20));
    expect(n(0x20)).toBeLessThan(n(0x38));
  });
});

describe("1000:21BF", () => {
  it("resolves at once without audio (tests, before any gesture)", async () => {
    await expect(titleBuzz()).resolves.toBeUndefined();
  });
});
