// Vendors reached by talking across a shop counter (dispatcher 1000:A686, handlers DS:0x2D54),
// Hawkwind, and the karma helpers shared with the conversations.
import type { Game } from "./game";
import type { LayerHandle, StatusPanel } from "../ui/layers";
import { rand8 } from "./rng";
import type { TownMap } from "./maps";
import { T } from "./tiles";
import { loadArena } from "./arenas";
import {
  ARMOUR_PRICES, ARMOUR_SHOPS, FOOD_MAX_X100, FOOD_SHOPS, GUILD_ITEMS, GUILD_SHOPS, HEALER_PRICES, HEALERS,
  INN_HEAL, INNS, REAGENT_SHOPS, SHOP_COUNTER_ROWS, SHOP_KIND_ORDER, TAVERNS, TOWN_IDS, WEAPON_PRICES, WEAPON_SHOPS,
  type ShopKind, type TownId,
} from "../data/tables";
import { ARMOUR, FOOD, GUILD, HAWKWIND, HEALER, HORSES, INN, REAGENTS, TALK, TAVERN, WEAPONS } from "./town/strings";
import {
  askKey, askMember, askYN, delay, nl, pause, putc, putNum, readLine, readNumber, say, strnieq, waitKey,
} from "./prompts";
import { karmaDec, karmaInc, Virtue } from "./karma";
import { canAct, isAlive } from "./party";
import { playEffect, SFX } from "../audio/speaker";

type Player = Game["save"]["players"][number];



// ---------------------------------------------------------------- inventory panel

/**
 * Contents of the 16x9 status panel (top right) while a vendor shows the inventory
 * (1000:4832 weapons, 48F8 armour, 4BC7 reagents, 4987 equipment); restored by 1000:4649.
 * Shown as a layer replacing the party list.
 */
export type StatsView = StatusPanel;

const statsLayers = new WeakMap<Game, LayerHandle>();
function setStats(g: Game, v: StatsView | null) {
  statsLayers.get(g)?.remove();
  statsLayers.delete(g);
  if (v) statsLayers.set(g, g.layers.push({ name: "stats", status: () => v }));
}

const pad2 = (ch: string, n: number) => (n < 10 ? ch : "") + String(n);
const blankRows = () => Array.from({ length: 8 }, () => "");

function weaponsView(g: Game): StatsView {
  const rows = blankRows();
  rows[0] = WEAPONS.invHands;
  // 1000:4832: two columns of 8 rows (rows 1..8), "B-5-STF"
  let r = 1, c = 0;
  for (let i = 1; i < 16; i++) {
    const n = g.save.weapons[i];
    if (!n) continue;
    const e = String.fromCharCode(0x41 + i) + pad2("-", n) + "-" + WEAPONS.abbr[i];
    rows[r] = (rows[r] + " ".repeat(16)).slice(0, c) + e;
    if (++r === 8) { r = 0; c += 8; }
  }
  return { title: WEAPONS.invTitle, rows: rows.map((s) => s.padEnd(16).slice(0, 16)) };
}

function armourView(g: Game): StatsView {
  const rows = blankRows();
  rows[0] = ARMOUR.invNone;
  let r = 1;
  for (let i = 1; i < 8; i++) {
    const n = g.save.armour[i];
    if (n) rows[r++] = String.fromCharCode(0x41 + i) + pad2("-", n) + "-" + ARMOUR.names[i];
  }
  return { title: ARMOUR.invTitle, rows: rows.map((s) => s.padEnd(16).slice(0, 16)) };
}

function reagentsView(g: Game): StatsView {
  const rows = blankRows();
  let r = 0;
  for (let i = 0; i < 8; i++) {
    const n = g.save.reagents[i];
    if (n) rows[r++] = String.fromCharCode(0x41 + i) + pad2("-", n) + "-" + REAGENTS.names[i];
  }
  return { title: REAGENTS.invTitle, rows: rows.map((s) => s.padEnd(16).slice(0, 16)) };
}

function equipmentView(g: Game): StatsView {
  const s = g.save, rows = blankRows();
  rows[0] = pad2(" ", s.torches) + GUILD.torches;
  rows[1] = pad2(" ", s.gems) + GUILD.gems;
  rows[2] = pad2(" ", s.keys) + GUILD.keys;
  if (s.sextants) rows[3] = pad2(" ", s.sextants) + GUILD.sextants;
  return { title: GUILD.invTitle, rows: rows.map((r) => r.padEnd(16).slice(0, 16)) };
}

// ---------------------------------------------------------------- dispatch

/** 1000:A686: the shop behind a counter is found from the counter square's row. */
export async function runShop(g: Game, counterY: number) {
  const map = g.map as TownMap;
  const id = map.loc.id;
  const town = TOWN_IDS[id] ?? null;
  const rows = town ? SHOP_COUNTER_ROWS[town] : {};
  let kind: ShopKind | null = null;
  for (let i = 7; i >= 0; i--) if (rows[SHOP_KIND_ORDER[i]] === counterY) { kind = SHOP_KIND_ORDER[i]; break; }
  if (!kind && counterY === 0x18 && id === 13) kind = "horses";
  if (!kind && counterY === 0x19 && id === 1) kind = "hawkwind";
  if (!kind || !town) { await say(g, TALK.funny); return; }
  try {
    switch (kind) {
      case "weapons": await weaponShop(g, town); break;
      case "armour": await armourShop(g, town); break;
      case "food": await foodShop(g, town); break;
      case "tavern": await tavern(g, town); break;
      case "reagents": await reagentShop(g, town); break;
      case "healer": await healer(g, town); break;
      case "inn": await inn(g, town); break;
      case "guild": await guild(g, town); break;
      case "horses": await horses(g); break;
      case "hawkwind": await hawkwind(g); break;
    }
  } finally {
    setStats(g, null);
  }
}

// ---------------------------------------------------------------- weapons & armour

interface EquipDesc {
  s: typeof WEAPONS | typeof ARMOUR;
  inv: number[];
  prices: readonly number[];
  view: (g: Game) => StatsView;
}

/** 1000:D085 (weapons) / 1000:D4AE (armour): Buy or Sell? */
async function equipMenu(g: Game, d: EquipDesc, name: string, keeper: string,
  buy: () => Promise<void>, sell: () => Promise<void>, bye: string) {
  setStats(g, d.view(g));
  await say(g, d.s.welcome, name, d.s.nl, keeper, d.s.buySell);
  for (;;) {
    const k = await g.getKey();
    let c: string | null = null; // null = beep and wait again
    if (k === " " || k === "Enter" || k === "Escape") { c = ""; nl(g); }
    else if (k === "B" || k === "b") c = "b";
    else if (k === "S" || k === "s") c = "s";
    if (c === null) { await playEffect(SFX.ERROR); continue; } // 1000:D136 / D55F
    if (c) {
      putc(g, c);
      nl(g);
      if (c === "b") await buy(); else await sell();
    }
    setStats(g, null);
    nl(g);
    await say(g, keeper, bye);
    return;
  }
}

/** 1000:CD1D / 1000:D16D: pay for `n` items. */
async function equipPay(g: Game, d: EquipDesc, keeper: string, n: number, item: number, ok: string, fail: string) {
  const cost = (d.prices[item] * n) & 0xffff;
  if (cost <= g.save.gold) {
    g.save.gold -= cost;
    d.inv[item] = Math.min(99, d.inv[item] + n);
    setStats(g, d.view(g));
    nl(g);
    await say(g, keeper, ok);
  } else await say(g, fail);
}

/** 1000:CEBE / 1000:D2F8: selling, half price, gold capped at 9999. */
async function equipSell(g: Game, d: EquipDesc, maxLetter: string, t: {
  intro: string; notOwn: string; give1: string; giveN: string; howManyX: string; wishSell: string; tooBad: string;
  notMany: string; gpThat: string; gpFor: string; it: string; them: string; deal: string; no: string; fine: string;
}) {
  await say(g, t.intro);
  let answer = "Y";
  for (;;) {
    const item = (await askKey(g, d.s.youSell, "B", maxLetter)) - 0x41;
    nl(g);
    if (item < 1) return;
    let text: string;
    if (d.inv[item] === 0) text = t.notOwn;
    else {
      let n: number;
      if (d.inv[item] < 2) {
        n = 1;
        await say(g, t.give1);
        putNum(g, d.prices[item] >> 1);
        await say(g, t.gpThat);
        text = d.s.names[item];
      } else {
        await say(g, t.howManyX, d.s.names[item], t.wishSell);
        n = await readNumber(g, 2);
        if (n < 1) { if (n === 0) await say(g, t.tooBad); else await playEffect(SFX.ERROR); return; } // 1000:CF5A
        if (d.inv[item] < n) { await say(g, t.notMany); return; }
        await say(g, t.giveN);
        putNum(g, (d.prices[item] * n) >> 1);
        await say(g, t.gpFor);
        text = n < 2 ? t.it : t.them;
      }
      await say(g, text, t.deal);
      answer = await askYN(g);
      if (answer !== "Y" && answer !== "N") return;
      if (answer === "N") text = t.no;
      else {
        d.inv[item] -= n;
        const sum = g.save.gold + ((d.prices[item] * n) >> 1);
        g.save.gold = sum < 10000 ? sum : 9999;
        setStats(g, d.view(g));
        text = t.fine;
      }
    }
    await say(g, text);
    // the original tests a stale Y/N answer after "not owned"; it continues the loop
    if (answer !== "Y" && answer !== "N") return;
  }
}

async function weaponShop(g: Game, town: TownId) {
  const shop = WEAPON_SHOPS.find((s) => s.town === town)!;
  const S = WEAPONS;
  const d: EquipDesc = { s: S, inv: g.save.weapons, prices: WEAPON_PRICES, view: weaponsView };
  // 1000:CD80
  const buy = async () => {
    nl(g);
    await say(g, S.veryGood);
    let again: string;
    do {
      await say(g, S.weHave);
      for (const it of shop.items) {
        putc(g, String.fromCharCode(it + 0x41)); putc(g, "-");
        await say(g, S.names[it]); putc(g, "s"); nl(g);
      }
      let item: number;
      for (;;) {
        item = (await askKey(g, S.interest, "B", "O")) - 0x41;
        if (item < 1 || shop.items.includes(item)) break;
        await playEffect(SFX.ERROR); // not sold here (1000:CE2D)
      }
      if (item < 0) break;
      if (g.save.gold < WEAPON_PRICES[item]) await say(g, S.noFunds);
      else {
        nl(g);
        await say(g, S.pitch[item]);
        nl(g);
        await say(g, S.howMany);
        const n = await readNumber(g, 2);
        if (n < 1) { if (n === 0) await say(g, S.tooBad); else await playEffect(SFX.ERROR); } // 1000:CE8F
        else await equipPay(g, d, shop.keeper, n, item, S.fine, S.fear);
      }
      await say(g, S.anythingElse);
      again = await askYN(g);
    } while (again === "Y");
    nl(g);
  };
  const sell = () => equipSell(g, d, "P", {
    intro: S.excellent, notOwn: S.notOwn, give1: S.give1, giveN: S.giveN, howManyX: S.howManyX, wishSell: S.wishSell,
    tooBad: S.tooBad2, notMany: S.notMany, gpThat: S.gpThat, gpFor: S.gpFor, it: S.it, them: S.them, deal: S.deal,
    no: S.hmmph, fine: S.fineElse,
  });
  await equipMenu(g, d, shop.name, shop.keeper, buy, sell, S.fare);
}

async function armourShop(g: Game, town: TownId) {
  const shop = ARMOUR_SHOPS.find((s) => s.town === town)!;
  const S = ARMOUR;
  const d: EquipDesc = { s: S, inv: g.save.armour, prices: ARMOUR_PRICES, view: armourView };
  // 1000:D1D0
  const buy = async () => {
    await say(g, S.wellThen);
    for (;;) {
      await say(g, S.gotList);
      for (const it of shop.items) {
        if (!it) continue;
        putc(g, String.fromCharCode(it + 0x41)); putc(g, " ");
        await say(g, S.names[it]); nl(g);
      }
      nl(g);
      let item: number;
      for (;;) {
        item = (await askKey(g, S.what, "B", "G")) - 0x41;
        if (item < 1 || shop.items.includes(item)) break;
        await playEffect(SFX.ERROR); // not sold here (1000:D27A)
      }
      if (item < 0) return;
      if (g.save.gold < ARMOUR_PRICES[item]) await say(g, S.cantPay);
      else {
        nl(g);
        await say(g, S.pitch[item]);
        nl(g);
        await say(g, S.howMany);
        const n = await readNumber(g, 2);
        if (n < 1) await say(g, S.tooBad);
        else await equipPay(g, d, shop.keeper, n, item, S.good, S.noGold);
      }
      await say(g, S.anything);
      if (await askYN(g) !== "Y") return;
    }
  };
  const sell = () => equipSell(g, d, "H", {
    intro: S.whatWill, notOwn: S.notOwn, give1: S.give1, giveN: S.giveN, howManyX: S.howManyX, wishSell: S.likeSell,
    tooBad: S.tooBad2, notMany: S.notMany, gpThat: S.gpThat, gpFor: S.gpFor, it: S.it, them: S.them, deal: S.deal,
    no: S.harumph, fine: S.fineElse,
  });
  await equipMenu(g, d, shop.name, shop.keeper, buy, sell, S.bye);
}

// ---------------------------------------------------------------- reagents (1000:CAF6)

async function reagentShop(g: Game, town: TownId) {
  const shop = REAGENT_SHOPS.find((s) => s.town === town)!;
  const S = REAGENTS, s = g.save;
  await say(g, S.blind, shop.name);
  setStats(g, reagentsView(g));
  await say(g, S.iam, shop.keeper, S.need);
  if (await askYN(g) === "Y") {
    await say(g, S.veryWell);
    let again: string;
    do {
      await say(g, S.list);
      const r = (await askKey(g, S.interest, "A", "F")) - 0x41;
      if (r < 0) break;
      const price = shop.prices[r];
      await say(g, S.weSell, S.names[r], S.for);
      putNum(g, price);
      await say(g, S.howMany);
      const n = await readNumber(g, 2);
      if (n < 1) await say(g, S.iSee);
      else {
        await say(g, S.thatWillBe);
        putNum(g, price * n);
        await say(g, S.youPay);
        const paid = await readNumber(g, 3);
        if (paid > 0) {
          const due = (price * n) & 0xffff;
          if (paid < due) {
            // the blind woman is cheated: honesty, justice and honor suffer
            const pen = due - paid < 12 ? 4 : Math.floor((due - paid) / 3);
            await karmaDec(g, Virtue.Honesty, pen);
            await karmaDec(g, Virtue.Justice, pen);
            await karmaDec(g, Virtue.Honor, pen);
          }
          if (s.gold < paid) await say(g, S.noGold);
          else {
            karmaInc(g, Virtue.Honesty, 2);
            karmaInc(g, Virtue.Justice, 2);
            karmaInc(g, Virtue.Honor, 2);
            s.gold -= paid;
            s.reagents[r] = Math.min(99, s.reagents[r] + n);
            setStats(g, reagentsView(g));
            await say(g, S.veryGood);
          }
        } else if (paid < 0) await playEffect(SFX.ERROR); // 1000:CC23
      }
      await say(g, S.anything);
      again = await askYN(g);
    } while (again === "Y");
  }
  setStats(g, null);
  nl(g);
  await say(g, shop.keeper, S.bye);
}

// ---------------------------------------------------------------- food (1000:E088)

async function foodShop(g: Game, town: TownId) {
  const shop = FOOD_SHOPS.find((s) => s.town === town)!;
  const S = FOOD, s = g.save, price = shop.pricePer25;
  await say(g, S.welcome, shop.name, S.nl, shop.keeper, S.goodDay);
  const c = await askYN(g);
  if (c === "Y") {
    await say(g, S.best);
    putNum(g, price);
    await say(g, S.gp);
    let again: string;
    do {
      await say(g, S.howMany);
      const n = ((await readNumber(g, 3)) << 24) >> 24; // kept in a signed char by the original
      if (n < 1) { await say(g, S.tooBad); again = "N"; }
      else if (((n * price) & 0xffff) <= s.gold) {
        s.food = Math.min(FOOD_MAX_X100, s.food + n * 2500);
        s.gold -= (n * price) & 0xffff;
        await say(g, S.thanks);
        again = await askYN(g);
      } else {
        if (s.gold < price) { await say(g, S.cannot); break; }
        await say(g, S.only);
        putNum(g, Math.floor(s.gold / price));
        await say(g, S.packs);
        again = "Y";
      }
    } while (again === "Y");
    await say(g, S.bye1);
  } else if (c === "N") await say(g, S.bye2);
}

// ---------------------------------------------------------------- tavern (1000:DFAF)

async function tavern(g: Game, town: TownId) {
  const idx = TAVERNS.findIndex((t) => t.town === town);
  const tv = TAVERNS[idx];
  const S = TAVERN, s = g.save;
  let ales = 0; // DS:0x913E

  // 1000:DD24: returns true to end the visit
  const food = async (): Promise<boolean> => {
    await say(g, S.specialty, tv.specialty, S.costs);
    putNum(g, tv.specialtyPrice);
    await say(g, S.plates);
    let n = await readNumber(g, 2);
    if (n < 1) { if (n < 0) await playEffect(SFX.ERROR); return true; } // 1000:DD7B
    let bought = 0;
    for (; n !== 0; n--) {
      if (s.gold < tv.specialtyPrice) {
        if (bought === 0) { await say(g, S.cannot); return true; }
        await say(g, S.only);
        putNum(g, bought);
        await say(g, S.plate);
        if (bought !== 1) putc(g, "s");
        putc(g, ".");
        nl(g);
        break;
      }
      s.gold -= tv.specialtyPrice;
      s.food = Math.min(FOOD_MAX_X100, s.food + 100);
      bought++;
    }
    return false;
  };

  // 1000:DE35: ale and rumours
  const ale = async (): Promise<boolean> => {
    if (ales === 3) { nl(g); await say(g, tv.keeper, S.tooMany); return true; }
    ales++;
    await say(g, S.mug);
    let paid = await readNumber(g, 2);
    if (paid < 1) { if (paid < 0) await playEffect(SFX.ERROR); return true; } // 1000:DE80
    if (paid < 2) { await say(g, S.wontPay); return true; }
    if (paid > s.gold) { await say(g, S.noGold); return true; }
    s.gold -= paid;
    if (paid > 2) {
      await say(g, S.know);
      const q = await readLine(g, 15);
      let t = 6;
      while (t >= 0 && !strnieq(q, S.topics[t], 16)) t--;
      if (t === 6) t = 3; // "mandrake root"
      // literal 1000:DEF6 (CMP/JGE): a tavern only knows the topics from its own index on
      if (t < idx) await say(g, S.fraid);
      else {
        const prices = [20, 30, 10, 40, 99, 25]; // DS:0x5EF8
        while (paid < prices[t]) {
          await say(g, S.foggy);
          const more = await readNumber(g, 2);
          if (more < 1) { await say(g, S.sorry); return true; }
          if (s.gold < more) { await say(g, S.dontHave); await say(g, S.sorry2); return true; }
          s.gold -= more;
          paid += more;
        }
        nl(g);
        await say(g, tv.keeper, S.says2, S.answers[t]);
        nl(g);
      }
    }
    await say(g, S.anythin);
    return await askYN(g) !== "Y";
  };

  nl(g);
  await say(g, tv.keeper, S.says, tv.name);
  nl(g);
  for (;;) {
    await say(g, tv.keeper, S.what);
    let k: string;
    for (;;) {
      k = (await g.getKey()).toUpperCase();
      if (k === " " || k === "ESCAPE" || k === "ENTER") { nl(g); return; }
      if (k === "F" || k === "A") break;
      await playEffect(SFX.ERROR); // 1000:E03D
    }
    putc(g, k);
    nl(g);
    if (k === "F" ? await food() : await ale()) break;
    await say(g, S.here);
    if (await askYN(g) !== "Y") break;
  }
  await say(g, S.seeYa);
}

// ---------------------------------------------------------------- inn (1000:D8DD)

async function inn(g: Game, town: TownId) {
  const idx = INNS.findIndex((i) => i.town === town);
  const def = INNS[idx];
  const S = INN, s = g.save;
  if (!g.onFoot) { await say(g, S.horse); return; }
  await say(g, S.welcome, def.name, S.iam, def.keeper, S.need);
  const c = await askYN(g);
  if (c !== "Y") { nl(g); await say(g, def.keeper, S.wrong); return; }
  nl(g);
  await say(g, S.pitch[idx]);
  nl(g);
  let room = def.rooms[0];
  if (def.rooms.length > 1) {
    const b = (await askKey(g, S.beds, "1", "3")) - 0x31;
    if (b < 0) return;
    room = def.rooms[b];
  } else {
    await say(g, S.take);
    const t = await askYN(g);
    if (t !== "Y") { if (t === "N") await say(g, S.better); return; }
  }
  if (room.price > s.gold) { await say(g, S.cantPay); return; }
  s.gold -= room.price;
  await say(g, S.pleasant);
  if ((rand8() & 3) === 0) await say(g, S.rats);
  await innSleep(g, idx, room.x, room.y);
}

/** 1000:D7D6: the night at the inn. */
async function innSleep(g: Game, innIndex: number, x: number, y: number) {
  const s = g.save;
  await delay(1);
  g.setPos(x, y);
  await delay(1);
  for (const p of g.members) if (isAlive(p)) p.status = "S";
  s.transport = T.CORPSE; // party drawn as sleepers
  await delay(5);
  s.transport = T.AVATAR;
  for (const p of g.members) {
    if (p.status !== "S") continue;
    p.status = "G";
    p.hp = Math.min(p.hpMax, p.hp + INN_HEAL.base + INN_HEAL.randMul * (rand8() % INN_HEAL.randMod));
  }
  mpRegen(g);
  if (isAlive(s.players[0]) && (rand8() & 7) === 0) await nightAmbush(g);
  else if (innIndex === 5 && (rand8() & 3) === 0) {
    // Skara Brae: a ghost (tile 0x9C, dialogue 16) appears next to the bed in NPC slot 0
    const town = g.map as TownMap;
    const ghost = { tile: 0x9c, x: g.px - 1, y: g.py, movement: 1, talk: 0x10, dialogue: town.dialogues[15] ?? null };
    if (town.npcs.length) town.npcs[0] = ghost; else town.npcs.push(ghost);
  }
  await say(g, INN.morning);
}

/** 1000:13B6: one tick of MP regeneration (max by class, capped at 99). */
function mpRegen(g: Game) {
  for (const p of g.members) {
    if (!isAlive(p)) continue;
    const max = Math.min(99, [p.int * 2, p.int, 0, p.int + (p.int >> 1), p.int >> 1, p.int, p.int, 0][p.klass] ?? 0);
    p.mp = Math.min(max, p.mp + 1);
  }
}

/** 1000:D7A8: rogues attack in INN.CON. */
async function nightAmbush(g: Game) {
  await say(g, INN.stroll);
  const arena = await loadArena("INN.CON");
  // group size as 1000:7E7E: 1 + (rand & 7), reduced while ((n - 1) >> 1) >= party size
  let n = 1 + (rand8() & 7);
  const party = g.save.members;
  while (((n - 1) >> 1) >= party) n = 1 + rand8() % (2 * party);
  const monsters = arena.monsterPos.slice(0, n).map(([x, y]) => ({ tile: 0xc8, x, y }));
  await g.fight({ arena, monsters, context: "town" });
}

// ---------------------------------------------------------------- healer (1000:DC4D)

async function healer(g: Game, town: TownId) {
  const def = HEALERS.find((h) => h.town === town)!;
  const S = HEALER, s = g.save, keeper = def.keeper;

  // 1000:DA05
  const who = async (): Promise<Player | null> => {
    nl(g);
    await say(g, keeper, S.asks);
    const i = await askMember(g, S.who);
    if (i < 0) { await say(g, S.noOne); return null; }
    return s.players[i];
  };
  // 1000:DA3E
  const pay = async (n: number): Promise<boolean> => {
    await say(g, S.pay);
    const c = await askYN(g);
    if (c === "Y") { s.gold -= n; return true; }
    if (c === "N") await say(g, S.cannot);
    return false;
  };
  // 1000:DA79: the screen and the member's line flash with the magic sound (pulse width 0xC0)
  const healed = () => playEffect(SFX.MAGIC, 0xc0);

  await say(g, S.welcome, def.name);
  nl(g);
  await say(g, keeper);
  let prompt: string = S.peace;
  for (;;) {
    await say(g, prompt);
    if (await askYN(g) !== "Y") break;
    nl(g);
    await say(g, keeper, S.perform);
    const c = await askKey(g, S.need, "A", "C");
    if (c < 0x41) break;
    const p = await who();
    if (p && c === 0x41) {
      // 1000:DAA2 cure
      if (p.status === "P") {
        await say(g, S.cure);
        let ok = true;
        if (s.gold < HEALER_PRICES.cure) {
          await say(g, S.notEnough);
          await pause(g, 5);
          await say(g, S.free);
        } else ok = await pay(HEALER_PRICES.cure);
        if (ok) { p.status = "G"; await healed(); }
      } else await say(g, S.noPoison);
    } else if (p && c === 0x42) {
      // 1000:DB29 heal
      if (p.hp === p.hpMax) await say(g, S.healthy);
      else {
        await say(g, S.heal);
        if (s.gold >= HEALER_PRICES.heal) { if (await pay(HEALER_PRICES.heal)) { p.hp = p.hpMax; await healed(); } }
        else await say(g, S.noGold);
      }
    } else if (p && c === 0x43) {
      // 1000:DB93 resurrect
      if (p.status === "D") {
        await say(g, S.res);
        if (s.gold >= HEALER_PRICES.resurrect) { if (await pay(HEALER_PRICES.resurrect)) { p.status = "G"; await healed(); } }
        else await say(g, S.noGold2);
      } else await say(g, S.notDead);
    }
    nl(g);
    await say(g, keeper);
    prompt = S.more;
  }
  // 1000:DBF5 blood donation
  if (s.players[0].hp > 399) {
    await say(g, S.blood);
    const c = await askYN(g);
    if (c === "Y") {
      karmaInc(g, Virtue.Sacrifice, 5);
      await say(g, S.great);
      s.players[0].hp -= 100;
      await delay(1);
    } else if (c === "N") await karmaDec(g, Virtue.Sacrifice, 5);
  }
  nl(g);
  await say(g, keeper, S.guarded);
}

// ---------------------------------------------------------------- guild (1000:D61E)

async function guild(g: Game, town: TownId) {
  const def = GUILD_SHOPS.find((x) => x.town === town)!;
  const S = GUILD, s = g.save;
  setStats(g, equipmentView(g));
  await say(g, S.avast, def.keeper, S.q, def.keeper, S.welcome, def.name);
  let prompt: string = S.see;
  for (;;) {
    await say(g, prompt);
    if (await askYN(g) !== "Y") break;
    nl(g);
    await say(g, def.keeper, S.gots);
    const i = (await askKey(g, S.wat, "A", "D")) - 0x41;
    if (i < 0) break;
    nl(g);
    await say(g, S.desc[i]);
    await say(g, S.buy);
    const c = await askYN(g);
    if (c !== "Y") { if (c === "N") await say(g, S.hmm); break; }
    const it = GUILD_ITEMS[i];
    if (s.gold < it.price) { setStats(g, null); await say(g, S.cantPay); return; }
    s[it.item] = Math.min(99, s[it.item] + it.qty);
    s.gold -= it.price;
    await say(g, S.fine);
    setStats(g, equipmentView(g));
    nl(g);
    await say(g, def.keeper);
    prompt = S.seeMore;
  }
  setStats(g, null);
  nl(g);
  await say(g, def.keeper, S.bye);
}

// ---------------------------------------------------------------- horses (1000:D596)

async function horses(g: Game) {
  const S = HORSES, s = g.save;
  await say(g, S.welcome);
  let c = await askYN(g);
  if (c === "Y") {
    await say(g, S.only);
    putNum(g, s.members);
    await say(g, S.price);
    c = await askYN(g);
    if (c === "Y") {
      if (s.members * 100 <= s.gold) {
        s.gold -= s.members * 100;
        await say(g, S.better);
        s.transport = T.HORSE_W;
        return;
      }
      await say(g, S.noGold);
    } else if (c === "N") await say(g, S.shame);
  } else if (c === "N") await say(g, S.shame2);
}

// ---------------------------------------------------------------- Hawkwind (1000:C922)

async function hawkwind(g: Game) {
  const S = HAWKWIND, s = g.save, me = s.players[0].name;
  if (!canAct(s.players[0])) { await say(g, S.only, me, S.ret, me, S.revived); return; }
  await say(g, S.welcome, me, S.intro);
  await waitKey(g, true);
  let q = "";
  for (;;) {
    await say(g, q === "" ? S.path : S.other);
    q = await readLine(g, 15);
    if (!q || strnieq(q, S.none, 16) || strnieq(q, S.bye, 16)) break;
    let v = 7;
    while (v >= 0 && !strnieq(q, S.virtues[v], 4)) v--;
    if (v < 0) { await say(g, S.notSubject); continue; }
    nl(g);
    const k = s.karma[v];
    if (k === 0) { await say(g, S.partial); continue; }
    const tier = k < 20 ? 0 : k < 40 ? 1 : k < 60 ? 2 : k < 99 ? 3 : 4;
    nl(g);
    await say(g, S.texts[tier * 8 + v]);
    nl(g);
    if (tier === 4) { await say(g, S.shrine); await waitKey(g, true); }
  }
  await say(g, S.fare);
  // once per 100 moves (DS:0x932E, shared with meditation)
  const m = Math.floor(s.moves / 100);
  if (m > 0xffff || m !== s.lastMeditation) {
    karmaInc(g, Virtue.Spirituality, 3);
    s.lastMeditation = m & 0xffff;
  }
}
