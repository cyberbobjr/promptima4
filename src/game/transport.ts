// Ships, horses and the balloon: B)oard, X)it, Y)ell and sailing with the wind (1000:2A5A).
import type { Game } from "./game";
import { DIRS, tileAt, type Dir } from "./maps";
import { MSG_CORE } from "./texts/core";
import { T, tileFlags, Walk } from "./tiles";
import { worldMonsterAt } from "./world/monsters";

export function board(g: Game) {
  g.con.print(MSG_CORE.board);
  if (!g.onFoot) { g.con.newline(); g.con.print(MSG_CORE.cant); return; }
  const i = g.objects.findIndex((o) => o.x === g.px && o.y === g.py && o.tile < 0x80);
  if (i < 0 || g.map.kind !== "world") { g.con.newline(); g.con.print(MSG_CORE.what); return; }
  const o = g.objects[i];
  g.objects.splice(i, 1);
  g.save.transport = o.tile;
  if (o.tile === T.BALLOON) g.con.print(MSG_CORE.balloon);
  else if (g.onHorse) { g.con.newline(); g.con.print(MSG_CORE.mountHorse); }
  else g.con.print(MSG_CORE.frigate);
  g.endTurn();
}

export function exitTransport(g: Game) {
  g.con.print(MSG_CORE.exit);
  if (g.onFoot) { g.con.newline(); g.con.print(MSG_CORE.what); return; }
  if (g.onShip && !(tileFlags(tileAt(g.map, g.px, g.py)) & Walk.Foot)) {
    // leaving a ship is only possible onto land; the original lets you exit onto the ship's square
  }
  g.objects.push({ tile: g.save.transport, x: g.px, y: g.py });
  g.save.transport = T.AVATAR;
  g.con.println("");
  g.endTurn();
}

export function yell(g: Game) {
  g.con.print(MSG_CORE.yell);
  if (!g.onHorse) { g.con.print(MSG_CORE.what); return; }
  g.con.print(MSG_CORE.giddyup);
}

export async function sail(g: Game, dir: Dir) {
  const shipTile = { W: T.SHIP_W, N: T.SHIP_N, E: T.SHIP_E, S: T.SHIP_S }[dir];
  if (g.save.transport !== shipTile) {
    g.save.transport = shipTile;
    g.con.print({ W: MSG_CORE.turnWest, N: MSG_CORE.turnNorth, E: MSG_CORE.turnEast, S: MSG_CORE.turnSouth }[dir]);
    g.endTurn();
    return;
  }
  const [dx, dy] = DIRS[dir];
  const t = tileAt(g.map, g.px + dx, g.py + dy);
  g.con.print({ W: MSG_CORE.sailWest, N: MSG_CORE.sailNorth, E: MSG_CORE.sailEast, S: MSG_CORE.sailSouth }[dir]);
  if (!(tileFlags(t) & Walk.Ship) || worldMonsterAt(g, g.px + dx, g.py + dy)) { await g.blocked(); g.endTurn(); return; }
  // Wind (1000:2A5A): into the wind only 1 turn in 4, with the wind 3 in 4.
  const d = { W: 0, N: 1, E: 2, S: 3 }[dir];
  const T4 = g.save.moves & 3;
  const wind = g.sky.wind;
  if ((d === wind && T4 !== 0) || (d === ((wind + 2) & 3) && T4 === 0)) {
    g.con.print(MSG_CORE.slowProgress); g.endTurn(); return;
  }
  g.setPos(g.px + dx, g.py + dy);
  g.endTurn();
}
