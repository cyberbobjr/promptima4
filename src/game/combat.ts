// Tactical combat on 11x11 maps (*.CON files and dungeon rooms).
// Ported from AVATAR.EXE (EXEPACK-unpacked): main loop 1000:5A6B, player attack 1000:61D1/6012,
// monster damage 1000:5DAB, monster turn 1000:9F7B/9CBC, combat end 1000:837A.
import type { CombatMap } from "../formats/maps";
import type { PlayerRecord } from "../formats/save";
import { ARMOURS, COMBAT_RULES, MONSTERS, NON_EVIL_TILES, PERSON_COMBAT, WALKABLE_TILES, WEAPONS, type MonsterDef, type MonsterRanged } from "../data/tables";
import type { Game } from "./game";
import { CLASS_TILES, T, animFrame } from "./tiles";
import { DIR_NAMES, DIRS, type Dir } from "./maps";
import { say } from "./prompts";
import { MSG_FIGHT as M } from "./texts/fight";

export interface CombatRequest {
  /** Arena: a decoded *.CON file or a dungeon room converted to the same shape. */
  arena: CombatMap;
  /** Monsters: tile and starting square. Use `spawnGroup` to build an encounter from one creature. */
  monsters: { tile: number; x: number; y: number }[];
  /** Where the fight happens (affects fleeing, rewards and what is left on the map afterwards). */
  context: "world" | "town" | "dungeon" | "ship";
  /** For dungeon rooms: index of the direction the party came from (0 N, 1 E, 2 S, 3 W). */
  entryDir?: number;
}

export interface CombatResult {
  outcome: "won" | "fled" | "lost";
  /** Square (arena coordinates) of the last monster killed — where the original drops a chest. */
  lastKill?: { x: number; y: number };
  /** True if every monster killed was evil and none was spared (rewards / karma decided by caller). */
  chest: boolean;
}

import { rand8 } from "./rng";
export { rand8 };
import { sleep } from "./prompts";
import { playEffect, SFX } from "../audio/speaker";
import { inverted, statusRowRect, VIEWPORT_RECT } from "../ui/invert";

const WALKABLE = new Set(WALKABLE_TILES);

/** 1000:7C25 */
export function monsterIndex(tile: number): number {
  if (tile < 0x80) return (tile & 0x1f) + 0x24;
  if (tile < 0x90) return (tile & 0x7f) >> 1;
  return ((tile & 0x7f) >> 2) + 4;
}

export interface CreatureInfo { name: string; baseHp: number; xp: number; maxDamageRoll: number; ranged: MonsterRanged | null; def: MonsterDef | null; }

export function creatureInfo(tile: number): CreatureInfo {
  const i = monsterIndex(tile);
  if (i < MONSTERS.length) {
    const m = MONSTERS[i];
    return { name: m.name, baseHp: m.baseHp, xp: m.xp, maxDamageRoll: m.maxDamageRoll, ranged: m.ranged, def: m };
  }
  const p = PERSON_COMBAT.find((q) => q.tile === (tile & ~1)) ?? PERSON_COMBAT[9];
  return { name: p.name, baseHp: p.baseHp, xp: p.xp, maxDamageRoll: p.baseHp >> 2, ranged: p.ranged, def: null };
}

const has = (c: CreatureInfo, f: MonsterDef["flags"][number]) => c.def?.flags.includes(f) ?? false;
export const isNonEvil = (tile: number) => tile < 0x80 || NON_EVIL_TILES.includes(tile & ~3);
export const isUndead = (tile: number) => [0x9c, 0xbc, 0xc4, 0xe4].includes(tile & ~3);

/** 1000:7E7E: group size and leader promotion for an encounter with `tile`. */
export function spawnGroup(tile: number, arena: CombatMap, partySize: number): CombatRequest["monsters"] {
  let n = 1 + (rand8() & 7);
  while (((n - 1) >> 1) >= partySize) n = 1 + (rand8() % (2 * partySize));
  if (tile < 0x90 || has(creatureInfo(tile), "stationary")) n = 1; // ships, sea monsters and mimics/reapers come alone // UNVERIFIED
  const out: CombatRequest["monsters"] = [];
  for (let i = 0; i < n; i++) {
    let t = tile;
    if (i < n - 1 && tile >= 0x90) {
      const leader = (x: number) => MONSTERS[monsterIndex(x)]?.leaderTile ?? x;
      if (rand8() % 32 === 0) t = leader(leader(tile));
      else if (rand8() % 8 === 0) t = leader(tile);
    }
    const [x, y] = arena.monsterPos[i];
    out.push({ tile: t, x, y });
  }
  return out;
}

interface Monster {
  tile: number; x: number; y: number; hp: number; info: CreatureInfo;
  asleep: boolean; alive: boolean;
}

interface Member { p: PlayerRecord; i: number; x: number; y: number; present: boolean; }

class Combat {
  tiles: Uint8Array;
  monsters: Monster[];
  party: Member[];
  effect: { x: number; y: number; tile: number } | null = null;
  lastKill: { x: number; y: number } | undefined;
  private active = -1;
  /** Dungeon rooms: the edge the first member left by (1000:79C9). */
  private roomExit: Dir | null = null;

  constructor(readonly g: Game, readonly req: CombatRequest) {
    this.tiles = req.arena.tiles.slice();
    this.monsters = req.monsters.map((m) => {
      const info = creatureInfo(m.tile);
      // spawn HP = (baseHp>>1) | (rand8 % baseHp)
      const hp = (info.baseHp >> 1) | (rand8() % Math.max(1, info.baseHp));
      return { tile: m.tile, x: m.x, y: m.y, hp, info, asleep: false, alive: true };
    });
    this.party = g.members.map((p, i) => {
      const [x, y] = req.arena.partyPos[i];
      return { p, i, x, y, present: p.status !== "D" };
    });
  }

  tileAt(x: number, y: number) { return x < 0 || y < 0 || x > 10 || y > 10 ? -1 : this.tiles[y * 11 + x]; }
  monsterAt(x: number, y: number) { return this.monsters.find((m) => m.alive && m.x === x && m.y === y); }
  memberAt(x: number, y: number) { return this.party.find((m) => m.present && m.x === x && m.y === y); }
  occupied(x: number, y: number) { return !!this.monsterAt(x, y) || !!this.memberAt(x, y); }

  view = (): number[] => {
    const out = new Array<number>(121);
    const frame = this.g.frame;
    for (let i = 0; i < 121; i++) out[i] = this.tiles[i];
    for (const m of this.monsters) if (m.alive) out[m.y * 11 + m.x] = has(m.info, "mimic") && !this.mimicRevealed(m) ? T.CHEST : animFrame(m.tile, frame + m.x);
    for (const m of this.party) {
      if (!m.present) continue;
      // sleepers are shown lying down
      out[m.y * 11 + m.x] = m.p.status === "S" ? T.CORPSE : CLASS_TILES[m.p.klass] + (frame & 1);
    }
    if (this.effect) out[this.effect.y * 11 + this.effect.x] = this.effect.tile;
    return out;
  };

  mimicRevealed(m: Monster) {
    return this.party.some((p) => p.present && Math.abs(p.x - m.x) + Math.abs(p.y - m.y) < 5);
  }

  /** Shows `tile` on a square for a moment; the effect `sfx` (1000:1D47) plays meanwhile. */
  async flash(x: number, y: number, tile: number = T.HIT_FLASH, sfx = -1) {
    this.effect = { x, y, tile };
    await Promise.all([sleep(140), sfx >= 0 ? playEffect(sfx) : undefined]);
    this.effect = null;
  }

  /** Animates a projectile from (x,y) along d; returns the first creature square hit or null. */
  async shoot(x: number, y: number, d: Dir, range: number, tile: number, hitsParty: boolean): Promise<{ x: number; y: number } | null> {
    const [dx, dy] = DIRS[d];
    for (let k = 1; k <= range; k++) {
      const cx = x + dx * k, cy = y + dy * k;
      const t = this.tileAt(cx, cy);
      if (t < 0) break;
      if (hitsParty ? this.memberAt(cx, cy) : this.monsterAt(cx, cy)) return { x: cx, y: cy };
      if (!WALKABLE.has(t) && t > T.SHALLOWS) break;
      this.effect = { x: cx, y: cy, tile };
      await sleep(45);
    }
    this.effect = null;
    return null;
  }

  // ------------------------------------------------------------ outcome

  get monstersLeft() { return this.monsters.some((m) => m.alive); }
  get partyLeft() { return this.party.some((m) => m.present && m.p.status !== "D"); }
  /** A dungeon room (mode 6): the room arena carries its exit direction. */
  get inRoom() { return this.req.context === "dungeon" && "exitDir" in this.req.arena; }
  /**
   * 1000:5A28: the fight is over when no member is left, or (except in dungeon rooms) no monster.
   * In a room the party stays after the last kill until everyone walks out (to reach an altar, a chest...).
   */
  get over() { return !this.partyLeft || (!this.inRoom && !this.monstersLeft); }

  // ------------------------------------------------------------ player side

  async run(): Promise<CombatResult> {
    const g = this.g;
    const layer = g.layers.push({ name: "combat", view: this.view });
    try {
      for (;;) {
        for (const m of this.party) {
          if (this.over) break;
          if (!m.present || m.p.status === "D") continue;
          if (m.p.status === "S") continue;
          this.active = m.i; g.activeMember = m.i;
          let again = true;
          while (again) {
            again = false;
            await this.playerTurn(m);
            if (this.g.spellEffect === "Q" && m.present && this.monstersLeft && rand8() & 1) again = true;
          }
          this.active = -1; g.activeMember = -1;
        }
        if (this.over) break;
        await this.monstersTurn();
        g.tickEffects();
        if (!this.partyLeft) break;
      }
    } finally {
      layer.remove();
    }
    return this.finish();
  }

  private async playerTurn(m: Member) {
    const g = this.g;
    g.con.print(`${m.p.name}${M.with}${WEAPONS[m.p.weapon].name}:\n`);
    for (;;) {
      const k = await g.input.next(15000);
      if (!k) { g.con.print(M.pass); return; }
      const key = k.key;
      const dir = (({ ArrowUp: "N", ArrowDown: "S", ArrowLeft: "W", ArrowRight: "E" }) as Record<string, Dir>)[key];
      if (dir) { await this.moveMember(m, dir); return; }
      switch (key.toLowerCase()) {
        case " ": g.con.print(M.pass); return;
        case "a": await this.attack(m); return;
        case "c":
          g.con.print(M.castSpell);
          await g.commands.get("c", "combat")!.run({ g, ctx: "combat", combat: this.api(m) });
          return;
        case "r": await g.readyWeapon(m.i); return;
        case "u": {
          // context for stones at altar rooms and the skull (items.ts)
          const arena = this.req.arena as CombatMap & { altar?: number };
          await g.commands.get("u", "combat")!.run({
            g, ctx: "combat",
            use: {
              pos: { x: m.x, y: m.y },
              altar: arena.altar ?? -1,
              room: this.req.context === "dungeon" && "altar" in arena,
              killAll: () => { for (const x of this.monsters) if (x.tile !== T.LORD_BRITISH) x.alive = false; },
            },
          });
          return;
        }
        case "z": await g.ztatsFor(m.i); continue;
        case "v": await g.commands.get("v", "combat")!.run({ g, ctx: "combat" }); return; // V)olume, 1000:5BC2
        default: g.con.print(M.badCommand); await playEffect(SFX.BAD_COMMAND); continue; // 1000:5BF1
      }
    }
  }

  /** 1000:7AE3: a click for the command, another for the step taken. */
  private async moveMember(m: Member, d: Dir) {
    const g = this.g;
    await playEffect(SFX.STEP);
    g.con.println(DIR_NAMES[d]);
    const [dx, dy] = DIRS[d];
    const nx = m.x + dx, ny = m.y + dy;
    if (nx < 0 || ny < 0 || nx > 10 || ny > 10) {
      // leaving the arena = fleeing (1000:7962): full-HP members fleeing evil foes cost Valor and Sacrifice.
      // In dungeon rooms the edge taken is the way out (orientation 0 W, 1 N, 2 E, 3 S).
      const arena = this.req.arena as CombatMap & { exitDir?: number | null };
      if ("exitDir" in arena) {
        // 1000:79C9: the first member out fixes the exit (column DS:96EE or row DS:96F4); the others
        // must take the same one, else "All must use same exit!" with the error buzz (1000:794D)
        if (this.roomExit !== null && this.roomExit !== d) { g.con.print(M.sameExit); await playEffect(SFX.ERROR); return; }
        this.roomExit = d;
        arena.exitDir = { W: 0, N: 1, E: 2, S: 3 }[d];
      }
      await playEffect(SFX.FLEE); // 1000:7962: every member leaving the field
      if (!this.monstersLeft) { m.present = false; return; }
      g.con.print(M.fleeing);
      if (m.p.hp === m.p.hpMax && this.monsters.some((x) => x.alive && !isNonEvil(x.tile))) {
        g.karmaDec(2, 2); g.karmaDec(4, 2);
      }
      m.present = false;
      return;
    }
    const t = this.tileAt(nx, ny);
    if (!WALKABLE.has(t) || this.occupied(nx, ny)) { await g.blocked(); return; }
    if (t === T.FIRE_FIELD && rand8() & 1) { g.con.print(M.slowProgress); return; }
    m.x = nx; m.y = ny;
    await playEffect(SFX.STEP);
    await this.terrainEffect(m);
  }

  /** Fields under a member (1000:9209, combat): the member's line flashes with the hurt noise (1000:09D9). */
  private async terrainEffect(m: Member) {
    const t = this.tileAt(m.x, m.y);
    const hurt = () => inverted(this.g, [statusRowRect(m.i)], () => playEffect(SFX.HURT)); // 1000:09D9
    if ((t === T.POISON_FIELD || t === T.SWAMP) && m.p.status === "G") { m.p.status = "P"; this.g.con.print(M.poisoned); await hurt(); }
    else if (t === T.FIRE_FIELD || t === T.LAVA) { await hurt(); this.g.damagePlayer(m.p, 16 + (rand8() % 32)); this.g.con.print(M.burned); }
    else if (t === T.SLEEP_FIELD && m.p.status === "G") { m.p.status = "S"; this.g.con.print(M.slept); await hurt(); }
  }

  /** 1000:96B9 / 1000:9764: the member's status line is inverted (1000:224B) while the hit shows with the hurt noise. */
  private hurtFlash(m: Member, tile: number) {
    return inverted(this.g, [statusRowRect(m.i)], () => this.flash(m.x, m.y, tile, SFX.HURT));
  }

  /**
   * 1000:9B03: under Jinx, a monster stepping onto another one hits it instead: the hit tile shows on
   * the victim with the hit noise and it takes rand & 0x3F damage, for no experience. True if it did.
   */
  private async jinx(x: number, y: number): Promise<boolean> {
    if (this.g.spellEffect !== "J") return false;
    const victim = this.monsterAt(x, y);
    if (!victim) return false;
    await this.flash(x, y, T.HIT_FLASH, SFX.HIT);
    this.damageMonster(victim, rand8() & 0x3f, null);
    return true;
  }

  private async attack(m: Member) {
    const g = this.g;
    const d = await g.askDir(M.dir); // 1000:61E5
    if (!d) return;
    const w = m.p.weapon;
    const weapon = WEAPONS[w];
    const [dx, dy] = DIRS[d];
    // the swing (1000:61D1) or the miss (1000:5F9D) sounds the attack effect
    // Halberd reaches 2 squares (1000:61D1)
    if (w === 10) {
      await playEffect(SFX.ATTACK);
      for (let k = 1; k <= 2; k++) {
        const t = this.monsterAt(m.x + dx * k, m.y + dy * k);
        if (t) { await this.resolveHit(m, t); return; }
      }
      await this.missed();
      return;
    }
    const adj = this.monsterAt(m.x + dx, m.y + dy);
    if (!weapon.ranged && !(w === 2 && !adj)) {
      await playEffect(SFX.ATTACK);
      if (!adj) { await this.missed(); return; }
      await this.resolveHit(m, adj);
      return;
    }
    // ranged weapons; a dagger with no adjacent target is thrown and lost; flaming oil asks for a range
    let range: number = COMBAT_RULES.rangedWeaponRange;
    if (w === 2 || w === 9) {
      if (g.save.weapons[w] <= 0 && w === 9) { g.con.print(M.noneLeft); return; }
      if (w === 9) {
        await say(g, M.range);
        const r = parseInt(await g.getKey(), 10);
        if (!(r >= 0 && r <= 9)) { g.con.println(""); return; }
        g.con.println(String(r));
        range = r;
      }
      if (g.save.weapons[w] > 0) g.save.weapons[w]--;
      if (g.save.weapons[w] === 0) { m.p.weapon = 0; g.con.print(M.lastOne); }
    }
    const projectile = w === 14 ? T.MAGIC_FLASH : T.MISSILE;
    await playEffect(SFX.ATTACK); // 1000:60F1
    const hit = await this.shoot(m.x, m.y, d, range, projectile, false);
    if (w === 9) {
      const fx = hit ? hit.x : m.x + dx * range, fy = hit ? hit.y : m.y + dy * range;
      if (this.tileAt(fx, fy) >= 0) this.tiles[fy * 11 + fx] = T.FIRE_FIELD;
    }
    const target = hit && this.monsterAt(hit.x, hit.y);
    if (!target) { g.con.print(M.missed); return; }
    await this.resolveHit(m, target);
  }

  /** 1000:5F9D(0): nothing in the way of the blow: the attack sound again, then the miss message. */
  private async missed() {
    await playEffect(SFX.ATTACK);
    this.g.con.print(M.missed);
  }

  /** 1000:6012 hit roll and damage; 1000:5DAB damage to monster. */
  private async resolveHit(m: Member, target: Monster) {
    const g = this.g;
    const w = m.p.weapon;
    const inAbyss = g.save.location === 24;
    const hit = !(inAbyss && w <= 10) && (m.p.dex >= 40 || rand8() <= m.p.dex + 128);
    if (!hit) { g.con.print(M.missed); return; }
    await this.flash(target.x, target.y, T.HIT_FLASH, SFX.HIT); // 1000:60CA
    this.damageMonster(target, rand8() % Math.min(255, m.p.str + WEAPONS[w].damage), m);
  }

  damageMonster(target: Monster, dmg: number, by: Member | null) {
    const g = this.g;
    if (target.tile === T.LORD_BRITISH) return;
    target.hp -= dmg;
    const name = target.info.name;
    if (target.hp <= 0) {
      target.alive = false;
      this.lastKill = { x: target.x, y: target.y };
      g.con.print(`${name} ${M.killed}`);
      if (by) {
        g.con.println(M.exp + target.info.xp);
        by.p.xp = Math.min(COMBAT_RULES.xpCap, by.p.xp + target.info.xp);
      }
      return;
    }
    const b = target.info.baseHp;
    // 1000:5E58: "Heavily "/"Lightly "/"Barely " + "Wounded!\n"
    const state = target.hp < 24 ? M.fleeing : target.hp < b / 4 ? M.critical : (target.hp < b / 2 ? M.heavily : target.hp < (3 * b) / 4 ? M.lightly : M.barely) + M.wounded;
    g.con.print(`${name}\n${state}`);
  }

  // ------------------------------------------------------------ monster side

  /** 1000:9F7B */
  private async monstersTurn() {
    for (const mon of this.monsters) {
      if (!mon.alive) continue;
      if (!this.partyLeft) return;
      // fields under monsters
      const t = this.tileAt(mon.x, mon.y);
      if (t === T.POISON_FIELD || ((t === T.FIRE_FIELD || t === T.LAVA) && !has(mon.info, "fireImmune"))) {
        await playEffect(SFX.HIT); // 1000:A0F6
        this.damageMonster(mon, rand8() & 0x7f, null);
        if (!mon.alive) continue;
      }
      if (mon.asleep) { if (rand8() % 8 === 0) mon.asleep = false; continue; }
      if (has(mon.info, "negatesMagic")) this.g.setSpellEffect("N", 2);
      if (has(mon.info, "teleports") && rand8() % 8 === 0) {
        for (let k = 0; k < 20; k++) {
          const x = rand8() % 11, y = rand8() % 11;
          if (WALKABLE.has(this.tileAt(x, y)) && !this.occupied(x, y)) { mon.x = x; mon.y = y; break; }
        }
        continue;
      }
      await this.monsterAct(mon);
      await sleep(60);
    }
  }

  private nearest(mon: Monster): Member | undefined {
    let best: Member | undefined, bd = 1e9;
    for (const m of this.party) {
      if (!m.present || m.p.status === "D") continue;
      const d = Math.abs(m.x - mon.x) + Math.abs(m.y - mon.y);
      if (d < bd) { bd = d; best = m; }
    }
    return best;
  }

  /** 1000:98E4 */
  private canEnter(mon: Monster, x: number, y: number): boolean {
    const t = this.tileAt(x, y);
    if (t < 0 || this.occupied(x, y)) return false;
    if (has(mon.info, "sea")) return t < 3;
    if (has(mon.info, "flies") && t < 3) return true;
    if (has(mon.info, "passesWalls")) return t >= 3 && t !== T.ENERGY_FIELD;
    return WALKABLE.has(t);
  }

  /** 1000:9CBC */
  private async monsterAct(mon: Monster) {
    const g = this.g;
    const target = this.nearest(mon);
    if (!target) return;
    if (has(mon.info, "stationary") && !(has(mon.info, "mimic") && this.mimicRevealed(mon)) && !has(mon.info, "castsSleep")) return;
    // sleep spell (Reaper, Balron)
    if (has(mon.info, "castsSleep") && g.spellEffect !== "N" && rand8() % 4 === 0) {
      g.con.print(M.sleep);
      await inverted(g, [VIEWPORT_RECT], () => playEffect(SFX.MAGIC, 0x80)); // 1000:9D7E, between two viewport inverts (1000:2241)
      for (const m of this.party) if (m.present && m.p.status === "G" && rand8() & 1) m.p.status = "S";
      return;
    }
    const dx = target.x - mon.x, dy = target.y - mon.y;
    const adjacent = Math.abs(dx) + Math.abs(dy) === 1;
    // ranged attack 1/4 of the time, along a row or column
    if (mon.info.ranged && rand8() % 4 === 0 && (dx === 0 || dy === 0) && !(mon.info.ranged === "magic" && g.spellEffect === "N")) {
      const d: Dir = dx === 0 ? (dy < 0 ? "N" : "S") : dx < 0 ? "W" : "E";
      await this.monsterRanged(mon, d);
      return;
    }
    if (mon.hp < COMBAT_RULES.monsterFleeHpBelow && !has(mon.info, "stationary")) {
      // flee: move away; leaving the map = escape (1000:9C56)
      const sx = -Math.sign(dx) || (rand8() & 1 ? 1 : -1), sy = -Math.sign(dy);
      const nx = mon.x + (Math.abs(dx) >= Math.abs(dy) ? sx : 0), ny = mon.y + (Math.abs(dx) >= Math.abs(dy) ? 0 : sy || 1);
      if (nx < 0 || ny < 0 || nx > 10 || ny > 10) {
        mon.alive = false;
        g.con.print(mon.info.name + M.flees);
        if (isNonEvil(mon.tile)) { g.karmaInc(1, 1); g.karmaInc(3, 1); }
        await playEffect(SFX.FLEE); // 1000:9C56
        return;
      }
      if (await this.jinx(nx, ny)) return;
      if (this.canEnter(mon, nx, ny)) { mon.x = nx; mon.y = ny; }
      return;
    }
    if (adjacent) {
      // thefts sound the flee effect (1000:9B6B, 9BA6)
      if (has(mon.info, "stealsFood")) { g.save.food = Math.max(0, g.save.food - 2500); g.con.print(M.foodStolen); await playEffect(SFX.FLEE); }
      if (has(mon.info, "stealsGold") && rand8() % 4 === 0) { g.save.gold = Math.max(0, g.save.gold - (rand8() & 0x3f)); g.con.print(M.goldStolen); await playEffect(SFX.FLEE); }
      await this.monsterMelee(mon, target);
      return;
    }
    // move one step towards the target (try the larger axis first)
    const steps: [number, number][] = Math.abs(dx) >= Math.abs(dy)
      ? [[Math.sign(dx), 0], [0, Math.sign(dy)]]
      : [[0, Math.sign(dy)], [Math.sign(dx), 0]];
    for (const [sx, sy] of steps) {
      if (!sx && !sy) continue;
      if (await this.jinx(mon.x + sx, mon.y + sy)) return;
      if (this.canEnter(mon, mon.x + sx, mon.y + sy)) { mon.x += sx; mon.y += sy; return; }
    }
  }

  /** 1000:9BE5 melee, 1000:96B9 damage */
  private async monsterMelee(mon: Monster, m: Member) {
    const g = this.g;
    g.con.println(M.attackedBy + mon.info.name); // 1000:5333
    await playEffect(SFX.MONSTER_ATTACK); // 1000:9C06
    const prot = g.spellEffect === "P" && rand8() & 1;
    if (prot || rand8() <= ARMOURS[m.p.armour].defense) { g.con.print(M.missed); return; }
    await this.hurtFlash(m, T.HIT_FLASH); // 1000:96B9
    const r = rand8() % Math.max(1, mon.info.maxDamageRoll);
    this.hurtMember(m, (r >> 4) * 10 + (r % 10));
  }

  hurtMember(m: Member, dmg: number) {
    const g = this.g;
    g.damagePlayer(m.p, dmg);
    if (m.p.status === "D") {
      g.con.print(m.p.name + M.isKilled);
      g.karmaInc(4, 1);
      m.present = false;
    } else g.con.print(`${m.p.name}\n${M.hit}`);
  }

  /** 1000:978C */
  private async monsterRanged(mon: Monster, d: Dir) {
    const g = this.g;
    const kind = mon.info.ranged!;
    const tiles: Record<MonsterRanged, number> = {
      poison: T.POISON_FIELD, energy: T.ENERGY_FIELD, fire: T.FIRE_FIELD, sleep: T.SLEEP_FIELD, lava: T.LAVA,
      missile: T.MISSILE, magic: T.MAGIC_FLASH, fireball: T.HIT_FLASH, boulder: T.ROCKS, randomField: T.POISON_FIELD + (rand8() & 3),
    };
    let tile = tiles[kind];
    await playEffect(SFX.CANNON); // 1000:97B1
    const hit = await this.shoot(mon.x, mon.y, d, 11, tile, true);
    const m = hit && this.memberAt(hit.x, hit.y);
    if (!m) {
      if (kind === "lava" && hit) this.tiles[hit.y * 11 + hit.x] = T.LAVA;
      return;
    }
    if (kind === "randomField") tile = tiles.randomField;
    await this.hurtFlash(m, tile); // 1000:9764 / 96B9
    const dmg = () => { const r = rand8() % Math.max(1, mon.info.maxDamageRoll); return (r >> 4) * 10 + (r % 10); };
    switch (tile) {
      case T.POISON_FIELD:
        if (m.p.status === "G" && rand8() & 1) { m.p.status = "P"; g.con.print(`${m.p.name}\n${M.poisoned}`); } else g.con.print(M.failed);
        break;
      case T.SLEEP_FIELD:
        if (m.p.status === "G" && rand8() & 1) { m.p.status = "S"; g.con.print(`${m.p.name}\n${M.slept}`); } else g.con.print(M.failed);
        break;
      case T.ENERGY_FIELD: g.con.print(M.electrified); this.hurtMember(m, dmg()); break;
      case T.FIRE_FIELD: g.con.print(M.fieryHit); this.hurtMember(m, dmg()); break;
      case T.LAVA: g.con.print(M.lavaHit); this.hurtMember(m, dmg()); break;
      case T.MAGIC_FLASH: g.con.print(M.magicalHit); this.hurtMember(m, dmg()); break;
      default: this.hurtMember(m, dmg());
    }
  }

  // ------------------------------------------------------------ end

  /** 1000:837A */
  private finish(): CombatResult {
    const g = this.g;
    const evil = this.req.monsters.some((m) => !isNonEvil(m.tile));
    // leaving a dungeon room: only "Leave Room!", printed by the dungeon (1000:837A, mode 6)
    if (this.inRoom) {
      if (this.party.every((m) => m.p.status === "D")) return { outcome: "lost", chest: false };
      return { outcome: this.monstersLeft ? "fled" : "won", lastKill: this.lastKill, chest: false };
    }
    if (!this.partyLeft) {
      if (this.party.every((m) => m.p.status === "D")) return { outcome: "lost", chest: false };
      if (this.monstersLeft) {
        if (evil) { g.con.print(M.battleLost); g.karmaDec(2, 2); }
        else { g.karmaInc(1, 2); g.karmaInc(3, 2); }
        return { outcome: "fled", chest: false };
      }
    }
    g.con.print(M.victory);
    if (evil) g.karmaInc(2, rand8() & 1);
    const first = creatureInfo(this.req.monsters[0]?.tile ?? 0);
    return { outcome: "won", lastKill: this.lastKill, chest: !first.def?.flags.includes("noChest") };
  }

  /** Narrow API for spells cast in combat (see magic.ts). */
  api(m: Member): CombatApi {
    return {
      caster: m.p,
      casterPos: { x: m.x, y: m.y },
      monsters: () => this.monsters.filter((x) => x.alive).map((x) => ({ tile: x.tile, x: x.x, y: x.y, hp: x.hp, asleep: x.asleep, undead: isUndead(x.tile) })),
      shoot: async (d, tile) => {
        const hit = await this.shoot(m.x, m.y, d, 11, tile, false);
        return hit ? { x: hit.x, y: hit.y } : null;
      },
      damageAt: (x, y, dmg) => { const t = this.monsterAt(x, y); if (t) this.damageMonster(t, dmg, m); },
      setHpAt: (x, y, hp) => { const t = this.monsterAt(x, y); if (t) t.hp = hp; },
      sleepAt: (x, y) => { const t = this.monsterAt(x, y); if (t) t.asleep = true; },
      tileAt: (x, y) => this.tileAt(x, y),
      setTile: (x, y, t) => { if (this.tileAt(x, y) >= 0) this.tiles[y * 11 + x] = t; },
      flash: (x, y, tile) => this.flash(x, y, tile),
    };
  }
}

export interface CombatApi {
  caster: PlayerRecord;
  casterPos: { x: number; y: number };
  monsters(): { tile: number; x: number; y: number; hp: number; asleep: boolean; undead: boolean }[];
  /** Fires a projectile from the caster; returns the monster square hit, if any. */
  shoot(d: Dir, tile: number): Promise<{ x: number; y: number } | null>;
  damageAt(x: number, y: number, dmg: number): void;
  setHpAt(x: number, y: number, hp: number): void;
  sleepAt(x: number, y: number): void;
  tileAt(x: number, y: number): number;
  setTile(x: number, y: number, t: number): void;
  flash(x: number, y: number, tile?: number): Promise<void>;
}

export async function runCombat(g: Game, req: CombatRequest): Promise<CombatResult> {
  return new Combat(g, req).run();
}
