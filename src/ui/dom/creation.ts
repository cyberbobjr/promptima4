// Character creation of the 2026 edition (with the modern title, src/ui/dom/title.ts): the same steps and rules
// as TITLE.EXE's "Initiate New Game" (src/intro/newgame.ts: name and sex, the story pages, the gypsy's seven
// dilemmas, the new party), shown as an HTML screen with the edition's illustrations (PixelLab, under
// assets/packs/pixellab/art/) instead of the 1987 pictures. The texts are still the original ones (TITLE).
// Keys go through the game's input queue; the name is typed in a real text field.
import { assets } from "../../assets/store";
import type { SaveGame } from "../../formats/save";
import type { Game } from "../../game/game";
import type { Key } from "../../game/input";
import { random } from "../../game/rng";
import { t } from "../../i18n/i18n";
import type { TitleData } from "../../intro/data";
import { buildNewSave } from "../../intro/newgame";
import { VIRTUE_ART } from "../../game/endgame/ui";
import { TITLE } from "../../intro/texts";
import { loadEditionFonts } from "../../render/fonts";
import { h } from "./dom";
import "./creation.css";

export interface ModernCreation {
  /** The new party, or null when the player backs out (empty name, Escape). */
  run(d: TitleData): Promise<SaveGame | null>;
}

/** Story page (TITLE.pages 0x1D..0x34) -> illustration, as the picture changes of FUN_1000_2883. */
function storyArt(page: number): string {
  if (page < 0x23) return "tree";
  if (page < 0x28) return "portal";
  if (page < 0x2c) return "tree";
  if (page < 0x2e) return "outside";
  if (page < 0x31) return "inside";
  if (page < 0x32) return "wagon";
  if (page < 0x34) return "gypsy";
  return "abacus";
}

class Aborted extends Error {}

/** The 40-column pre-wrapped texts of TITLE.EXE as flowing text: single line breaks become spaces. */
const reflow = (s: string) => s.replace(/([^\n])\n(?!\n)/g, "$1 ").trim();

export function createModernCreation(overlay: HTMLElement, g: Game): ModernCreation {
  const art = (name: string) => assets.url(`packs/pixellab/art/${name}.png`);
  const img = h("img", { class: "nc-img", alt: "", draggable: "false" });
  const gate = h("img", { class: "nc-gate", alt: "", src: assets.url("packs/pixellab/sprites/moongate-3.png"), hidden: true });
  const cardEls = [0, 1].map(() => h("figure", { class: "nc-card" }, h("img", { alt: "" }), h("figcaption", {})));
  const cards = h("div", { class: "nc-cards", hidden: true }, ...cardEls);
  const beads = h("div", { class: "nc-abacus", hidden: true, "aria-hidden": "true" });
  const beadCells: HTMLElement[][] = [];
  for (let v = 0; v < 8; v++) {
    const col = h("div", { class: "nc-col" });
    beadCells.push(Array.from({ length: 7 }, () => { const b = h("i", {}); col.append(b); return b; }));
    beads.append(col);
  }
  const pic = h("div", { class: "nc-pic" }, img, gate, cards, beads);
  const text = h("div", { class: "nc-text", "aria-live": "polite" });
  const controls = h("div", { class: "nc-controls" });
  const root = h("div", { class: "nc-root", hidden: true, onclick: (e: Event) => {
    // a click on the screen (not on a control) turns the page
    if (!(e.target as HTMLElement).closest("button, input")) g.input.push({ key: "Enter", code: "Enter", source: "pointer" });
  } }, h("div", { class: "nc-stage" }, pic, h("div", { class: "nc-box" }, text, controls)));
  overlay.append(root);

  const show = (name: string) => {
    const src = art(name);
    if (img.getAttribute("src") === src) return;
    img.classList.remove("in");
    img.src = src;
    void img.decode().catch(() => undefined).then(() => img.classList.add("in"));
  };
  const say = (s: string) => { text.textContent = reflow(s); };
  const pushKey = (key: string) => g.input.push({ key, code: "", source: "pointer" });
  const button = (label: string, key: string) => h("button", { type: "button", class: "nc-btn", onclick: () => pushKey(key) }, label);

  /** Next key; Escape backs out of the whole creation (as TITLE.EXE's key reader). */
  async function key(): Promise<Key> {
    for (;;) {
      const k = await g.input.next();
      if (!k) continue;
      if (k.key === "Escape") throw new Aborted();
      return k;
    }
  }
  /** A page: the text and a "continue" button, until any key. */
  async function page(s: string) {
    say(s);
    controls.replaceChildren(button(t("creation.continue"), "Enter"));
    await key();
  }

  async function askName(): Promise<string | null> {
    say(`${TITLE.namePrompt1} ${TITLE.namePrompt2}`);
    const input = h("input", { class: "nc-input", type: "text", maxlength: "11", autocomplete: "off", spellcheck: "false", "aria-label": t("creation.name") });
    const ok = h("button", { type: "button", class: "nc-btn" }, t("creation.ok"));
    controls.replaceChildren(input, ok);
    input.focus();
    return new Promise((resolve) => {
      const done = (v: string | null) => { input.removeEventListener("keydown", onKey); resolve(v); };
      const submit = () => { const v = input.value.trim(); if (v) done(v); else input.focus(); };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Enter") { e.preventDefault(); submit(); }
        if (e.key === "Escape") { e.preventDefault(); done(null); }
      };
      input.addEventListener("keydown", onKey);
      ok.addEventListener("click", submit);
    });
  }

  async function askSex(): Promise<"M" | "F"> {
    say(TITLE.sexPrompt);
    controls.replaceChildren(button("M", "m"), button("F", "f"));
    for (;;) {
      const c = (await key()).key.toUpperCase();
      if (c === "M" || c === "F") return c;
    }
  }

  async function story() {
    for (let p = 0x1d; p < 0x35; p++) {
      show(storyArt(p));
      // FUN_1000_273e / 27e0: the moongate rises from the hill, then sinks into it
      gate.hidden = p < 0x20 || p > 0x22;
      gate.className = `nc-gate${p === 0x20 ? " rise" : p === 0x22 ? " sink" : ""}`;
      await page(TITLE.pages[p]);
    }
    gate.hidden = true;
  }

  /** FUN_1000_2c12: seven dilemmas between random pairs of cards, winners meet again (4, 2, 1). */
  async function casting(d: TitleData) {
    const rnd8 = () => Math.floor(random() * 8);
    const names = TITLE.virtueNames;
    const bonus = [d.strBonus, d.dexBonus, d.intBonus];
    const stats = [15, 15, 15];
    const karma = new Array(8).fill(50);
    const mark = new Uint8Array(8);
    let last = 0;
    show("abacus");
    cards.hidden = beads.hidden = false;
    for (const col of beadCells) for (const b of col) b.className = "";
    for (let round = 0; round < 7; round++) {
      if (round === 4 || round === 6) for (let v = 0; v < 8; v++) if (mark[v] < 0x80) mark[v] = 0;
      let a: number, b: number;
      do a = rnd8(); while (mark[a]);
      do b = rnd8(); while (mark[b] || b === a);
      if (b < a) [a, b] = [b, a];
      [a, b].forEach((v, i) => {
        const [image, cap] = [cardEls[i].querySelector("img")!, cardEls[i].querySelector("figcaption")!];
        image.src = art(`card-${VIRTUE_ART[v]}`);
        cap.textContent = names[v];
      });
      cards.classList.remove("deal"); void cards.offsetWidth; cards.classList.add("deal");
      const place = (round === 0 ? TITLE.placeFirst : round === 6 ? TITLE.placeLast : TITLE.placeMore)[0];
      await page(`${place}${TITLE.upon[0]}${names[a]}${TITLE.and}${names[b]}${TITLE.consider}`);
      say(TITLE.pages[d.questionBase[a] + b]);
      controls.replaceChildren(button("A", "a"), button("B", "b"));
      for (;;) {
        const c = (await key()).key.toLowerCase();
        if (c === "a") break;
        if (c === "b") { [a, b] = [b, a]; break; }
      }
      last = a;
      mark[a] = 1;
      karma[a] += 5;
      for (let i = 0; i < 3; i++) stats[i] += bonus[i][a];
      beadCells[a][round].className = "won";
      mark[b] = 0xff;
      beadCells[b][round].className = "lost";
    }
    cards.hidden = true;
    for (const s of TITLE.finalTexts) await page(s);
    return { virtue: last, karma, str: stats[0], dex: stats[1], int: stats[2] };
  }

  return {
    async run(d) {
      await loadEditionFonts();
      root.hidden = false;
      img.removeAttribute("src");
      cards.hidden = beads.hidden = gate.hidden = true;
      try {
        show("tree");
        const name = await askName();
        if (!name) return null;
        const sex = await askSex();
        await story();
        const result = await casting(d);
        return await buildNewSave(d, name, sex, result);
      } catch (e) {
        if (e instanceof Aborted) return null;
        throw e;
      } finally {
        root.hidden = true;
        controls.replaceChildren();
      }
    },
  };
}
