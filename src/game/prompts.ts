// Console text output, keyboard prompts and waits reproducing the AVATAR.EXE primitives
// (print 1000:0B38, putchar 1000:0C9F, newline 1000:2230, line input 1000:1445, number input 1000:169C,
// Y/N 1000:162F, key choice 1000:11F9, member choice 1000:1287, delays 1000:16CD). One implementation
// for the whole engine.
import type { Game } from "./game";
import { CON_W } from "./console";
import { MSG_CORE } from "./texts/core";
import { playEffect, SFX } from "../audio/speaker";

/** Current column in the message area. */
function col(g: Game): number {
  const l = g.con.lines;
  return l[l.length - 1].length;
}

/** 1000:2230: carriage return + scroll. */
export function nl(g: Game) { g.con.newline(); }

/** 1000:0C9F: one character; wraps at column 16, a space at the end of a line is dropped. */
export function putc(g: Game, ch: string) {
  if (ch === "\b") { g.con.backspace(); return; }
  if (ch === "\n") { nl(g); return; }
  if (ch === " ") { if (col(g) >= CON_W) return; }
  else if (col(g) >= CON_W) nl(g);
  g.con.print(ch === "\x12" ? " " : ch); // glyph 0x12 of CHARSET.EGA is blank
}

/** 1000:0C03 with width 1: a decimal number. */
export function putNum(g: Game, n: number) { for (const c of String(n)) putc(g, c); }

/** Waits for a key after a full screen of text (1000:0B38 counts 12 line breaks). */
async function pageWait(g: Game) {
  g.input.clear();
  await g.getKey();
}

/**
 * 1000:0B38: prints a string with word wrap (a word that does not fit on the current line starts a
 * new one; a word = run of characters up to a space, newline or end, control characters included).
 * After 12 line breaks it waits for a key. Several strings = several calls (one page count each).
 */
export async function say(g: Game, ...texts: string[]) {
  for (const t of texts) await say1(g, t);
}

async function say1(g: Game, text: string) {
  let left = 0, lines = 0;
  for (let i = 0; i < text.length; i++) {
    const zero = left === 0;
    left--;
    if (zero) {
      left = 0;
      // a space before ! ? : ; (French typography) stays with the word, so the sign never starts a line
      const glued = (k: number) => text[k] === " " && "!?:;»".includes(text[k + 1] ?? "");
      while (i + left < text.length && text[i + left] !== "\n" && (text[i + left] !== " " || glued(i + left))) left++;
      if (left + col(g) > CON_W && col(g) !== 0) {
        if (lines++ === 12) { await pageWait(g); lines = 0; }
        nl(g);
      }
    }
    if (text[i] === "\n" && lines++ === 12) { await pageWait(g); lines = 0; }
    putc(g, text[i]);
  }
}

/** Printing without word wrap (Lord British's answers, 1000:E3D2): pauses on the 13th line break. */
export async function sayRaw(g: Game, text: string) {
  let lines = 0;
  for (const ch of text) {
    if (ch === "\n" && lines++ === 12) { await pause(g); lines = 0; }
    putc(g, ch);
  }
}

/** 1000:E1FC: flush the keyboard, wait 10 seconds or until a key is pressed. */
export async function pause(g: Game, seconds = 10) {
  g.input.clear();
  await g.input.next(seconds * 1000);
}

/** 1000:16CD with no key check: fixed delay. */
export function delay(seconds: number): Promise<void> {
  return sleep(seconds * 1000);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One unit of FUN_1000_16cd (the overworld input wait is 0x19 units = 8 s). */
export const TICK_MS = 320;

/** FUN_1000_16cd(n, 0): uninterruptible delay. */
export const ticks = (n: number) => sleep(n * TICK_MS);

/** FUN_1000_2F7E: wait up to 15 units or until a key, which is consumed. */
export async function pauseUnits(g: Game, units = 15) { await g.input.next(units * TICK_MS); }

/** FUN_1000_1804: flush the keyboard buffer. */
export function flushKeys(g: Game) { g.input.clear(); }

/** 1000:17F4: waits for a key (flushes pending keys first when `flush`, as 1000:1804 does). */
export async function waitKey(g: Game, flush = false): Promise<string> {
  if (flush) g.input.clear();
  return g.getKey();
}

/** Error buzz 1000:1D47(1). */
const beep = () => playEffect(SFX.ERROR);

/** Key name -> character code as the BIOS would return it (low byte). */
function keyCode(k: string): number {
  if (k === "Enter") return 0x0d;
  if (k === "Escape") return 0x1b;
  if (k === "Backspace") return 0x08;
  return k.length === 1 ? k.charCodeAt(0) & 0x7f : 0;
}

/**
 * 1000:1445: line input of at most `size - 1` characters, echoed; leading and trailing blanks are
 * removed. No newline is printed (callers do it).
 */
export async function readLine(g: Game, size: number): Promise<string> {
  let s = "";
  for (;;) {
    const k = await g.getKey();
    if (k === "Enter") break;
    if (k === "Backspace" || k === "ArrowLeft") {
      if (s) { s = s.slice(0, -1); g.con.backspace(); } else await beep();
      continue;
    }
    const c = keyCode(k);
    if (k.length === 1 && s.length !== size - 1 && c > 0x1f && c < 0x80) { s += k; putc(g, k); } else await beep();
  }
  return s.trim();
}

/** C atoi() as used by 1000:169C. */
function atoi(s: string): number {
  const m = /^\s*([+-]?\d+)/.exec(s);
  return m ? parseInt(m[1], 10) : 0;
}

/** 1000:169C: number of up to `digits` characters, then a newline. Empty input = 0. */
export async function readNumber(g: Game, digits: number): Promise<number> {
  const s = await readLine(g, digits + 1);
  nl(g);
  return s ? atoi(s) : 0;
}

/** 1000:162F: waits for Y, N, space, Esc or Enter; echoes Y/N; newline. Returns "Y", "N" or another char. */
export async function askYN(g: Game): Promise<string> {
  for (;;) {
    const key = await g.getKey();
    let c = keyCode(key);
    if (c > 0x60 && c < 0x7b) c -= 0x20;
    // the language's own yes/no letters (O/N in French) count as Y/N
    const yn = key.length === 1 ? answerLetter(key) : "";
    if (yn === "Y" || yn === "N") c = yn.charCodeAt(0);
    if (c === 0x4e || c === 0x59 || c === 0x20 || c === 0x1b || c === 0x0d) {
      if (c === 0x4e || c === 0x59) putc(g, yn === "Y" || yn === "N" ? key.toUpperCase() : String.fromCharCode(c));
      nl(g);
      return String.fromCharCode(c);
    }
    await beep();
  }
}

/**
 * First letter of a yes/no answer as the engine expects it ("Y"/"N"): the language's letters
 * (MSG_CORE.yesLetter/noLetter, e.g. O/N in French) and the original Y/N are both accepted.
 */
export function answerLetter(ch: string): string {
  const c = fold(ch);
  if (c === fold(MSG_CORE.yesLetter)) return "Y";
  if (c === fold(MSG_CORE.noLetter)) return "N";
  return ch.toUpperCase();
}

/**
 * 1000:11F9: prints `prompt`, reads one key (upper-cased, echoed, then a newline) and repeats with a
 * beep until it lies in [lo, hi]. Enter/space -> -1, Esc -> -2. Returns the character code.
 */
export async function askKey(g: Game, prompt: string, lo: string, hi: string): Promise<number> {
  const max = hi, min = lo;
  let first = true;
  for (;;) {
    if (!first) await beep();
    first = false;
    await say(g, prompt);
    const k = await g.getKey();
    if (k === "Enter" || k === " " || k === "Escape") { nl(g); return k === "Escape" ? -2 : -1; }
    let c = keyCode(k);
    if (c > 0x60 && c < 0x7b) c -= 0x20;
    if (c > 0x20 && c < 0x7f) putc(g, String.fromCharCode(c));
    nl(g);
    if (c >= min.charCodeAt(0) && c <= max.charCodeAt(0)) return c;
  }
}

/** 1000:1287: choose a party member. 0-based index, -1 none (Enter/Esc), -2 for "0". */
export async function askMember(g: Game, prompt: string): Promise<number> {
  const n = g.save.members;
  if (n === 1) { await say(g, prompt); await say(g, "1\n"); return 0; }
  const c = await askKey(g, prompt, "0", String.fromCharCode(0x30 + n));
  if (c === 0x30) return -2;
  if (c < 0) return -1;
  return c - 0x31;
}

/** 1000:EC39: case-insensitive compare of at most `n` characters, stopping at the end of either string. */
export function strnieq(a: string, b: string, n: number): boolean {
  // accents are ignored too, so translated words can be typed without them ("epee" = "épée")
  for (let i = 0; i < n; i++) {
    const x = fold(a[i] ?? ""), y = fold(b[i] ?? "");
    if (x !== y) return false;
    if (!x) return true;
  }
  return true;
}

/** One character, lower case and without its accent. */
const fold = (c: string) => c.normalize("NFD").charAt(0).toLowerCase();

/** strnieq with the usual length of typed answers. */
export const sameText = (a: string, b: string, n = 16) => strnieq(a, b, n);
