// Dungeon exploration (first-person 3D view rendered with three.js).
// Rules ported from the unpacked AVATAR.EXE (addresses 1000:xxxx; see docs/RE_NOTES.md):
//   84D2 dungeon command loop, 87E2 end of turn, 9209 cell effects, 9414/95AA wandering monsters,
//   8743/7D50 encounters, 7FFD/837A rooms, 72EC/7150 chests, B9B2 search (orbs, fountains, altars),
//   C41D/C23B peer at a gem, 7525 ignite torch, 89DB/8A1F klimb/descend, 3F03/3EE4 entry.
// Save layout while underground (as in the original): save.x/y = position in the dungeon (DS:9318/9319),
// save.dngX/dngY = overworld position (DS:9332/9333), dngLevel = level (DS:9336, 0xFFFF on the surface),
// orientation 0 W, 1 N, 2 E, 3 S (DS:9334), balloonState = torch turns left (DS:9320).
import { assets } from "../assets/store";
import type { CombatMap, DungeonRoom } from "../formats/maps";
import type { PlayerRecord } from "../formats/save";
import type { CombatResult } from "./combat";
import type { Game } from "./game";
import { LOCATIONS, type LocationDef } from "./locations";
import { DIR_DX, DIR_DY, DungeonView } from "../dungeon/view";
import {
  ABYSS, ABYSS_ITEMS, ALTAR_EXITS, ALTAR_NAMES, DUNGEON_ARENAS, FIRST_DUNGEON, MONSTER_UPGRADE, NO_CHEST_MONSTERS,
  ORB_DAMAGE, ORB_DEX, ORB_INT, ORB_STAT_CAP, ORB_STR, PEER_GLYPHS, STATIC_MONSTERS, STONE_NAMES, monsterIndex,
} from "../dungeon/tables";
import { fmt } from "../data/text";
import { MSG_FIGHT as M } from "./texts/fight";

/** Arena passed to combat for a dungeon room: the 11x11 room plus what combat needs to know about it. */
export interface DungeonArena extends CombatMap {
  /** Room triggers (stepping on tile at x,y changes the listed squares). */
  triggers: DungeonRoom["triggers"];
  /** Altar room virtue (0 Truth, 1 Love, 2 Courage) or -1: hook for U)se stone at the altar (1000:01E1). */
  altar: number;
  /** Set by combat when the party walks off the room: orientation of the exit (0 W, 1 N, 2 E, 3 S). */
  exitDir: number | null;
}


/** Facing labels by orientation (0 W, 1 N, 2 E, 3 S), DS:1632.. (" North", "  West"). */
const dirLabel = (d: number) => [M.west6, M.north6, M.east6, M.south6][d].padStart(6);
const SURFACE = 0xffff;
const HYTHLOTH = 23;
/** Same input wait as the overworld loop (FUN_1000_16cd(0x19,1)). */
const IDLE_MS = 8000;

import { rand8 as rnd } from "./rng";
/** Sign of a random signed byte (FUN_1000_4fd7 on FUN_1000_1771). */
const rndSign = () => { const v = (rnd() << 24) >> 24; return v < 0 ? -1 : v > 0 ? 1 : 0; };
import { sleep, askMember } from "./prompts";
import { canAct } from "./party";
import { playEffect, SFX } from "../audio/speaker";

interface Wanderer { tile: number; x: number; y: number; px: number; py: number; level: number; }

class DungeonRun {
  private loc!: LocationDef;
  private levels: Uint8Array[] = [];
  private rooms: DungeonRoom[] = [];
  private cleared = new Map<number, Set<number>>();
  private wanderers: (Wanderer | null)[] = [];
  /** Unwrapped position for smooth wrapping in the 3D view. */
  private ux = 1; private uy = 1;
  private readonly view: DungeonView;
  private peer: number[] | null = null;
  private fighting = false;
  private done = false;

  constructor(private readonly g: Game) {
    this.view = new DungeonView(g.r.assets);
  }

  private get s() { return this.g.save; }
  private get con() { return this.g.con; }
  private get level() { return this.s.dngLevel; }
  private get dir() { return this.s.orientation & 3; }

  // ------------------------------------------------------------------ map access

  cell(x: number, y: number, level = this.level): number { return this.levels[level][((y & 7) << 3) | (x & 7)]; }
  setCell(x: number, y: number, v: number, level = this.level) { this.levels[level][((y & 7) << 3) | (x & 7)] = v; }
  private get here() { return this.cell(this.s.x, this.s.y); }
  private ahead(k: number) { return this.cell(this.s.x + DIR_DX[this.dir] * k, this.s.y + DIR_DY[this.dir] * k); }

  /**
   * What Q)uit & save keeps underground: the 8 level maps as modified by the party (DNGMAP.SAV, 512 bytes,
   * DS:8742) and the wandering monsters (32 slots: tile, x, y, level, 4 arrays of 32 bytes).
   */
  saveState(): { map: Uint8Array; monsters: Uint8Array } {
    const map = new Uint8Array(512);
    this.levels.forEach((l, i) => map.set(l, i * 64));
    const monsters = new Uint8Array(128);
    this.wanderers.forEach((m, i) => {
      if (!m) return;
      monsters[i] = m.tile; monsters[32 + i] = m.x; monsters[64 + i] = m.y; monsters[96 + i] = m.level;
    });
    return { map, monsters };
  }

  /** Puts back a saved state (resuming a game saved underground). */
  restoreState(map: Uint8Array, monsters: Uint8Array | null) {
    this.levels = this.levels.map((_, i) => map.slice(i * 64, i * 64 + 64));
    if (monsters) for (let i = 0; i < 32; i++)
      this.wanderers[i] = monsters[i] ? { tile: monsters[i], x: monsters[32 + i], y: monsters[64 + i], px: monsters[32 + i], py: monsters[64 + i], level: monsters[96 + i] } : null;
    this.ux = this.s.x; this.uy = this.s.y;
  }

  /** Loads a dungeon (FUN_1000_3e94): fresh copy of the levels, no wandering monsters. */
  async load(loc: LocationDef) {
    const dng = await assets.dungeon(loc.dungeon!);
    this.loc = loc;
    this.levels = dng.levels.map((l) => l.slice());
    this.rooms = dng.rooms;
    this.wanderers = new Array(32).fill(null);
    if (!this.cleared.has(loc.id)) this.cleared.set(loc.id, new Set());
  }

  // ------------------------------------------------------------------ view

  refresh(tween = true) {
    if (this.s.dngLevel === SURFACE) return; // left the dungeon (X-it, Y-up, Codex ejection)
    this.view.update({
      cellAt: (x, y) => this.cell(x, y), ux: this.ux, uy: this.uy, dir: this.dir, lit: this.s.balloonState > 0,
    }, tween);
  }

  /** Viewport layer: the 3D view, hidden (black) while a peer map is shown. */
  scene3d() { return this.peer ? null : { scene: this.view.scene, camera: this.view.camera }; }

  /** Drawn after Game.draw: level and facing in the frame (FUN_1000_353d), peer map (FUN_1000_c23b). */
  hud() {
    if (this.fighting) return;
    const r = this.g.r;
    this.view.frame(performance.now());
    r.fillRect(11 * 8, 0, 16, 8, 0);
    r.drawText(fmt(M.level, { n: this.level + 1 }), 11, 0);
    r.fillRect(7 * 8, 23 * 8, 10 * 8, 8, 0);
    r.drawText(M.dirLabel + dirLabel(this.dir), 7, 23);
    if (this.peer) {
      r.fillRect(8, 8, 176, 176, 0);
      for (let row = 1; row <= 22; row++)
        for (let col = 1; col <= 22; col++) {
          const gl = this.peer[row * 23 + col];
          if (gl >= 0) r.drawGlyph(gl, col, row);
        }
    }
  }

  // ------------------------------------------------------------------ main loop (1000:84D2)

  async run(): Promise<void> {
    this.refresh(false);
    // Spells and items act on the level through these hooks (magic.ts).
    const h = this.g.dungeon;
    h.cell = (x, y, level) => this.cell(x, y, level);
    h.setCell = (x, y, level, v) => this.setCell(x, y, v, level);
    h.exit = () => this.exitToSurface();
    h.refresh = () => { this.ux = this.s.x; this.uy = this.s.y; this.refresh(false); };
    h.peer = () => this.peerGem(false);
    h.state = () => this.saveState();
    try {
      await this.loop();
    } finally {
      h.cell = h.setCell = h.exit = h.refresh = null;
      h.peer = null;
      h.state = null;
    }
  }

  private async loop() {
    while (!this.done) {
      if (this.s.dngLevel === SURFACE) { this.done = true; break; } // X-it / Y-up from level 1

      await this.cellEffects();
      this.refresh();
      if (!this.members.some((p) => p.status !== "D")) {
        // the party is dead: leave the dungeon; the main loop resurrects it (1000:0EB1, "All is Dark...")
        this.done = true;
        return;
      }
      if (!this.members.some((p) => p.status === "G" || p.status === "P")) {
        this.con.print(M.zzz);
        await sleep(500);
        await this.endTurn();
        continue;
      }
      const k = await this.g.input.next(IDLE_MS);
      const passTurn = await this.command(k ? k.key : " ");
      if (this.done) break;
      if (passTurn) await this.endTurn();
    }
  }

  private get members() { return this.g.members; }

  /** Returns false when the command does not take a turn (turning, bad keys). */
  private async command(key: string): Promise<boolean> {
    switch (key) {
      case "ArrowUp": await this.advance(); return true;
      case "ArrowDown": await this.retreat(); return true;
      case "ArrowLeft": this.con.print(M.turnLeft); this.turn(-1); return false;
      case "ArrowRight": this.con.print(M.turnRight); this.turn(1); return false;
    }
    switch (key.toLowerCase()) {
      case " ": this.con.print(M.pass); return true;
      case "k": this.klimb(); return true;
      case "d": this.descend(); return true;
      case "g": await this.getChest(); return true;
      case "s": await this.search(); return true;
      case "i": this.ignite(); return true;
      case "p": await this.peerGem(); return true;
      case "a": case "b": case "e": case "f": case "j": case "l": case "o": case "t": case "x": case "y":
        this.con.print(M.notHere); await playEffect(SFX.BAD_COMMAND); return true; // 1000:85E8
    }
    // C)ast, M)ix, U)se, N)ew order, R)eady, W)ear, Z)tats, H)ole up, V)olume, Q)uit & save: registered commands
    const cmd = this.g.commands.get(key, "dungeon");
    if (cmd) {
      await cmd.run({ g: this.g, ctx: "dungeon" });
      if (cmd.key === "c" || cmd.key === "u" || cmd.key === "h") this.refresh(false);
      return cmd.key !== "q";
    }
    this.con.print(M.dngBadCommand);
    await playEffect(SFX.BAD_COMMAND); // 1000:8562
    return false;
  }

  // ------------------------------------------------------------------ movement

  /** FUN_1000_88e8: only forward moves enter doors, rooms and secret doors; energy fields (0xA1) and walls block. */
  private passable(forward: boolean, c: number): boolean {
    const t = c & 0xf0;
    if (forward && (t === 0xc0 || t === 0xe0 || t === 0xd0)) return true;
    return c !== 0xa1 && c < 0xc0;
  }

  private async advance() { // 1000:891E
    this.con.print(M.advance);
    if (!this.passable(true, this.ahead(1))) { await this.g.blocked(); return; }
    this.step(this.dir, 1);
  }

  private async retreat() { // 1000:895F
    this.con.print(M.retreat);
    if (!this.passable(false, this.ahead(-1))) { await this.g.blocked(); return; }
    this.step(this.dir, -1);
  }

  private step(dir: number, k: number) {
    this.ux += DIR_DX[dir] * k; this.uy += DIR_DY[dir] * k;
    this.s.x = this.ux & 7; this.s.y = this.uy & 7;
    this.refresh();
  }

  private turn(d: number) { // 1000:899F / 89BD
    this.s.orientation = (this.dir + d) & 3;
    this.refresh();
  }

  private klimb() { // 1000:89DB
    this.con.print(M.klimb);
    const t = this.here & 0xf0;
    if (t !== 0x10 && t !== 0x30) { this.con.print(M.what); return; }
    this.con.print(M.up);
    if (this.level === 0) { this.exitToSurface(); return; }
    this.s.dngLevel--;
    this.con.println(M.toLevel + (this.level + 1));
    this.refresh(false);
  }

  private descend() { // 1000:8A1F
    this.con.print(M.descend);
    const t = this.here & 0xf0;
    if (t !== 0x20 && t !== 0x30) { this.con.print(M.what); return; }
    this.s.dngLevel++;
    this.con.println(M.downToLevel + (this.level + 1));
    this.refresh(false);
  }

  private exitToSurface() {
    const s = this.s;
    s.dngLevel = SURFACE;
    s.x = s.dngX; s.y = s.dngY;
    this.g.setPos(s.x, s.y);
    this.done = true;
  }

  // ------------------------------------------------------------------ cell effects (1000:9209, mode 3)

  private async cellEffects() {
    const c = this.here, t = c & 0xf0;
    if (t === 0xa0) {
      const sub = c & 3;
      if (sub === 0) await this.poisonField();
      else if (sub === 2) await this.hazard();
      else if (sub === 3) await this.sleepField();
    } else if (t === 0x80) {
      if (c === 0x80) { this.con.print(M.winds); this.s.balloonState = 0; return; }
      this.con.print(c < 0x88 ? M.fallingRocks : M.pit);
      await this.hazard();
    }
  }


  /** Each member hit flashes with the hurt noise (1000:09D9). */
  private async poisonField() { // 1000:91D1
    for (const p of this.members.slice().reverse()) if (p.status === "G" && (rnd() & 7) === 0) { p.status = "P"; await playEffect(SFX.HURT); }
  }

  private async sleepField() { // 1000:919A
    for (const p of this.members.slice().reverse()) if (canAct(p) && (rnd() & 3) === 0) { p.status = "S"; await playEffect(SFX.HURT); }
  }

  /** 1000:1584 underground: the party flashes with the hit noise, then each living member, 50%: 10 + rand%15 damage. */
  private async hazard() {
    await playEffect(SFX.HIT);
    for (const p of this.members.slice().reverse())
      if ((rnd() & 1) && p.status !== "D") this.g.damage(p, (rnd() % 15) + 10);
  }

  // ------------------------------------------------------------------ end of turn (1000:87E2)

  private async endTurn() {
    this.g.endTurn(); // food, poison, sleep (1/8 wake), MP, move counter, timed effects
    this.moveMonsters();
    this.spawnMonsters();
    const s = this.s;
    if (s.balloonState > 0) s.balloonState--;
    if (s.balloonState === 0) this.con.print(M.dark);
    this.refresh();
    if (!(await this.encounter()))
      while ((this.here & 0xf0) === 0xd0 && !this.done) await this.room();
  }

  /** 1000:93A5: a wandering monster may step onto an empty, non-hazard cell; rarely back where it came from. */
  private free(m: Wanderer, x: number, y: number): boolean {
    const b = this.cell(x, y), t = b & 0xf0;
    return (b & 0xf) === 0 && (b & 0xe0) !== 0x80 && t !== 0xa0 && t !== 0xd0 && t !== 0xf0 &&
      ((rnd() & 7) === 0 || m.px !== x || m.py !== y);
  }

  private moveMonsters() { // 1000:9414
    const s = this.s;
    for (let i = 31; i >= 0; i--) {
      const m = this.wanderers[i];
      if (!m || m.level !== this.level || STATIC_MONSTERS.includes(m.tile) || (m.x === s.x && m.y === s.y)) continue;
      let nx = -1, ny = -1;
      for (let a = 7; a >= 0; a--) {
        const dx = rndSign(), dy = rndSign();
        if ((rnd() & 1) && dx !== 0) { nx = (m.x + dx) & 7; ny = m.y; if (this.free(m, nx, ny)) break; }
        if (dy !== 0) { nx = m.x; ny = (m.y + dy) & 7; if (this.free(m, nx, ny)) break; }
        nx = (m.x + dx) & 7; ny = m.y;
        if (this.free(m, nx, ny)) break;
        nx = -1;
      }
      if (nx < 0) continue;
      this.setCell(nx, ny, this.cell(nx, ny) | (((m.tile - 0x90) >> 2) + 1));
      this.setCell(m.x, m.y, this.cell(m.x, m.y) & 0xf0);
      m.px = m.x; m.py = m.y; m.x = nx; m.y = ny;
    }
  }

  private spawnMonsters() { // 1000:95AA: two slots per level, never on the party's row or column
    const s = this.s, L = this.level;
    for (const i of [L * 4 + 1, L * 4]) {
      if (this.wanderers[i]) continue;
      const x = rnd() & 7, y = rnd() & 7;
      if (x === s.x || y === s.y || this.cell(x, y) !== 0) continue;
      const tile = (((rnd() & 3) + L) * 4 + 0x90) & 0xff;
      if (tile === 0xac) continue;
      this.wanderers[i] = { tile, x, y, px: x, py: y, level: L };
      this.setCell(x, y, ((tile - 0x90) >> 2) + 1);
    }
  }

  // ------------------------------------------------------------------ combat

  private async fight(arena: CombatMap, monsters: { tile: number; x: number; y: number }[], entryDir?: number): Promise<CombatResult["outcome"]> {
    this.fighting = true;
    const g = this.g;
    try {
      return (await g.fight({ arena, monsters, context: "dungeon", entryDir })).outcome;
    } finally {
      this.fighting = false;
    }
  }

  /** 1000:8743: the party shares a cell with a wandering monster -> combat (1000:7D50). */
  private async encounter(): Promise<boolean> {
    const s = this.s, c = this.here, t = c & 0xf0;
    if ((c & 0xf) === 0 || t === 0x80 || t === 0x90 || t === 0xa0 || t === 0xd0 || t === 0xf0) return false;
    const tile = ((c & 0xf) * 4 + 0x8c) & 0xff;
    this.setCell(s.x, s.y, t);
    const i = this.wanderers.findIndex((m) => m && m.level === this.level && m.x === s.x && m.y === s.y);
    if (i >= 0) this.wanderers[i] = null;
    const arena = await assets.combat(DUNGEON_ARENAS[t >> 4]);
    const res = await this.fight(arena, this.group(tile, arena));
    // 1000:8283: a beaten group leaves a chest on an empty square.
    if (res === "won" && !NO_CHEST_MONSTERS.includes(tile) && this.here === 0) this.setCell(s.x, s.y, 0x40);
    this.refresh(false);
    return true;
  }

  /** Group generation (1000:7E7E): size, occasional stronger members, random arena slots. */
  private group(base: number, arena: CombatMap) {
    const n = this.s.members;
    let count = rnd() & 7; // DS:242A gives 0 for the r==0 case
    while (count >> 1 >= n) count = rnd() % (n * 2);
    const used = new Set<number>();
    const out: { tile: number; x: number; y: number }[] = [];
    for (; count >= 0; count--) {
      let slot: number;
      do slot = rnd() & 15; while (used.has(slot));
      used.add(slot);
      let tile = base;
      if (base > 0x80 && count !== 0) {
        if ((rnd() & 0x1f) === 0) tile = MONSTER_UPGRADE[monsterIndex(MONSTER_UPGRADE[monsterIndex(base)])];
        else if ((rnd() & 7) === 0) tile = MONSTER_UPGRADE[monsterIndex(base)];
      }
      const [x, y] = arena.monsterPos[slot];
      out.push({ tile, x, y });
    }
    return out;
  }

  /** Dungeon room (1000:7FFD), then leaving it (1000:837A). */
  private async room() {
    const s = this.s, n = this.here & 0xf;
    const idx = this.loc.id === ABYSS ? (this.level >> 1) * 16 + n : n;
    const room = this.rooms[idx];
    let altar = -1;
    if (n === 15 && this.loc.id < ABYSS) {
      altar = s.x === 3 ? 1 : s.x < 3 ? 0 : 2;
      this.con.print(`${M.altarRoom}${ALTAR_NAMES[altar]}\n`);
    }
    // party start set by direction of travel (0 = came from the north, 1 east, 2 south, 3 west)
    const entry = ((this.dir - 1) ^ 2) & 3;
    const arena: DungeonArena = {
      tiles: room.tiles.slice(),
      monsterPos: room.monsters.map((m) => [m.x, m.y] as [number, number]),
      partyPos: room.partyPos[entry],
      triggers: room.triggers, altar, exitDir: null,
    };
    // Rooms are cleared once per visit of the dungeon (the original re-reads them from disk every time).
    const done = this.cleared.get(this.loc.id)!;
    const res = await this.fight(arena, done.has(idx) ? [] : room.monsters.map((m) => ({ ...m })), entry);
    if (res === "lost") { this.refresh(false); return; }
    if (res === "won") done.add(idx);
    this.con.print(M.leaveRoom);
    if (arena.exitDir !== null) s.orientation = arena.exitDir & 3;
    if (altar >= 0) {
      const id = ALTAR_EXITS[altar * 4 + ((this.dir - 1) & 3)];
      const loc = LOCATIONS[id];
      this.con.print(M.intoDungeon);
      this.con.println(loc.name);
      s.location = id;
      s.dngX = loc.x; s.dngY = loc.y;
      await this.load(loc);
    }
    this.step(this.dir, 1);
    this.refresh(false);
  }

  // ------------------------------------------------------------------ commands

  /** 1000:1287: "Who ...?" party member prompt; -1 when cancelled (or "0"). */
  private async askPlayer(prompt: string): Promise<number> {
    const i = await askMember(this.g, prompt);
    return i < 0 ? -1 : i;
  }

  private async getChest() { // 1000:72EC / 722F
    this.con.print(M.getChest);
    const i = await this.askPlayer(M.whoOpens);
    if (i < 0) return;
    const p = this.members[i];
    if (!canAct(p)) { this.con.print(M.disabled); return; }
    if (this.here !== 0x40) { this.con.print(M.notHere); return; }
    this.setCell(this.s.x, this.s.y, 0);
    await this.chestTrap(p);
    // 1000:70F1
    const gold = (rnd() % 80) + (rnd() & 7) + 10;
    this.con.print(M.chestHolds);
    this.con.print(gold + M.gold);
    this.s.gold = Math.min(9999, this.s.gold + gold);
    this.refresh(false);
  }

  /** 1000:7150: half the chests are trapped; type = (r1&3)&r2 with r1 even, i.e. only Acid or Poison. */
  private async chestTrap(p: PlayerRecord) {
    const r1 = rnd();
    if (r1 & 1) return;
    const type = r1 & 3 & rnd();
    this.con.print([M.trapAcid, M.trapSleep, M.trapPoison, M.trapBomb][type] + M.trap);
    if (rnd() % 100 <= p.dex + 25) { this.con.print(M.evaded); await playEffect(SFX.FLEE); return; }
    if (type === 3) { await this.hazard(); return; }
    // acid, sleep, poison: the member flashes with the hurt noise (1000:09D9)
    if (type === 1) p.status = "S";
    else if (type === 2) p.status = "P";
    await playEffect(SFX.HURT);
    if (type === 0) this.g.damage(p, rnd() % 30);
  }

  private ignite() { // 1000:7525
    this.con.print(M.ignite);
    if (this.s.torches === 0) { this.con.print(M.noneLeft); return; }
    this.s.torches--;
    this.s.balloonState += 100;
    this.refresh(false);
  }

  private async search() { // 1000:B9B2
    this.con.print(M.search);
    const t = this.here & 0xf0;
    if (t === 0x70) await this.orb();
    else if (t === 0x90) await this.fountain();
    else if (t === 0xb0) await this.altarStone();
    else this.con.print(M.findNothing);
  }

  private async orb() { // 1000:B795
    this.con.print(M.orb);
    const i = await this.askPlayer(M.whoTouches);
    if (i < 0) return;
    const p = this.members[i];
    if (!canAct(p)) { this.con.print(M.disabledNl); return; }
    const d = this.loc.id - FIRST_DUNGEON;
    this.setCell(this.s.x, this.s.y, 0);
    await this.hurt(p, ORB_DAMAGE[d] * 100);
    const raise = (k: "str" | "dex" | "int", msg: string) => { p[k] = Math.min(ORB_STAT_CAP, p[k] + 5); this.con.print(msg); };
    if (ORB_STR[d]) raise("str", M.strength);
    if (ORB_DEX[d]) raise("dex", M.dexterity);
    if (ORB_INT[d]) raise("int", M.intelligence);
    this.refresh(false);
  }

  private async fountain() { // 1000:B863
    this.con.print(M.fountain);
    const i = await this.askPlayer(M.whoDrinks);
    if (i < 0) return;
    const p = this.members[i];
    if (!canAct(p)) { this.con.print(M.disabledNl2); return; }
    switch (this.here & 0xf) {
      case 1: if (p.hp !== p.hpMax) { this.con.print(M.refreshing); p.hp = p.hpMax; return; } break;
      case 2: this.con.print(M.nasty); await this.hurt(p, 100); return;
      case 3: if (p.status === "P") { p.status = "G"; this.con.print(M.delicious); return; } break;
      case 4: if (p.status !== "P") { p.status = "P"; this.con.print(M.choke); await this.hurt(p, 100); return; } break;
    }
    this.con.print(M.noEffect);
  }

  /** 1000:B730: the member's line flashes with three hurt noises, then the damage. */
  private async hurt(p: PlayerRecord, n: number) {
    for (let i = 0; i < 3; i++) await playEffect(SFX.HURT);
    this.g.damage(p, n);
  }

  /** 1000:B93F: the dungeon's stone lies on its altar cell; +5 Honor and 200 XP to the Avatar. */
  private async altarStone() {
    const id = this.loc.id, bit = 1 << (id - FIRST_DUNGEON);
    if (id === HYTHLOTH || id === ABYSS || (this.s.stones & bit)) { this.con.print(M.findNothing); return; }
    this.s.stones |= bit;
    this.con.print(M.findThe + STONE_NAMES[id - FIRST_DUNGEON] + M.stone);
    this.g.karmaInc(5, 5); // 1000:09F8 karma_inc(5, Honor)
    const av = this.s.players[0];
    av.xp = Math.min(9999, av.xp + 200);
  }

  /** 1000:C41D; `useGem` = false for the View spell. */
  private async peerGem(useGem = true) {
    if (useGem) {
      this.con.print(M.peerAt);
      if (this.s.gems === 0) { this.con.print(M.what); return; }
      this.con.print(M.aGem);
      this.s.gems--;
    }
    this.peer = this.peerMap();
    await this.g.getKey();
    this.peer = null;
  }

  /** 1000:C23B: flood fill from the party over a 22x22 window (8-connected, walls stop it). */
  private peerMap(): number[] {
    const W = 23, grid = new Array<number>(W * W).fill(-1);
    const seen = new Uint8Array(W * W);
    const queue: [number, number, number, number][] = [[11, 11, this.s.x, this.s.y]];
    seen[11 * W + 11] = 1;
    grid[11 * W + 11] = 1; // party marker (FUN_1000_22c0(1))
    while (queue.length) {
      const [col, row, x, y] = queue.shift()!;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          const c = col + dx, r = row + dy;
          if ((!dx && !dy) || c < 1 || c > 22 || r < 1 || r > 22 || seen[r * W + c]) continue;
          const v = this.cell(x + dx, y + dy);
          grid[r * W + c] = PEER_GLYPHS[v >> 4];
          if ((v & 0xf0) === 0xf0) continue;
          seen[r * W + c] = 1;
          queue.push([c, r, (x + dx) & 7, (y + dy) & 7]);
        }
    }
    return grid;
  }

  dispose() { this.view.dispose(); }
}

/**
 * Enters a dungeon, or (`resume`) goes back into the one a game was saved in, with the saved level maps
 * (DNGMAP.SAV) and wandering monsters.
 */
export async function runDungeon(g: Game, loc: LocationDef, resume?: { map: Uint8Array; monsters: Uint8Array | null }): Promise<void> {
  const s = g.save;
  if (!resume) {
    if (!g.onFoot) { g.con.print(M.onlyOnFoot); return; } // 1000:3F03
    if (loc.id === ABYSS && (s.items & ABYSS_ITEMS) !== ABYSS_ITEMS) { g.con.print(M.cant); return; } // 1000:3FB9
  }
  const run = new DungeonRun(g);
  await run.load(loc);
  if (import.meta.env.DEV) (window as unknown as { __dungeon: DungeonRun }).__dungeon = run; // for automated tests
  if (resume) run.restoreState(resume.map, resume.monsters);
  else {
    // 1000:3F03 / 3EE4: start at (1,1) of level 1 facing East; the overworld position is kept in dngX/dngY.
    s.dngX = s.x; s.dngY = s.y;
    s.x = 1; s.y = 1; s.orientation = 2; s.dngLevel = 0;
  }
  // The 3D view in the viewport, the level/direction in the frame and the peer map.
  const layer = g.layers.push({ name: "dungeon", view: () => null, scene3d: () => run.scene3d(), draw: () => run.hud() });
  try {
    await run.run();
  } finally {
    layer.remove();
    if (s.dngLevel !== SURFACE) { s.dngLevel = SURFACE; s.x = s.dngX; s.y = s.dngY; g.setPos(s.x, s.y); }
    run.dispose();
  }
}

/** Dev helper: `__toDungeon(17..24)` puts the party on that dungeon's entrance (then press E). */
if (import.meta.env.DEV) {
  (window as unknown as { __toDungeon: (id: number) => void }).__toDungeon = (id: number) => {
    const g = (window as unknown as { __game?: Game }).__game;
    const loc = LOCATIONS[id];
    if (g && loc?.dungeon && g.map.kind === "world") g.setPos(loc.x, loc.y);
  };
}
