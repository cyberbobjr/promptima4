// Party commands: A)ttack, R)eady, W)ear, H)ole up, G)et chest, L)ocate, Z)tats, Q)uit & save.
import { writeSave } from "../io/gamefs";
import { encodeSave, type PlayerRecord } from "../formats/save";
import { ARMOURS, CAMP_RULES, CHEST_TRAPS, WEAPONS } from "../data/tables";
import { isAlive } from "./party";
import { MSG_CORE } from "./texts/core";
import { equipArmour, equipWeapon } from "./equipment";
import { say, ticks } from "./prompts";
import { isNonEvil, spawnGroup } from "./combat";
import { loadArena } from "./arenas";
import { CLASS_NAMES, maxMp, type Game } from "./game";
import { DIRS, setTile, tileAt } from "./maps";
import { rand, rand8 } from "./rng";
import { T } from "./tiles";
import { encodeObjects } from "./world/objects";
import { worldFight, worldMonsterAt } from "./world/monsters";
import { playEffect, SFX, toggleSound } from "../audio/speaker";
import { inverted, statusRowRect } from "../ui/invert";
import { hazardFlash } from "./endgame/ui";

export async function attack(g: Game) {
  g.con.print(MSG_CORE.attack);
  const d = await g.askDir("");
  if (!d) return;
  const [dx, dy] = DIRS[d];
  const x = g.px + dx, y = g.py + dy;
  if (g.map.kind === "world") {
    const m = worldMonsterAt(g, x, y);
    if (!m) { g.con.print(MSG_CORE.nothingToAttack); return; }
    if (isNonEvil(m.tile)) { g.karmaDec(1, 5); g.karmaDec(3, 5); g.karmaDec(5, 5); }
    await worldFight(g, m);
    return;
  }
  const npc = g.npcAt(x, y);
  if (!npc) { g.con.print(MSG_CORE.nothingToAttack); return; }
  // Attacking townsfolk (1000:628F): Compassion, Justice, Honor -5; guards and Lord British turn hostile.
  g.karmaDec(1, 5); g.karmaDec(3, 5); g.karmaDec(5, 5);
  if (g.map.kind === "town") for (const n of g.map.npcs) if (n.tile === T.GUARD || n.tile === T.LORD_BRITISH) { n.movement = 0xff; n.hostile = true; }
  await worldFight(g, { tile: npc.tile, x, y }, "town");
}

/** Z)tats of one member, as shown in combat (with weapon and armour). */
export async function ztatsFor(g: Game, i: number) {
  const p = g.save.players[i];
  printStats(g, p);
  g.con.println(MSG_CORE.statWeapon + WEAPONS[p.weapon].name);
  g.con.println(MSG_CORE.statArmour + ARMOURS[p.armour].name);
}

/** Name, sex, class, status and the stat lines (labels DS:18D6..). */
function printStats(g: Game, p: PlayerRecord) {
  const M = MSG_CORE;
  g.con.println(`${p.name}`);
  g.con.println(`${p.sex === 0x0b ? "M" : "F"} ${CLASS_NAMES[p.klass]}  ${p.status}`);
  g.con.println(`${M.statMp}${p.mp} ${M.statLv}${Math.floor(p.hpMax / 100)}`);
  g.con.println(`${M.statStr}${p.str} ${M.statHp}${p.hp}`);
  g.con.println(`${M.statDex}${p.dex} ${M.statHm}${p.hpMax}`);
  g.con.println(`${M.statInt}${p.int} ${M.statEx}${p.xp}`);
}

/**
 * Z)tats (1000:4E45): the member is chosen with 1000:1287, which buzzes (effect 1) and asks again for
 * a number above the party size, like the number keys of the stats browser 1000:4CC1. The browser
 * itself (pages of members, equipment, items) is the port's console listing; "0" (its items page) does
 * nothing here.
 */
export async function ztats(g: Game) {
  const i = await g.askMember(MSG_CORE.ztatsFor);
  if (i < 0) return;
  printStats(g, g.save.players[i]);
}

/** R)eady a weapon (1000:7631): letter A..P from the inventory, class mask bit 0x80 >> class. */
export async function readyWeapon(g: Game, member?: number) {
  g.con.print(MSG_CORE.readyWeapon);
  const i = member ?? await g.askMember(MSG_CORE.readyFor);
  if (i < 0) return;
  const p = g.save.players[i];
  await say(g, MSG_CORE.weapon);
  const k = (await g.getKey()).toUpperCase();
  const w = k.charCodeAt(0) - 65;
  if (!(w >= 0 && w < 16)) { g.con.println(""); return; }
  g.con.println(WEAPONS[w].name);
  const r = equipWeapon(g.save, p, w);
  if (r === "noneLeft") g.con.print(MSG_CORE.noneLeft);
  else if (r === "notAllowed") {
    g.con.print(MSG_CORE.mayNotUseA + CLASS_NAMES[p.klass] + MSG_CORE.mayNotUse + WEAPONS[w].name + "!\n");
    await playEffect(SFX.ERROR); // 1000:75DC
  }
}

/** W)ear armour (1000:7732). */
export async function wearArmour(g: Game) {
  g.con.print(MSG_CORE.wearArmour);
  const i = await g.askMember(MSG_CORE.wearFor);
  if (i < 0) return;
  const p = g.save.players[i];
  await say(g, MSG_CORE.armour);
  const k = (await g.getKey()).toUpperCase();
  const a = k.charCodeAt(0) - 65;
  if (!(a >= 0 && a < 8)) { g.con.println(""); return; }
  g.con.println(ARMOURS[a].name);
  const r = equipArmour(g.save, p, a);
  if (r === "noneLeft") g.con.print(MSG_CORE.noneLeft);
  else if (r === "notAllowed") g.con.print(MSG_CORE.mayNotUseA + CLASS_NAMES[p.klass] + MSG_CORE.mayNotUse + ARMOURS[a].name + "!\n");
}

/**
 * H)ole up & camp (1000:8AB0): on the overworld or in a dungeon, on foot. The party rests 10 time units;
 * 1 in 8 it is ambushed asleep (1000:8A5A), else, once per 100 moves, the living members wake up and heal.
 */
export async function holeUp(g: Game) {
  g.con.print(MSG_CORE.holeUp);
  const inDungeon = g.mode === "dungeon";
  if (!inDungeon && g.save.location !== 0) { g.con.print(MSG_CORE.notHere); return; }
  if (!g.onFoot) { g.con.print(MSG_CORE.onlyOnFoot); return; }
  g.con.print(MSG_CORE.resting);
  await ticks(CAMP_RULES.restTicks);
  if ((rand8() & 7) === 0) {
    g.con.print(MSG_CORE.ambushed);
    const tile = CAMP_RULES.ambushTiles[rand8() & 7];
    for (const p of g.members) if (p.status === "G") p.status = "S";
    const arena = await loadArena(inDungeon ? CAMP_RULES.arenaDungeon : CAMP_RULES.arenaWorld);
    await g.fight({ arena, monsters: spawnGroup(tile, arena, g.save.members), context: inDungeon ? "dungeon" : "world" });
    return;
  }
  if (Math.floor(g.save.moves / 100) === g.save.lastCamp) { g.con.print(MSG_CORE.noEffect); return; }
  g.save.lastCamp = Math.floor(g.save.moves / 100) & 0xffff;
  for (const p of g.members) {
    if (!isAlive(p)) continue;
    if (p.status === "S") p.status = "G";
    p.hp = Math.min(p.hpMax, p.hp + (rand8() & 0x77) + 99);
    p.mp = maxMp(p);
  }
  g.con.print(MSG_CORE.playersHealed);
}

/** G)et chest (1000:72EC -> 722F): chests on the town map are stolen; dropped chests are free. */
export async function getChest(g: Game) {
  g.con.print(MSG_CORE.getChest);
  const obj = g.map.kind === "world" ? g.objects.find((o) => o.tile === T.CHEST && o.x === g.px && o.y === g.py) : undefined;
  const onMap = tileAt(g.map, g.px, g.py) === T.CHEST;
  if (!obj && !onMap) { g.con.print(MSG_CORE.notHere); return; }
  const who = await g.askMember(MSG_CORE.whoOpens);
  if (who < 0) return;
  if (g.save.players[who].status === "D" || g.save.players[who].status === "S") { g.con.print(MSG_CORE.disabled); return; }
  if (obj) g.objects = g.objects.filter((o) => o !== obj);
  else {
    setTile(g.map, g.px, g.py, T.BRICK_FLOOR);
    if (g.map.kind === "town") { g.karmaDec(0, 1); g.karmaDec(3, 1); g.karmaDec(5, 1); }
  }
  await openChest(g, who);
  g.endTurn();
}

/** Chest trap and contents (1000:7150, 1000:70F1). `who` = -1 never triggers traps (Open spell). */
export async function openChest(g: Game, who: number) {
  const r1 = rand8();
  if ((r1 & 1) === 0) {
    const kind = r1 & 3 & rand8();
    g.con.print(CHEST_TRAPS.types[kind] + MSG_CORE.trap);
    const p = who >= 0 ? g.save.players[who] : null;
    if (!p || rand8() % 100 <= p.dex + 25) { g.con.print(MSG_CORE.evaded); await playEffect(SFX.FLEE); }
    else if (kind === 3) { // bomb: the whole party (1000:1584)
      await hazardFlash(g);
      for (const m of g.members) if (m.status !== "D" && rand8() & 1) g.damagePlayer(m, 10 + (rand8() % 15));
    } else {
      // acid, sleep, poison: the member's line flashes with the hurt noise (1000:09D9)
      if (kind === 1) p.status = "S";
      else if (kind === 2) p.status = "P";
      await inverted(g, [statusRowRect(who)], () => playEffect(SFX.HURT));
      if (kind === 0) g.damagePlayer(p, rand8() % 30);
    }
  }
  const gold = (rand8() % 80) + (rand8() & 7) + 10;
  g.con.print(MSG_CORE.chestHolds + gold + MSG_CORE.gold);
  g.save.gold = Math.min(9999, g.save.gold + gold);
}

/** V)olume (1000:70AD): sound on or off. */
export async function volume(g: Game) {
  await say(g, MSG_CORE.volume);
  await say(g, toggleSound() ? MSG_CORE.volumeOn : MSG_CORE.volumeOff);
}

export function locate(g: Game) {
  g.con.print(MSG_CORE.locate);
  if (g.save.sextants <= 0) { g.con.print(MSG_CORE.what); return; }
  // 1000:7561: the closing '"' of the latitude is part of the "Longitude" string
  const L = (v: number) => String.fromCharCode(65 + (v >> 4)) + "'" + String.fromCharCode(65 + (v & 15));
  g.con.print(MSG_CORE.latitude + L(g.py) + MSG_CORE.longitude + L(g.px) + '"\n');
}

/**
 * Q)uit & save (1000:6F29): the move count first, then the save on the overworld (PARTY.SAV and the
 * overworld objects) or in a dungeon (PARTY.SAV, the level maps DNGMAP.SAV and the wandering monsters).
 */
export async function quitSave(g: Game) {
  g.con.print(MSG_CORE.quitSave);
  g.con.print(g.save.moves + MSG_CORE.moves);
  const state = g.mode === "dungeon" ? g.dungeon.state?.() : null;
  if (!state && (g.map.kind !== "world" || g.save.location !== 0)) { g.con.print(MSG_CORE.notHere); return; }
  await writeSave("PARTY.SAV", encodeSave(g.save));
  if (state) {
    await writeSave("DNGMAP.SAV", state.map);
    await writeSave("DNGMON.SAV", state.monsters);
  } else await writeSave("OUTMONST.SAV", encodeObjects(g.objects));
  await (await import("./journal")).saveJournal(g); // EXTRA.json: journal of discovered places
  g.con.print(MSG_CORE.quitHint);
}
