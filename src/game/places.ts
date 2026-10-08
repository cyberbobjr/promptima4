// Places: entering towns, castles, dungeons and shrines, townsfolk movement, floors, T)alk, O)pen, J)immy.
import { assets } from "../assets/store";
import { MAP_ENTRY } from "../data/tables";
import type { Game } from "./game";
import { LocKind, locationAt, SHRINES, VIRTUES, type LocationDef } from "./locations";
import { DIRS, setTile, tileAt, type Dir, type TownMap } from "./maps";
import { rand } from "./rng";
import { talkTo } from "./talk";
import { isTalkOver, T, tileFlags, Walk } from "./tiles";
import { runDungeon } from "./dungeon";
import { MSG_CORE } from "./texts/core";
import { TALK } from "./town/strings";
import { playEffect, SFX } from "../audio/speaker";

/** Townsfolk movement at the end of a turn; hostile ones attack when adjacent. */
export function moveNpcs(g: Game, town: TownMap) {
  for (const n of town.npcs) {
    if (n.movement === 0) continue;
    // hostile townsfolk (guards after a crime, movement 0xFF) attack when adjacent
    if ((n.hostile || n.movement === 0xff) && Math.abs(n.x - g.px) + Math.abs(n.y - g.py) === 1) {
      g.pendingAttack = { tile: n.tile, x: n.x, y: n.y };
      continue;
    }
    let dx = 0, dy = 0;
    if (n.movement === 1) {
      if (rand(2)) continue;
      const d = (["N", "S", "E", "W"] as Dir[])[rand(4)];
      [dx, dy] = DIRS[d];
    } else {
      // follow / attack: step towards the party
      const ddx = Math.sign(g.px - n.x), ddy = Math.sign(g.py - n.y);
      if (Math.abs(g.px - n.x) > Math.abs(g.py - n.y)) dx = ddx; else dy = ddy;
    }
    const nx = n.x + dx, ny = n.y + dy;
    if (nx < 0 || ny < 0 || nx >= 32 || ny >= 32) continue;
    if (!(tileFlags(tileAt(town, nx, ny)) & Walk.Foot) || tileAt(town, nx, ny) === T.DOOR) continue;
    if (nx === g.px && ny === g.py) continue;
    if (town.npcs.some((o) => o !== n && o.x === nx && o.y === ny)) continue;
    n.x = nx; n.y = ny;
  }
}

/** Opened doors close again after 4 turns. */
export function closeDoors(g: Game) {
  for (const d of g.openedDoors) if (--d.turns === 0) setTile(g.map, d.x, d.y, T.DOOR);
  g.openedDoors = g.openedDoors.filter((d) => d.turns > 0);
}

export async function enter(g: Game) {
  g.con.print(MSG_CORE.enter);
  if (g.map.kind !== "world" || !g.onFoot && !g.onHorse) { g.con.print(MSG_CORE.what); return; }
  // shrines (1000:4018: tile 0x1E under the party)
  const shrine = SHRINES.find((s) => s.x === g.px && s.y === g.py);
  if (shrine && tileAt(g.world, g.px, g.py) === T.SHRINE) {
    g.con.print(MSG_CORE.shrineOf + VIRTUES[shrine.virtue] + MSG_CORE.bang);
    g.con.newline();
    if (!g.onFoot) { g.con.print(MSG_CORE.onlyOnFoot); return; }
    await g.enterShrine(shrine.virtue);
    return;
  }
  const loc = locationAt(g.px, g.py);
  if (!loc) { g.con.print(MSG_CORE.what); return; }
  const t = tileAt(g.world, g.px, g.py);
  const M = MSG_CORE;
  // "ruin!\n\n", "castle!\n\n"... (DS:176C..)
  g.con.print(t === T.RUINS ? M.enterRuin : loc.kind === LocKind.Castle ? M.enterCastle : loc.kind === LocKind.Village ? M.enterVillage : loc.kind === LocKind.Dungeon ? M.enterDungeon : M.enterTowne);
  g.con.println(loc.name);
  if (loc.kind === LocKind.Dungeon) {
    g.save.location = loc.id;
    await runDungeon(g, loc);
    g.save.location = 0;
    return;
  }
  await enterTown(g, loc, 0);
}

export async function enterTown(g: Game, loc: LocationDef, level: number, at?: [number, number]) {
  const file = level === 0 ? loc.map! : loc.map2!;
  const { tiles, npcs } = await assets.town(file);
  const dialogues = await assets.talk(loc.talk!);
  const town: TownMap = {
    kind: "town", loc, level, width: 32, height: 32, tiles, dialogues,
    npcs: npcs
      // 1000:3F4A: in the virtue towns the companion (slot 31) is gone if that class is already in the party
      .filter((n) => !(n.index === 31 && loc.id >= 5 && loc.id <= 12 && g.members.some((p) => p.klass === loc.id - 5)))
      .map((n) => ({ index: n.index, tile: n.tile, x: n.x, y: n.y, movement: n.movement, talk: n.talk, dialogue: n.talk ? dialogues[n.talk - 1] ?? null : null })),
  };
  g.map = town;
  g.save.location = loc.id;
  const [x, y] = at ?? townEntry(town);
  g.setPos(x, y);
  g.openedDoors = [];
}

/** Entry square (1000:3F4A): castles at the south edge, towns/villages at the west edge. */
function townEntry(town: TownMap): [number, number] {
  const e = town.loc.kind === LocKind.Castle ? MAP_ENTRY.castle : MAP_ENTRY.towne;
  return [e.x, e.y];
}

export async function leaveTown(g: Game) {
  const loc = (g.map as TownMap).loc;
  g.map = g.world;
  g.save.location = 0;
  g.setPos(loc.x, loc.y);
  g.con.print(MSG_CORE.leaving);
}

export async function klimb(g: Game) {
  g.con.print(MSG_CORE.klimb);
  if (g.map.kind === "town" && tileAt(g.map, g.px, g.py) === T.LADDER_UP && g.map.loc.map2) {
    g.con.print(MSG_CORE.toSecondFloor);
    await enterTown(g, g.map.loc, 1, [g.px, g.py]);
    return;
  }
  // 1000:4477: the balloon takes off (DS:9320 = 1; nothing moves on the world while it flies, 1000:1C53)
  if (g.inBalloon && g.map.kind === "world") { g.con.print(MSG_CORE.altitude); g.save.balloonState = 1; return; }
  g.con.newline(); g.con.print(MSG_CORE.what);
}

export async function descend(g: Game) {
  // 1000:44EE: the balloon lands, on grass only (DS:9444 = 4), with the error buzz elsewhere
  if (g.inBalloon && g.map.kind === "world") {
    g.con.print(MSG_CORE.landBalloon);
    if (tileAt(g.map, g.px, g.py) !== T.GRASS) { await playEffect(SFX.ERROR); g.con.print(MSG_CORE.notHere); return; }
    if (g.save.balloonState === 0) { g.con.print(MSG_CORE.alreadyLanded); return; }
    g.save.balloonState = 0;
    return;
  }
  g.con.print(MSG_CORE.descend);
  if (g.map.kind === "town" && tileAt(g.map, g.px, g.py) === T.LADDER_DOWN && g.map.level === 1) {
    g.con.print(MSG_CORE.toFirstFloor);
    await enterTown(g, g.map.loc, 0, [g.px, g.py]);
    return;
  }
  g.con.newline(); g.con.print(MSG_CORE.what);
}

export async function talk(g: Game) {
  g.con.print(MSG_CORE.talk); // DS:2D68, then "Dir: " (DS:2D6E)
  const d = await g.askDir(MSG_CORE.talkDir);
  if (!d) return;
  const [dx, dy] = DIRS[d];
  let npc = g.npcAt(g.px + dx, g.py + dy);
  let counter: { x: number; y: number } | null = null;
  if (!npc && isTalkOver(tileAt(g.map, g.px + dx, g.py + dy))) {
    npc = g.npcAt(g.px + 2 * dx, g.py + 2 * dy);
    if (npc) counter = { x: g.px + dx, y: g.py + dy };
  }
  if (!npc) { g.con.print(TALK.funny); g.endTurn(); return; }
  await talkTo(g, npc, counter);
  g.endTurn();
}

export async function open(g: Game) {
  g.con.print(MSG_CORE.open);
  const d = await g.askDir("");
  if (!d) return;
  const [dx, dy] = DIRS[d];
  const x = g.px + dx, y = g.py + dy, t = tileAt(g.map, x, y);
  if (t === T.DOOR) {
    setTile(g.map, x, y, T.BRICK_FLOOR);
    g.openedDoors.push({ x, y, turns: 4 });
    g.con.print(MSG_CORE.opened);
  } else if (t === T.LOCKED_DOOR) g.con.print(MSG_CORE.cant);
  else g.con.print(MSG_CORE.notHere);
  g.endTurn();
}

export async function jimmy(g: Game) {
  g.con.print(MSG_CORE.jimmy);
  const d = await g.askDir(MSG_CORE.dir);
  if (!d) return;
  const [dx, dy] = DIRS[d];
  const x = g.px + dx, y = g.py + dy;
  if (tileAt(g.map, x, y) !== T.LOCKED_DOOR) { g.con.print(MSG_CORE.notHere); g.endTurn(); return; }
  if (g.save.keys <= 0) { g.con.print(MSG_CORE.noKeysLeft); g.endTurn(); return; }
  g.save.keys--;
  setTile(g.map, x, y, T.DOOR);
  g.con.print(MSG_CORE.unlocked);
  g.endTurn();
}
