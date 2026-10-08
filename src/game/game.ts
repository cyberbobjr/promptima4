// Game state, main loop, movement and screen composition. The commands live in their modules
// (actions.ts, places.ts, transport.ts, world/*, magic.ts, items.ts) and are found through the
// command registry; modes draw through layers (src/ui/layers.ts).
import { readSave } from "../io/gamefs";
import { config } from "../config/config";
import { assets } from "../assets/store";
import type { PlayerRecord, SaveGame } from "../formats/save";
import { EGA_PALETTE } from "../formats/ega";
import { Renderer, TILE, VIEW_TILES, VIEW_X, VIEW_Y } from "../render/renderer";
import { Console } from "./console";
import { Input, INTERRUPT, type Key } from "./input";
import { DIR_NAMES, DIRS, tileAt, type Dir, type MapCtx, type Npc, type WorldMap } from "./maps";
import { slowChance, T, tileFlags, Walk } from "./tiles";
import { CLASSES, MAX_MP_BY_CLASS } from "../data/tables";
import { MSG_CORE } from "./texts/core";
import { runCombat, type CombatRequest, type CombatResult } from "./combat";
import { HORN_EFFECT } from "./items";
import { LayerStack } from "../ui/layers";
import { drawStatus } from "../ui/statusPanel";
import { CommandRegistry, endsTurn, type Command, type CommandContext } from "./commands";
import { meditateAt } from "./shrine";
import { adjustKarma, karmaDec, karmaInc } from "./karma";
import { askMember } from "./prompts";
import type { DungeonHooks } from "./magic";
import { rand } from "./rng";
import { viewTiles } from "./view";
import { runDungeon } from "./dungeon";
import { LOCATIONS } from "./locations";
import { Sky, checkMoongate } from "./world/sky";
import { decodeObjects, type WorldObject } from "./world/objects";
import { partyDeath, worldFight, worldTurn } from "./world/monsters";
import { board, exitTransport, sail, yell } from "./transport";
import { closeDoors, descend, enter, jimmy, klimb, leaveTown, moveNpcs, open, talk } from "./places";
import { attack, getChest, holeUp, locate, openChest, quitSave, readyWeapon, volume, wearArmour, ztats, ztatsFor } from "./actions";
import { playEffect, SFX } from "../audio/speaker";
import { inverted, partyRowsRects, statusRowRect } from "../ui/invert";

export const CLASS_NAMES = CLASSES;

export { rand };
export type { WorldObject };

/** Class maximum MP (1000:13B6), capped at 99. */
export function maxMp(p: PlayerRecord): number {
  return Math.min(99, Math.floor(p.int * (MAX_MP_BY_CLASS[p.klass]?.mult ?? 0)));
}

export class Game {
  save!: SaveGame;
  world!: WorldMap;
  map!: MapCtx;
  /** party position on the current map (mirrors save.x/y on the overworld) */
  px = 0; py = 0;
  objects: WorldObject[] = [];
  readonly con = new Console();
  /** Moons, moongates and wind. */
  readonly sky = new Sky();
  /** Animation clock: +1 per 250 ms tick (main.ts). */
  private animTick = 0;
  get frame() { return this.animTick; }
  /** Modes (intro, combat, dungeon, shops, visions, endgame) draw through layers over the game screen. */
  readonly layers = new LayerStack();
  /** Key commands by context; modules register theirs (magic.ts, items.ts). */
  readonly commands = new CommandRegistry();
  /** Level access for spells and items while in a dungeon (set by dungeon.ts, all null elsewhere). */
  readonly dungeon: DungeonHooks = { cell: null, setCell: null, exit: null, refresh: null, peer: null, state: null };
  /** Town doors opened with O)pen, closing again after a few turns. */
  openedDoors: { x: number; y: number; turns: number }[] = [];
  /** The overworld creatures still have to act for this turn (world/monsters.ts worldTurn). */
  private worldTurnPending = false;
  /** Monster that will attack at the end of this turn. */
  pendingAttack: WorldObject | null = null;
  /** Shrine reached through a moongate, entered at the end of the turn (-1 = none). */
  pendingShrine = -1;
  /** Active timed spell effect DS:0x95A4 ('P','J','N','Q' or null) and its countdown DS:0x946E. */
  spellEffect: string | null = null;
  private spellTurns = 0;
  /** Party member whose combat turn it is (-1 outside combat). */
  activeMember = -1;
  private frameCanvas: HTMLCanvasElement;

  constructor(readonly r: Renderer, readonly input: Input) {
    this.frameCanvas = document.createElement("canvas");
    this.frameCanvas.width = 320; this.frameCanvas.height = 200;
    const ctx = this.frameCanvas.getContext("2d")!;
    const img = ctx.createImageData(320, 200);
    r.assets.frame.pixels.forEach((c, i) => img.data.set([...EGA_PALETTE[c], 255], i * 4));
    ctx.putImageData(img, 0, 0);
    this.registerCommands();
  }

  /** Overworld/town context of the key commands. */
  get context(): CommandContext { return this.map?.kind === "town" ? "town" : "world"; }

  /** Where the player is now, for the command bar and the help: a fight, a dungeon, a town or the world. */
  get mode(): CommandContext {
    if (this.activeMember >= 0) return "combat";
    if (this.save && this.save.location >= 17 && this.save.location <= 24) return "dungeon";
    return this.context;
  }

  /** Commands of the core modules (1000:1C06 dispatch); C, M, U, S, P, N, F, I come from magic.ts and items.ts. */
  private registerCommands() {
    const out: readonly CommandContext[] = ["world", "town"], all: readonly CommandContext[] = ["world", "town", "dungeon"];
    const cmd = (key: string, id: string, contexts: readonly CommandContext[], run: (g: Game) => unknown): Command =>
      ({ key, id, contexts, run: async () => { await run(this); } });
    this.commands.register(
      cmd(" ", "pass", out, (g) => { g.con.print(MSG_CORE.pass); g.endTurn(); }),
      cmd("a", "attack", out, attack),
      cmd("b", "board", out, board),
      cmd("d", "descend", out, descend),
      cmd("e", "enter", out, enter),
      cmd("g", "getChest", out, getChest),
      cmd("h", "holeUp", all, holeUp),
      cmd("j", "jimmy", out, jimmy),
      cmd("k", "klimb", out, klimb),
      cmd("l", "locate", out, locate),
      cmd("o", "open", out, open),
      cmd("q", "quitSave", all, quitSave),
      cmd("r", "ready", all, (g) => readyWeapon(g)),
      cmd("t", "talk", out, talk),
      // V)olume (1000:70AD) in every dispatch (1000:1AD4, combat 5BC2, dungeon 85D9); the turn goes by
      { key: "v", id: "volume", contexts: ["world", "town", "dungeon", "combat"], run: async (env) => { await volume(env.g); endsTurn(env); } },
      cmd("w", "wear", all, wearArmour),
      cmd("x", "exit", out, exitTransport),
      cmd("y", "yell", out, yell),
      cmd("z", "ztats", all, ztats),
    );
  }

  // ---------------------------------------------------------------- setup

  async start(save: SaveGame) {
    this.save = save;
    const world = await assets.world();
    this.world = { kind: "world", width: 256, height: 256, tiles: world };
    this.map = this.world;
    this.px = save.x; this.py = save.y;
    if (save.members === 0) save.members = 1;
    const objs = await readSave("OUTMONST.SAV");
    this.objects = objs ? decodeObjects(objs) : [];
    this.con.clear();
    // A game saved underground goes back into its dungeon (level maps in DNGMAP.SAV).
    const map = save.location >= 17 && save.location <= 24 && save.dngLevel < 8 ? await readSave("DNGMAP.SAV") : null;
    if (map && map.length >= 512) {
      this.px = save.dngX; this.py = save.dngY;
      await runDungeon(this, LOCATIONS[save.location], { map, monsters: await readSave("DNGMON.SAV") });
      save.location = 0;
    } else if (save.location >= 17 && save.location <= 24) {
      // saved underground without the level maps: back at the entrance
      save.location = 0; save.dngLevel = 0xffff; save.x = save.dngX; save.y = save.dngY;
      this.setPos(save.x, save.y);
    }
    await this.mainLoop();
  }

  get members() { return this.save.players.slice(0, this.save.members); }
  get onFoot() { return this.save.transport === T.AVATAR || this.save.transport === 0; }
  get onShip() { return this.save.transport >= T.SHIP_W && this.save.transport <= T.SHIP_S; }
  get onHorse() { return this.save.transport === T.HORSE_W || this.save.transport === T.HORSE_E; }
  get inBalloon() { return this.save.transport === T.BALLOON; }

  // ---------------------------------------------------------------- loop

  /** True while the main loop waits for a command on the overworld or in a town. */
  atPrompt = false;
  private queued: (() => Promise<void> | void)[] = [];

  /**
   * Runs `action` from the main loop at the next command prompt, like a command (interface panels:
   * teleports, debug fights, entering places). Returns false if the game is not at its prompt.
   */
  runAtPrompt(action: () => Promise<void> | void): boolean {
    if (!this.atPrompt) return false;
    this.queued.push(action);
    this.input.interrupt();
    return true;
  }

  private async mainLoop() {
    for (;;) {
      this.atPrompt = true;
      const k = await this.input.next(this.map.kind === "world" ? 8000 : 6000);
      this.atPrompt = false;
      if (k?.code === INTERRUPT) {
        for (let a = this.queued.shift(); a; a = this.queued.shift()) await a();
      } else if (!k) { this.con.print(MSG_CORE.pass); this.endTurn(); }
      else await this.command(k);
      if (this.pendingShrine >= 0) {
        const v = this.pendingShrine;
        this.pendingShrine = -1;
        await this.enterShrine(v);
      }
      if (this.worldTurnPending) {
        this.worldTurnPending = false;
        if (this.map.kind === "world" && !(this.save.location >= 17 && this.save.location <= 24)) await worldTurn(this);
      }
      if (this.pendingAttack) {
        const m = this.pendingAttack;
        this.pendingAttack = null;
        await this.worldFight(m, this.map.kind === "town" ? "town" : "world");
      }
      if (this.members.every((p) => p.status === "D")) await partyDeath(this);
    }
  }

  async command(k: Key) {
    const dir = Input.direction(k);
    if (dir) { await this.move(dir); return; }
    const ctx = this.context;
    const c = this.commands.get(k.key, ctx);
    if (c) await c.run({ g: this, ctx });
    else { this.con.print(MSG_CORE.badCommand); await playEffect(SFX.BAD_COMMAND); } // 1000:1A1E
  }

  // ---------------------------------------------------------------- prompts

  async askDir(prompt = MSG_CORE.dir): Promise<Dir | null> {
    this.con.print(prompt);
    for (;;) {
      const k = await this.input.next();
      if (!k) continue;
      const d = Input.direction(k);
      if (d) { this.con.println(DIR_NAMES[d]); return d; }
      if (k.key === "Escape" || k.key === "Enter" || k.key === " ") { this.con.println(""); return null; }
      await playEffect(SFX.ERROR); // 1000:12D6: any other key
    }
  }

  async getLine(maxLen = 15): Promise<string> {
    let s = "";
    for (;;) {
      const k = await this.input.next();
      if (!k) continue;
      if (k.key === "Enter") { this.con.newline(); return s; }
      if (k.key === "Backspace") { if (s) { s = s.slice(0, -1); this.con.backspace(); } continue; }
      if (k.key === "Escape") { this.con.newline(); return ""; }
      if (k.key.length === 1 && s.length < maxLen && k.key >= " " && k.key.charCodeAt(0) !== 0x7f) { s += k.key; this.con.print(k.key); }
    }
  }

  async getKey(): Promise<string> {
    for (;;) { const k = await this.input.next(); if (k) return k.key; }
  }

  async waitKey() { await this.getKey(); }

  /** 1000:1287 (prompts.ts); -1 when cancelled or "0". */
  async askMember(prompt: string): Promise<number> {
    const i = await askMember(this, prompt);
    return i < 0 ? -1 : i;
  }

  // ---------------------------------------------------------------- turn

  /** End of an overworld/town turn (1000:1C53). */
  endTurn() {
    const s = this.save;
    s.moves++;
    // Food: party size hundredths per turn (1000:138B).
    if (s.food >= s.members) s.food -= s.members;
    else {
      s.food = 0;
      this.con.print(MSG_CORE.starving);
      for (const p of this.members) if (p.status !== "D") this.damagePlayer(p, 2);
      void inverted(this, partyRowsRects(s.members), () => playEffect(SFX.HIT)); // the whole party's lines invert (1000:1C53, 1000:224B)
    }
    for (const [i, p] of this.members.entries()) {
      if (p.status === "P") { this.damagePlayer(p, 2); void inverted(this, [statusRowRect(i)], () => playEffect(SFX.HIT)); } // the member's line inverts
      else if (p.status === "S" && rand(8) === 0) p.status = "G";
      // MP regen +1 up to the class maximum (1000:13B6)
      if (p.status !== "D") p.mp = Math.min(maxMp(p), p.mp + 1);
    }
    if (this.onShip && s.shipHull < 50 && rand(4) === 0) s.shipHull++;
    this.tickEffects();
    if (this.map.kind === "town") moveNpcs(this, this.map);
    // monsters, shots, whirlpools: run by the main loop once the command is over (they take time)
    if (this.map.kind === "world" && !(this.save.location >= 17 && this.save.location <= 24)) this.worldTurnPending = true;
    closeDoors(this);
  }

  // ---------------------------------------------------------------- party helpers

  /** 1000:1135 */
  damagePlayer(p: PlayerRecord, n: number) {
    if (p.status === "D" || config().debug.godMode) return; // debug panel: god mode
    p.hp = Math.max(0, p.hp - n);
    if (p.hp === 0) p.status = "D";
  }

  damage(p: PlayerRecord, n: number) { this.damagePlayer(p, n); }

  /** Karma (karma.ts): 1000:09F8 / 1000:0A17. */
  karmaInc(v: number, n: number) { karmaInc(this, v, n); }
  karmaDec(v: number, n: number) { karmaDec(this, v, n); }
  adjustKarma(virtue: number, delta: number) { adjustKarma(this, virtue, delta); }

  setSpellEffect(e: string, turns: number) { this.spellEffect = e; this.spellTurns = turns; }
  tickEffects() { if (this.spellEffect && --this.spellTurns <= 0) this.spellEffect = null; }

  npcAt(x: number, y: number): Npc | undefined {
    return this.map.kind === "town" ? this.map.npcs.find((n) => n.x === x && n.y === y) : undefined;
  }

  // ---------------------------------------------------------------- entry points used by other modules

  /** Meditation at a shrine (shrine.ts), from E)nter or a moongate. */
  async enterShrine(virtue: number) { await meditateAt(this, virtue); }
  /** Overworld or town fight against one creature (world/monsters.ts). */
  worldFight(m: WorldObject, context: CombatRequest["context"] = "world") { return worldFight(this, m, context); }
  /** Runs a tactical combat; see combat.ts. */
  fight(req: CombatRequest): Promise<CombatResult> { return runCombat(this, req); }
  readyWeapon(member?: number) { return readyWeapon(this, member); }
  ztatsFor(i: number) { return ztatsFor(this, i); }
  openChest(who: number) { return openChest(this, who); }

  // ---------------------------------------------------------------- movement

  async move(dir: Dir) {
    const [dx, dy] = DIRS[dir];
    if (this.onShip) { await sail(this, dir); return; }
    if (this.inBalloon) { this.con.print(MSG_CORE.driftOnly); return; }
    if (this.onHorse) this.save.transport = dx < 0 ? T.HORSE_W : dx > 0 ? T.HORSE_E : this.save.transport;
    // on foot or horseback: a click for the command, another for the step taken (1000:2B8C, 2B19)
    await playEffect(SFX.STEP);
    this.con.println(DIR_NAMES[dir]);
    const nx = this.px + dx, ny = this.py + dy;
    if (this.map.kind === "town" && (nx < 0 || ny < 0 || nx >= 32 || ny >= 32)) {
      await playEffect(SFX.STEP);
      await leaveTown(this);
      this.endTurn();
      return;
    }
    const t = tileAt(this.map, nx, ny);
    const need = this.onHorse ? Walk.Horse : Walk.Foot;
    const blocked = !(tileFlags(t) & need) || !!this.npcAt(nx, ny) ||
      (this.map.kind === "world" && this.onFoot && this.objects.some((o) => o.x === (nx & 255) && o.y === (ny & 255) && o.tile >= 0x80));
    if (blocked) { await this.blocked(); this.endTurn(); return; }
    if (rand(1000) < slowChance(t) * 1000) { this.con.print(MSG_CORE.slowProgress); this.endTurn(); return; }
    await playEffect(SFX.STEP);
    this.setPos(nx, ny);
    this.endTurn();
    await checkMoongate(this);
    // 1000:27D9: walking south into the approach of the Shrine of Humility summons daemons, unless the horn was blown
    if (this.map.kind === "world" && dir === "S" && this.px >= 229 && this.px <= 233 && this.py >= 212 && this.py <= 216 &&
        this.spellEffect !== HORN_EFFECT && !this.pendingAttack) {
      this.pendingAttack = { tile: 0xf0, x: this.px, y: this.py + 1 };
    }
  }

  /** 1000:29C3: the blocked message (DS:0929) and the error buzz (the original also flushes the keyboard there). */
  async blocked() {
    this.con.print(MSG_CORE.blocked);
    await playEffect(SFX.ERROR);
  }

  setPos(x: number, y: number) {
    if (this.map.kind === "world") { x &= 255; y &= 255; this.save.x = x; this.save.y = y; }
    this.px = x; this.py = y;
    for (const l of this.moveListeners) l(this);
  }

  private moveListeners = new Set<(g: Game) => void>();
  /** Called after every position change (journal of discovered places, interface). Returns the unsubscribe. */
  onMove(fn: (g: Game) => void): () => void { this.moveListeners.add(fn); return () => this.moveListeners.delete(fn); }

  // ---------------------------------------------------------------- drawing

  tick() { this.animTick++; this.r.animateTiles(); this.sky.tick(this.save); }

  draw() {
    const r = this.r;
    const { base, layers } = this.layers.visible();
    const drawLayers = () => { for (const l of layers) l.draw?.(r); };
    r.setInverts(this.layers.inverts()); // src/ui/invert.ts
    if (!base || !this.save || !this.map) {
      r.setView(null);
      r.view3d = null;
      if (base) r.ui.drawImage(this.frameCanvas, 0, 0);
      drawLayers();
      return;
    }
    r.ui.drawImage(this.frameCanvas, 0, 0);
    r.clearRect(VIEW_X, VIEW_Y, VIEW_TILES * TILE, VIEW_TILES * TILE);
    // viewport: the topmost layer providing tiles or a 3D scene, else the map
    let viewLayer = null;
    for (let i = layers.length - 1; i >= 0 && !viewLayer; i--) if (layers[i].view || layers[i].scene3d) viewLayer = layers[i];
    r.view3d = viewLayer?.scene3d?.() ?? null;
    r.setView(viewLayer ? viewLayer.view?.() ?? null : viewTiles(this));
    drawStatus(this, r);
    drawLayers();
  }
}
