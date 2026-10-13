// Responsive game screen (config.display.layout "modern"): the canvas shows only the 11x11 map (Renderer
// compact crop) and the rest of the original screen becomes HTML next to it or below it: the party (or the list
// a layer shows in its place: shops, mixtures, reagents), food, gold, the active spell, the moons, the wind or
// the dungeon level, and the console. The game keeps drawing the classic 320x200 screen; these panels read the
// same state each frame. Interpretation of the port: the original has one fixed 320x200 layout.
import type { Game } from "../../game/game";
import { CLASS_NAMES } from "../../game/game";
import { t } from "../../i18n/i18n";
import { config, onConfigChange, updateConfig } from "../../config/config";
import type { ScreenRect } from "../../render/renderer";
import { h } from "./dom";
import type { Shell } from "./shell";
import "./hud.css";

/**
 * A moon in phase 0 (new) .. 4 (full) .. 7, as the status line's glyphs 0x14..0x1B: a disc whose dark part is an
 * inset shadow sliding across it (waxing from the right, waning from the left).
 */
function moon(phase: number, kind: "trammel" | "felucca") {
  const p = phase & 7, offset = p === 0 ? 0 : p <= 4 ? (4 - p) * 0.25 : -(p - 4) * 0.25;
  return h("i", { class: `hud-moon ${kind}${p === 0 ? " new" : ""}`, style: `--shade:${offset}em` });
}

/** Party rows (0..7) covered by the inverted status-line areas (src/ui/invert.ts statusRowRect). */
function flashedRows(rects: readonly ScreenRect[]): Set<number> {
  const out = new Set<number>();
  for (const r of rects) {
    if (r.x < 184 || r.y >= 72) continue;
    for (let y = r.y; y < r.y + r.h; y += 8) if (y >= 8 && y < 72) out.add((y >> 3) - 1);
  }
  return out;
}

export function installHud(shell: Shell, g: Game): void {
  const canvas = g.r.gl.domElement;
  const map = h("div", { class: "hud-map" });
  const party = h("section", { class: "hud-panel hud-party", "aria-label": t("hud.party") });
  const res = h("section", { class: "hud-panel hud-res" });
  const con = h("section", { class: "hud-panel hud-console", "aria-live": "polite", "aria-label": t("hud.console") });
  const side = h("div", { class: "hud-side" }, party, res, con);
  const grid = h("div", { class: "hud-grid" }, map, side);
  canvas.replaceWith(grid);
  map.append(canvas);
  shell.stage.classList.add("layout-modern");
  g.r.compact = true;
  g.r.resize();

  // music on/off during the game (the same setting as the title screen's knob, remembered)
  const music = h("button", {
    type: "button", class: "hud-music",
    onclick: () => void updateConfig({ music: { enabled: !config().music.enabled } }),
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

  let partyKey = "", resKey = "", conKey = "", solo: boolean | null = null;
  const frame = () => {
    requestAnimationFrame(frame);
    const s = g.save, { base, layers } = g.layers.visible();
    const playing = !!s && !!g.map && base;
    if (solo !== !playing) {
      solo = !playing;
      grid.classList.toggle("solo", solo);
      side.hidden = solo;
      g.r.resize();
    }
    if (!playing || !s) return;

    // party, or the list a layer shows instead
    let list: { title: string; rows: string[] } | null = null;
    for (let i = layers.length - 1; i >= 0 && !list; i--) list = layers[i].panel?.() ?? layers[i].status?.() ?? null;
    const flash = flashedRows(g.layers.inverts());
    const members = g.members.slice(0, s.members);
    const pk = JSON.stringify([list, members.map((p) => [p.name, p.klass, p.hp, p.hpMax, p.status]), g.activeMember, [...flash]]);
    if (pk !== partyKey) {
      partyKey = pk;
      if (list) party.replaceChildren(h("h2", {}, list.title), h("pre", { class: "hud-list" }, list.rows.join("\n")));
      else party.replaceChildren(...members.map((p, i) => {
        const hpPct = p.hpMax > 0 ? Math.max(0, Math.min(100, Math.round((100 * p.hp) / p.hpMax))) : 0;
        const state = p.status === "P" ? "poison" : p.status === "S" ? "sleep" : p.status === "D" ? "dead" : hpPct < 25 ? "low" : "";
        return h("div", { class: `hud-member ${state}${i === g.activeMember ? " turn" : ""}${flash.has(i) ? " flash" : ""}` },
          h("span", { class: "hud-n" }, String(i + 1)),
          h("span", { class: "hud-name" }, p.name),
          // hit points, and the status letter of the original when it is not Good
          h("span", { class: "hud-hp" }, String(p.hp), p.status !== "G" ? h("b", { class: "hud-st", title: t(`hud.status.${p.status}`) }, p.status) : null),
          h("span", { class: "hud-class" }, CLASS_NAMES[p.klass] ?? ""),
          h("span", { class: "hud-bar" }, h("i", { style: `width:${hpPct}%` })));
      }));
    }

    // food, gold, spell effect, moons, wind or the layers' captions (dungeon level and facing)
    let caption: string[] | null = null;
    for (let i = layers.length - 1; i >= 0 && !caption; i--) caption = layers[i].caption?.() ?? null;
    const pad = (n: number) => String(n).padStart(4, "0");
    const wind = g.map.kind === "world" && !caption ? t(`hud.wind.${g.sky.wind}`) : null;
    const effect = g.spellEffect && g.spellEffect >= "A" ? g.spellEffect : "";
    const rk = JSON.stringify([s.food, s.gold, effect, s.trammelPhase, s.feluccaPhase, wind, caption]);
    if (rk !== resKey) {
      resKey = rk;
      const parts = [
        h("span", {}, t("hud.food"), " ", h("b", {}, pad(Math.floor(s.food / 100)))),
        h("span", {}, t("hud.gold"), " ", h("b", {}, pad(s.gold))),
        effect ? h("span", { class: "hud-effect", title: t("hud.effect") }, effect) : null,
        h("span", { class: "hud-moons", title: t("hud.moons") }, moon(s.trammelPhase, "trammel"), moon(s.feluccaPhase, "felucca")),
        wind ? h("span", {}, wind) : null,
        ...(caption ?? []).map((c) => h("span", {}, c)),
      ];
      res.replaceChildren(...parts.filter((p): p is HTMLSpanElement => p !== null), music);
    }

    // console: the game's 16-column lines, the blinking cursor after the last one
    const lines = g.con.lines, cursor = g.con.cursor;
    const ck = JSON.stringify([lines, cursor]);
    if (ck !== conKey) {
      conKey = ck;
      con.replaceChildren(...lines.map((l, i) => h("div", { class: "hud-line" }, l, i === lines.length - 1 && cursor ? h("span", { class: "hud-cursor" }) : null)));
    }
  };
  requestAnimationFrame(frame);
}
