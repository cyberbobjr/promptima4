// PC-speaker effects of AVATAR.EXE (1000:1D47 and the 13 routines of its table at DS:06A7).
//
// The original never programs the PIT for its effects: each routine toggles the speaker data bit
// (bit 1 of port 0x61, gate bit 0 cleared) by hand, between busy-wait loops. Most loop counts are
// multiplied by a CPU-speed factor measured at start-up (DS:8728, 1000:0012: iterations of a fixed
// loop during one BIOS timer tick, divided by 1000), so the durations are the same on any machine.
// Here every effect is first turned into the exact list of speaker toggles (pure functions below,
// unit-tested), then rendered sample by sample (an exact 1-bit square wave, area-sampled) and played
// through WebAudio. See docs/RE_NOTES.md "PC speaker".
import { config, onConfigChange, updateConfig } from "../config/config";
import { isManualClock } from "../game/clock";
import { soundRand8 } from "../game/rng";

// ------------------------------------------------------------------ timing model

/** The PIT input clock; the BIOS timer tick used by the calibration is 65536 counts of it. */
export const PIT_HZ = 1193182;
/** One BIOS timer tick (INT 1Ch), the calibration window: 54.925 ms. */
export const TIMER_TICK_US = (65536 / PIT_HZ) * 1e6;
/** 8088 cycles of one pass of the calibration loop at 1000:00CF..00EC (INC mem, JS, 3 MOV mem, MOV, MOV, RCR DX,20, CMP CS:mem, JZ). */
export const CALIBRATION_CYCLES = 232;
/**
 * Time of one "calibrated cycle": a loop body of c cycles run K*m times lasts m*c*UNIT_US on any CPU
 * (K = DS:8728 = iterations per tick / 1000). 0.2368 µs.
 */
export const UNIT_US = TIMER_TICK_US / (CALIBRATION_CYCLES * 1000);
/** Reference machine for the two loops that are not calibrated (effects 0 and 4): a 4.77 MHz PC. */
export const REF_CPU_HZ = 4772727;

/** m loop passes per K of a c-cycle loop (calibrated). */
const cal = (m: number, c: number) => m * c * UNIT_US;
/** n passes of a c-cycle loop, not calibrated (reference CPU). */
const raw = (n: number, c: number) => (n * c * 1e6) / REF_CPU_HZ;

/** Number of effects in the table DS:06A7 (1000:1D47 ignores n >= 13). */
export const EFFECT_COUNT = 13;

/** Effect numbers, named after their uses in the original (docs/RE_NOTES.md "PC speaker"). */
export const SFX = {
  /** 1000:1D69: one click — every step on foot or horseback, in combat too. */
  STEP: 0,
  /** 1000:1D82: low buzz — refused key, blocked move, wrong answer. */
  ERROR: 1,
  /** 1000:1DA8: beep + buzz — bad command, command not available here, cannons not broadside. */
  BAD_COMMAND: 2,
  /** 1000:1EB3: falling sweep — cannon fire, monster missiles. */
  CANNON: 3,
  /** 1000:1EFD: pause + rising sweep — the party's attacks. */
  ATTACK: 4,
  /** 1000:1F4A: falling sweep — a monster's melee attack. */
  MONSTER_ATTACK: 5,
  /** 1000:1E7F: noise — a creature is hit, damage to the party, earthquakes. */
  HIT: 6,
  /** 1000:1E53: noise — a party member is hurt (traps, monster hits). */
  HURT: 7,
  /** 1000:1F22: fast rising sweep — evaded traps, fleeing, thefts, failed spells. */
  FLEE: 8,
  /** 1000:1DCD(p): pulse-width sweep — magic (moongates, spells, healing, level up). */
  MAGIC: 9,
  /** 1000:1F73(p): p bursts of noise — casting (p = spell MP), Lord British's healing. */
  CAST: 10,
  /** 1000:1FA3: long falling sweep — whirlpool. */
  WHIRLPOOL: 11,
  /** 1000:1FCC: long rising sweep — twister. */
  TWISTER: 12,
} as const;

// ------------------------------------------------------------------ effects as toggle lists

/**
 * A speaker waveform: durations in µs of alternating levels, starting with the speaker OFF
 * (spans[0] off, spans[1] on, ...). The speaker is off again after the last span.
 */
export type Spans = number[];

/** Records `out 61h` and busy waits like the original routines. */
class Speaker {
  private level = 0;
  readonly spans: Spans = [0];
  /** al of the routines: the state written by the next `out` (0 = off, 1 = on). */
  al = 0;
  wait(us: number) { this.spans[this.spans.length - 1] += us; }
  /** out 61h,al */
  out() { if (this.al !== this.level) { this.level = this.al; this.spans.push(0); } }
  /** xor al,2 */
  flip() { this.al ^= 1; }
  /** out, xor */
  toggle() { this.out(); this.flip(); }
  done(): Spans {
    this.al = 0; this.out();
    while (this.spans.length > 1 && this.spans[this.spans.length - 1] === 0) this.spans.pop();
    return this.spans;
  }
}

/** Builds the effects into `s` (separate so effect 2 can chain effect 1). */
function build(s: Speaker, n: number, p: number, rnd: () => number): void {
  switch (n) {
    case 0: // 1000:1D69: on, 50 passes of DEC DI/JNZ (18 cycles, not calibrated), off
      s.flip(); s.out(); s.wait(raw(50, 18));
      return;
    case 1: // 1000:1D82: 16 x (out, xor, wait 0xCA*K passes of DEC/PUSHF/PUSH/POP/POPF/JNZ = 71 cycles)
      for (let i = 0; i < 16; i++) { s.toggle(); s.wait(cal(0xca, 71)); }
      return;
    case 2: // 1000:1DA8: 48 x (out, xor, wait 0xE0*K x 18 cycles), then effect 1
      for (let i = 0; i < 48; i++) { s.toggle(); s.wait(cal(0xe0, 18)); }
      s.al = 0; s.out();
      build(s, 1, p, rnd);
      return;
    case 3: // 1000:1EB3: bl = 5..255: out, xor, wait K*bl/2 x (DEC CX/NOP/NOP/JNZ = 24 cycles)
      for (let bl = 5; bl <= 255; bl++) { s.toggle(); s.wait(cal(bl / 2, 24)); }
      return;
    case 4: // 1000:1EFD: bl = 0 (K*0/2 = 0: DEC CX wraps, 65536 passes, not calibrated), then 255..128
      s.toggle(); s.wait(raw(65536, 24));
      for (let bl = 255; bl >= 128; bl--) { s.toggle(); s.wait(cal(bl / 2, 24)); }
      return;
    case 5: // 1000:1F4A: bl = 128..255: out, xor, wait K*bl/2 x (DEC CX/4 NOP/JNZ = 30 cycles)
      for (let bl = 128; bl <= 255; bl++) { s.toggle(); s.wait(cal(bl / 2, 30)); }
      return;
    case 6: // 1000:1E7F: 255 x (r = rand|1 & 0x7F, wait (3*r*K/4) x LOOP = 17 cycles, out, xor)
      for (let i = 0; i < 255; i++) { const r = (rnd() & 0x7f) | 1; s.wait(cal((3 * r) / 4, 17)); s.toggle(); }
      return;
    case 7: // 1000:1E53: 255 x (r = rand & 0x7F | 0x40, wait r*K/2 x (NOP/NOP/DEC/JNZ = 24 cycles), out, xor)
      for (let i = 0; i < 255; i++) { const r = (rnd() & 0x7f) | 0x40; s.wait(cal(r / 2, 24)); s.toggle(); }
      return;
    case 8: // 1000:1F22: bl = 128..1: out, xor, wait K*bl/2 x 24 cycles
      for (let bl = 128; bl >= 1; bl--) { s.toggle(); s.wait(cal(bl / 2, 24)); }
      return;
    case 9: { // 1000:1DCD(p): K' = K/2; pulses on for (p+1-c)*K', off for c*K' (18-cycle loops), 48 per step, c = 1..26 then 27..1
      const pw = p & 0xff;
      const pulse = (c: number) => {
        for (let i = 0; i < 48; i++) { s.wait(cal((pw + 1 - c) / 2, 18)); s.toggle(); s.wait(cal(c / 2, 18)); s.toggle(); }
      };
      for (let c = 1; c <= 26; c++) pulse(c);
      for (let c = 27; c >= 1; c--) pulse(c);
      return;
    }
    case 10: { // 1000:1F73(p): p bursts (0 = 256) of 40 half-periods of r*2*K x 18 cycles, r = rand & 0x3F + 0x40
      const bursts = (p & 0xff) || 256;
      for (let b = 0; b < bursts; b++) {
        const r = (rnd() & 0x3f) + 0x40;
        for (let i = 0; i < 40; i++) { s.wait(cal(r * 2, 18)); s.toggle(); }
      }
      return;
    }
    case 11: // 1000:1FA3: cx = 0x40..0xBF, 20 half-periods each of cx*K x (NOP/DEC/JNZ = 21 cycles)
      for (let cx = 0x40; cx < 0xc0; cx++) for (let i = 0; i < 20; i++) { s.wait(cal(cx, 21)); s.toggle(); }
      return;
    case 12: // 1000:1FCC: cx = 0xC0 down to 0x41, as 11
      for (let cx = 0xc0; cx > 0x40; cx--) for (let i = 0; i < 20; i++) { s.wait(cal(cx, 21)); s.toggle(); }
      return;
  }
}

/** The toggles of effect n (param = second argument of 1000:1D47, used by effects 9 and 10). */
export function effectSpans(n: number, param = 0, rnd: () => number = soundRand8): Spans {
  const s = new Speaker();
  if (n >= 0 && n < EFFECT_COUNT) build(s, n, param, rnd);
  return s.done();
}

/** Total duration of a waveform, in µs: how long the original blocks while playing it. */
export const spansDuration = (spans: Spans): number => spans.reduce((a, b) => a + b, 0);

/** Pitch of each on+off pair (Hz), for inspection and tests. */
export function spanFrequencies(spans: Spans): number[] {
  const out: number[] = [];
  for (let i = 1; i + 1 < spans.length; i += 2) out.push(1e6 / (spans[i] + spans[i + 1]));
  return out;
}

/**
 * Samples of a waveform: the 1-bit speaker level averaged over each sample period (area sampling,
 * against aliasing), through a DC blocker (the speaker cone does not hold a position), plus a short
 * tail for the blocker to settle. Output in [-1, 1].
 */
export function renderSpans(spans: Spans, sampleRate: number, tailMs = 20): Float32Array {
  const total = spansDuration(spans) / 1e6;
  const n = Math.ceil(total * sampleRate) + Math.ceil((tailMs / 1000) * sampleRate);
  const out = new Float32Array(n);
  // integral of the level over [0, t]
  let t = 0;
  for (let i = 0; i < spans.length; i++) {
    const t0 = t, t1 = t + spans[i] / 1e6;
    t = t1;
    if (i % 2 === 0) continue; // off
    const s0 = t0 * sampleRate, s1 = t1 * sampleRate;
    for (let k = Math.floor(s0); k < Math.min(n, Math.ceil(s1)); k++) out[k] += Math.min(s1, k + 1) - Math.max(s0, k);
  }
  // DC blocker y[n] = x[n] - x[n-1] + R*y[n-1], R for a ~20 Hz corner
  const R = 1 - (2 * Math.PI * 20) / sampleRate;
  let px = 0, py = 0;
  for (let k = 0; k < n; k++) {
    const x = out[k];
    py = x - px + R * py;
    px = x;
    out[k] = Math.max(-1, Math.min(1, py));
  }
  return out;
}

// ------------------------------------------------------------------ playback

/** The game's volume flag DS:06A6 is config.sound.enabled here. */
export const soundOn = (): boolean => config().sound?.enabled !== false;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
/** AudioContext time at which the queued effects end (effects play one after the other, as in the original). */
let queueEnd = 0;
/** Effects queued further ahead than this are dropped. */
const MAX_BACKLOG_S = 4;
/** Overall level of the full-scale square wave at volume 1. */
const HEADROOM = 0.5;

const gainFor = (): number => Math.max(0, Math.min(1, config().sound?.volume ?? 0.5)) * HEADROOM;

/**
 * Hooks the first user gesture: browsers only let an AudioContext run after one, so the context is
 * created (or resumed) then. Before it, and in tests, the effects are silent.
 */
export function initSpeaker(): void {
  if (typeof window === "undefined" || typeof AudioContext === "undefined") return;
  const events = ["pointerdown", "keydown", "touchend"] as const;
  const unlock = () => {
    try {
      if (!ctx) {
        ctx = new AudioContext();
        master = ctx.createGain();
        master.gain.value = gainFor();
        master.connect(ctx.destination);
      }
      if (ctx.state === "suspended") void ctx.resume();
    } catch (e) {
      console.warn("speaker: no audio", e);
    }
    if (ctx?.state === "running") for (const ev of events) window.removeEventListener(ev, unlock, true);
  };
  for (const ev of events) window.addEventListener(ev, unlock, true);
  onConfigChange(() => { if (master && ctx) master.gain.setValueAtTime(gainFor(), ctx.currentTime); });
}

/** Effects without randomness are rendered once (buffer and duration in µs). */
const cache = new Map<string, { buf: AudioBuffer; us: number }>();

/**
 * 1000:1D47(n, param): plays effect n and resolves when it has been heard, like the original which
 * busy-waits while the speaker plays. Resolves at once when the sound is off (the original returns
 * at once when DS:06A6 is 0), when nothing can be heard (no user gesture yet, no WebAudio: tests) and
 * under the test driver's manual clock, so sound never changes the timing of tests.
 */
export function playEffect(n: number, param = 0): Promise<void> {
  if (!(n >= 0 && n < EFFECT_COUNT)) return Promise.resolve();
  const random = n === 6 || n === 7 || n === 10;
  return playSpans(() => effectSpans(n, param), random ? undefined : `${n}:${param & 0xff}`);
}

/** True when a waveform would be heard now (sound on, AudioContext created by a gesture and running). */
export const speakerReady = (): boolean => soundOn() && !!ctx && !!master && ctx.state === "running";

/**
 * Plays any speaker waveform (other programs' routines, e.g. TITLE.EXE's: src/audio/titleSounds.ts)
 * through the same queue as the effects. `make` is only called when the sound can be heard; a
 * `cacheKey` keeps the rendered buffer for waveforms without randomness. Same promise semantics as
 * playEffect: resolves when the waveform has played, at once when nothing can be heard or under
 * the test clock.
 */
export function playSpans(make: () => Spans, cacheKey?: string): Promise<void> {
  if (!speakerReady() || !ctx || !master) return Promise.resolve();
  let fx = cacheKey === undefined ? undefined : cache.get(cacheKey);
  if (!fx) {
    const spans = make();
    const data = renderSpans(spans, ctx.sampleRate);
    const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
    buf.getChannelData(0).set(data);
    fx = { buf, us: spansDuration(spans) };
    if (cacheKey !== undefined) cache.set(cacheKey, fx);
  }
  const now = ctx.currentTime;
  const start = Math.max(now + 0.005, queueEnd);
  if (start - now > MAX_BACKLOG_S) return Promise.resolve();
  const src = ctx.createBufferSource();
  src.buffer = fx.buf;
  src.connect(master);
  src.start(start);
  const end = start + fx.us / 1e6;
  queueEnd = end;
  if (isManualClock()) return Promise.resolve();
  return new Promise((r) => setTimeout(r, Math.max(0, (end - now) * 1000)));
}

/** V)olume (1000:70AD): flips the sound flag (saved like the settings panel's); returns the new state. */
export function toggleSound(): boolean {
  const on = !soundOn();
  void updateConfig({ sound: { enabled: on } });
  return on;
}

/** For tests in a browser: the context, once a gesture created it. */
export const audioContext = (): AudioContext | null => ctx;
