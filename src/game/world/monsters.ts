// Overworld monsters (1000:5851, 1000:5712), their fights and the party's death (1000:0EB1);
// pirate ships and sea serpents/dragons firing at the party (1000:564B), whirlpools and twisters
// (1000:7918), the party hazard they cause (1000:1584).
import { COMBAT_MAP_RULES, MONSTER_SPAWN } from "../../data/tables";
import { creatureInfo, isNonEvil, spawnGroup, type CombatRequest } from "../combat";
import { loadArena } from "../arenas";
import type { Game } from "../game";
import { LOCATIONS } from "../locations";
import { tileAt } from "../maps";
import { rand, rand8 } from "../rng";
import { T, tileFlags, Walk } from "../tiles";
import type { WorldObject } from "./objects";
import { MSG_CORE } from "../texts/core";
import { playEffect, SFX } from "../../audio/speaker";
import { drawViewTile, hazardFlash } from "../endgame/ui";
import { sleep } from "../prompts";
import { viewTiles } from "../view";
import { invertAreas, partyRowsRects } from "../../ui/invert";

const wrap = (v: number) => ((v % 256) + 256) % 256;
const delta = (a: number, b: number) => { const d = wrap(a - b); return d > 127 ? d - 256 : d; };

/** Pirate ship tiles 0x80..0x83: the low bits are its heading (0 W, 1 N, 2 E, 3 S, as the party's ships). */
export const isPirate = (t: number) => (t & ~3) === T.PIRATE_SHIP;
const HEADING_STEP: readonly [number, number][] = [[-1, 0], [0, -1], [1, 0], [0, 1]];
/** Whirlpool (0x8C) and twister (0x8E), whatever their animation frame. */
const WHIRLPOOL = 0x8c, TWISTER = 0x8e;
/** 1000:786F: where a whirlpool throws the party. */
const WHIRLPOOL_EXIT = { x: 0x7f, y: 0x4e };

export function worldMonsterAt(g: Game, x: number, y: number): WorldObject | undefined {
  return g.objects.find((o) => o.tile >= 0x80 && o.x === (x & 255) && o.y === (y & 255));
}

/**
 * The overworld part of the end of a turn (1000:1C53): nothing moves while the balloon flies; else
 * whirlpools and twisters strike (1000:7918), the monsters move or fire (1000:5712) and spawn
 * (1000:5851), and whirlpools and twisters strike again. Run by the main loop after the command
 * (Game.endTurn only flags it), because the shots and strikes take time.
 */
export async function worldTurn(g: Game) {
  if (g.inBalloon && g.save.balloonState !== 0) return;
  if (await vortices(g)) return;
  if (await moveWorldMonsters(g)) return;
  await vortices(g);
}

/** 1000:5712 + 1000:5851. Returns true when the party died (its ship sank). */
async function moveWorldMonsters(g: Game): Promise<boolean> {
  const s = g.save;
  const monsters = g.objects.filter((o) => o.tile >= 0x80);
  // despawn monsters that are far away
  g.objects = g.objects.filter((o) => o.tile < 0x80 || (Math.abs(delta(o.x, g.px)) < 16 && Math.abs(delta(o.y, g.py)) < 16));
  for (const m of monsters) {
    if (!g.objects.includes(m)) continue;
    const info = creatureInfo(m.tile);
    const flags = info.def?.flags ?? [];
    const dx = delta(g.px, m.x), dy = delta(g.py, m.y);
    const dist = Math.abs(dx) + Math.abs(dy);
    if (dist === 1 && !flags.includes("randomMove")) {
      if (!(isNonEvil(m.tile) && rand(2))) { g.pendingAttack ??= m; return false; }
    }
    if (flags.includes("cannons") && isPirate(m.tile)) {
      // 1000:568F: within 3 squares and broadside (heading W/E with the party in its column, N/S in
      // its row) it fires its cannons, else it sails (1000:5500)
      const h = m.tile & 3;
      if (dist < 4 && (h === 0 || h === 2 ? dx === 0 : dy === 0)) {
        if (await fireAtParty(g, m.x, m.y, Math.sign(dx), Math.sign(dy), T.MISSILE)) return true;
      } else pirateSail(g, m, dx, dy);
      continue;
    }
    // 1000:5712: sea serpents, lava lizards and dragons breathe fire half the time when the party is
    // within 4 squares on both axes, aimed diagonally if need be; then they move as usual
    if (flags.includes("breathesOverworld") && Math.abs(dx) < 5 && Math.abs(dy) < 5 && rand8() & 1) {
      if (await fireAtParty(g, m.x, m.y, Math.sign(dx), Math.sign(dy), T.HIT_FLASH)) return true;
      if (!g.objects.includes(m)) continue;
    }
    let sx = 0, sy = 0;
    if (flags.includes("randomMove") || rand(4) === 0) {
      [sx, sy] = [[1, 0], [-1, 0], [0, 1], [0, -1]][rand(4)];
    } else if (Math.abs(dx) >= Math.abs(dy)) sx = Math.sign(dx); else sy = Math.sign(dy);
    const nx = wrap(m.x + sx), ny = wrap(m.y + sy);
    // 1000:4E94: whirlpools and twisters may move onto the party and onto other objects (1000:7918)
    const vortex = flags.includes("randomMove");
    if (!vortex && nx === g.px && ny === g.py) continue;
    const t = tileAt(g.world, nx, ny);
    const ok = flags.includes("sea") ? t < 3 || (flags.includes("flies") && (tileFlags(t) & Walk.Foot) !== 0)
      : flags.includes("flies") ? (tileFlags(t) & (Walk.Foot | Walk.Ship)) !== 0
      : (tileFlags(t) & Walk.Foot) !== 0 && t !== T.TOWN && t !== T.CASTLE && t !== T.VILLAGE && t !== T.LCB_ENTRANCE && t !== T.DUNGEON && t !== T.SHRINE;
    if (ok && (vortex || !g.objects.some((o) => o.x === nx && o.y === ny))) { m.x = nx; m.y = ny; }
  }
  // spawning: 1/16 per turn, up to 4 monsters, away from the party
  if (g.objects.filter((o) => o.tile >= 0x80).length < MONSTER_SPAWN.overworldSlots && rand(16) === 0) {
    const ox = rand(32) - 16, oy = rand(32) - 16;
    if (Math.abs(ox) > 5 && Math.abs(oy) > 5) {
      const x = wrap(g.px + ox), y = wrap(g.py + oy);
      const t = tileAt(g.world, x, y);
      let tile = -1;
      if (t < 2 && rand(8) === 0) tile = MONSTER_SPAWN.seaTiles[rand(8)];
      else if (t >= T.GRASS && t <= T.HILLS) {
        const mask = MONSTER_SPAWN.landMaskByMoves.find((e) => s.moves < e.below)!.mask;
        tile = MONSTER_SPAWN.landBaseTile + 4 * (rand8() & rand8() & mask);
      }
      if (tile >= 0 && !g.objects.some((o) => o.x === x && o.y === y)) g.objects.push({ tile, x, y });
    }
  }
  // bridge trolls (1000:9209)
  if (tileAt(g.world, g.px, g.py) === T.BRIDGE && rand(8) === 0) {
    g.con.print(MSG_CORE.bridgeTrolls);
    g.pendingAttack ??= { tile: 0xa4, x: g.px, y: g.py };
  }
  return false;
}

// ---------------------------------------------------------------- pirate ships

/** 1000:5500: a pirate ship sails ahead when the party lies ahead of it, else turns (1000:5443). */
function pirateSail(g: Game, m: WorldObject, dx: number, dy: number) {
  const h = m.tile & 3;
  const ahead = h === 0 ? dx < 0 : h === 1 ? dy < 0 : h === 2 ? dx > 0 : dy > 0;
  if (ahead) pirateStep(g, m);
  else pirateTurn(g, m, dx, dy);
}

/** 1000:5443: far away (over 5 squares), or 1 time in 4, it turns towards the party; else it sails ahead. */
function pirateTurn(g: Game, m: WorldObject, dx: number, dy: number) {
  if (Math.abs(dx) + Math.abs(dy) > 5 || (rand8() & 3) === 0) {
    m.tile = T.PIRATE_SHIP | (Math.abs(dx) < Math.abs(dy) ? (dy < 0 ? 1 : 3) : dx < 0 ? 0 : 2);
    return;
  }
  pirateStep(g, m);
}

/**
 * 1000:53AF: one square ahead, on deep or plain water (1000:4E94: tiles 0-1) not taken by an object
 * or the party, and when the wind allows it (1000:2A5A, as for the party's ships); blocked, it turns
 * by a random quarter (or not at all).
 */
function pirateStep(g: Game, m: WorldObject) {
  const h = m.tile & 3;
  const x = wrap(m.x + HEADING_STEP[h][0]), y = wrap(m.y + HEADING_STEP[h][1]);
  const free = tileAt(g.world, x, y) < 2 && !(x === g.px && y === g.py) && !g.objects.some((o) => o.x === x && o.y === y);
  if (!free) {
    const r = rand8(); // signed byte: its sign is the turn
    m.tile = T.PIRATE_SHIP | ((h + (r === 0 ? 0 : r < 128 ? 1 : -1)) & 3);
    return;
  }
  // DS:9148 is read before the end of turn counts the move (Game.endTurn already did)
  const t4 = (g.save.moves - 1) & 3, wind = g.sky.wind;
  if ((h === wind && t4 !== 0) || (((h + 2) & 3) === wind && t4 === 0)) return;
  m.x = x; m.y = y;
}

/**
 * 1000:5569 / 1000:564B: a cannonball (tile 0x4D, pirates) or a fire bolt (0x4F) leaves (x, y) with
 * the cannon sound and flies 3 squares by (sx, sy). The first object in the way stops it with the hit
 * noise: monsters are sunk 1 time in 4, other objects (ships, horses...) always. Reaching the party,
 * the hit tile shows on the party's square and the party takes a hazard (1000:1584). No message.
 * Returns true when the party died.
 */
async function fireAtParty(g: Game, x: number, y: number, sx: number, sy: number, tile: number): Promise<boolean> {
  await playEffect(SFX.CANNON);
  let shot: { vx: number; vy: number } | null = null;
  const restore = g.layers.push({ name: "shot", draw: (r) => { if (shot) drawViewTile(r, tile, shot.vx, shot.vy); } });
  try {
    for (let k = 1; k <= 3; k++) {
      x = wrap(x + sx); y = wrap(y + sy);
      if (x === g.px && y === g.py) {
        shot = null;
        return await withCentreTile(g, T.HIT_FLASH, () => partyHazard(g));
      }
      const o = g.objects.find((ob) => ob.x === x && ob.y === y); // 1000:0A58
      if (o) {
        shot = null;
        await playEffect(SFX.HIT);
        if (o.tile >= 0x80 && rand8() & 3) return false;
        g.objects = g.objects.filter((ob) => ob !== o);
        return false;
      }
      shot = { vx: 5 + delta(x, g.px), vy: 5 + delta(y, g.py) };
      await sleep(80);
    }
    return false;
  } finally {
    restore.remove();
  }
}

/** The viewport as it is now with `tile` on the party's square (DS:95AE drawn at 5,5 by 1000:36C7), while `fn` runs. */
async function withCentreTile<R>(g: Game, tile: number, fn: () => Promise<R>): Promise<R> {
  const view = viewTiles(g);
  view[60] = tile;
  const layer = g.layers.push({ name: "centre", view: () => view });
  try { return await fn(); } finally { layer.remove(); }
}

// ---------------------------------------------------------------- party hazard

/**
 * 1000:1584 on the overworld and in towns (the dungeon has its own, dungeon.ts): the party flashes
 * (hazardFlash); on a ship the hull loses 10 and below 10 the ship sinks (DS:0660) and the party dies;
 * else each member, last first, 1 time in 2: 10 + rand % 15 damage. Returns true when the ship sank.
 */
export async function partyHazard(g: Game): Promise<boolean> {
  await hazardFlash(g);
  const s = g.save;
  if (g.onShip) {
    const hull = s.shipHull;
    s.shipHull = hull - 10;
    if (hull < 10) {
      s.shipHull = 0;
      // the lines are inverted once more, but the status redraw (1000:0CF7) that follows wipes them
      g.con.print(MSG_CORE.shipSinks);
      await partyDeath(g);
      return true;
    }
    return false;
  }
  for (const p of g.members.slice().reverse())
    if ((rand8() & 1) && p.status !== "D") g.damagePlayer(p, (rand8() % 15) + 10);
  return false;
}

// ---------------------------------------------------------------- whirlpools and twisters

/** 1000:7918: each whirlpool, then each twister, strikes what is on its square. Returns true when the party died. */
async function vortices(g: Game): Promise<boolean> {
  for (const o of g.objects.slice().reverse()) {
    if (!g.objects.includes(o) || g.map.kind !== "world") continue;
    const base = o.tile & ~1;
    if (base === WHIRLPOOL && await whirlpool(g, o)) return true;
    if (base === TWISTER && await twister(g, o)) return true;
  }
  return false;
}

/**
 * 1000:786F: a whirlpool on the party's square shows on it, throws the party to (0x7F, 0x4E) with the
 * long falling sweep (effect 11), the party takes a hazard and ends up on a ship facing west.
 */
async function whirlpool(g: Game, o: WorldObject): Promise<boolean> {
  if (o.x === g.px && o.y === g.py) {
    const died = await withCentreTile(g, WHIRLPOOL, async () => {
      g.setPos(WHIRLPOOL_EXIT.x, WHIRLPOOL_EXIT.y);
      await playEffect(SFX.WHIRLPOOL);
      return partyHazard(g);
    });
    if (died) return true;
    g.save.transport = T.SHIP_W;
  }
  await swallow(g, o, SFX.WHIRLPOOL);
  return false;
}

/** 1000:78D1: a twister on the party's square: the long rising sweep (effect 12), then four hazards. */
async function twister(g: Game, o: WorldObject): Promise<boolean> {
  if (o.x === g.px && o.y === g.py) {
    await playEffect(SFX.TWISTER);
    for (let i = 0; i < 4; i++) if (await partyHazard(g)) return true;
  }
  await swallow(g, o, SFX.TWISTER);
  return false;
}

/** 1000:7821: every other object on the vortex's square disappears, each with the vortex sound. */
async function swallow(g: Game, v: WorldObject, sfx: number) {
  for (const o of g.objects.slice().reverse()) {
    if (o === v || o.x !== v.x || o.y !== v.y || !g.objects.includes(o)) continue;
    g.objects = g.objects.filter((ob) => ob !== o);
    await playEffect(sfx);
  }
}

// ---------------------------------------------------------------- fights and death

/** Overworld (or town) combat against one creature; the arena depends on the terrain (1000:7C65). */
export async function worldFight(g: Game, m: WorldObject, context: CombatRequest["context"] = "world") {
  const info = creatureInfo(m.tile);
  g.con.print(MSG_CORE.attackedBy + info.name + "\n");
  const partyTile = tileAt(g.map, g.px, g.py);
  const monsterTile = tileAt(g.map, m.x, m.y);
  const onShip = g.onShip;
  const rules = COMBAT_MAP_RULES;
  const pirate = isPirate(m.tile);
  let file: string;
  if (onShip) file = pirate ? rules.onShip.vsPirateShip : monsterTile < 3 ? rules.onShip.enemyOnWater : rules.onShip.otherwise;
  else if (pirate) file = rules.onLand.vsPirateShip;
  else if (monsterTile < 3) file = rules.onLand.enemyOnWater;
  else file = rules.onLand.byPartyTile[partyTile] ?? rules.onLand.default;
  const arena = await loadArena(file);
  const fightTile = pirate ? rules.pirateCrewTile : m.tile;
  const monsters = context === "town" ? [{ tile: m.tile, x: arena.monsterPos[0][0], y: arena.monsterPos[0][1] }] : spawnGroup(fightTile, arena, g.save.members);
  const res = await g.fight({ arena, monsters, context: onShip ? "ship" : context });
  if (res.outcome === "won") {
    g.objects = g.objects.filter((o) => o !== m);
    if (context === "town" && g.map.kind === "town") g.map.npcs = g.map.npcs.filter((n) => !(n.x === m.x && n.y === m.y));
    if (pirate) g.objects.push({ tile: T.SHIP_W, x: m.x, y: m.y }); // the captured ship
    else if (res.chest && context === "world" && (tileFlags(tileAt(g.map, m.x, m.y)) & Walk.Foot)) g.objects.push({ tile: T.CHEST, x: m.x, y: m.y });
  }
}

/** "All is Dark..." — Lord British resurrects the party (1000:0EB1). */
export async function partyDeath(g: Game) {
  const M = MSG_CORE;
  const lines = [M.allIsDark, M.butWait, M.whereAmI, M.amIDead, M.afterlife, M.youHear, M.feelMotion];
  for (const l of lines) { g.con.print(l); await new Promise((r) => setTimeout(r, 1200)); }
  for (const p of g.members) { p.status = "G"; p.hp = p.hpMax; }
  g.map = g.world;
  g.save.location = 0;
  g.save.transport = T.AVATAR;
  g.objects = [];
  g.setPos(LOCATIONS[1].x, LOCATIONS[1].y + 1);
  g.con.print(MSG_CORE.lordBritishRevives);
}
