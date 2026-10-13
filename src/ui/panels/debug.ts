// Debug panel (config.debug.enabled): edit the party, the inventory and the world, start fights,
// toggle god mode and set up the state needed to try the less tested features.
//
// Changes are only applied while the game waits for a key (g.input.waiting). Actions that run game
// code (fights, entering places, the Codex) must run inside the main loop, not next to it: they are
// queued as a private key that the main loop hands to Game.command, wrapped here for that one key.
import { ABYSS_ENTRANCE, ARMOURS, CLASSES, ITEM_FLAGS, MONSTERS, MOONGATES, REAGENTS, SPELLS, STONE_COLORS, WEAPONS } from "../../data/tables";
import { config, updateConfig } from "../../config/config";
import type { PlayerRecord } from "../../formats/save";
import { runCodex } from "../../game/endgame/codex";
import { maxMp, type Game } from "../../game/game";
import type { Key } from "../../game/input";
import { LOCATIONS, SHRINES, VIRTUES, type LocationDef } from "../../game/locations";
import { setTile, tileAt } from "../../game/maps";
import { enter, enterTown } from "../../game/places";
import { T, tileFlags, Walk } from "../../game/tiles";
import { t } from "../../i18n/i18n";
import { h } from "../dom/dom";
import type { Panel } from "../dom/panels";
import "./debug.css";

type Tab = "party" | "items" | "world" | "combat" | "spells" | "tests";
const TABS: Tab[] = ["party", "items", "world", "combat", "spells", "tests"];

// ------------------------------------------------------------------ game state helpers

/** The game waits for a key: edits are safe. */
const idle = (g: Game) => !!g.save && g.input.waiting;
/** The game waits for a command on the overworld or in a town (not in a prompt, a fight or a dungeon). */
const atPrompt = (g: Game) => !!g.save && g.atPrompt && (g.mode === "world" || g.mode === "town");

/** Runs `fn` from the main loop at its command prompt (as if it were a command). */
function runInLoop(g: Game, fn: () => Promise<unknown> | unknown) {
  g.runAtPrompt(async () => { try { await fn(); } catch (e) { console.error("debug action failed", e); } });
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? Math.round(v) : lo));
const foot = (x: number, y: number, g: Game) => (tileFlags(tileAt(g.world, x, y)) & Walk.Foot) !== 0;
const sea = (x: number, y: number, g: Game) => (tileFlags(tileAt(g.world, x, y)) & Walk.Ship) !== 0;

/** Back on the overworld (out of a town), on foot. */
function toWorld(g: Game) {
  if (g.map.kind !== "world") {
    g.map = g.world;
    g.save.location = 0;
    g.openedDoors = [];
  }
  if (!g.onFoot && !g.onHorse) g.save.transport = T.AVATAR;
}

function teleport(g: Game, x: number, y: number) {
  toWorld(g);
  g.pendingAttack = null;
  g.setPos(x, y);
}

/** A walkable square next to (x, y) on the overworld (south first, like the castle exits). */
function besides(g: Game, x: number, y: number): [number, number] {
  for (const [dx, dy] of [[0, 1], [-1, 0], [1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const nx = (x + dx) & 255, ny = (y + dy) & 255;
    if (foot(nx, ny, g) && !LOCATIONS.some((l) => l.id > 0 && l.x === nx && l.y === ny)) return [nx, ny];
  }
  return [x, y];
}

/** Nearest overworld square around (x, y) matching `ok` (square spiral). */
function nearest(x: number, y: number, ok: (x: number, y: number) => boolean): [number, number] | null {
  for (let r = 0; r < 64; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = (x + dx) & 255, ny = (y + dy) & 255;
        if (ok(nx, ny)) return [nx, ny];
      }
  return null;
}

function heal(p: PlayerRecord) { p.status = "G"; p.hp = p.hpMax; p.mp = maxMp(p); }

/** At least `n` members; empty slots get a companion of a class not in the party yet. */
function fillParty(g: Game, n: number) {
  const s = g.save;
  for (let i = s.members; i < n; i++) {
    const p = s.players[i];
    if (!p.name) {
      const used = new Set(s.players.slice(0, i).map((m) => m.klass));
      const k = [0, 1, 2, 3, 4, 5, 6, 7].find((c) => !used.has(c)) ?? i % 8;
      Object.assign(p, { name: CLASSES[k], klass: k, sex: 0x0b, hp: 300, hpMax: 300, xp: 500, str: 25, dex: 25, int: 25, weapon: 0, armour: 0, status: "G" });
      p.mp = maxMp(p);
    }
  }
  s.members = Math.max(s.members, n);
}

/** Moon phases 0 (new) .. 4 (full) .. 7, as in the status line. */
const MOON_GLYPHS = ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"];

const ABYSS_ITEMS = ITEM_FLAGS.bell | ITEM_FLAGS.book | ITEM_FLAGS.candle | ITEM_FLAGS.bellRung | ITEM_FLAGS.bookRead | ITEM_FLAGS.candleLit;
const KEY_PARTS = ITEM_FLAGS.keyTruth | ITEM_FLAGS.keyLove | ITEM_FLAGS.keyCourage;

/** Everything the end of the game needs: items, stones, runes, elevation, 8 members. */
function endgameState(g: Game) {
  const s = g.save;
  s.items |= ABYSS_ITEMS | KEY_PARTS;
  s.stones = 0xff; s.runes = 0xff;
  s.karma.fill(0);
  fillParty(g, 8);
  s.torches = Math.max(s.torches, 99); s.gems = Math.max(s.gems, 99);
  for (const p of g.members) heal(p);
}

const mix = (g: Game, letters: string, n = 99) => { for (const l of letters) g.save.mixtures[l.charCodeAt(0) - 65] = n; };
const fullMp = (g: Game) => { for (const p of g.members) if (p.status !== "D") p.mp = maxMp(p); };

const LCB = () => LOCATIONS[1];
/** On foot next to Lord British's castle. */
const nearCastle = (g: Game) => { const [x, y] = besides(g, LCB().x, LCB().y); teleport(g, x, y); };
/** On a ship (facing West) at the nearest water with `rows` navigable squares to the north. */
function onShip(g: Game, rows = 1): boolean {
  const spot = nearest(LCB().x, LCB().y, (x, y) => { for (let k = 0; k < rows; k++) if (!sea(x, (y - k) & 255, g)) return false; return true; });
  if (!spot) return false;
  teleport(g, spot[0], spot[1]);
  g.save.transport = T.SHIP_W;
  g.objects = g.objects.filter((o) => !(o.x === spot[0] && o.y === spot[1]));
  return true;
}

const fight = (g: Game, tile: number) => {
  const town = g.map.kind === "town";
  // In a town the creature stands on the party square (no townsperson removed when it is won).
  return g.worldFight({ tile, x: g.px, y: town ? g.py : (g.py - 1) & 255 }, town ? "town" : "world");
};

/** Test set-ups: state for a feature, then an optional action run from the main loop. */
interface TestCase { id: string; setup(g: Game): void; loop?: (g: Game) => Promise<unknown> | void }
const TESTS: TestCase[] = [
  { id: "blink", setup: (g) => { nearCastle(g); mix(g, "B"); fullMp(g); } },
  { id: "gate", setup: (g) => { nearCastle(g); mix(g, "G"); fullMp(g); } },
  { id: "winds", setup: (g) => { onShip(g); mix(g, "W"); fullMp(g); } },
  { id: "dispell", setup: (g) => { nearCastle(g); mix(g, "D"); fullMp(g); setTile(g.world, (g.px + 1) & 255, g.py, T.ENERGY_FIELD); } },
  { id: "energy", setup: (g) => { mix(g, "E"); fullMp(g); }, loop: (g) => fight(g, 0xc0) },
  {
    id: "open", setup: (g) => {
      nearCastle(g); mix(g, "O"); fullMp(g);
      if (!g.objects.some((o) => o.tile === T.CHEST && o.x === g.px && o.y === g.py)) g.objects.push({ tile: T.CHEST, x: g.px, y: g.py });
    },
  },
  {
    id: "cannons", setup: (g) => {
      if (!onShip(g, 3)) return;
      const y = (g.py - 2) & 255;
      g.objects = g.objects.filter((o) => o.tile < 0x80);
      g.objects.push({ tile: T.PIRATE_SHIP, x: g.px, y });
    },
  },
  { id: "newOrder", setup: (g) => fillParty(g, 8) },
  { id: "telescope", setup: (g) => toWorld(g), loop: (g) => enterTown(g, LOCATIONS[2], 0, [22, 3]) },
  {
    id: "altars", setup: (g) => {
      g.save.stones = 0xff; mix(g, "XYZ"); fullMp(g); g.save.torches = Math.max(g.save.torches, 99);
      teleport(g, LOCATIONS[17].x, LOCATIONS[17].y);
    }, loop: (g) => enter(g),
  },
  { id: "abyss", setup: (g) => { endgameState(g); teleport(g, ABYSS_ENTRANCE.x, ABYSS_ENTRANCE.y); }, loop: (g) => enter(g) },
  { id: "codex", setup: (g) => { endgameState(g); teleport(g, ABYSS_ENTRANCE.x, ABYSS_ENTRANCE.y); }, loop: (g) => runCodex(g) },
];

/** Locations for teleport / enter: towns, castles, dungeons, then the shrines. */
const PLACES = () => [
  ...LOCATIONS.filter((l) => l.id > 0).map((l) => ({ value: `loc:${l.id}`, label: `${l.id}. ${l.name}` })),
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((v) => ({ value: `shrine:${v}`, label: t("debug.shrine", { virtue: VIRTUES[v] }) })),
];

// ------------------------------------------------------------------ panel

export function createDebugPanel(g: Game): Panel {
  let tab: Tab = "party";
  let place = "loc:1";
  let monster = 20;
  let timer: ReturnType<typeof setInterval> | undefined;

  return {
    id: "debug",
    size: "wide",
    title: () => t("menu.debug"),
    dispose() { clearInterval(timer); },
    render(body, ctx) {
      clearInterval(timer);
      const s = g.save;
      if (!s) { body.append(h("p", {}, t("debug.noGame"))); return; }

      /** Applies a change if the game is idle, then redraws the panel. */
      const apply = (fn: () => void) => () => {
        if (!idle(g)) return;
        fn();
        ctx.refresh();
      };
      /** Closes the panel and runs `fn` from the main loop. */
      const inLoop = (fn: () => Promise<unknown> | unknown, before?: () => void) => () => {
        if (!atPrompt(g)) return;
        before?.();
        ctx.close();
        runInLoop(g, fn);
      };
      const btn = (label: string, onclick: () => void, need: "idle" | "prompt" = "idle", attrs: Record<string, string> = {}) =>
        h("button", { class: "dbg-btn", "data-need": need, onclick, ...attrs }, label);
      /** Number field; `free` ones only keep a value for a button (no game change, always enabled). */
      const num = (label: string, value: number, max: number, set: (v: number) => void, free = false) =>
        h("label", { class: "dbg-field" },
          h("span", {}, label),
          h("input", {
            type: "number", min: 0, max, value, inputmode: "numeric", "data-need": free ? undefined : "idle",
            onchange: (e) => {
              const el = e.target as HTMLInputElement;
              if (free) { set(clamp(+el.value, 0, max)); return; }
              if (!idle(g)) { el.value = String(value); return; }
              set(clamp(+el.value, 0, max));
              ctx.refresh();
            },
          }));
      /** Select; "none" ones only keep a value for a button (always enabled). */
      const choose = (label: string, value: string | number, opts: { value: string | number; label: string }[], set: (v: string) => void, need: "idle" | "prompt" | "none" = "idle") =>
        h("label", { class: "dbg-field" },
          h("span", {}, label),
          h("select", {
            "data-need": need === "none" ? undefined : need,
            onchange: (e) => {
              const el = e.target as HTMLSelectElement;
              if (need !== "none" && !(need === "prompt" ? atPrompt(g) : idle(g))) { el.value = String(value); return; }
              set(el.value);
              if (need !== "none") ctx.refresh();
            },
          }, opts.map((o) => h("option", { value: o.value, selected: String(o.value) === String(value) }, o.label))));
      const flag = (label: string, on: boolean, set: (v: boolean) => void) =>
        h("label", { class: "dbg-flag" },
          h("input", {
            type: "checkbox", checked: on, "data-need": "idle",
            onchange: (e) => {
              const el = e.target as HTMLInputElement;
              if (!idle(g)) { el.checked = on; return; }
              set(el.checked);
              ctx.refresh();
            },
          }), h("span", {}, label));
      const section = (title: string, ...content: (Node | Node[] | null | false)[]) =>
        h("section", { class: "dbg-section" }, h("h3", {}, title), ...content);
      const grid = (...items: Node[]) => h("div", { class: "dbg-grid" }, items);
      const actions = (...items: Node[]) => h("div", { class: "dbg-actions" }, items);

      // ---- header: game state, god mode, tabs
      const state = h("span", { class: "dbg-state", role: "status" });
      const head = h("div", { class: "dbg-head" },
        state,
        h("label", { class: "dbg-flag dbg-god" },
          h("input", { type: "checkbox", checked: config().debug.godMode, onchange: (e) => void updateConfig({ debug: { godMode: (e.target as HTMLInputElement).checked } }) }),
          h("span", {}, t("debug.godMode"))),
        h("button", { class: "dbg-btn", title: t("debug.refresh"), "aria-label": t("debug.refresh"), onclick: () => ctx.refresh() }, "↻"));
      const tabs = h("div", { class: "dbg-tabs", role: "tablist" },
        TABS.map((id) => h("button", {
          class: `dbg-tab${id === tab ? " active" : ""}`, role: "tab", "aria-selected": id === tab ? "true" : "false", "data-tab": id,
          onclick: () => { tab = id; ctx.refresh(); },
        }, t(`debug.tab.${id}`))));
      const content = h("div", { class: "dbg-content", role: "tabpanel" });
      body.append(h("div", { class: "dbg-top" }, head, tabs), content);

      // ---- tabs
      if (tab === "party") renderParty();
      else if (tab === "items") renderItems();
      else if (tab === "world") renderWorld();
      else if (tab === "combat") renderCombat();
      else if (tab === "spells") renderSpells();
      else renderTests();

      function renderParty() {
        const statuses = ["G", "P", "S", "D"].map((v) => ({ value: v, label: t(`debug.status.${v}`) }));
        content.append(
          section(t("debug.party"),
            actions(
              choose(t("debug.members"), s.members, [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: n, label: String(n) })), (v) => {
                const n = +v;
                if (n > s.members) fillParty(g, n); else s.members = n;
              }),
              btn(t("debug.healAll"), apply(() => { for (const p of g.members) heal(p); })),
              btn(t("debug.maxStats"), apply(() => { for (const p of g.members) { p.str = p.dex = p.int = 50; p.hpMax = 800; heal(p); } }))),
            g.members.map((p, i) => h("div", { class: "dbg-member" },
              h("h4", {}, `${i + 1}. ${p.name}`),
              grid(
                choose(t("debug.class"), p.klass, CLASSES.map((c, k) => ({ value: k, label: c })), (v) => { p.klass = +v; }),
                choose(t("debug.status"), p.status, statuses, (v) => { p.status = v; if (v !== "D" && p.hp === 0) p.hp = 1; }),
                num(t("debug.hp"), p.hp, 9999, (v) => { p.hp = v; p.hpMax = Math.max(p.hpMax, v); }),
                num(t("debug.hpMax"), p.hpMax, 9999, (v) => { p.hpMax = v; p.hp = Math.min(p.hp, v); }),
                num(t("debug.mp"), p.mp, 99, (v) => { p.mp = v; }),
                num(t("debug.xp"), p.xp, 9999, (v) => { p.xp = v; }),
                num(t("debug.str"), p.str, 99, (v) => { p.str = v; }),
                num(t("debug.dex"), p.dex, 99, (v) => { p.dex = v; }),
                num(t("debug.int"), p.int, 99, (v) => { p.int = v; }),
                choose(t("debug.weapon"), p.weapon, WEAPONS.map((w) => ({ value: w.index, label: w.name })), (v) => { p.weapon = +v; }),
                choose(t("debug.armour"), p.armour, ARMOURS.map((a) => ({ value: a.index, label: a.name })), (v) => { p.armour = +v; }),
              )))),
          section(t("debug.supplies"),
            grid(
              num(t("debug.gold"), s.gold, 9999, (v) => { s.gold = v; }),
              num(t("debug.food"), Math.floor(s.food / 100), 9999, (v) => { s.food = v * 100; }),
              num(t("debug.torches"), s.torches, 99, (v) => { s.torches = v; }),
              num(t("debug.gems"), s.gems, 99, (v) => { s.gems = v; }),
              num(t("debug.keys"), s.keys, 99, (v) => { s.keys = v; }),
              num(t("debug.sextants"), s.sextants, 99, (v) => { s.sextants = v; }),
              num(t("debug.hull"), s.shipHull, 99, (v) => { s.shipHull = v; })),
            actions(btn(t("debug.fillSupplies"), apply(() => {
              s.gold = 9999; s.food = 999900; s.torches = s.gems = s.keys = s.sextants = 99;
            })))),
          section(t("debug.karma"),
            h("p", { class: "dbg-note" }, t("debug.karmaHint")),
            grid(...VIRTUES.map((v, i) => h("div", { class: "dbg-karma" },
              num(v, s.karma[i], 99, (n) => { s.karma[i] = n; }),
              s.karma[i] === 0 ? h("span", { class: "dbg-elevated" }, t("debug.elevated"))
                : btn(t("debug.elevate"), apply(() => { s.karma[i] = 0; }))))),
            actions(btn(t("debug.elevateAll"), apply(() => s.karma.fill(0))))),
        );
      }

      function renderItems() {
        const bits = (n: number, names: readonly string[], get: () => number, set: (v: number) => void) =>
          grid(...names.slice(0, n).map((name, i) => flag(name, (get() & (1 << i)) !== 0, (on) => set(on ? get() | (1 << i) : get() & ~(1 << i)))));
        const counts = (names: readonly string[], list: number[], max: number, from = 0) =>
          grid(...names.map((name, i) => i < from ? null : num(name, list[i], max, (v) => { list[i] = v; })).filter((x): x is HTMLLabelElement => !!x));
        const itemNames = Object.keys(ITEM_FLAGS) as (keyof typeof ITEM_FLAGS)[];
        content.append(
          section(t("debug.questItems"),
            grid(...itemNames.map((k) => flag(t(`debug.item.${k}`), (s.items & ITEM_FLAGS[k]) !== 0, (on) => { s.items = on ? s.items | ITEM_FLAGS[k] : s.items & ~ITEM_FLAGS[k]; }))),
            actions(btn(t("debug.allQuestItems"), apply(() => { s.items |= ABYSS_ITEMS | KEY_PARTS | ITEM_FLAGS.skull | ITEM_FLAGS.horn | ITEM_FLAGS.wheel; })))),
          section(t("debug.stones"), bits(8, STONE_COLORS, () => s.stones, (v) => { s.stones = v; }),
            actions(btn(t("debug.all"), apply(() => { s.stones = 0xff; })))),
          section(t("debug.runes"), bits(8, VIRTUES, () => s.runes, (v) => { s.runes = v; }),
            actions(btn(t("debug.all"), apply(() => { s.runes = 0xff; })))),
          section(t("debug.reagents"), counts(REAGENTS, s.reagents, 99),
            actions(btn(t("debug.fill99"), apply(() => s.reagents.fill(99))))),
          section(t("debug.weapons"), counts(WEAPONS.map((w) => w.name), s.weapons, 99, 1),
            actions(btn(t("debug.fill8"), apply(() => { for (let i = 1; i < s.weapons.length; i++) s.weapons[i] = 8; })))),
          section(t("debug.armours"), counts(ARMOURS.map((a) => a.name), s.armour, 99, 1),
            actions(btn(t("debug.fill8"), apply(() => { for (let i = 1; i < s.armour.length; i++) s.armour[i] = 8; })))),
        );
      }

      function renderWorld() {
        const where = g.mode === "combat" ? t("debug.inCombat") : g.map.kind === "town" ? `${g.map.loc.name} (${g.px}, ${g.py})` : g.mode === "dungeon" ? t("debug.inDungeon") : `${t("debug.overworld")} (${g.px}, ${g.py})`;
        const placeLoc = (): { loc?: LocationDef; shrine?: number } => {
          const [kind, n] = place.split(":");
          return kind === "loc" ? { loc: LOCATIONS[+n] } : { shrine: +n };
        };
        const placePos = (): [number, number] | null => {
          const p = placeLoc();
          if (p.loc) return [p.loc.x, p.loc.y];
          const sh = SHRINES.find((x) => x.virtue === p.shrine);
          return sh ? [sh.x, sh.y] : null;
        };
        let tx = g.map.kind === "world" ? g.px : s.x, ty = g.map.kind === "world" ? g.py : s.y;
        const transports = [
          { value: T.AVATAR, label: t("debug.onFoot") }, { value: T.HORSE_W, label: t("debug.horse") },
          { value: T.SHIP_W, label: t("debug.ship") }, { value: T.BALLOON, label: t("debug.balloon") },
        ];
        const current = g.onShip ? T.SHIP_W : g.onHorse ? T.HORSE_W : g.inBalloon ? T.BALLOON : T.AVATAR;
        const phases = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({ value: n, label: String(n) }));
        let trammel = s.trammelPhase, felucca = s.feluccaPhase;
        content.append(
          section(t("debug.position"), h("p", { class: "dbg-note" }, where)),
          section(t("debug.places"),
            actions(
              choose(t("debug.place"), place, PLACES(), (v) => { place = v; }, "none"),
              btn(t("debug.teleportNear"), () => {
                const pos = placePos();
                if (!pos || !atPrompt(g)) return;
                const [x, y] = besides(g, pos[0], pos[1]);
                teleport(g, x, y);
                ctx.close();
              }, "prompt", { id: "dbg-teleport-near" }),
              btn(t("debug.enterPlace"), inLoop(() => {
                const p = placeLoc();
                if (p.shrine === 6) return g.enterShrine(6); // only reachable through a moongate
                const pos = placePos()!;
                teleport(g, pos[0], pos[1]);
                g.save.transport = T.AVATAR;
                return enter(g);
              }), "prompt", { id: "dbg-enter" }))),
          section(t("debug.coordinates"),
            actions(
              num("x", tx, 255, (v) => { tx = v; }, true),
              num("y", ty, 255, (v) => { ty = v; }, true),
              btn(t("debug.teleport"), () => { if (atPrompt(g)) { teleport(g, tx, ty); ctx.close(); } }, "prompt", { id: "dbg-teleport-xy" }))),
          section(t("debug.transport"),
            actions(choose(t("debug.transport"), current, transports, (v) => { if (g.map.kind === "world") s.transport = +v; }, "prompt"))),
          section(t("debug.moons"),
            actions(
              choose(t("debug.trammel"), trammel, phases, (v) => { trammel = +v; }, "none"),
              choose(t("debug.felucca"), felucca, phases, (v) => { felucca = +v; }, "none"),
              btn(t("debug.apply"), apply(() => {
                s.trammelPhase = trammel; s.feluccaPhase = felucca;
                (g.sky as unknown as { trammelByte: number }).trammelByte = -1; // re-read from the save on the next tick
              }))),
            h("p", { class: "dbg-note" }, t("debug.moonsHint"))),
          section(t("debug.gates"),
            h("div", { class: "dbg-table-wrap" }, h("table", { class: "dbg-table" },
              h("thead", {}, h("tr", {},
                ...["debug.gate", "debug.position", "debug.trammel", "debug.felucca", ""].map((k) => h("th", {}, k ? t(k) : "")))),
              h("tbody", {}, MOONGATES.map((m) => h("tr", {
                class: [m.phase === s.trammelPhase ? "open" : "", m.phase === s.feluccaPhase ? "dest" : ""].join(" ").trim(),
              },
                h("td", {}, m.nearTown),
                h("td", {}, `${m.x}, ${m.y}`),
                h("td", {}, `${MOON_GLYPHS[m.phase]} ${m.phase}`, m.phase === s.trammelPhase ? h("small", {}, t("debug.gateOpen")) : null),
                h("td", {}, `${MOON_GLYPHS[m.phase]} ${m.phase}`, m.phase === s.feluccaPhase ? h("small", {}, t("debug.gateDest")) : null),
                h("td", {}, h("div", { class: "dbg-cell-actions" },
                  btn(t("debug.gateOpenIt"), apply(() => {
                    s.trammelPhase = m.phase;
                    (g.sky as unknown as { trammelByte: number }).trammelByte = -1;
                  })),
                  btn(t("debug.teleportNear"), () => {
                    if (!atPrompt(g)) return;
                    const [x, y] = besides(g, m.x, m.y);
                    teleport(g, x, y);
                    ctx.close();
                  }, "prompt")))))))),
            h("p", { class: "dbg-note" }, t("debug.gatesHint"))),
        );
      }

      function renderCombat() {
        content.append(
          section(t("debug.fight"),
            h("p", { class: "dbg-note" }, t("debug.fightHint")),
            actions(
              choose(t("debug.monster"), monster, MONSTERS.map((m, i) => ({ value: i, label: `${m.name} (${m.tile.toString(16)})` })), (v) => { monster = +v; }, "none"),
              btn(t("debug.startFight"), inLoop(() => fight(g, MONSTERS[monster].tile)), "prompt", { id: "dbg-fight" }))),
          section(t("debug.godMode"), h("p", { class: "dbg-note" }, t("debug.godModeHint"))),
        );
      }

      function renderSpells() {
        content.append(
          section(t("debug.mixtures"),
            h("p", { class: "dbg-note" }, t("debug.mixturesHint")),
            actions(
              btn(t("debug.castAny"), apply(() => { s.mixtures.fill(99); fullMp(g); })),
              btn(t("debug.fullMp"), apply(() => fullMp(g)))),
            grid(...SPELLS.map((sp, i) => num(`${sp.letter} ${sp.name}`, s.mixtures[i], 99, (v) => { s.mixtures[i] = v; })))),
        );
      }

      function renderTests() {
        content.append(
          section(t("debug.tests"),
            h("p", { class: "dbg-note" }, t("debug.testsHint")),
            h("ul", { class: "dbg-tests" }, TESTS.map((tc) => h("li", {},
              h("div", {}, h("strong", {}, t(`debug.test.${tc.id}`)), h("small", {}, t(`debug.test.${tc.id}.hint`))),
              btn(t("debug.setUp"), () => {
                if (!atPrompt(g)) return;
                tc.setup(g);
                ctx.close();
                if (tc.loop) runInLoop(g, () => tc.loop!(g));
              }, "prompt", { "data-test": tc.id }))))),
        );
      }

      // ---- availability of the controls (the game may be busy: a prompt, an animation...)
      const update = () => {
        const ready = idle(g), prompt = atPrompt(g);
        state.textContent = prompt ? t("debug.ready") : ready ? t("debug.readyEditOnly") : t("debug.busy");
        state.className = `dbg-state ${prompt ? "ok" : ready ? "partial" : "busy"}`;
        for (const el of body.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>("[data-need]"))
          el.disabled = el.dataset.need === "prompt" ? !prompt : !ready;
      };
      update();
      timer = setInterval(update, 250);
    },
  };
}
