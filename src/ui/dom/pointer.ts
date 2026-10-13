// Mouse and touch on the game screen. Every action ends as the original keys pushed to Input, so the
// game logic cannot tell them from the keyboard:
// - overworld / towns: tap a square to walk there (one arrow key per turn, along an A* path), tap a
//   neighbour (townsfolk, monster, door) or the party for a small menu of commands;
// - dungeons: swipe up/down to advance/retreat, left/right to turn, tap for a menu of commands;
// - combat: tap a foe next to the active member to attack it, elsewhere to step towards it.
// A walk stops on a prompt, a fight, a change of map, a key from the player or at the end of the path.
import type { Game } from "../../game/game";
import { config } from "../../config/config";
import { t } from "../../i18n/i18n";
import { creatureInfo } from "../../game/combat";
import { DIRS, tileAt, type Dir } from "../../game/maps";
import { findPath, findPathNextTo, gridFor, type PathGrid } from "../../game/pathfinding";
import { CLASS_TILES, isTalkOver, T } from "../../game/tiles";
import { WALKABLE_TILES } from "../../data/tables";
import { TILE, VIEW_TILES, VIEW_X, VIEW_Y } from "../../render/renderer";
import { h } from "./dom";
import type { Shell } from "./shell";
import "./pointer.css";

const ARROW: Record<Dir, string> = { N: "ArrowUp", S: "ArrowDown", E: "ArrowRight", W: "ArrowLeft" };
const HALF = VIEW_TILES >> 1;
/** Pointer travel (CSS px) under which a gesture is a tap. */
const TAP_SLOP = 12;
/** Shortest time between two walking steps (ms), so the walk can be followed. */
const STEP_MS = 140;
/** Refused steps (slow progress, wind, a ship turning) retried before searching again. */
const RETRIES = 6;

/** Menu entry: original keys to push, or a local action that takes no turn. */
interface MenuItem { label: string; keys: string[]; run?: () => void }

/** Direction of a neighbouring offset, or null. */
function dirOf(dx: number, dy: number): Dir | null {
  for (const [d, [x, y]] of Object.entries(DIRS) as [Dir, [number, number]][]) if (x === dx && y === dy) return d;
  return null;
}

export function installPointer(shell: Shell, g: Game): void {
  const canvas = shell.stage.querySelector("canvas") as HTMLCanvasElement;
  const overlay = shell.overlay;
  canvas.classList.add("pointer-target");

  // ------------------------------------------------------------ keys

  /** Keys pushed by this module (the others stop a walk). */
  let pushing = false;
  const push = (...keys: string[]) => {
    pushing = true;
    try { for (const key of keys) g.input.push({ key, code: key.startsWith("Arrow") ? key : "", source: "pointer" }); } finally { pushing = false; }
  };
  g.input.onKey(() => { if (!pushing) stopWalk(); });

  /**
   * The game waits for a command, not inside a prompt, and no panel is open. On the overworld and in
   * towns the main loop says so (g.atPrompt); dungeon and combat loops print an empty line then.
   */
  const idle = () => !!g.save && !!g.map && g.input.waiting && !shell.panels.openId &&
    (g.mode === "world" || g.mode === "town" ? g.atPrompt : g.con.lines[g.con.lines.length - 1] === "");

  // ------------------------------------------------------------ geometry

  /** Viewport square under a client point, as an offset from the centre (the party), or null. */
  function cellAt(cx: number, cy: number): { dx: number; dy: number } | null {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    // the canvas shows g.r.crop of the 320x200 screen (the map alone in the compact layout)
    const c = g.r.crop;
    const lx = c.x + ((cx - r.left) / r.width) * c.w, ly = c.y + ((cy - r.top) / r.height) * c.h;
    const vx = Math.floor((lx - VIEW_X) / TILE), vy = Math.floor((ly - VIEW_Y) / TILE);
    if (lx < VIEW_X || ly < VIEW_Y || vx >= VIEW_TILES || vy >= VIEW_TILES) return null;
    return { dx: vx - HALF, dy: vy - HALF };
  }

  /** Client rectangle of a viewport square, relative to the overlay. */
  function cellRect(dx: number, dy: number) {
    const r = canvas.getBoundingClientRect(), o = overlay.getBoundingClientRect();
    const c = g.r.crop, sx = r.width / c.w, sy = r.height / c.h;
    return {
      left: r.left - o.left + (VIEW_X + (dx + HALF) * TILE - c.x) * sx, top: r.top - o.top + (VIEW_Y + (dy + HALF) * TILE - c.y) * sy,
      width: TILE * sx, height: TILE * sy,
    };
  }

  /** Brief square marking where a tap landed (red: no way there). */
  function mark(dx: number, dy: number, ok: boolean) {
    const c = cellRect(dx, dy);
    const el = h("div", { class: `pointer-mark${ok ? "" : " pointer-mark-bad"}` });
    Object.assign(el.style, { left: `${c.left}px`, top: `${c.top}px`, width: `${c.width}px`, height: `${c.height}px` });
    overlay.append(el);
    setTimeout(() => el.remove(), 450);
  }

  // ------------------------------------------------------------ context menu

  let menu: { el: HTMLElement; release: () => void; keys: (e: KeyboardEvent) => void } | null = null;

  function closeMenu() {
    if (!menu) return;
    const m = menu;
    menu = null;
    window.removeEventListener("keydown", m.keys, true);
    m.release();
    m.el.remove();
  }

  function openMenu(items: MenuItem[], x: number, y: number, title?: string) {
    closeMenu();
    if (!items.length) return;
    const el = h("div", { class: "pointer-menu", role: "menu", "aria-label": title ?? t("pointer.menu") });
    if (title) el.append(h("div", { class: "pointer-menu-title" }, title));
    for (const it of items) {
      el.append(h("button", {
        role: "menuitem",
        onclick: () => {
          closeMenu();
          it.run?.();
          if (it.keys.length && idle()) push(...it.keys);
        },
      }, it.label));
    }
    el.append(h("button", { class: "pointer-menu-cancel", role: "menuitem", onclick: () => closeMenu() }, t("pointer.cancel")));
    overlay.append(el);
    // keep it inside the overlay
    const o = overlay.getBoundingClientRect(), b = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(x - o.left + 8, o.width - b.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(y - o.top + 8, o.height - b.height - 4))}px`;
    // the keyboard closes the menu (and does not reach the game meanwhile)
    const release = g.input.block();
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Tab" || e.key === "Enter" || e.key === " ") return; // menu navigation
      if (e.key === "Escape") e.preventDefault();
      closeMenu();
    };
    window.addEventListener("keydown", keys, true);
    menu = { el, release, keys };
    (el.querySelector("button") as HTMLElement | null)?.focus({ preventScroll: true });
  }

  /** Look: the name of a creature, shown in a short bubble. */
  function look(name: string, x: number, y: number) {
    const o = overlay.getBoundingClientRect();
    const el = h("div", { class: "pointer-look" }, t("pointer.see", { name }));
    Object.assign(el.style, { left: `${x - o.left}px`, top: `${y - o.top}px` });
    overlay.append(el);
    setTimeout(() => el.remove(), 1800);
  }

  // ------------------------------------------------------------ walking

  let walk: { path: Dir[]; tx: number; ty: number; next: boolean; map: unknown; mode: string; from: [number, number] | null;
    retries: number; researched: boolean; last: number; timer: ReturnType<typeof setInterval> } | null = null;

  function stopWalk() {
    if (!walk) return;
    clearInterval(walk.timer);
    walk = null;
  }

  const wrapX = (x: number) => (g.map.kind === "world" ? x & 255 : x);
  const wrapY = (y: number) => (g.map.kind === "world" ? y & 255 : y);

  /** Path from the party to (tx,ty) on the current map (next to it when `next`). */
  function pathTo(grid: PathGrid, tx: number, ty: number, next: boolean): Dir[] | null {
    return next ? findPathNextTo(grid, g.px, g.py, tx, ty) : findPath(grid, g.px, g.py, tx, ty);
  }

  function startWalk(path: Dir[], tx: number, ty: number, next: boolean) {
    stopWalk();
    if (!path.length) return;
    walk = { path, tx, ty, next, map: g.map, mode: g.mode, from: null, retries: 0, researched: false, last: 0, timer: setInterval(stepWalk, 30) };
    stepWalk();
  }

  function stepWalk() {
    const w = walk;
    if (!w || !g.input.waiting) return;
    if (g.map !== w.map || g.mode !== w.mode || !idle()) { stopWalk(); return; }
    if (performance.now() - w.last < STEP_MS) return;
    if (w.from) {
      // result of the previous step
      const [fx, fy] = w.from;
      const [ex, ey] = [wrapX(fx + DIRS[w.path[0]][0]), wrapY(fy + DIRS[w.path[0]][1])];
      if (g.px === ex && g.py === ey) { w.path.shift(); w.retries = 0; }
      else if (g.px === fx && g.py === fy) {
        if (++w.retries > RETRIES) { if (!research(w)) return; }
      } else { stopWalk(); return; } // moved elsewhere (moongate...)
      w.from = null;
    }
    if (!w.path.length) { stopWalk(); return; }
    // someone stepped into the way: search again (once per walk)
    const grid = gridFor(g);
    if (!grid) { stopWalk(); return; }
    const [dx, dy] = DIRS[w.path[0]];
    const nx = g.px + dx, ny = g.py + dy;
    const outside = g.map.kind === "town" && (nx < 0 || ny < 0 || nx >= 32 || ny >= 32);
    if (!outside && !grid.passable(wrapX(nx), wrapY(ny)) && !research(w)) return;
    w.from = [g.px, g.py];
    w.last = performance.now();
    push(ARROW[w.path[0]]);
  }

  /** New path to the walk's target; stops the walk when there is none. */
  function research(w: NonNullable<typeof walk>): boolean {
    const grid = gridFor(g);
    const p = !w.researched && grid ? pathTo(grid, w.tx, w.ty, w.next) : null;
    w.researched = true;
    if (!p || !p.length) { stopWalk(); return false; }
    w.path = p; w.retries = 0;
    return true;
  }

  // ------------------------------------------------------------ overworld and towns

  /** Commands for what is under the party. */
  function hereItems(): MenuItem[] {
    const items: MenuItem[] = [];
    const tile = tileAt(g.map, g.px, g.py);
    const world = g.map.kind === "world";
    const obj = world ? g.objects.find((o) => o.x === g.px && o.y === g.py) : undefined;
    if (tile === T.CHEST || obj?.tile === T.CHEST) items.push({ label: t("pointer.get"), keys: ["g"] });
    if ((!world && tile === T.LADDER_UP) || g.inBalloon) items.push({ label: t("pointer.klimb"), keys: ["k"] });
    if ((!world && tile === T.LADDER_DOWN) || g.inBalloon) items.push({ label: t("pointer.descend"), keys: ["d"] });
    const entrances: number[] = [T.DUNGEON, T.TOWN, T.CASTLE, T.VILLAGE, T.LCB_WEST, T.LCB_ENTRANCE, T.LCB_EAST, T.RUINS, T.SHRINE];
    if (world && (g.onFoot || g.onHorse) && entrances.includes(tile)) items.push({ label: t("pointer.enter"), keys: ["e"] });
    const boardable = obj && ((obj.tile >= T.SHIP_W && obj.tile <= T.HORSE_E) || obj.tile === T.BALLOON);
    if (world && g.onFoot && boardable) items.push({ label: t("pointer.board"), keys: ["b"] });
    if (!g.onFoot) items.push({ label: t("pointer.exit"), keys: ["x"] });
    return items;
  }

  /** Townsperson or monster on a square of the map. */
  function creatureAt(x: number, y: number): number | null {
    const npc = g.npcAt(x, y);
    if (npc) return npc.tile;
    if (g.map.kind === "world") {
      const m = g.objects.find((o) => o.x === (x & 255) && o.y === (y & 255) && o.tile >= 0x80);
      if (m) return m.tile;
    }
    return null;
  }

  function tapMap(dx: number, dy: number, cx: number, cy: number) {
    if (dx === 0 && dy === 0) { stopWalk(); openMenu(hereItems(), cx, cy); return; }
    const tx = wrapX(g.px + dx), ty = wrapY(g.py + dy);
    const who = creatureAt(tx, ty);
    const d = dirOf(dx, dy);
    if (who !== null) {
      // talking over a shop counter reaches two squares away
      const across = !d && (dx === 0 || dy === 0) && Math.abs(dx + dy) === 2 && isTalkOver(tileAt(g.map, g.px + dx / 2, g.py + dy / 2));
      if (d || across) {
        stopWalk();
        const dir = d ?? dirOf(Math.sign(dx), Math.sign(dy))!;
        const name = creatureInfo(who).name;
        const items: MenuItem[] = [{ label: t("pointer.talk"), keys: ["t", ARROW[dir]] }];
        if (d) items.push({ label: t("pointer.attack"), keys: ["a", ARROW[dir]] });
        // Look does not take a turn: it only names the creature
        items.push({ label: t("pointer.look"), keys: [], run: () => look(name, cx, cy) });
        openMenu(items, cx, cy, name);
        return;
      }
      if (!config().controls.tapToMove) return;
      const grid = gridFor(g);
      const p = grid && pathTo(grid, tx, ty, true);
      mark(dx, dy, !!p);
      if (p) startWalk(p, tx, ty, true);
      return;
    }
    const tile = tileAt(g.map, g.px + dx, g.py + dy);
    if (d && (tile === T.DOOR || tile === T.LOCKED_DOOR) && g.map.kind === "town") {
      stopWalk();
      openMenu([
        { label: t("pointer.open"), keys: ["o", ARROW[d]] },
        { label: t("pointer.jimmy"), keys: ["j", ARROW[d]] },
      ], cx, cy);
      return;
    }
    if (!config().controls.tapToMove) return;
    const grid = gridFor(g);
    const p = grid && pathTo(grid, tx, ty, false);
    mark(dx, dy, !!p);
    if (p) startWalk(p, tx, ty, false);
  }

  // ------------------------------------------------------------ dungeon

  function dungeonMenu(cx: number, cy: number) {
    openMenu([
      { label: t("pointer.advance"), keys: ["ArrowUp"] },
      { label: t("pointer.retreat"), keys: ["ArrowDown"] },
      { label: t("pointer.turnLeft"), keys: ["ArrowLeft"] },
      { label: t("pointer.turnRight"), keys: ["ArrowRight"] },
      { label: t("pointer.klimb"), keys: ["k"] },
      { label: t("pointer.descend"), keys: ["d"] },
      { label: t("pointer.get"), keys: ["g"] },
      { label: t("pointer.search"), keys: ["s"] },
      { label: t("pointer.ignite"), keys: ["i"] },
      { label: t("pointer.peer"), keys: ["p"] },
      { label: t("pointer.pass"), keys: [" "] },
    ], cx, cy);
  }

  // ------------------------------------------------------------ combat

  /** Last known square of each member (several members of one class look the same). */
  const memberPos = new Map<number, { x: number; y: number }>();

  function combatTap(dx: number, dy: number) {
    const view = g.layers.top("view")?.();
    const who = g.activeMember;
    if (!view || who < 0) return;
    const at = (x: number, y: number) => (x < 0 || y < 0 || x >= VIEW_TILES || y >= VIEW_TILES ? -1 : view[y * VIEW_TILES + x]);
    const tx = dx + HALF, ty = dy + HALF;
    // the active member: the figure of its class (the one seen last there when several)
    const figure = CLASS_TILES[g.save.players[who].klass];
    const cands: { x: number; y: number }[] = [];
    for (let i = 0; i < view.length; i++) if ((view[i] & ~1) === figure) cands.push({ x: i % VIEW_TILES, y: Math.floor(i / VIEW_TILES) });
    if (!cands.length) return;
    const known = memberPos.get(who);
    const me = cands.find((c) => known && c.x === known.x && c.y === known.y)
      ?? cands.reduce((a, b) => (Math.abs(a.x - tx) + Math.abs(a.y - ty) <= Math.abs(b.x - tx) + Math.abs(b.y - ty) ? a : b));
    const ox = tx - me.x, oy = ty - me.y;
    if (ox === 0 && oy === 0) return;
    const isCreature = (tile: number) => tile >= 0x80 || (tile >= T.GUARD && tile <= 0x5f) || tile === T.CHEST;
    const isMember = (tile: number) => tile >= 0x20 && tile <= 0x2f;
    const d = dirOf(ox, oy);
    if (d && isCreature(at(tx, ty))) { push("a", ARROW[d]); return; }
    if (!config().controls.tapToMove) return;
    // one step towards the square, around obstacles when possible
    const walkable = new Set<number>(WALKABLE_TILES);
    const grid: PathGrid = {
      width: VIEW_TILES, height: VIEW_TILES, exits: true,
      passable: (x, y) => { const tile = at(x, y); return walkable.has(tile) && !isCreature(tile) && !isMember(tile); },
    };
    const inside = tx >= 0 && ty >= 0 && tx < VIEW_TILES && ty < VIEW_TILES;
    const p = (inside && grid.passable(tx, ty) ? findPath(grid, me.x, me.y, tx, ty, { maxSteps: 30 }) : null)
      ?? findPathNextTo(grid, me.x, me.y, tx, ty, { maxSteps: 30 });
    const step = p?.[0] ?? (Math.abs(ox) >= Math.abs(oy) ? (ox > 0 ? "E" : "W") : (oy > 0 ? "S" : "N"));
    mark(dx, dy, !!p);
    const [sx, sy] = DIRS[step];
    memberPos.set(who, { x: me.x + sx, y: me.y + sy });
    push(ARROW[step]);
  }

  // ------------------------------------------------------------ gestures

  let down: { x: number; y: number; id: number; time: number } | null = null;

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    down = { x: e.clientX, y: e.clientY, id: e.pointerId, time: performance.now() };
  });
  canvas.addEventListener("pointercancel", () => { down = null; });
  canvas.addEventListener("pointerup", (e) => {
    const start = down;
    down = null;
    if (!start || start.id !== e.pointerId) return;
    if (menu) { closeMenu(); return; } // a tap outside the menu only closes it
    if (!g.save || !g.map || shell.panels.openId) return;
    const mx = e.clientX - start.x, my = e.clientY - start.y;
    const swipe = Math.hypot(mx, my) > TAP_SLOP;
    const mode = g.mode;
    if (mode === "dungeon") {
      if (!idle()) return;
      if (swipe) {
        if (!config().controls.tapToMove) return;
        push(Math.abs(mx) > Math.abs(my) ? (mx > 0 ? "ArrowRight" : "ArrowLeft") : (my > 0 ? "ArrowDown" : "ArrowUp"));
      } else dungeonMenu(e.clientX, e.clientY);
      return;
    }
    if (swipe) return;
    const cell = cellAt(e.clientX, e.clientY);
    if (!cell) return;
    if (mode === "combat") { if (idle()) combatTap(cell.dx, cell.dy); return; }
    // a tap while walking changes the destination; the game must be waiting for a command
    stopWalk();
    if (!idle()) return;
    tapMap(cell.dx, cell.dy, e.clientX, e.clientY);
  });
  // forget the combat positions after each fight
  setInterval(() => {
    if (memberPos.size && !g.layers.visible().layers.some((l) => l.name === "combat")) memberPos.clear();
  }, 1000);
}
