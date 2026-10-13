// Title screen of the port's 2026 edition, "Promptima IV" (replaces TITLE.EXE's title, src/intro/title.ts,
// when config.display.title is "modern"). Same layout as the 1987 screen: the two creatures in the top corners
// (sprites of the PixelLab pack), the credit line, the logo, the subtitle and the menu box. DOM over the canvas;
// its keys go through the game's input queue (keyboard, clicks and taps alike), so the intro flow of
// src/game/intro.ts drives it as it drives the classic title.
import { assets } from "../../assets/store";
import { config, onConfigChange, updateConfig } from "../../config/config";
import type { Game } from "../../game/game";
import type { Key } from "../../game/input";
import { t } from "../../i18n/i18n";
import { h } from "./dom";
import "./title.css";

export type TitleChoice = "journey" | "new";
export interface ModernTitle {
  /** Shows the title (with its opening animation when `opening`) until Resume or New Session is chosen. */
  run(opening: boolean): Promise<TitleChoice>;
  /** A message in the menu box until a key is pressed (no saved game...). */
  notice(lines: readonly string[]): Promise<void>;
  hide(): void;
}

const FONTS: [string, string, FontFaceDescriptors?][] = [
  ["Pirata One", "fonts/PirataOne-Regular.woff2"],
  ["Dancing Script", "fonts/DancingScript-Bold.woff2", { weight: "700" }],
];
let fontsLoaded: Promise<unknown> | null = null;
function loadFonts() {
  fontsLoaded ??= Promise.all(FONTS.map(async ([family, file, desc]) => {
    try { document.fonts.add(await new FontFace(family, `url(${import.meta.env.BASE_URL}${file})`, desc).load()); }
    catch (e) { console.warn(`title font ${family} unavailable`, e); }
  }));
  return fontsLoaded;
}

/** Links to the legal pages (public/legal/, in French), opened in a new tab so that the game stays. */
export function legalLinks(cls: string) {
  const base = import.meta.env.BASE_URL;
  // the pages show the interface language (they hold English and French)
  const link = (key: string, file: string) => h("a", { href: `${base}legal/${file}?lang=${config().lang.ui}`, target: "_blank", rel: "noopener" }, t(key));
  return h("nav", { class: cls, "aria-label": t("legal.nav") },
    link("legal.notice", "mentions-legales.html"), link("legal.terms", "cgu.html"), link("legal.contact", "contact.html"),
    ...SUPPORT.map(([key, href]) => h("a", { class: "support", href, target: "_blank", rel: "noopener" }, t(key))));
}

/** Voluntary support of the author (Settings > About and the title screen). */
const SUPPORT: [string, string][] = [
  ["legal.kofi", "https://ko-fi.com/batmanfr"],
  ["legal.sponsors", "https://github.com/sponsors/cyberbobjr"],
];

type Item = "replay" | "resume" | "new";
const ITEMS: Item[] = ["replay", "resume", "new"];
/** Letters: the original's (R, J, I) and the initials of the new labels. */
const LETTERS: Record<string, Item> = { r: "replay", p: "replay", j: "resume", c: "resume", i: "new", n: "new", s: "new" };

export function createModernTitle(overlay: HTMLElement, g: Game): ModernTitle {
  let root: HTMLElement | null = null;
  let selected = 0;
  const push = (key: string) => g.input.push({ key, code: "", source: "pointer" });

  function build() {
    const sprite = (name: string) => h("span", { class: "pt-sprite", style: `background-image:url(${assets.url(`packs/pixellab/sprites/${name}.png`)})` });
    const stars = h("div", { class: "pt-stars" });
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let i = 0; i < 90; i++) {
      const s = h("i", { style: `left:${(rnd() * 100).toFixed(2)}%;top:${(rnd() * 70).toFixed(2)}%;animation-delay:${(rnd() * 3.4).toFixed(2)}s` });
      if (rnd() > 0.8) s.classList.add("big");
      stars.append(s);
    }
    const buttons = ITEMS.map((id, i) => h("button", {
      type: "button", class: "pt-item", "data-item": id,
      onclick: () => { selected = i; push("Enter"); },
      onmouseenter: () => select(i),
    }, t(`title.${id}`)));
    const el = h("div", { class: "pt-root", role: "dialog", "aria-label": `${t("title.name")} ${t("title.number")}` },
      stars,
      h("div", { class: "pt-screen" },
        h("span", { class: "pt-moon t" }), h("span", { class: "pt-moon f" }),
        h("div", { class: "pt-niche l" }, sprite("daemon")),
        h("div", { class: "pt-niche r" }, sprite("dragon"),
          h("span", { class: "pt-breath" }, "{"), h("span", { class: "pt-breath b2" }, "}"), h("span", { class: "pt-breath b3" }, "{}")),
        h("div", { class: "pt-credit" },
          h("span", { class: "pt-lord" }, t("title.lord")),
          h("span", { class: "pt-small" }, t("title.and")),
          h("span", { class: "pt-company" }, t("title.company")),
          h("span", { class: "pt-small" }, t("title.present"))),
        h("div", { class: "pt-logo" },
          h("span", { class: "pt-shine" }, h("span", { class: "pt-ice" }, "Prompt"), h("span", { class: "pt-gold" }, "ima")),
          h("span", { class: "pt-ice pt-num" }, t("title.number")), h("span", { class: "pt-cursor" })),
        h("div", { class: "pt-subtitle" }, t("title.subtitle")),
        h("div", { class: "pt-box" },
          h("div", { class: "pt-tagline" }, t("title.tagline")),
          h("div", { class: "pt-menu" }, h("div", { class: "pt-head" }, t("title.options"), h("span", { class: "pt-spiral" }, "@")), ...buttons),
          h("div", { class: "pt-notice", hidden: true }),
          h("div", { class: "pt-foot" }, t("title.credits"), h("small", {}, t("title.creditsSmall")))),
        legalLinks("pt-legal")));
    // music on/off, saved in the settings (remembered after a reload)
    const music = h("button", {
      type: "button", class: "pt-music",
      onclick: (e) => { e.stopPropagation(); void updateConfig({ music: { enabled: !config().music.enabled } }); },
    });
    const showMusic = () => {
      const on = config().music.enabled;
      music.textContent = "♪";
      music.classList.toggle("off", !on);
      music.setAttribute("aria-pressed", on ? "false" : "true");
      music.title = music.ariaLabel = t(on ? "title.musicOn" : "title.musicOff");
    };
    showMusic();
    onConfigChange(showMusic);
    el.querySelector(".pt-screen")!.append(music);
    overlay.append(el);
    return el;
  }

  function select(i: number) {
    selected = (i + ITEMS.length) % ITEMS.length;
    root?.querySelectorAll(".pt-item").forEach((b, k) => b.classList.toggle("on", k === selected));
  }

  function show(opening: boolean) {
    if (!root) root = build();
    root.hidden = false;
    // the opening sequence plays in CSS; a key skips to its end
    root.classList.toggle("opening", opening);
    root.classList.toggle("done", !opening);
    select(selected);
  }

  /** Waits the end of the opening animation, or a key that skips it (the key is then consumed). */
  async function opening() {
    const end = performance.now() + OPENING_MS;
    while (performance.now() < end) {
      const k = await g.input.next(Math.max(1, end - performance.now()));
      if (k) break;
    }
    root?.classList.add("done");
  }

  const choose = (item: Item): TitleChoice | "replay" => (item === "resume" ? "journey" : item === "new" ? "new" : "replay");

  return {
    async run(withOpening) {
      await loadFonts();
      for (let open = withOpening; ;) {
        show(open);
        if (open) await opening();
        for (;;) {
          const k: Key | null = await g.input.next();
          if (!k) continue;
          const key = k.key.length === 1 ? k.key.toLowerCase() : k.key;
          let item: Item | undefined;
          if (key === "ArrowDown") { select(selected + 1); continue; }
          if (key === "ArrowUp") { select(selected - 1); continue; }
          if (key === "Enter" || key === " ") item = ITEMS[selected];
          else item = LETTERS[key];
          if (!item) continue;
          select(ITEMS.indexOf(item));
          const c = choose(item);
          if (c === "replay") { open = true; break; }
          return c;
        }
      }
    },
    async notice(lines) {
      if (!root) return;
      const box = root.querySelector<HTMLElement>(".pt-notice")!, menu = root.querySelector<HTMLElement>(".pt-menu")!;
      box.replaceChildren(...lines.map((l) => h("p", {}, l)));
      box.hidden = false; menu.hidden = true;
      await g.input.next();
      box.hidden = true; menu.hidden = false;
    },
    hide() { if (root) root.hidden = true; },
  };
}

/** Length of the opening sequence in title.css (the last element ends its animation then). */
const OPENING_MS = 4200;
