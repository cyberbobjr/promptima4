// World map panel: the whole of WORLD.MAP drawn with the current tile pack, with zoom (wheel, buttons,
// pinch, + / -) and pan (drag, arrow keys), the party (blinking) and the discovered places of the
// journal (src/game/journal.ts), listed beside the map (a click centres the map on the place).
import type { Game } from "../../game/game";
import type { LoadedPack } from "../../assets/store";
import { t } from "../../i18n/i18n";
import { journalOf, PLACES, partyWorldPos, placeName, type Place, type PlaceKind } from "../../game/journal";
import { h } from "../dom/dom";
import type { Panel } from "../dom/panels";
import "./worldmap.css";

const W = 256;
/** Pixels per tile of the two cached renderings: full detail, and an overview for small zooms. */
const BIG = 16, SMALL = 4;
const MAX_PPT = 64;
const ZOOM_STEPS = [2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];
const LABEL_PPT = 8;

const KINDS: readonly PlaceKind[] = ["castle", "town", "village", "ruin", "dungeon", "abyss", "shrine", "moongate"];
const COLORS: Record<PlaceKind, string> = {
  castle: "#ffd75e", town: "#55ffff", village: "#7dff7d", ruin: "#c8b48c",
  dungeon: "#ff5555", abyss: "#ff3df0", shrine: "#ffa0f4", moongate: "#9fb4ff",
};

// ---------------------------------------------------------------- cached map images

interface MapImages { big: HTMLCanvasElement; small: HTMLCanvasElement }
let cache: { pack: LoadedPack; tiles: Uint8Array; images: MapImages } | null = null;

function canvas(w: number, hgt: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w; c.height = hgt;
  return c;
}

/** The pack's atlas as 16x16 tiles of 16 pixels (HD packs are scaled down). */
function atlas16(pack: LoadedPack): Uint32Array {
  const src = canvas(pack.size, pack.size);
  src.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(pack.rgba.buffer, pack.rgba.byteOffset, pack.rgba.byteLength), pack.size, pack.size), 0, 0);
  if (pack.size === 16 * BIG) return new Uint32Array(pack.rgba.buffer, pack.rgba.byteOffset, pack.rgba.byteLength >> 2);
  const dst = canvas(16 * BIG, 16 * BIG);
  const ctx = dst.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, dst.width, dst.height);
  return new Uint32Array(ctx.getImageData(0, 0, dst.width, dst.height).data.buffer);
}

function mapImages(pack: LoadedPack, tiles: Uint8Array, layered: Uint32Array | null): MapImages {
  if (cache && cache.pack === pack && cache.tiles === tiles) return cache.images;
  // a layered pack draws its own tiles (its classic atlas is only the fallback of uncovered ids)
  const atlas = layered ?? atlas16(pack);
  const aw = 16 * BIG, size = W * BIG;
  const img = new ImageData(size, size);
  const dst = new Uint32Array(img.data.buffer);
  for (let ty = 0; ty < W; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const tile = tiles[ty * W + tx];
      const so = (tile >> 4) * BIG * aw + (tile & 15) * BIG;
      const d = ty * BIG * size + tx * BIG;
      for (let r = 0; r < BIG; r++) dst.set(atlas.subarray(so + r * aw, so + r * aw + BIG), d + r * size);
    }
  }
  const big = canvas(size, size);
  big.getContext("2d")!.putImageData(img, 0, 0);
  // overview: halved twice with smoothing (one big step would skip pixels)
  let small = big;
  for (let s = size / 2; s >= W * SMALL; s /= 2) {
    const c = canvas(s, s);
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(small, 0, 0, s, s);
    small = c;
  }
  const images = { big, small };
  cache = { pack, tiles, images };
  return images;
}

// ---------------------------------------------------------------- panel

/** Zoom kept between openings (pixels per tile; 0 = default). */
let lastPpt = 0;

export function createWorldmapPanel(g: Game): Panel {
  let cleanup: (() => void) | null = null;
  let keys: ((e: KeyboardEvent) => boolean) | null = null;

  return {
    id: "worldmap",
    size: "wide",
    title: () => t("menu.worldmap"),
    render(body) {
      cleanup?.();
      body.classList.add("wm-body");
      const view = mount(g, body);
      cleanup = view.dispose;
      keys = view.onKey;
    },
    onKey: (e) => keys?.(e) ?? false,
    dispose() { cleanup?.(); cleanup = null; keys = null; },
  };
}

function mount(g: Game, body: HTMLElement): { dispose: () => void; onKey: (e: KeyboardEvent) => boolean } {
  const journal = journalOf(g);
  journal.update();
  const labels = { shrine: (v: string) => t("map.shrine", { name: v }), moongate: (n: string) => t("map.moongate", { name: n }) };
  const nameOf = (p: Place) => placeName(p, labels);

  const cv = h("canvas", { class: "wm-canvas", tabindex: 0, role: "img", "aria-label": t("map.canvas") });
  const tip = h("div", { class: "wm-tip", hidden: true });
  const btn = (label: string, title: string, cls: string, fn: () => void) =>
    h("button", { class: cls, title, "aria-label": title, onclick: fn }, label);
  const tools = h("div", { class: "wm-tools" },
    btn("-", t("map.zoomOut"), "wm-out", () => step(-1)),
    btn("+", t("map.zoomIn"), "wm-in", () => step(1)),
    btn(t("map.party"), t("map.centre"), "wm-centre", () => centreOnParty()));
  const viewEl = h("div", { class: "wm-view" }, cv, tools, tip, h("div", { class: "wm-hint" }, t("map.hint")));
  const count = h("div", { class: "wm-count" });
  const list = h("div", { class: "wm-list" });
  body.append(h("div", { class: "wm" }, viewEl, h("aside", { class: "wm-side" }, h("h3", {}, t("map.places")), count, list)));

  const sameMap = cache && cache.pack === g.r.assets.pack && cache.tiles === g.world.tiles;
  const images = mapImages(g.r.assets.pack, g.world.tiles, sameMap ? null : g.r.layeredAtlas(BIG));
  const ctx = cv.getContext("2d")!;
  let vw = 1, vh = 1, dpr = 1;
  let ppt = lastPpt || 8, cx = 128, cy = 128;
  let selected: string | null = null;
  let dirty = true;

  const party = () => {
    const p = partyWorldPos(journal.state());
    return { x: p.x + 0.5, y: p.y + 0.5 };
  };
  const minPpt = () => Math.min(vw, vh) / W;
  const clampView = () => {
    ppt = Math.max(minPpt(), Math.min(MAX_PPT, ppt));
    const hw = vw / 2 / ppt, hh = vh / 2 / ppt;
    cx = W <= 2 * hw ? W / 2 : Math.max(hw, Math.min(W - hw, cx));
    cy = W <= 2 * hh ? W / 2 : Math.max(hh, Math.min(W - hh, cy));
    lastPpt = ppt;
    dirty = true;
  };
  const toScreen = (x: number, y: number) => ({ sx: vw / 2 + (x - cx) * ppt, sy: vh / 2 + (y - cy) * ppt });
  const zoomAt = (sx: number, sy: number, next: number) => {
    const wx = cx + (sx - vw / 2) / ppt, wy = cy + (sy - vh / 2) / ppt;
    ppt = Math.max(minPpt(), Math.min(MAX_PPT, next));
    cx = wx - (sx - vw / 2) / ppt; cy = wy - (sy - vh / 2) / ppt;
    clampView();
    hideTip();
  };
  function step(dir: 1 | -1) {
    const next = dir > 0 ? ZOOM_STEPS.find((z) => z > ppt + 0.01) ?? MAX_PPT : [...ZOOM_STEPS].reverse().find((z) => z < ppt - 0.01) ?? minPpt();
    zoomAt(vw / 2, vh / 2, next);
  }
  const pan = (dx: number, dy: number) => { cx += dx / ppt; cy += dy / ppt; clampView(); hideTip(); };
  function centreOn(x: number, y: number) { cx = x; cy = y; clampView(); }
  function centreOnParty() { selected = null; const p = party(); centreOn(p.x, p.y); renderList(); showTipAt(p.x, p.y, t("map.you")); }

  // ---- drawing

  const known = () => PLACES.filter((p) => journal.has(p.key));
  const markerSize = () => Math.max(3.5, Math.min(9, ppt * 0.5));

  function drawMarker(p: Place, s: number) {
    const { sx, sy } = toScreen(p.x + 0.5, p.y + 0.5);
    if (sx < -40 || sy < -40 || sx > vw + 40 || sy > vh + 40) return;
    ctx.fillStyle = COLORS[p.kind];
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (p.kind === "shrine") { ctx.moveTo(sx, sy - s); ctx.lineTo(sx + s, sy); ctx.lineTo(sx, sy + s); ctx.lineTo(sx - s, sy); ctx.closePath(); }
    else if (p.kind === "moongate") ctx.arc(sx, sy, s * 0.9, 0, Math.PI * 2);
    else if (p.kind === "dungeon" || p.kind === "abyss") { ctx.moveTo(sx - s, sy - s * 0.8); ctx.lineTo(sx + s, sy - s * 0.8); ctx.lineTo(sx, sy + s); ctx.closePath(); }
    else ctx.rect(sx - s * 0.8, sy - s * 0.8, s * 1.6, s * 1.6);
    ctx.fill();
    ctx.stroke();
    if (p.key === selected) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.strokeRect(sx - s - 4, sy - s - 4, 2 * s + 8, 2 * s + 8);
    }
  }

  type Box = { x0: number; y0: number; x1: number; y1: number };
  /** Draws the name below the marker, or above when that place is taken; skipped when both are. */
  function drawLabel(p: Place, s: number, taken: Box[]) {
    const { sx, sy } = toScreen(p.x + 0.5, p.y + 0.5);
    if (sx < -200 || sy < -20 || sx > vw + 200 || sy > vh + 20) return;
    const text = nameOf(p);
    ctx.font = `8px "Press Start 2P", monospace`;
    const w = ctx.measureText(text).width + 4, lh = 11;
    const free = (b: Box) => !taken.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
    const below: Box = { x0: sx - w / 2, x1: sx + w / 2, y0: sy + s + 2, y1: sy + s + 2 + lh };
    const above: Box = { x0: sx - w / 2, x1: sx + w / 2, y0: sy - s - 2 - lh, y1: sy - s - 2 };
    const box = free(below) ? below : free(above) ? above : null;
    if (!box) return;
    taken.push(box);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#000";
    ctx.strokeText(text, sx, box.y0 + 2);
    ctx.fillStyle = p.key === selected ? "#fff" : COLORS[p.kind];
    ctx.fillText(text, sx, box.y0 + 2);
  }

  function draw(now: number) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, vw, vh);
    // visible part of the map, in whole tiles
    const left = cx - vw / 2 / ppt, top = cy - vh / 2 / ppt;
    const tx0 = Math.max(0, Math.floor(left)), ty0 = Math.max(0, Math.floor(top));
    const tx1 = Math.min(W, Math.ceil(left + vw / ppt)), ty1 = Math.min(W, Math.ceil(top + vh / ppt));
    if (tx1 > tx0 && ty1 > ty0) {
      const src = ppt >= SMALL * 2 ? images.big : images.small, st = src.width / W;
      ctx.imageSmoothingEnabled = ppt < st;
      ctx.drawImage(src, tx0 * st, ty0 * st, (tx1 - tx0) * st, (ty1 - ty0) * st,
        (tx0 - left) * ppt, (ty0 - top) * ppt, (tx1 - tx0) * ppt, (ty1 - ty0) * ppt);
    }
    const s = markerSize();
    const places = known();
    for (const p of places) drawMarker(p, s);
    const pp = party(), { sx, sy } = toScreen(pp.x, pp.y);
    const r = Math.max(6, ppt * 0.7);
    // labels: the selected place first, never over the party
    const taken: Box[] = [{ x0: sx - r, x1: sx + r, y0: sy - r, y1: sy + r }];
    const sel = places.find((q) => q.key === selected);
    if (sel) drawLabel(sel, s, taken);
    if (ppt >= LABEL_PPT) for (const p of places) if (p !== sel) drawLabel(p, s, taken);
    // party: a ring, its centre blinking
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#000";
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#fff";
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.stroke();
    if (Math.floor(now / 400) % 2 === 0) {
      ctx.fillStyle = "#ff3030";
      ctx.beginPath(); ctx.arc(sx, sy, r * 0.55, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = "#000"; ctx.stroke();
    }
  }

  let raf = 0, lastBlink = -1;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    const blink = Math.floor(now / 400) % 2;
    if (!dirty && blink === lastBlink) return;
    dirty = false; lastBlink = blink;
    draw(now);
  };

  const resize = () => {
    const rect = cv.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    vw = Math.max(1, rect.width); vh = Math.max(1, rect.height);
    cv.width = Math.round(vw * dpr); cv.height = Math.round(vh * dpr);
    clampView();
  };
  const ro = new ResizeObserver(() => resize());
  ro.observe(cv);

  // ---- tooltip

  let tipTimer = 0;
  function hideTip() { tip.hidden = true; clearTimeout(tipTimer); }
  function showTipAt(x: number, y: number, text: string, autoHide = true) {
    const { sx, sy } = toScreen(x, y);
    if (sx < 0 || sy < 0 || sx > vw || sy > vh) { hideTip(); return; }
    tip.textContent = text;
    tip.style.left = `${sx}px`;
    tip.style.top = `${sy - Math.max(4, ppt * 0.5)}px`;
    tip.hidden = false;
    clearTimeout(tipTimer);
    if (autoHide) tipTimer = window.setTimeout(() => { tip.hidden = true; }, 2500);
  }
  /** Name under the screen point (place or party), with its tile centre. */
  function hit(sx: number, sy: number): { x: number; y: number; text: string } | null {
    const reach = Math.max(10, markerSize() + 4);
    const pp = party(), ps = toScreen(pp.x, pp.y);
    let best: { x: number; y: number; text: string } | null = null, bestD = reach;
    if (Math.hypot(ps.sx - sx, ps.sy - sy) <= Math.max(reach, ppt * 0.7)) { best = { ...pp, text: t("map.you") }; bestD = Math.hypot(ps.sx - sx, ps.sy - sy) - 0.01; }
    for (const p of known()) {
      const q = toScreen(p.x + 0.5, p.y + 0.5), d = Math.hypot(q.sx - sx, q.sy - sy);
      if (d < bestD) { bestD = d; best = { x: p.x + 0.5, y: p.y + 0.5, text: nameOf(p) }; }
    }
    return best;
  }

  // ---- pointer: drag, pinch, wheel, hover and tap

  const pointers = new Map<number, { x: number; y: number }>();
  let travel = 0;
  const local = (e: PointerEvent | WheelEvent) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const pair = () => {
    const [a, b] = [...pointers.values()];
    return { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  };
  const onDown = (e: PointerEvent) => {
    try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic or already released pointer */ }
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 1) travel = 0;
    cv.focus({ preventScroll: true });
  };
  const onMove = (e: PointerEvent) => {
    const p = local(e);
    const prev = pointers.get(e.pointerId);
    if (!prev) {
      if (e.pointerType === "mouse") { const hh = hit(p.x, p.y); if (hh) showTipAt(hh.x, hh.y, hh.text, false); else hideTip(); }
      return;
    }
    if (pointers.size === 1) {
      travel += Math.hypot(p.x - prev.x, p.y - prev.y);
      pointers.set(e.pointerId, p);
      if (travel > 4) pan(prev.x - p.x, prev.y - p.y);
    } else if (pointers.size === 2) {
      const before = pair();
      pointers.set(e.pointerId, p);
      const after = pair();
      travel += 10;
      if (before.d > 0) zoomAt(before.mx, before.my, ppt * (after.d / before.d));
      pan(before.mx - after.mx, before.my - after.my);
    }
  };
  const onUp = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    const wasSingle = pointers.size === 1;
    pointers.delete(e.pointerId);
    if (wasSingle && travel <= 4 && e.type === "pointerup") {
      const p = local(e), hh = hit(p.x, p.y);
      if (hh) showTipAt(hh.x, hh.y, hh.text); else hideTip();
    }
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = local(e);
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * vh : e.deltaY;
    zoomAt(p.x, p.y, ppt * Math.exp(-dy * 0.0015));
  };
  cv.addEventListener("pointerdown", onDown);
  cv.addEventListener("pointermove", onMove);
  cv.addEventListener("pointerup", onUp);
  cv.addEventListener("pointercancel", onUp);
  cv.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && !pointers.size) hideTip(); });
  cv.addEventListener("wheel", onWheel, { passive: false });

  // ---- list of discovered places

  function renderList() {
    const places = known();
    count.textContent = t("map.count", { n: places.length, total: PLACES.length });
    if (!places.length) { list.replaceChildren(h("p", { class: "wm-none" }, t("map.none"))); return; }
    list.replaceChildren(...KINDS.map((kind) => {
      const of = places.filter((p) => p.kind === kind).map((p) => ({ p, name: nameOf(p) })).sort((a, b) => a.name.localeCompare(b.name));
      if (!of.length) return null;
      return h("section", { class: "wm-group" },
        h("h4", {}, h("span", { class: "wm-swatch", style: `background:${COLORS[kind]}` }), t(`map.kind.${kind}`)),
        h("ul", {}, of.map(({ p, name }) => h("li", {},
          h("button", { class: p.key === selected ? "sel" : undefined, "data-key": p.key, onclick: () => select(p) }, name)))));
    }).filter((x) => x !== null));
  }
  function select(p: Place) {
    selected = p.key;
    if (ppt < 12) ppt = 12;
    centreOn(p.x + 0.5, p.y + 0.5);
    renderList();
    (list.querySelector(`[data-key="${p.key}"]`) as HTMLElement | null)?.focus();
    showTipAt(p.x + 0.5, p.y + 0.5, nameOf(p));
  }
  const offJournal = journal.onChange(() => { renderList(); dirty = true; });
  renderList();

  // ---- keyboard

  const onKey = (e: KeyboardEvent): boolean => {
    const stepPx = Math.max(32, Math.min(vw, vh) / 4);
    switch (e.key) {
      case "ArrowLeft": pan(-stepPx, 0); return true;
      case "ArrowRight": pan(stepPx, 0); return true;
      case "ArrowUp": pan(0, -stepPx); return true;
      case "ArrowDown": pan(0, stepPx); return true;
      case "+": case "=": step(1); return true;
      case "-": case "_": step(-1); return true;
      case "c": case "C": case "Home": centreOnParty(); return true;
    }
    return false;
  };

  resize();
  const p0 = party();
  centreOn(p0.x, p0.y);
  raf = requestAnimationFrame(loop);
  cv.focus({ preventScroll: true });

  return {
    onKey,
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      offJournal();
      clearTimeout(tipTimer);
    },
  };
}
