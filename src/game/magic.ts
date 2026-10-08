// Spells: C)ast (also in combat) and M)ix reagents.
// Ported from AVATAR.EXE (unpacked): cast 1000:6E4A, pay MP 1000:63B4, "Failed!" 1000:6399, context checks
// 1000:6409/6428/6447, projectiles 1000:6466, handlers DS:216E (1000:6558..6DC1), mixing 1000:8C08,
// status lists 1000:4BC7 (reagents) / 1000:4C42 (mixtures).
import { GATE_DESTINATIONS, REAGENTS, SPELLS, WALKABLE_TILES } from "../data/tables";
import { endsTurn } from "./commands";
import type { CombatApi } from "./combat";
import { isUndead, rand8 } from "./combat";
import type { Game } from "./game";
import { DIRS, setTile, tileAt, type Dir } from "./maps";
import { T } from "./tiles";
import { addDrawHook, clearStatusRows, drawStatusTitle, gameMode, shake } from "./endgame/ui";
import { askKey, askMember as askPlayer } from "./prompts";
import { canAct, isAlive } from "./party";
import { peerAtMap } from "./items";
import { MSG_MAGIC as M } from "./texts/magic";
import { playEffect, SFX } from "../audio/speaker";

/**
 * Hooks filled by dungeon.ts while the party is underground (the level data lives in the dungeon module).
 * Coordinates are dungeon cells (0..7); `level` is save.dngLevel. Set them on entry, reset to null on exit.
 */
export interface DungeonHooks {
  /** Cell byte of the level map (DS:8742 + level*64). */
  cell: ((x: number, y: number, level: number) => number) | null;
  setCell: ((x: number, y: number, level: number, v: number) => void) | null;
  /** Leave the dungeon for the overworld at save.dngX/dngY (X-it, Y-up from level 1, Codex ejection). */
  exit: (() => void) | null;
  /** save.x/y/dngLevel/balloonState were changed (Y-up, Z-down, Light, fields): resync and redraw. */
  refresh: (() => void) | null;
  /** Dungeon peer map (1000:C23B) without using a gem: View spell. */
  peer: (() => Promise<void>) | null;
  /** State saved by Q)uit & save underground: the 8 level maps (DNGMAP.SAV) and the wandering monsters. */
  state: (() => { map: Uint8Array; monsters: Uint8Array }) | null;
}

/** Dungeon light counter DS:9320 (= save.balloonState underground): Light spell and torches add 100 turns. */
export function addDungeonLight(g: Game, turns: number) {
  g.save.balloonState = (g.save.balloonState + turns) & 0xffff;
  g.dungeon.refresh?.();
}

/** Dungeon orientation offsets DS:080C/0810 (0 W, 1 N, 2 E, 3 S). */
const DDX = [-1, 0, 1, 0], DDY = [0, -1, 0, 1];
const WALKABLE = new Set(WALKABLE_TILES);
const ABYSS = 24;

interface Ctx { g: Game; who: number; spell: number; api: CombatApi | null; mode: number; }

/** 1000:6399: the failure message and the flee sound. */
async function failed(g: Game) {
  g.con.print(M.failed);
  await playEffect(SFX.FLEE);
}

/**
 * 1000:63B4: MP are paid; noise bursts as many as the MP, then the magic sound (pulse width 0x60 + spell)
 * between two screen flashes; then Negate makes the spell fail.
 */
async function pay(c: Ctx): Promise<boolean> {
  const p = c.g.save.players[c.who];
  const mp = SPELLS[c.spell].mp;
  p.mp = Math.max(0, p.mp - mp);
  await playEffect(SFX.CAST, mp);
  await playEffect(SFX.MAGIC, 0x60 + c.spell);
  if (c.g.spellEffect === "N") { await failed(c.g); return false; }
  return true;
}

async function outdoorsOnly(c: Ctx) { if (c.mode === 1) return true; c.g.con.print(M.outdoorsOnly); await failed(c.g); return false; }
async function combatOnly(c: Ctx) { if (c.mode > 3) return true; c.g.con.print(M.combatOnly); await failed(c.g); return false; }
async function dungeonOnly(c: Ctx) { if (c.mode === 3) return true; c.g.con.print(M.dungeonOnly); await failed(c.g); return false; }

/** Square in front of the party underground. */
function ahead(g: Game): [number, number] {
  const o = g.save.orientation & 3;
  return [(g.save.x + DDX[o]) & 7, (g.save.y + DDY[o]) & 7];
}

/** Projectile spells 1000:6466: Magic Missile 'M', Iceball 'N', Fireball 'O', Kill 0x8C. */
async function projectile(c: Ctx, kind: number) {
  if (!(await combatOnly(c))) return;
  const d = await c.g.askDir(M.dirProjectile);
  if (!d || !(await pay(c))) return;
  const hit = await c.api!.shoot(d, kind);
  if (!hit) { await failed(c.g); return; }
  const r = rand8();
  const dmg = kind === T.MISSILE ? (r % 0x40) | 0x10 : kind === T.MAGIC_FLASH ? (r % 0xe0) | 0x20 : kind === T.HIT_FLASH ? (r % 0x80) | 0x18 : 0xe8;
  await Promise.all([c.api!.flash(hit.x, hit.y), playEffect(SFX.HIT)]); // 1000:64E7
  c.api!.damageAt(hit.x, hit.y, dmg);
}

/** Effect char spells (Jinx, Negate, Protection, Quickness): 10 turns (DS:95A4 / DS:946E). */
async function effect(c: Ctx, ch: string) { if (await pay(c)) c.g.setSpellEffect(ch, 10); }

async function statusSpell(c: Ctx, prompt: string, apply: (p: Ctx) => boolean) {
  const who = await askPlayer(c.g, prompt);
  if (who < 0 || !(await pay(c))) return;
  if (!apply({ ...c, who })) await failed(c.g);
}

/**
 * The overworld is seen through a 32x32 window (DS:8742) copied from the 32x32 world blocks. 1000:26B6 rebuilds it
 * around the party (position 8..23 in it, DS:959C/959D); a step (1000:2839/2891/28E9/2941) moves that position and
 * scrolls the window by 16 only when it leaves 5..26, keeping the half still in view. Blink searches this window, and
 * a field dispelled on the overworld is only cleared in it: it is back once its square leaves the window or the
 * window is rebuilt (Blink, Gate, coming back to the overworld...).
 */
interface WorldWindow { world: Game["world"]; x: number; y: number; wx: number; wy: number; cleared: { x: number; y: number; tile: number }[] }
const windows = new WeakMap<Game, WorldWindow>();
const windowPos = (v: number) => ((v & 15) < 8 ? (v & 15) + 16 : v & 15); // 1000:26B6

function restoreFields(w: WorldWindow, keep: (f: { x: number; y: number }) => boolean) {
  w.cleared = w.cleared.filter((f) => { if (keep(f)) return true; setTile(w.world, f.x, f.y, f.tile); return false; });
}

/** 1000:26B6: window rebuilt around the party from the world blocks. */
function rebuildWindow(g: Game): WorldWindow {
  const old = windows.get(g);
  if (old) restoreFields(old, () => false);
  const w = { world: g.world, x: g.px, y: g.py, wx: windowPos(g.px), wy: windowPos(g.py), cleared: [] };
  windows.set(g, w);
  return w;
}

/** Window of the party now (rebuilt if the party was moved without being tracked). */
function worldWindow(g: Game): WorldWindow {
  const w = windows.get(g);
  return w && w.world === g.world && w.x === g.px && w.y === g.py ? w : rebuildWindow(g);
}

/** Move listener: one step scrolls the window as 1000:2839..2941 do, anything else rebuilds it. */
function trackWindow(g: Game) {
  const w = windows.get(g);
  // first move of a game, or back on the overworld (1000:26B6 is called when leaving a town or a dungeon)
  if (!w || w.world !== g.world) { if (g.map.kind === "world") rebuildWindow(g); return; }
  if (g.map.kind !== "world") { restoreFields(w, () => false); windows.delete(g); return; }
  const dx = ((g.px - w.x + 128) & 255) - 128, dy = ((g.py - w.y + 128) & 255) - 128;
  if (Math.abs(dx) + Math.abs(dy) !== 1) { rebuildWindow(g); return; }
  w.x = g.px; w.y = g.py; w.wx += dx; w.wy += dy;
  if (w.wx < 5) w.wx += 16; else if (w.wx > 26) w.wx -= 16;
  if (w.wy < 5) w.wy += 16; else if (w.wy > 26) w.wy -= 16;
  restoreFields(w, (f) => ((f.x - w.x + w.wx) & 255) < 32 && ((f.y - w.y + w.wy) & 255) < 32);
}

/** Blink 1000:65AA: farthest walkable square of the loaded 32x32 window in that direction. */
async function blink(c: Ctx) {
  const g = c.g, s = g.save, tr = s.transport || T.AVATAR;
  if (tr > 0x13 && tr !== T.BALLOON) {
    if (!(await outdoorsOnly(c))) return;
    const d = await g.askDir(M.dirBlink);
    if (!d || !(await pay(c))) return;
    if ((s.x & s.y) < 0xc0) {
      const [dx, dy] = DIRS[d];
      const { wx, wy } = worldWindow(g); // party position inside the window
      let lx = wx, ly = wy;
      while (lx >= 0 && lx < 32 && ly >= 0 && ly < 32) { lx += dx; ly += dy; }
      do { lx -= dx; ly -= dy; } while (!(lx === wx && ly === wy) && !WALKABLE.has(tileAt(g.world, s.x + lx - wx, s.y + ly - wy)));
      if (lx !== wx || ly !== wy) { g.setPos(s.x + lx - wx, s.y + ly - wy); rebuildWindow(g); return; }
    }
  }
  await failed(g);
}

/** Dispell 1000:66DA */
async function dispell(c: Ctx) {
  const g = c.g, s = g.save;
  if (c.mode === 3) {
    if (!(await pay(c))) return;
    const [x, y] = ahead(g), h = g.dungeon;
    if (h.cell && h.setCell && (h.cell(x, y, s.dngLevel) & 0xf0) === 0xa0) { h.setCell(x, y, s.dngLevel, 0); h.refresh?.(); return; }
  } else if (c.mode > 2 || !(g.inBalloon && s.balloonState !== 0)) {
    const d = await g.askDir(M.dirDispell);
    if (!d || !(await pay(c))) return;
    const [dx, dy] = DIRS[d];
    if (c.mode < 4) {
      const x = g.px + dx, y = g.py + dy;
      if (g.map.kind === "world" || (x >= 0 && y >= 0 && x <= 31 && y <= 31)) {
        const t = tileAt(g.map, x, y);
        // the field becomes the tile the party stands on (DS:9444)
        if (t >= T.POISON_FIELD && t <= T.SLEEP_FIELD) {
          setTile(g.map, x, y, tileAt(g.map, g.px, g.py));
          if (g.map.kind === "world") worldWindow(g).cleared.push({ x: x & 255, y: y & 255, tile: t });
          return;
        }
      }
    } else {
      const api = c.api!, x = api.casterPos.x + dx, y = api.casterPos.y + dy;
      if (x >= 0 && y >= 0 && x < 11 && y < 11) {
        const t = api.tileAt(x, y);
        if (t >= T.POISON_FIELD && t <= T.SLEEP_FIELD) { api.setTile(x, y, api.tileAt(api.casterPos.x, api.casterPos.y)); return; }
      }
    }
  }
  await failed(g);
}

/** Energy field 1000:6882: F)ire, L)ightning, P)oison, S)leep. */
async function energy(c: Ctx) {
  const g = c.g, s = g.save;
  g.con.print(M.energyType);
  const k = (await g.getKey()).toUpperCase();
  const field = ({ F: T.FIRE_FIELD, L: T.ENERGY_FIELD, P: T.POISON_FIELD, S: T.SLEEP_FIELD } as Record<string, number>)[k] ?? -1;
  if (field >= 0) {
    g.con.println(k);
    if (c.mode === 3) {
      if (!(await pay(c))) return;
      const [x, y] = ahead(g), h = g.dungeon;
      if (h.cell && h.setCell) {
        if (h.cell(x, y, s.dngLevel) !== 0) await failed(g);
        h.setCell(x, y, s.dngLevel, 0xa0 | (field & 3)); // written even after "Failed!" (original behaviour)
        h.refresh?.();
      }
      return;
    }
    if (c.mode > 3) {
      const d = await g.askDir(M.dirEnergy);
      if (!d || !(await pay(c))) return;
      const api = c.api!, [dx, dy] = DIRS[d], x = api.casterPos.x + dx, y = api.casterPos.y + dy;
      // only the terrain is tested (list DS:0904, 1000:2999): the field is also laid under a creature
      if (x >= 0 && y >= 0 && x < 11 && y < 11 && WALKABLE.has(api.tileAt(x, y))) { api.setTile(x, y, field); return; }
    }
  }
  await failed(g);
}

/** Gate 1000:69E5: "To Phase:" 1..8 -> moongate coordinates DS:0814/081C. */
async function gate(c: Ctx) {
  const g = c.g, tr = g.save.transport || T.AVATAR;
  if (tr < 0x14 || tr === T.BALLOON) { await failed(g); return; }
  if (!(await outdoorsOnly(c))) return;
  const k = await askKey(g, M.toPhase, "0", "8");
  if (k < 0 || k === 0x30 || !(await pay(c))) return;
  const dest = GATE_DESTINATIONS[k - 0x31];
  g.setPos(dest.x, dest.y);
  rebuildWindow(g);
}

/** Open 1000:6B02: chest under the party (never trapped outside combat), or under the caster in combat. */
async function open(c: Ctx) {
  const g = c.g;
  if (!(await pay(c))) return;
  if (c.mode === 1 && g.inBalloon) { await failed(g); return; }
  if (c.mode === 3) {
    const h = g.dungeon, s = g.save;
    if (h.cell && h.setCell && h.cell(s.x, s.y, s.dngLevel) === 0x40) {
      h.setCell(s.x, s.y, s.dngLevel, 0); h.refresh?.();
      await g.openChest(-1);
      return;
    }
  } else if (c.mode < 4) {
    // 1000:722F: a world chest is an object; a chest of the town map is stolen
    const obj = g.map.kind === "world" ? g.objects.find((o) => o.tile === T.CHEST && o.x === g.px && o.y === g.py) : undefined;
    if (obj) { g.objects = g.objects.filter((o) => o !== obj); await g.openChest(-1); return; }
    if (tileAt(g.map, g.px, g.py) === T.CHEST) {
      setTile(g.map, g.px, g.py, T.BRICK_FLOOR);
      if (g.map.kind === "town") { g.karmaDec(0, 1); g.karmaDec(3, 1); g.karmaDec(5, 1); }
      await g.openChest(-1);
      return;
    }
  } else {
    // 1000:7337: chest under the caster; trap evade roll uses the caster's DEX
    const api = c.api!, { x, y } = api.casterPos;
    if (api.tileAt(x, y) === T.CHEST) {
      api.setTile(x, y, T.DUNGEON_FLOOR);
      const h = c.g.dungeon, s = g.save;
      if (c.g.save.location >= 17 && h.cell && h.setCell && h.cell(s.x, s.y, s.dngLevel) === 0x40) h.setCell(s.x, s.y, s.dngLevel, 0);
      await g.openChest(c.who);
      return;
    }
  }
  g.con.print(M.notHere); // 1000:11AA
}

/** Y-up 1000:6D3D / Z-down 1000:6DC1: random empty square of the new level (32 tries). */
async function changeLevel(c: Ctx, delta: number) {
  const g = c.g, s = g.save, h = g.dungeon;
  if (!(await dungeonOnly(c)) || !(await pay(c))) return;
  if (s.location !== ABYSS && !(delta > 0 && s.dngLevel === 7)) {
    const level = s.dngLevel + delta;
    if (level < 0) { h.exit?.(); return; }
    if (h.cell) {
      for (let k = 0x20; k > 0; k--) {
        const x = rand8() & 7, y = rand8() & 7;
        if (h.cell(x, y, level) === 0) { s.dngLevel = level; s.x = x; s.y = y; h.refresh?.(); return; }
      }
    }
  }
  await failed(g);
}

/** View 1000:6CB2 -> peer 1000:C403 (town/world overview, or the dungeon level). */
async function view(c: Ctx) {
  if (!(await pay(c))) return;
  if (c.g.save.location < 0x11) await peerAtMap(c.g);
  else await c.g.dungeon.peer?.();
}

/** Spell handlers, table DS:216E. */
const HANDLERS: ((c: Ctx) => Promise<void> | void)[] = [
  // A Awaken 1000:6558
  (c) => statusSpell(c, M.whoAwaken, ({ g, who }) => { const p = g.save.players[who]; if (p.status !== "S") return false; p.status = "G"; return true; }),
  blink, // B
  // C Cure 1000:669B
  (c) => statusSpell(c, M.whoCure, ({ g, who }) => { const p = g.save.players[who]; if (p.status !== "P") return false; p.status = "G"; return true; }),
  dispell, // D
  energy, // E
  (c) => projectile(c, T.HIT_FLASH), // F Fireball 'O'
  gate, // G
  // H Heal 1000:6A40: 75..99 HP (1000:09B1)
  (c) => statusSpell(c, M.whoHeal,({ g, who }) => {
    const p = g.save.players[who];
    if (!isAlive(p)) return false;
    p.hp = Math.min(p.hpMax, p.hp + (rand8() % 25) + 75);
    return true;
  }),
  (c) => projectile(c, T.MAGIC_FLASH), // I Iceball 'N'
  (c) => effect(c, "J"), // J Jinx
  (c) => projectile(c, 0x8c), // K Kill
  // L Light 1000:6AB7
  async (c) => { if ((await dungeonOnly(c)) && (await pay(c))) addDungeonLight(c.g, 100); },
  (c) => projectile(c, T.MISSILE), // M Magic missile 'M'
  (c) => effect(c, "N"), // N Negate
  open, // O
  (c) => effect(c, "P"), // P Protection
  (c) => effect(c, "Q"), // Q Quickness
  // R Resurrect 1000:6B68: not in combat; HP is left as it is
  async (c) => {
    if (c.mode < 4) {
      const who = await askPlayer(c.g, M.whoResurrect);
      if (who < 0 || !(await pay(c))) return;
      const p = c.g.save.players[who];
      if (p.status === "D") { p.status = "G"; return; }
    }
    await failed(c.g);
  },
  // S Sleep 1000:6BAE: not undead nor Balron; asleep if rand8 > HP
  async (c) => {
    if (!(await combatOnly(c)) || !(await pay(c))) return;
    for (const m of c.api!.monsters()) if (!isUndead(m.tile) && (m.tile & ~3) !== 0xfc && (m.hp & 0xff) < rand8()) c.api!.sleepAt(m.x, m.y);
  },
  // T Tremor 1000:6BF8
  async (c) => {
    if (!(await combatOnly(c)) || !(await pay(c))) return;
    await shake(c.g);
    for (const m of c.api!.monsters().reverse()) {
      if (m.hp >= 0xc0) continue;
      if ((rand8() & 1) === 0) { await Promise.all([c.api!.flash(m.x, m.y, T.HIT_FLASH), playEffect(SFX.HIT)]); c.api!.damageAt(m.x, m.y, 0xff); } // 1000:6C51
      else if (rand8() & 1) c.api!.setHpAt(m.x, m.y, 0x17);
    }
  },
  // U Undead 1000:6C71
  async (c) => {
    if (!(await combatOnly(c)) || !(await pay(c))) return;
    for (const m of c.api!.monsters().reverse()) if (m.undead && rand8() & 1 && m.hp > 0x17) c.api!.setHpAt(m.x, m.y, 0x17);
  },
  view, // V
  // W Winds 1000:6CC3: the wind comes from the given direction (DS:96F2: 0 W, 1 N, 2 E, 3 S)
  async (c) => {
    if (!(await outdoorsOnly(c))) return;
    const d = await c.g.askDir(M.fromDir);
    if (!d || !(await pay(c))) return;
    c.g.sky.wind = ({ W: 0, N: 1, E: 2, S: 3 } as Record<Dir, number>)[d];
  },
  // X X-it 1000:6D22: level = 0xFFFF -> back to the surface
  async (c) => { if ((await dungeonOnly(c)) && (await pay(c))) c.g.dungeon.exit?.(); },
  (c) => changeLevel(c, -1), // Y
  (c) => changeLevel(c, 1), // Z
];

/** Mixtures list in the status area while choosing a spell (1000:4C42). */
function mixtureList(g: Game) {
  return addDrawHook(g, (r) => {
    clearStatusRows(r);
    drawStatusTitle(r, M.mixturesTitle);
    let row = 1, col = 24;
    for (let i = 0; i < 26 && col <= 0x26; i++) {
      const n = g.save.mixtures[i];
      if (!n) continue;
      r.drawText(`${String.fromCharCode(65 + i)}-${String(n).padStart(2, "0")}`, col, row);
      if (++row === 9) { row = 1; col += 5; }
    }
  });
}

/** Reagents list in the status area while mixing (1000:4BC7): "A-5-Sulfur Ash". */
function reagentList(g: Game) {
  return addDrawHook(g, (r) => {
    clearStatusRows(r);
    drawStatusTitle(r, M.reagentsTitle);
    let row = 1;
    for (let i = 0; i < 8; i++) {
      const n = g.save.reagents[i];
      if (!n) continue;
      r.drawText(`${String.fromCharCode(65 + i)}${String(n).padStart(2, "-")}-${REAGENTS[i]}`.slice(0, 16), 24, row++);
    }
  });
}

/** Cast 1000:6E4A. `api` is set in combat (caster = the member whose turn it is). */
async function cast(g: Game, api: CombatApi | null) {
  const s = g.save, mode = api ? 4 : gameMode(g);
  let who: number;
  if (!api) {
    g.con.print(M.castSpell);
    who = await askPlayer(g, M.player);
    if (who < 0) return;
    if (!canAct(s.players[who])) { g.con.print(M.disabled); return; }
  } else {
    g.con.println("");
    who = s.players.indexOf(api.caster);
  }
  const restore = mixtureList(g);
  let k: number;
  try { k = await askKey(g, M.spell, "A", "Z"); } finally { restore(); }
  if (k < 0) return;
  const spell = k - 0x41;
  g.con.print(SPELLS[spell].name + M.spellBang);
  if (s.mixtures[spell] === 0) { g.con.print(M.noneLeft); return; }
  s.mixtures[spell]--; // consumed before the MP check
  if (s.players[who].mp < SPELLS[spell].mp) { g.con.print(M.mpTooLow); await failed(g); return; }
  await HANDLERS[spell]({ g, who, spell, api, mode });
}

/** Mix reagents 1000:8C08: one mixture per success; loops back to "For Spell:" until Enter/Esc there. */
async function mix(g: Game) {
  const s = g.save;
  for (;;) {
    g.con.print(M.mixReagents);
    let k: number;
    const restoreM = mixtureList(g);
    try { k = await askKey(g, M.forSpell, "A", "Z"); } finally { restoreM(); }
    if (k < 0) return;
    const spell = k - 0x41;
    g.con.println(SPELLS[spell].name);
    const saved = s.reagents.slice();
    let mask = 0, done = false;
    const restoreR = reagentList(g);
    try {
      while (!done) {
        const r = await askKey(g, M.reagent, "A", "H");
        if (r === -2) { s.reagents.splice(0, 8, ...saved); return; } // Esc: reagents given back, mixing ends
        if (r === -1) {
          if (mask === 0) g.con.print(M.nothingMixed);
          else {
            g.con.print(M.youMix);
            if (SPELLS[spell].reagentMask === mask) {
              g.con.print(M.success);
              s.mixtures[spell] = Math.min(99, s.mixtures[spell] + 1);
            } else g.con.print(M.fizzles);
          }
          done = true;
          continue;
        }
        const i = r - 0x41;
        if (s.reagents[i] === 0) { g.con.print(M.noneLeft); done = true; continue; } // reagents already added are lost
        mask |= 0x80 >> i;
        s.reagents[i]--;
      }
    } finally { restoreR(); }
  }
}

export function installMagic(g: Game) {
  g.onMove(trackWindow);
  g.commands.register(
    { key: "c", id: "cast", contexts: ["world", "town", "dungeon"], run: async (env) => { await cast(g, null); endsTurn(env); } },
    { key: "c", id: "cast", contexts: ["combat"], run: (env) => cast(g, env.combat!) },
    { key: "m", id: "mix", contexts: ["world", "town", "dungeon"], run: async (env) => { await mix(g); endsTurn(env); } },
  );
}
