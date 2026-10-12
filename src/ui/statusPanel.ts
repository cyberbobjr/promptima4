// The right-hand side of the game screen: moons, party list (or a mode's panel), food and gold,
// active spell effect and the message console.
import type { Renderer } from "../render/renderer";
import { CON_COL, CON_H, CON_ROW } from "../game/console";
import type { Game } from "../game/game";
import type { StatusPanel } from "./layers";

/**
 * Width of the upper panels (party list, food and gold): 15 columns, as in the original, where column 39 is
 * the right border of START.EGA around them. The console below has no border and uses all 16 columns.
 */
const PANEL_W = 15;

export function drawStatus(g: Game, r: Renderer) {
  const s = g.save;
  // moons
  r.drawGlyph(0x14 + s.trammelPhase, 11, 0);
  r.drawGlyph(0x14 + s.feluccaPhase, 12, 0);
  // party list, or an inventory panel set by shops (title on row 0, 8 rows of PANEL_W chars)
  const sv: StatusPanel | null = g.layers.top("status")?.() ?? null;
  if (sv) {
    r.fillRect(CON_COL * 8, 0, PANEL_W * 8, 8, 0);
    r.drawText(sv.title.slice(0, PANEL_W), CON_COL + ((PANEL_W - Math.min(PANEL_W, sv.title.length)) >> 1), 0);
  }
  for (let i = 0; i < 8; i++) {
    const row = 1 + i;
    r.fillRect(CON_COL * 8, row * 8, PANEL_W * 8, 8, 0);
    if (sv) { r.drawText((sv.rows[i] ?? "").slice(0, PANEL_W), CON_COL, row); continue; }
    if (i >= s.members) continue;
    const p = s.players[i];
    r.drawText(`${i + 1}-${p.name.slice(0, 9)}`, CON_COL, row);
    const hp = String(p.hp);
    r.drawText(hp + p.status, CON_COL + PANEL_W - hp.length - 1, row);
    if (i === g.activeMember) {
      // highlight the member whose turn it is (black background becomes blue)
      r.ui.globalCompositeOperation = "lighter";
      r.fillRect(CON_COL * 8, row * 8, PANEL_W * 8, 8, 1);
      r.ui.globalCompositeOperation = "source-over";
    }
  }
  r.fillRect(CON_COL * 8, 10 * 8, PANEL_W * 8, 8, 0);
  const pad = (n: number) => String(n).padStart(4, "0");
  r.drawText(`F:${pad(Math.floor(s.food / 100))}   G:${pad(s.gold)}`, CON_COL, 10);
  // active spell effect letter after the food counter (1000:0CF7)
  if (g.spellEffect && g.spellEffect >= "A") r.drawText(g.spellEffect, CON_COL + 7, 10);
  // console
  r.fillRect(CON_COL * 8, CON_ROW * 8, 16 * 8, CON_H * 8, 0);
  g.con.lines.forEach((line, i) => r.drawText(line, CON_COL, CON_ROW + i));
  const last = g.con.lines.length - 1;
  if (g.con.cursor && g.con.lines[last].length < 16) r.drawGlyph(0x1c + (g.frame & 3), CON_COL + g.con.lines[last].length, CON_ROW + last);
}
