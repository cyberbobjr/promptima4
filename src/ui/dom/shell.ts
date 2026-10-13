// The page around the game: the canvas stage (with the overlay for panels and pointer input) and the
// command bar. Panels register themselves as menu entries here.
import type { Game } from "../../game/game";
import { config, updateConfig } from "../../config/config";
import { t } from "../../i18n/i18n";
import { CommandBar, type MenuEntry } from "./commandBar";
import { h } from "./dom";
import { Panels, type Panel } from "./panels";
import { openTextEntry } from "./textEntry";
import "./styles.css";

export interface Shell {
  stage: HTMLElement;
  overlay: HTMLElement;
  panels: Panels;
  bar: CommandBar;
  /** Adds a menu button opening a panel (inventory, map, help, debug...). */
  addPanel(panel: () => Panel, opts?: { visible?: () => boolean; key?: string }): void;
}

/** Builds the page around the existing canvas. */
export function createShell(canvas: HTMLCanvasElement, g: Game): Shell {
  const overlay = h("div", { id: "overlay" });
  const stage = h("main", { id: "stage" });
  const app = h("div", { id: "app" });
  canvas.replaceWith(app);
  stage.append(canvas, overlay);
  const panels = new Panels(overlay, g);
  const menus: MenuEntry[] = [];
  const bar = new CommandBar(g, menus, () => openTextEntry(overlay, g));
  app.append(stage, bar.root);
  // a discreet handle on the edge of the stage folds the bar away (saved in the settings)
  const handle = h("button", {
    type: "button", class: "bar-handle",
    onclick: () => { void updateConfig({ controls: { barCollapsed: !config().controls.barCollapsed } }).then(showBar); },
  });
  stage.append(handle);
  const showBar = () => {
    const mode = config().controls.commandBar;
    const touch = matchMedia("(pointer: coarse)").matches;
    const none = mode === "never" || (mode === "auto" && !touch && !matchMedia("(min-width: 1100px)").matches);
    const folded = config().controls.barCollapsed;
    const changed = app.classList.contains("bar-folded") !== (folded && !none);
    app.classList.toggle("no-bar", none);
    app.classList.toggle("bar-folded", folded && !none);
    handle.title = handle.ariaLabel = t(folded ? "ui.barShow" : "ui.barHide");
    handle.setAttribute("aria-expanded", folded ? "false" : "true");
    // the canvas fits the new room (the renderer follows window resizes)
    if (changed) dispatchEvent(new Event("resize"));
  };
  showBar();
  addEventListener("resize", showBar);

  // Function keys open the panels from the keyboard (they never reach the game).
  const hotkeys = new Map<string, () => void>();
  addEventListener("keydown", (e) => {
    const fn = hotkeys.get(e.key);
    if (fn && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); fn(); }
  });

  return {
    stage, overlay, panels, bar,
    addPanel(make, opts = {}) {
      const panel = make();
      const run = () => panels.toggle(panel);
      menus.push({ id: panel.id, label: () => t(`menu.${panel.id}`), run, visible: opts.visible });
      if (opts.key) hotkeys.set(opts.key, run);
      bar.update(true);
    },
  };
}
